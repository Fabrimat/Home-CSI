/*
 * sounding.c
 *
 * ===================== MECHANISM CHOICE AND WHY ==========================
 *
 * Requirement: emit a frame that (a) every other node on the channel can
 * decode and get CSI from, (b) is tiny, (c) does not depend on the AP
 * forwarding anything, and (d) carries an unambiguous source MAC so peers
 * can classify it.
 *
 * Option A - UDP broadcast to 255.255.255.255 through the AP.
 *   Rejected. At layer 2 that frame is addressed to the AP, which then
 *   re-broadcasts it: two transmissions of airtime instead of one, and the
 *   copy the peers hear best is the AP's, not ours. It also silently stops
 *   working if the AP filters broadcast or the node has no IP yet.
 *
 * Option B - raw 802.11 injection with esp_wifi_80211_tx().
 *   Chosen. One transmission, destination ff:ff:ff:ff:ff:ff, source = our
 *   own STA MAC, sent on the channel we are already tuned to, with no AP
 *   involvement and no IP stack involvement. This is the same approach the
 *   ESP32-CSI-Tool uses.
 *
 * Frame type: a Vendor-Specific public ACTION management frame (category
 * 0x7f). Management frames are decoded by every 802.11 station on the
 * channel regardless of association state, which is exactly what we need for
 * a mesh of stations that are all associated to the same AP but are not
 * talking to each other at layer 3. An action frame is also unambiguously
 * "not data", so it cannot be confused with household traffic, and at 38
 * bytes it is about as short as a decodable 802.11 frame gets.
 *
 * Sequence control is left zero: with en_sys_seq = true the driver fills it.
 *
 * JITTER: nine nodes flashed from one image with one interval would transmit
 * in lockstep and collide with each other forever - and, worse, the
 * collisions would be periodic, which puts a fake periodicity right into the
 * sensing signal. Every interval is therefore multiplied by a random factor
 * in [1 - jitter, 1 + jitter], and the task also starts at a random offset.
 *
 * UNVERIFIED: esp_wifi_80211_tx() behaviour with management frames while
 * associated has not been tested on real Halocode hardware by this project.
 * If it returns ESP_ERR_INVALID_ARG on your IDF version, the fallback is to
 * send a QoS-Null or Data frame instead; the counters in the heartbeat make
 * that failure obvious rather than silent (sounding failures show up as a
 * flat frames_captured on the *other* nodes).
 * =========================================================================
 */

#include "sounding.h"

#include <string.h>

#include "esp_log.h"
#include "esp_random.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "csi_protocol/csi_codec.h"
#include "wifi_link.h"

static const char *TAG = "sounding";

#define SOUNDING_TASK_STACK 3072
#define SOUNDING_TASK_PRIO 3

/* 24-byte 802.11 MAC header + 1 category + 3 OUI + 6 payload = 34 bytes. */
#define SOUNDING_FRAME_LEN 34

static node_config_t s_cfg;
static sounding_stats_t s_stats;
static uint8_t s_frame[SOUNDING_FRAME_LEN];
static uint32_t s_counter;

static void build_frame_template(void)
{
    memset(s_frame, 0, sizeof s_frame);

    /* Frame control: version 0, type 00 (management), subtype 1101 (Action).
     * Little-endian on the wire => 0xD0 0x00. */
    s_frame[0] = 0xD0;
    s_frame[1] = 0x00;
    /* Duration/ID left 0; the driver/PHY fills what it needs. */

    /* addr1 = DA = broadcast. THIS is the line that makes the mesh work. */
    memset(&s_frame[4], 0xFF, 6);

    /* addr2 = SA = our own MAC (filled at start, once Wi-Fi knows it). */
    wifi_link_own_mac(&s_frame[10]);

    /* addr3 = BSSID. Refreshed per transmission once associated; broadcast
     * until then so the frame is still well formed. */
    memset(&s_frame[16], 0xFF, 6);

    /* seq ctrl (bytes 22-23) left zero: en_sys_seq=true lets the driver own
     * the sequence number. */

    /* Body: Vendor Specific action category. */
    s_frame[24] = 0x7F;
    /* OUI: 00:00:00 is the reserved/experimental block. We are not
     * registering an OUI for a house sensor. */
    s_frame[25] = 0x00;
    s_frame[26] = 0x00;
    s_frame[27] = 0x00;
    /* 6 bytes of our own: node_id + a rolling counter. Peers cannot read it
     * (the CSI callback never sees the frame body), but a sniffer capture
     * makes soundings instantly identifiable during field debugging. */
    hcs_put_u16le(&s_frame[28], s_cfg.node_id);
    hcs_put_u32le(&s_frame[30], 0);
}

static uint32_t jittered_interval_ms(void)
{
    const uint32_t base = s_cfg.sounding_interval_ms;
    const uint32_t pct = s_cfg.sounding_jitter_pct;
    if (pct == 0u || base == 0u) {
        return base;
    }
    const uint32_t span = (base * pct) / 100u;
    if (span == 0u) {
        return base;
    }
    return base - span + (esp_random() % (2u * span + 1u));
}

static void sounding_task(void *arg)
{
    (void)arg;

    /* Random start offset on top of the per-interval jitter: nodes that boot
     * together must not begin their schedules in phase. */
    vTaskDelay(pdMS_TO_TICKS(esp_random() % (s_cfg.sounding_interval_ms + 1u)));

    for (;;) {
        if (wifi_link_state() >= WIFI_LINK_CONNECTED) {
            /* Keep addr3 current: some APs/drivers care that a management
             * frame from an associated STA carries the right BSSID. */
            uint8_t bssid[6];
            wifi_link_ap_bssid(bssid);
            static const uint8_t zero[6] = { 0 };
            if (memcmp(bssid, zero, 6) != 0) {
                memcpy(&s_frame[16], bssid, 6);
            }
            hcs_put_u32le(&s_frame[30], ++s_counter);

            const esp_err_t err =
                esp_wifi_80211_tx(WIFI_IF_STA, s_frame, sizeof s_frame,
                                  true /* en_sys_seq */);
            if (err == ESP_OK) {
                s_stats.sent++;
            } else {
                s_stats.failed++;
                /* Log sparsely: a disconnected node would otherwise spam. */
                if ((s_stats.failed % 100u) == 1u) {
                    ESP_LOGW(TAG, "esp_wifi_80211_tx failed: %s (%u failures)",
                             esp_err_to_name(err), (unsigned)s_stats.failed);
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(jittered_interval_ms()));
    }
}

esp_err_t sounding_start(const node_config_t *cfg)
{
    if (cfg == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    s_cfg = *cfg;
    if (s_cfg.sounding_interval_ms == 0u) {
        ESP_LOGW(TAG, "sounding disabled (interval 0) - this node contributes "
                      "nothing to the mesh");
        return ESP_OK;
    }
    memset(&s_stats, 0, sizeof s_stats);
    build_frame_template();

    ESP_LOGI(TAG,
             "broadcast sounding every %u ms +/- %u%% (%u-byte action frame, "
             "DA=ff:ff:ff:ff:ff:ff)",
             (unsigned)s_cfg.sounding_interval_ms,
             (unsigned)s_cfg.sounding_jitter_pct, (unsigned)SOUNDING_FRAME_LEN);

    if (xTaskCreate(sounding_task, "sounding", SOUNDING_TASK_STACK, NULL,
                    SOUNDING_TASK_PRIO, NULL)
        != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

void sounding_get_stats(sounding_stats_t *out)
{
    if (out) {
        *out = s_stats;
    }
}
