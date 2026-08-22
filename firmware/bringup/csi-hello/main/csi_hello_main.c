/*
 * csi-hello - the smallest program that proves a board produces CSI.
 *
 * WHAT IT DOES
 *   Joins one AP, turns CSI on, and prints one human-readable line per CSI
 *   callback: timestamp, source MAC, RSSI, signal mode, the format flags,
 *   the raw byte length, and the first few subcarrier amplitudes.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   No crypto, no networking, no ring buffer, no batching, no NVS
 *   provisioning, no LED. When something in the real firmware goes wrong,
 *   this is the tool you fall back to, so it must never be the thing that is
 *   broken. Keep it boring.
 *
 * WHAT THE OUTPUT TELLS YOU
 *   - Lines appearing at all           => the radio, the driver and CSI work.
 *   - `len` values                     => the real CSI record sizes on THIS
 *                                         hardware. Use them to set
 *                                         CONFIG_HCS_CSI_MAX_LEN in the main
 *                                         firmware instead of guessing.
 *   - `sig=0` vs `sig=1`               => non-HT vs HT frames; the main
 *                                         firmware's csi_format mapping is
 *                                         derived from exactly these fields.
 *   - amplitudes changing when you     => the board is actually sensing the
 *     wave your hand in front of it       room, not just receiving packets.
 */

#include <math.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

static const char *TAG = "csi-hello";

static volatile uint32_t s_callbacks;
static volatile uint32_t s_printed;

/* The callback runs in the Wi-Fi task. Printing from here is exactly what the
 * real firmware must NOT do - it is acceptable here only because this app has
 * no other job and losing a few frames to UART latency does not matter. That
 * asymmetry is the whole reason the real firmware has a ring buffer. */
static void csi_cb(void *ctx, wifi_csi_info_t *info)
{
    (void)ctx;
    if (info == NULL || info->buf == NULL || info->len <= 0) {
        return;
    }
    const uint32_t n = ++s_callbacks;
    if ((n % CONFIG_CSIHELLO_PRINT_EVERY_N) != 0u) {
        return;
    }
    s_printed++;

    const wifi_pkt_rx_ctrl_t *rx = &info->rx_ctrl;
    const int8_t *csi = (const int8_t *)info->buf;

    /* Amplitude from the interleaved signed 8-bit I/Q pairs. Amplitude only:
     * ESP32 CSI phase is not usable without heavy sanitisation, which is why
     * the whole pipeline downstream is amplitude-first. */
    char amps[128];
    int off = 0;
    const int pairs = info->len / 2;
    const int want = CONFIG_CSIHELLO_AMPLITUDES;
    for (int i = 0; i < want && i < pairs && off < (int)sizeof(amps) - 8; i++) {
        const int im = csi[2 * i];
        const int re = csi[2 * i + 1];
        const int amp = (int)(sqrtf((float)(re * re + im * im)) + 0.5f);
        off += snprintf(&amps[off], sizeof(amps) - (size_t)off, "%d ", amp);
    }
    amps[off > 0 ? off - 1 : 0] = '\0';

    printf("[%10lld us] src=%02x:%02x:%02x:%02x:%02x:%02x rssi=%4d ch=%2u "
           "sig=%u mcs=%2u bw=%u sec=%u stbc=%u noise=%4d len=%4d amp[0..%d]="
           "%s  (cb=%u printed=%u)\n",
           (long long)esp_timer_get_time(), info->mac[0], info->mac[1],
           info->mac[2], info->mac[3], info->mac[4], info->mac[5],
           (int)rx->rssi, (unsigned)rx->channel, (unsigned)rx->sig_mode,
           (unsigned)rx->mcs, (unsigned)rx->cwb,
           (unsigned)rx->secondary_channel, (unsigned)rx->stbc,
           (int)rx->noise_floor, (int)info->len, want - 1, amps,
           (unsigned)s_callbacks, (unsigned)s_printed);
}

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id,
                          void *data)
{
    (void)arg;
    (void)base;
    (void)data;
    if (id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (id == WIFI_EVENT_STA_DISCONNECTED) {
        ESP_LOGW(TAG, "disconnected, retrying in 2 s");
        vTaskDelay(pdMS_TO_TICKS(2000));
        esp_wifi_connect();
    } else if (id == WIFI_EVENT_STA_CONNECTED) {
        uint8_t primary = 0;
        wifi_second_chan_t second = WIFI_SECOND_CHAN_NONE;
        esp_wifi_get_channel(&primary, &second);
        ESP_LOGI(TAG, "associated; operating on channel %u (secondary %d)",
                 (unsigned)primary, (int)second);
    }
}

void app_main(void)
{
    printf("\n=== csi-hello: does this board produce CSI? ===\n");

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES
        || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi_event, NULL, NULL));

    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));

    wifi_config_t wc;
    memset(&wc, 0, sizeof wc);
    strncpy((char *)wc.sta.ssid, CONFIG_CSIHELLO_WIFI_SSID,
            sizeof(wc.sta.ssid) - 1);
    strncpy((char *)wc.sta.password, CONFIG_CSIHELLO_WIFI_PASSWORD,
            sizeof(wc.sta.password) - 1);
    wc.sta.channel = CONFIG_CSIHELLO_CHANNEL_HINT;
    wc.sta.threshold.authmode = WIFI_AUTH_OPEN;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));

    /* 20 MHz, so the CSI layout matches what the real deployment will see. */
    ESP_ERROR_CHECK(esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20));

    ESP_ERROR_CHECK(esp_wifi_start());

    /* Everything below must come AFTER esp_wifi_start(). If CSI never fires,
     * the first thing to check is that this order was not disturbed. */
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));

    /* Promiscuous mode: without it you only get CSI for frames addressed to
     * this station, which on a quiet network is almost nothing. */
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous(true));

    wifi_csi_config_t csi_cfg;
    memset(&csi_cfg, 0, sizeof csi_cfg);
    csi_cfg.lltf_en = true;
    csi_cfg.htltf_en = true;
    csi_cfg.stbc_htltf2_en = true;
    csi_cfg.ltf_merge_en = false;
    csi_cfg.channel_filter_en = false;
    csi_cfg.manu_scale = false;
    ESP_ERROR_CHECK(esp_wifi_set_csi_config(&csi_cfg));
    ESP_ERROR_CHECK(esp_wifi_set_csi_rx_cb(csi_cb, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_csi(true));

    uint8_t mac[6] = { 0 };
    esp_wifi_get_mac(WIFI_IF_STA, mac);
    printf("STA MAC: %02x:%02x:%02x:%02x:%02x:%02x   <-- record this in the "
           "bring-up table\n",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    printf("Joining SSID '%s'. Waiting for CSI callbacks...\n\n",
           CONFIG_CSIHELLO_WIFI_SSID);

    uint32_t last = 0;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(5000));
        const uint32_t now = s_callbacks;
        if (now == last) {
            ESP_LOGW(TAG,
                     "no CSI callbacks in the last 5 s (total %u). Checklist: "
                     "associated? CONFIG_ESP_WIFI_CSI_ENABLED set? any 2.4 "
                     "GHz traffic on this channel at all? try pinging the AP "
                     "from another device.",
                     (unsigned)now);
        } else {
            ESP_LOGI(TAG, "CSI rate: %u callbacks in 5 s (total %u)",
                     (unsigned)(now - last), (unsigned)now);
        }
        last = now;
    }
}
