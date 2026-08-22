/*
 * wifi_link.c
 *
 * ===================== ESP-IDF CALL ORDER (IMPORTANT) =====================
 *
 * Getting this order wrong is the classic silent failure of ESP32 CSI work:
 * everything returns ESP_OK and no CSI ever arrives. The order below is the
 * one used by the ESP32-CSI-Tool pattern and by the IDF docs; each step notes
 * why it sits where it does.
 *
 *   1. esp_netif_init(), esp_event_loop_create_default(),
 *      esp_netif_create_default_wifi_sta()
 *        - netif and the default event loop must exist before esp_wifi_init,
 *          otherwise the driver's internal event posting has nowhere to go.
 *
 *   2. esp_wifi_init(WIFI_INIT_CONFIG_DEFAULT())
 *
 *   3. esp_wifi_set_storage(WIFI_STORAGE_RAM)
 *        - BEFORE set_config. Otherwise the driver may merge a previously
 *          stored SSID/channel from NVS with ours, which produces a node that
 *          associates to the wrong AP after a re-provision. (We also disable
 *          CONFIG_ESP_WIFI_NVS_ENABLED, belt and braces.)
 *
 *   4. esp_wifi_set_mode(WIFI_MODE_STA)
 *        - BEFORE set_config and BEFORE set_bandwidth: both are per-interface
 *          and the interface must exist in the chosen mode first.
 *
 *   5. esp_wifi_set_config(WIFI_IF_STA, ...) with .channel = pinned
 *        - the channel field is a scan HINT; it makes association fast and
 *          deterministic. It does NOT pin the radio by itself (see step 10).
 *
 *   6. esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20)
 *        - MUST be after set_mode. Doing it before start is fine and is what
 *          we want, so the very first association is already HT20 and no
 *          CSI is captured at 40 MHz with a different subcarrier layout.
 *
 *   7. esp_wifi_start()
 *
 *   8. esp_wifi_set_ps(WIFI_PS_NONE)
 *        - AFTER start. Power save is the single most destructive setting for
 *          CSI: with it on, the radio sleeps between beacons and CSI arrival
 *          becomes bursty garbage. NON-NEGOTIABLE.
 *
 *   9. promiscuous filter -> promiscuous rx cb -> esp_wifi_set_promiscuous(true)
 *        - AFTER start. Promiscuous mode coexists with an associated STA on
 *          the same channel; this is what lets us hear other nodes'
 *          broadcast soundings and foreign traffic.
 *
 *  10. csi config -> csi rx cb -> esp_wifi_set_csi(true)   [csi_capture.c]
 *        - AFTER start AND after promiscuous is enabled, otherwise CSI is
 *          only produced for frames addressed to us.
 *
 *  11. esp_wifi_connect()
 *        - last, after every RX-side setting is already live, so no frames
 *          are missed during association.
 *
 * ON PINNING THE CHANNEL, HONESTLY:
 *   esp_wifi_set_channel() does NOT override the channel of an associated
 *   STA - the AP's channel wins, and calling it while associated is at best
 *   ignored and at worst causes a disassociation. The channel is therefore
 *   pinned by (a) configuring the dedicated AP to a fixed channel, (b) giving
 *   the STA config that channel as its scan hint, and (c) VERIFYING with
 *   esp_wifi_get_channel() after association and shouting if it differs.
 *   wifi_link_verify_radio() does (c). We only call esp_wifi_set_channel()
 *   while NOT associated, where it is meaningful.
 * ==========================================================================
 */

#include "wifi_link.h"

#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "wifi_link";

#define BACKOFF_MIN_MS 1000u
#define BACKOFF_MAX_MS 60000u
#define BACKOFF_JITTER_PCT 25u

static node_config_t s_cfg;
static volatile wifi_link_state_t s_state = WIFI_LINK_IDLE;
static uint8_t s_own_mac[6];
static uint8_t s_bssid[6];
static uint32_t s_backoff_ms = BACKOFF_MIN_MS;
static int64_t s_down_since_us;
static esp_timer_handle_t s_retry_timer;

/* --- reconnect scheduling --------------------------------------------- */

/* Exponential backoff with +/-25% jitter.
 *
 * Nine nodes on the same breaker come back at the same instant after a power
 * cut. Without jitter they all hit the AP's association queue in lockstep,
 * all fail, and all retry in lockstep forever. The jitter is not cosmetic. */
static uint32_t jittered(uint32_t base_ms)
{
    const uint32_t span = (base_ms * BACKOFF_JITTER_PCT) / 100u;
    if (span == 0u) {
        return base_ms;
    }
    const uint32_t delta = esp_random() % (2u * span + 1u);
    return base_ms - span + delta;
}

static void retry_timer_cb(void *arg)
{
    (void)arg;
    ESP_LOGI(TAG, "reconnecting to '%s'", s_cfg.ap_ssid);
    s_state = WIFI_LINK_CONNECTING;
    const esp_err_t err = esp_wifi_connect();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "esp_wifi_connect: %s", esp_err_to_name(err));
    }
}

static void schedule_reconnect(void)
{
    const uint32_t delay_ms = jittered(s_backoff_ms);
    ESP_LOGW(TAG, "retrying association in %u ms (backoff %u ms)",
             (unsigned)delay_ms, (unsigned)s_backoff_ms);
    esp_timer_stop(s_retry_timer);
    ESP_ERROR_CHECK_WITHOUT_ABORT(
        esp_timer_start_once(s_retry_timer, (uint64_t)delay_ms * 1000ull));

    s_backoff_ms = (s_backoff_ms >= BACKOFF_MAX_MS / 2u)
                       ? BACKOFF_MAX_MS
                       : s_backoff_ms * 2u;
}

/* --- events ------------------------------------------------------------ */

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id,
                          void *data)
{
    (void)arg;
    (void)base;
    switch (id) {
    case WIFI_EVENT_STA_START:
        /* First association attempt is delayed by a random 0-3 s so a fleet
         * powering up together does not stampede the AP. */
        esp_timer_stop(s_retry_timer);
        ESP_ERROR_CHECK_WITHOUT_ABORT(esp_timer_start_once(
            s_retry_timer, (uint64_t)(esp_random() % 3000u) * 1000ull));
        break;

    case WIFI_EVENT_STA_CONNECTED: {
        const wifi_event_sta_connected_t *ev =
            (const wifi_event_sta_connected_t *)data;
        memcpy(s_bssid, ev->bssid, 6);
        s_state = WIFI_LINK_CONNECTED;
        s_backoff_ms = BACKOFF_MIN_MS;
        s_down_since_us = 0;
        ESP_LOGI(TAG,
                 "associated to %02x:%02x:%02x:%02x:%02x:%02x on channel %u",
                 ev->bssid[0], ev->bssid[1], ev->bssid[2], ev->bssid[3],
                 ev->bssid[4], ev->bssid[5], (unsigned)ev->channel);
        if (ev->channel != s_cfg.channel) {
            ESP_LOGE(TAG,
                     "AP is on channel %u but this node is configured for %u. "
                     "The mesh only works if every node and the AP share ONE "
                     "channel - fix the AP or the node config.",
                     (unsigned)ev->channel, (unsigned)s_cfg.channel);
        }
        wifi_link_verify_radio();
        break;
    }

    case WIFI_EVENT_STA_DISCONNECTED: {
        const wifi_event_sta_disconnected_t *ev =
            (const wifi_event_sta_disconnected_t *)data;
        if (s_down_since_us == 0) {
            s_down_since_us = esp_timer_get_time();
        }
        memset(s_bssid, 0, sizeof s_bssid);
        s_state = WIFI_LINK_DISCONNECTED;
        ESP_LOGW(TAG, "disconnected (reason %u)", (unsigned)ev->reason);
        schedule_reconnect();
        break;
    }

    default:
        break;
    }
}

static void on_ip_event(void *arg, esp_event_base_t base, int32_t id,
                        void *data)
{
    (void)arg;
    (void)base;
    (void)data;
    if (id == IP_EVENT_STA_GOT_IP) {
        s_state = WIFI_LINK_GOT_IP;
        s_down_since_us = 0;
        ESP_LOGI(TAG, "got IP - uplink can resolve and send");
    } else if (id == IP_EVENT_STA_LOST_IP) {
        ESP_LOGW(TAG, "lost IP");
        if (s_state == WIFI_LINK_GOT_IP) {
            s_state = WIFI_LINK_CONNECTED;
        }
    }
}

/* --- public ------------------------------------------------------------ */

esp_err_t wifi_link_start(const node_config_t *cfg)
{
    if (cfg == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    s_cfg = *cfg;
    s_state = WIFI_LINK_CONNECTING;
    s_down_since_us = esp_timer_get_time();

    const esp_timer_create_args_t targs = {
        .callback = retry_timer_cb,
        .name = "wifi_retry",
    };
    ESP_ERROR_CHECK(esp_timer_create(&targs, &s_retry_timer));

    /* 1 */
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    /* 2 */
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, ESP_EVENT_ANY_ID, on_ip_event, NULL, NULL));

    /* 3 - before set_config, so no stale stored credentials can leak in */
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));

    /* 4 */
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));

    /* 5 */
    wifi_config_t wc;
    memset(&wc, 0, sizeof wc);
    strncpy((char *)wc.sta.ssid, s_cfg.ap_ssid, sizeof(wc.sta.ssid) - 1);
    strncpy((char *)wc.sta.password, s_cfg.ap_password,
            sizeof(wc.sta.password) - 1);
    wc.sta.channel = s_cfg.channel; /* scan hint, see the header comment */
    wc.sta.scan_method = WIFI_FAST_SCAN;
    wc.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    /* The dedicated AP may legitimately be open (it carries only encrypted
     * payloads), so do not demand a minimum authmode. */
    wc.sta.threshold.authmode = WIFI_AUTH_OPEN;
    /* One fixed AP, one fixed channel: roaming/PMF negotiation only adds
     * ways for the association to move somewhere we did not intend. */
    wc.sta.pmf_cfg.capable = true;
    wc.sta.pmf_cfg.required = false;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));

    /* 6 - 20 MHz, enforced. HT40 would change the CSI subcarrier layout and
     * halve the usable channel count; docs/architecture.md pins 20 MHz. */
    ESP_ERROR_CHECK(esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20));

    /* 7 */
    ESP_ERROR_CHECK(esp_wifi_start());

    /* 8 - WIFI_PS_NONE. Do not "optimise" this away. */
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    ESP_LOGI(TAG, "power save disabled (WIFI_PS_NONE)");

    /* 9 - promiscuous alongside the association. The filter keeps management
     * + data frames (soundings are Action management frames; the AP's and
     * household traffic are data frames) and drops control frames, which
     * carry no useful channel estimate for us. */
    const wifi_promiscuous_filter_t filter = {
        .filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_DATA,
    };
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous_filter(&filter));
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous(true));
    ESP_LOGI(TAG, "promiscuous mode enabled alongside STA association");

    /* While not yet associated we ARE allowed to pin the channel, and doing
     * so means promiscuous capture starts on the right channel immediately
     * instead of wherever the last scan left the radio. */
    const esp_err_t ch_err =
        esp_wifi_set_channel(s_cfg.channel, WIFI_SECOND_CHAN_NONE);
    if (ch_err != ESP_OK) {
        ESP_LOGW(TAG, "esp_wifi_set_channel(%u): %s (harmless if already "
                      "associating)",
                 (unsigned)s_cfg.channel, esp_err_to_name(ch_err));
    }

    ESP_ERROR_CHECK(esp_wifi_get_mac(WIFI_IF_STA, s_own_mac));
    ESP_LOGI(TAG, "own MAC %02x:%02x:%02x:%02x:%02x:%02x", s_own_mac[0],
             s_own_mac[1], s_own_mac[2], s_own_mac[3], s_own_mac[4],
             s_own_mac[5]);

    /* Step 10 (CSI) is csi_capture_start(), called by main.c right after this
     * function returns. Step 11 (connect) is triggered from the STA_START
     * event above, which fires once esp_wifi_start() completes. */
    return ESP_OK;
}

wifi_link_state_t wifi_link_state(void)
{
    return s_state;
}

bool wifi_link_is_connected(void)
{
    return s_state == WIFI_LINK_GOT_IP;
}

uint32_t wifi_link_down_seconds(void)
{
    if (s_down_since_us == 0) {
        return 0;
    }
    const int64_t now = esp_timer_get_time();
    return (uint32_t)((now - s_down_since_us) / 1000000);
}

int8_t wifi_link_rssi(void)
{
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
        return (int8_t)ap.rssi;
    }
    return 0;
}

uint8_t wifi_link_channel(void)
{
    uint8_t primary = 0;
    wifi_second_chan_t second = WIFI_SECOND_CHAN_NONE;
    if (esp_wifi_get_channel(&primary, &second) == ESP_OK) {
        return primary;
    }
    return 0;
}

void wifi_link_own_mac(uint8_t out[6])
{
    memcpy(out, s_own_mac, 6);
}

void wifi_link_ap_bssid(uint8_t out[6])
{
    memcpy(out, s_bssid, 6);
}

void wifi_link_verify_radio(void)
{
    uint8_t primary = 0;
    wifi_second_chan_t second = WIFI_SECOND_CHAN_NONE;
    if (esp_wifi_get_channel(&primary, &second) == ESP_OK) {
        if (primary != s_cfg.channel) {
            ESP_LOGE(TAG,
                     "RADIO OFF-CHANNEL: on %u, expected %u. Every CSI link "
                     "to the other nodes is dead until this is fixed.",
                     (unsigned)primary, (unsigned)s_cfg.channel);
        }
        if (second != WIFI_SECOND_CHAN_NONE) {
            ESP_LOGE(TAG, "secondary channel is %d, expected NONE (20 MHz)",
                     (int)second);
        }
    }

    wifi_bandwidth_t bw = WIFI_BW_HT20;
    if (esp_wifi_get_bandwidth(WIFI_IF_STA, &bw) == ESP_OK
        && bw != WIFI_BW_HT20) {
        ESP_LOGE(TAG, "bandwidth is not HT20 - re-forcing 20 MHz");
        ESP_ERROR_CHECK_WITHOUT_ABORT(
            esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20));
    }

    wifi_ps_type_t ps = WIFI_PS_NONE;
    if (esp_wifi_get_ps(&ps) == ESP_OK && ps != WIFI_PS_NONE) {
        ESP_LOGE(TAG, "power save came back on (%d) - re-forcing WIFI_PS_NONE",
                 (int)ps);
        ESP_ERROR_CHECK_WITHOUT_ABORT(esp_wifi_set_ps(WIFI_PS_NONE));
    }
}
