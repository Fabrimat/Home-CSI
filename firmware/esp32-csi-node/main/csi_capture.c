/* csi_capture.c - see csi_capture.h. */

#include "csi_capture.h"

#include <string.h>

#include "esp_idf_version.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"

#include "wifi_link.h"

static const char *TAG = "csi_cap";

/* Statically allocated ring storage. Nothing on the capture path allocates,
 * so the worst case RAM footprint is known at link time:
 *   CONFIG_HCS_RING_SLOTS * (CONFIG_HCS_CSI_MAX_LEN + sizeof(meta)) */
static csi_ring_slot_t s_slots[CONFIG_HCS_RING_SLOTS];
static csi_ring_t s_ring;

static node_config_t s_cfg;
static bw_budget_t s_budget;
static csi_capture_stats_t s_stats;
static wifi_csi_config_t s_csi_cfg;

/* --- helpers used inside the callback (must stay allocation-free) ------ */

static inline bool mac_eq(const uint8_t a[6], const uint8_t b[6])
{
    return memcmp(a, b, 6) == 0;
}

static csi_source_class_t classify_source(const uint8_t src[6])
{
    uint8_t bssid[6];
    wifi_link_ap_bssid(bssid);
    if (mac_eq(src, bssid)) {
        return CSI_SOURCE_AP;
    }
    for (uint8_t i = 0; i < s_cfg.allowlist_len; i++) {
        if (mac_eq(src, s_cfg.allowlist[i])) {
            return CSI_SOURCE_PEER_SOUNDING;
        }
    }
    return CSI_SOURCE_FOREIGN;
}

/*
 * Map the driver's report onto the protocol's csi_format tag (proto S9.3).
 *
 * UNVERIFIED AGAINST HARDWARE. The reasoning is:
 *   - a non-HT frame (sig_mode == 0) can only carry an LLTF estimate;
 *   - an HT frame with STBC set is the STBC_HT_LTF case;
 *   - otherwise what is present is whatever we asked wifi_csi_config_t for.
 * Because the tag is descriptive and the length is authoritative, a wrong
 * tag degrades interpretation but never desynchronises a batch - consumers
 * parse by csi_len (proto S9.2/S14). csi-hello prints sig_mode, stbc and the
 * raw length side by side so this mapping can be corrected from evidence.
 *
 * ESP32-C6 (docs/hardware-esp32c6.md): this project has not been able to
 * build/run against real C6 CSI callbacks (no hardware, no ESP-IDF
 * toolchain available while writing this), so it is worth being explicit
 * about what is and is not assumed here. The C6 is an 802.11ax (Wi-Fi 6)
 * radio; if its driver ever reports a `sig_mode` value other than the two
 * this function already checks (0 = non-HT, and HT via the stbc/htltf_en
 * checks below), the existing fall-through still returns SOME already-
 * defined tag rather than crashing or misparsing - it does not, and must
 * not, invent a new csi_format value to represent an HE PPDU. Per
 * CLAUDE.md and docs/protocol.md S9.3, csi_format is a two-place contract
 * (this file and server/packages/protocol) and is out of scope to extend
 * here; if bring-up evidence ever shows the C6 needs a genuinely new tag,
 * that is a call for a future brief with real hardware in hand, not a
 * guess made from a doc. */
static uint8_t classify_format(const wifi_pkt_rx_ctrl_t *rx)
{
    if (rx->sig_mode == 0) {
        return HCS_CSI_FORMAT_LLTF;
    }
    if (rx->stbc) {
        return HCS_CSI_FORMAT_STBC_HT_LTF;
    }
    if (s_csi_cfg.lltf_en && s_csi_cfg.htltf_en) {
        return HCS_CSI_FORMAT_LLTF_HT_LTF;
    }
    if (s_csi_cfg.htltf_en) {
        return HCS_CSI_FORMAT_HT_LTF;
    }
    return HCS_CSI_FORMAT_LLTF;
}

/* --- the CSI callback: runs in the Wi-Fi task ------------------------- */

static void csi_rx_cb(void *ctx, wifi_csi_info_t *info)
{
    (void)ctx;
    if (info == NULL || info->buf == NULL || info->len <= 0) {
        return;
    }
    s_stats.frames_seen++;

    const wifi_pkt_rx_ctrl_t *rx = &info->rx_ctrl;

    /* Cheapest rejection first: a weak frame's channel estimate is noise. */
    if (rx->rssi < s_cfg.rssi_floor_dbm) {
        s_stats.dropped_rssi++;
        return;
    }

    const csi_source_class_t src_class = classify_source(info->mac);
    if (s_cfg.allowlist_enforced && src_class == CSI_SOURCE_FOREIGN) {
        s_stats.dropped_notallow++;
        return;
    }

    /*
     * first_word_invalid: the ESP32 Wi-Fi driver can report a CSI buffer
     * whose first 4 bytes (one I/Q sample "word") are not valid channel
     * data - a documented quirk on the classic ESP32 and, per
     * docs/hardware-esp32c6.md, also observed on later variants including
     * the C6. Skip exactly those leading bytes here, at the callback,
     * rather than passing the flag downstream for someone else to handle:
     *
     *   - every consumer of csi_data parses strictly by csi_len (proto
     *     S9.2/S14; the server's csiParsing.ts derives subcarrier count from
     *     length alone, never from csi_format or any assumed constant), so
     *     shrinking csi_len to cover only the bytes actually kept is safe by
     *     construction - it can never desynchronise a batch, it just means
     *     this one record's csi_len is 4 bytes shorter than the driver's raw
     *     info->len;
     *   - the alternative (zeroing the 4 bytes instead of dropping them)
     *     would silently inject fabricated "valid-looking" samples into an
     *     amplitude-first pipeline, which is worse than a shorter but
     *     entirely genuine record.
     *
     * Counted in csi_capture_stats_t.first_word_invalid either way, so a
     * fleet-wide rate of this can be seen without a serial cable. */
    const uint8_t *csi_bytes = (const uint8_t *)info->buf;
    uint16_t csi_len = (uint16_t)info->len;
    if (info->first_word_invalid) {
        s_stats.first_word_invalid++;
        if (csi_len > 4u) {
            csi_bytes += 4;
            csi_len -= 4u;
        } else {
            /* Nothing valid survives a 4-byte trim of a record this short;
             * deliver nothing rather than a near-empty, meaningless one. */
            s_stats.dropped_invalid++;
            return;
        }
    }

    const uint32_t wire_bytes = (uint32_t)HCS_RECORD_FIXED_LEN + csi_len;
    const bw_class_t bw_class = (src_class == CSI_SOURCE_FOREIGN)
                                    ? BW_CLASS_FOREIGN
                                    : BW_CLASS_SOUNDING;

    /* Ask the budget BEFORE the memcpy: a rejected record should not cost us
     * 384 bytes of copying inside the Wi-Fi task. Pure integer work. */
    const int64_t now_us = esp_timer_get_time();
    if (bw_budget_admit(&s_budget, bw_class, wire_bytes, (uint64_t)now_us,
                        csi_ring_used_pct(&s_ring))
        != BW_ADMIT) {
        s_stats.dropped_budget++;
        return;
    }

    csi_ring_meta_t meta;
    memset(&meta, 0, sizeof meta);
    memcpy(meta.src_mac, info->mac, 6);
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
    /* dmac was added to wifi_csi_info_t in IDF v5.0. On older IDFs the
     * destination is simply unavailable and stays all-zero on the wire. */
    memcpy(meta.dst_mac, info->dmac, 6);
#endif
    meta.rssi = (int8_t)rx->rssi;
    meta.rate = (uint8_t)rx->rate;
    meta.sig_mode = (uint8_t)rx->sig_mode;
    meta.mcs = (rx->sig_mode == 1) ? (uint8_t)rx->mcs : HCS_MCS_NOT_APPLICABLE;
    meta.bandwidth = (uint8_t)rx->cwb; /* 0 = HT20, 1 = HT40 (proto S9.2) */
    meta.channel = (uint8_t)rx->channel;
    meta.secondary_channel = (uint8_t)rx->secondary_channel;
    meta.noise_floor = (int8_t)rx->noise_floor;
    meta.rx_timestamp_us = (uint64_t)now_us;
    meta.csi_format = classify_format(rx);
    meta.source_class = (uint8_t)src_class;

    /* The only expensive thing the callback does, and it is a bounded memcpy
     * into pre-allocated storage. Then return immediately. csi_bytes/csi_len
     * are the (possibly first_word_invalid-trimmed) view computed above -
     * never info->buf/info->len directly. */
    if (!csi_ring_push(&s_ring, &meta, csi_bytes, csi_len)) {
        s_stats.dropped_ring++;
        return;
    }
    s_stats.admitted++;
}

/* --- start ------------------------------------------------------------- */

esp_err_t csi_capture_start(const node_config_t *cfg)
{
    if (cfg == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    s_cfg = *cfg;
    memset(&s_stats, 0, sizeof s_stats);

    csi_ring_init(&s_ring, s_slots, CONFIG_HCS_RING_SLOTS);
    bw_budget_init(&s_budget, &s_cfg.bw, (uint64_t)esp_timer_get_time());

    ESP_LOGI(TAG, "ring: %u slots x %u max CSI bytes = %u bytes static",
             (unsigned)CONFIG_HCS_RING_SLOTS, (unsigned)CSI_RING_MAX_CSI_LEN,
             (unsigned)sizeof(s_slots));

#if CONFIG_IDF_TARGET_ESP32C6
    /* Espressif's own esp-csi project configures ESP32/C3/S3/C6 CSI through
     * this same wifi_csi_config_t shape (lltf_en/htltf_en/stbc_htltf2_en/
     * ltf_merge_en/channel_filter_en/manu_scale/shift), so the fields below
     * are used identically on the C6. That said: this project has not had
     * an ESP-IDF toolchain or a C6 board available while writing this, so
     * that equivalence has not been build-verified here. If `idf.py build`
     * on esp32c6 reports one of these fields as unknown, that is the
     * target/IDF-version rename to go fix (see firmware/bringup/README.md
     * and docs/hardware-esp32c6.md), not a design decision made blind. */
    ESP_LOGI(TAG, "target: esp32c6 - CSI config fields below are assumed "
                  "identical to the classic ESP32 API; not build-verified "
                  "by this project (see docs/hardware-esp32c6.md)");
#endif
    memset(&s_csi_cfg, 0, sizeof s_csi_cfg);
    /* Keep both LLTF and HT-LTF: the extra subcarriers materially improve
     * motion sensitivity, and the record is self-describing (csi_format +
     * csi_len) so a mixed stream is fine for the server. */
    s_csi_cfg.lltf_en = true;
    s_csi_cfg.htltf_en = true;
    s_csi_cfg.stbc_htltf2_en = true;
    /* Do NOT let the driver fold the two HT-LTFs together: we want the raw
     * estimate, and the protocol stores raw bytes verbatim. */
    s_csi_cfg.ltf_merge_en = false;
    s_csi_cfg.channel_filter_en = false;
    /* Leave the DC/first-word quirk visible rather than silently zeroing it;
     * the server records raw bytes and B4 decides what to do. */
    s_csi_cfg.manu_scale = false;
    s_csi_cfg.shift = 0;

    /* Step 10 of the ordering in wifi_link.c: config -> callback -> enable,
     * all after esp_wifi_start() and after promiscuous mode is live. */
    esp_err_t err = esp_wifi_set_csi_config(&s_csi_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_set_csi_config: %s", esp_err_to_name(err));
        return err;
    }
    err = esp_wifi_set_csi_rx_cb(csi_rx_cb, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_set_csi_rx_cb: %s", esp_err_to_name(err));
        return err;
    }
    err = esp_wifi_set_csi(true);
    if (err != ESP_OK) {
        ESP_LOGE(TAG,
                 "esp_wifi_set_csi(true): %s. Is CONFIG_ESP_WIFI_CSI_ENABLED "
                 "set, and was esp_wifi_start() called first?",
                 esp_err_to_name(err));
        return err;
    }

    ESP_LOGI(TAG, "CSI capture enabled (rssi floor %d dBm, allowlist %s)",
             (int)s_cfg.rssi_floor_dbm,
             s_cfg.allowlist_enforced ? "ENFORCED" : "advisory");
    return ESP_OK;
}

csi_ring_t *csi_capture_ring(void)
{
    return &s_ring;
}

void csi_capture_get_stats(csi_capture_stats_t *out)
{
    if (out) {
        *out = s_stats;
    }
}

uint32_t csi_capture_frames_captured(void)
{
    return s_stats.frames_seen;
}

uint32_t csi_capture_frames_dropped(void)
{
    /* Everything the node saw but will not deliver, for any reason. The
     * batcher's "too large to ever fit" drops are added by net_uplink. */
    return s_stats.dropped_rssi + s_stats.dropped_notallow
           + s_stats.dropped_budget + s_stats.dropped_ring
           + s_stats.dropped_invalid;
}

const bw_budget_t *csi_capture_budget(void)
{
    return &s_budget;
}

void csi_capture_reconfigure_bw(const bw_budget_cfg_t *cfg)
{
    if (cfg == NULL) {
        return;
    }
    bw_budget_reconfigure(&s_budget, cfg, (uint64_t)esp_timer_get_time());
}
