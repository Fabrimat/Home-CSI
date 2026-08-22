/* time_sync.c - see time_sync.h. */

#include "time_sync.h"

#include <string.h>
#include <sys/time.h>

#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "esp_sntp.h"
#include "esp_timer.h"

static const char *TAG = "time_sync";

static volatile bool s_synced;
static bool s_started;

static void on_sync(struct timeval *tv)
{
    (void)tv;
    if (!s_synced) {
        ESP_LOGI(TAG, "SNTP converged; wall clock is now usable for "
                      "cross-node alignment");
    }
    s_synced = true;
}

esp_err_t time_sync_start(const char *server)
{
    if (s_started) {
        return ESP_OK;
    }
    const char *srv = (server != NULL && server[0] != '\0') ? server
                                                            : "pool.ntp.org";

    /* esp_netif_sntp_* is the IDF v5 wrapper. It starts a background task and
     * returns immediately; we deliberately never call
     * esp_netif_sntp_sync_wait(), because blocking startup on the internet
     * would mean a node with a broken uplink captures nothing at all. */
    esp_sntp_config_t cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG(srv);
    cfg.start = true;
    cfg.server_from_dhcp = false;
    cfg.sync_cb = on_sync;
    /* Smooth adjustment would keep the clock monotonic but converges too
     * slowly from a cold (1970) start; a step is correct here, and it is
     * exactly why the protocol also carries a monotonic timestamp. */
    cfg.smooth_sync = false;

    const esp_err_t err = esp_netif_sntp_init(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_netif_sntp_init(%s): %s", srv, esp_err_to_name(err));
        return err;
    }
    s_started = true;
    ESP_LOGI(TAG, "SNTP started against %s (capture is NOT gated on this)",
             srv);
    return ESP_OK;
}

bool time_sync_is_synced(void)
{
    return s_synced;
}

uint64_t time_sync_wall_clock_us(void)
{
    struct timeval tv;
    if (gettimeofday(&tv, NULL) != 0) {
        return 0;
    }
    return (uint64_t)tv.tv_sec * 1000000ull + (uint64_t)tv.tv_usec;
}

uint64_t time_sync_mono_us(void)
{
    return (uint64_t)esp_timer_get_time();
}
