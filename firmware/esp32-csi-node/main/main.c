/*
 * main.c - startup order, task creation, watchdog and recovery policy.
 *
 * ============================== STARTUP ORDER ============================
 *   1. NVS               - everything else reads config from it
 *   2. node_config       - and log which source (NVS/Kconfig) won per field
 *   3. boot_epoch        - persisted BEFORE a single datagram can be sent,
 *                          so a crash cannot cause an epoch to be reused
 *   4. status_led        - as early as possible, so a failure after this
 *                          point is visible without a serial cable
 *   5. wifi_link         - netif, event loop, STA, PS_NONE, HT20, promiscuous
 *   6. csi_capture       - CSI config + callback + enable (must be after 5)
 *   7. time_sync         - non-blocking; capture never waits for it
 *   8. sounding          - broadcast mesh transmitter
 *   9. net_uplink        - consumer task; owns the shared seq counter
 *  10. ota              - LAST, on purpose. It is the only optional
 *                          subsystem, and its post-update health checkpoint
 *                          waits for (9) to have sent a heartbeat, so
 *                          starting it any earlier would only block sooner
 *  11. supervisor loop   - this task; feeds the WDT and applies the recovery
 *                          policy below
 *
 * ============================ RECOVERY POLICY ============================
 * Three distinct failure classes, three distinct responses:
 *
 *   RECONNECT (no reboot): the AP went away, DNS failed, a send failed.
 *     wifi_link retries with exponential backoff + jitter; net_uplink
 *     re-resolves and re-opens its socket with its own backoff. The node
 *     keeps capturing throughout - CSI does not need the internet.
 *
 *   REBOOT (esp_restart), for states a running node cannot recover from:
 *     a) Wi-Fi down continuously for CONFIG_HCS_RECONNECT_REBOOT_S. A driver
 *        or DHCP state machine that has wedged is not going to un-wedge; a
 *        reboot is cheap and a dark node is not.
 *     b) sequence space exhausted. Refusing to wrap is what keeps the AEAD
 *        nonce unique; only a reboot (which bumps boot_epoch) gives us a
 *        fresh sequence space.
 *
 *   PANIC-REBOOT via the task watchdog, for tasks that stop turning:
 *     the uplink task and this supervisor both subscribe. With
 *     CONFIG_ESP_TASK_WDT_PANIC=y a starved task panics and reboots the
 *     chip, which is the correct outcome for a headless sensor.
 *
 *   REFUSE TO SEND (but stay alive and loud): missing PSK/node_id/server.
 *     The node boots, logs exactly what is missing, shows LED_STATE_ERROR
 *     and keeps its console usable so it can be diagnosed in place. It does
 *     NOT reboot-loop, because a reboot loop hides the message.
 * =========================================================================
 */

#include <string.h>

#include "esp_err.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#include "app_version.h"
#include "boot_epoch.h"
#include "crypto.h"
#include "csi_capture.h"
#include "heartbeat.h"
#include "net_uplink.h"
#include "node_config.h"
#include "ota.h"
#include "sounding.h"
#include "status_led.h"
#include "time_sync.h"
#include "wifi_link.h"

static const char *TAG = "main";

static node_config_t s_cfg;

static esp_err_t init_nvs(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES
        || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        /* Corrupt or from a newer NVS format. Erasing is the only way
         * forward, but it destroys the provisioned identity AND the boot
         * epoch, so say so as loudly as a log line can. */
        ESP_LOGE(TAG,
                 "NVS is unusable (%s) and is being ERASED. This wipes the "
                 "node's provisioned identity (node_id, PSK, server) and its "
                 "boot epoch. Re-run tools/provision.py, and clear this "
                 "node's replay state on the server (or give it a new "
                 "node_id) per docs/protocol.md S6.",
                 esp_err_to_name(err));
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    return err;
}

static void supervisor_loop(void)
{
    const esp_err_t wdt = esp_task_wdt_add(NULL);
    if (wdt != ESP_OK) {
        ESP_LOGW(TAG, "esp_task_wdt_add(main): %s", esp_err_to_name(wdt));
    }

    uint32_t tick = 0;
    for (;;) {
        esp_task_wdt_reset();

        /* Every 10 s: confirm the radio is still where we pinned it. A
         * channel or bandwidth drift kills every link in the mesh, and it is
         * completely invisible unless you look. */
        if ((tick % 10u) == 0u && wifi_link_state() >= WIFI_LINK_CONNECTED) {
            wifi_link_verify_radio();
        }

        /* Recovery (a): the link has been down too long to be transient. */
        const uint32_t down_s = wifi_link_down_seconds();
        if (s_cfg.reconnect_reboot_s != 0 && down_s >= s_cfg.reconnect_reboot_s) {
            ESP_LOGE(TAG, "Wi-Fi down for %u s (limit %u) - rebooting",
                     (unsigned)down_s, (unsigned)s_cfg.reconnect_reboot_s);
            vTaskDelay(pdMS_TO_TICKS(200)); /* let the log drain */
            esp_restart();
        }

        /* Recovery (b): sequence exhaustion. Only a reboot gives a new
         * boot_epoch, and only a new boot_epoch gives fresh nonces. */
        net_uplink_stats_t us;
        net_uplink_get_stats(&us);
        if (us.seq_exhausted > 0) {
            ESP_LOGE(TAG, "sequence space exhausted - rebooting to obtain a "
                          "fresh boot_epoch");
            vTaskDelay(pdMS_TO_TICKS(200));
            esp_restart();
        }

        /* Start SNTP as soon as there is a route, and not before. */
        if (wifi_link_is_connected()) {
            (void)time_sync_start(s_cfg.sntp_server);
        }

        tick++;
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

/* Config is unusable: stay up, stay loud, stay diagnosable. */
static void misconfigured_loop(const char *why)
{
    status_led_set(LED_STATE_ERROR);
    const esp_err_t wdt = esp_task_wdt_add(NULL);
    (void)wdt;
    for (;;) {
        esp_task_wdt_reset();
        ESP_LOGE(TAG,
                 "NODE NOT DEPLOYABLE: %s. Provision it with "
                 "firmware/esp32-csi-node/tools/provision.py, or set the "
                 "bench fallbacks in menuconfig. Not rebooting, so this "
                 "message stays readable.",
                 why);
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "Home CSI node firmware v%u.%u.%u starting",
             HCS_FW_VERSION_MAJOR, HCS_FW_VERSION_MINOR, HCS_FW_VERSION_PATCH);

    /* 1 */
    ESP_ERROR_CHECK(init_nvs());

    /* 2 */
    ESP_ERROR_CHECK(node_config_load(&s_cfg));
    node_config_log(&s_cfg);

    /* 4 (early, so everything after this is visible without a console) */
    status_led_init();
    status_led_set(LED_STATE_BOOTING);

    const char *why = NULL;
    if (!node_config_is_deployable(&s_cfg, &why)) {
        misconfigured_loop(why);
        return; /* not reached */
    }

    /* 3 - before anything can send. */
    uint32_t boot_epoch = 0;
    const esp_err_t eerr = boot_epoch_begin(&boot_epoch);
    if (eerr != ESP_OK) {
        misconfigured_loop("boot epoch could not be established or persisted "
                           "(see the boot_epoch log lines above)");
        return; /* not reached */
    }

    /* 5 */
    status_led_set(LED_STATE_CONNECTING);
    ESP_ERROR_CHECK(wifi_link_start(&s_cfg));

    /* 6 - must follow 5; see the ordering comment in wifi_link.c. */
    ESP_ERROR_CHECK(csi_capture_start(&s_cfg));

    /* 7 - fire and forget; retried from the supervisor once there is a route.
     * Capture and batching run happily with sntp_synced = 0. */
    (void)time_sync_start(s_cfg.sntp_server);

    /* 8 */
    ESP_ERROR_CHECK(sounding_start(&s_cfg));

    /* 9 */
    ESP_ERROR_CHECK(net_uplink_start(&s_cfg, boot_epoch));

    /* 10 - deliberately NOT ESP_ERROR_CHECK'd beyond task creation: a node
     * that cannot auto-update is still a node that captures CSI, and OTA must
     * never be a reason to refuse to run. ota_start() logs its own reason if
     * api_base is missing. */
    (void)ota_start(&s_cfg);

    ESP_LOGI(TAG, "startup complete; supervisor running");

    /* 11 */
    supervisor_loop();
}
