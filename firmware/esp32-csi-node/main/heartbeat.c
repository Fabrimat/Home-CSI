/* heartbeat.c - see heartbeat.h. */

#include "heartbeat.h"

#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"

#include "app_version.h"
#include "csi_capture.h"
#include "sounding.h"
#include "time_sync.h"
#include "wifi_link.h"

static const char *TAG = "heartbeat";

void heartbeat_build(hcs_heartbeat_t *out, uint32_t batches_sent,
                     uint32_t send_failures, uint32_t extra_dropped)
{
    if (out == NULL) {
        return;
    }
    memset(out, 0, sizeof(*out));

    out->uptime_s = (uint32_t)(esp_timer_get_time() / 1000000ll);
    out->free_heap_bytes = (uint32_t)esp_get_free_heap_size();
    out->min_free_heap_bytes = (uint32_t)esp_get_minimum_free_heap_size();
    out->frames_captured = csi_capture_frames_captured();
    out->frames_dropped = csi_capture_frames_dropped() + extra_dropped;
    out->batches_sent = batches_sent;
    out->send_failures = send_failures;
    out->rssi_to_ap = wifi_link_rssi();
    out->channel = wifi_link_channel();
    out->sntp_synced = time_sync_is_synced() ? 1u : 0u;
    out->fw_version_major = HCS_FW_VERSION_MAJOR;
    out->fw_version_minor = HCS_FW_VERSION_MINOR;
    out->fw_version_patch = HCS_FW_VERSION_PATCH;
}

void heartbeat_log(const hcs_heartbeat_t *hb)
{
    if (hb == NULL) {
        return;
    }
    csi_capture_stats_t cs;
    csi_capture_get_stats(&cs);
    sounding_stats_t ss;
    sounding_get_stats(&ss);
    const bw_budget_t *bw = csi_capture_budget();
    const csi_ring_t *ring = csi_capture_ring();

    ESP_LOGI(TAG,
             "up=%us heap=%u/%u rssi=%d ch=%u sntp=%u | seen=%u kept=%u "
             "drop=%u | batches=%u sendfail=%u | fw=%u.%u.%u",
             (unsigned)hb->uptime_s, (unsigned)hb->free_heap_bytes,
             (unsigned)hb->min_free_heap_bytes, (int)hb->rssi_to_ap,
             (unsigned)hb->channel, (unsigned)hb->sntp_synced,
             (unsigned)cs.frames_seen, (unsigned)cs.admitted,
             (unsigned)hb->frames_dropped, (unsigned)hb->batches_sent,
             (unsigned)hb->send_failures, (unsigned)hb->fw_version_major,
             (unsigned)hb->fw_version_minor, (unsigned)hb->fw_version_patch);

    /* The wire payload only has room for a single frames_dropped total, so
     * the breakdown - which is what you actually need to tune a node - lives
     * here on the console. */
    ESP_LOGI(TAG,
             "  drops: rssi=%u notallow=%u budget=%u ring=%u "
             "(ring full=%u oversize=%u, high water %u/%u)",
             (unsigned)cs.dropped_rssi, (unsigned)cs.dropped_notallow,
             (unsigned)cs.dropped_budget, (unsigned)cs.dropped_ring,
             (unsigned)ring->drops_full, (unsigned)ring->drops_oversize,
             (unsigned)ring->high_water, (unsigned)ring->capacity);
    ESP_LOGI(TAG,
             "  budget: admit snd=%u frn=%u | drop disabled=%u decimated=%u "
             "recrate=%u byterate=%u",
             (unsigned)bw->admitted[BW_CLASS_SOUNDING],
             (unsigned)bw->admitted[BW_CLASS_FOREIGN],
             (unsigned)bw->dropped[BW_DROP_CLASS_DISABLED],
             (unsigned)bw->dropped[BW_DROP_DECIMATED],
             (unsigned)bw->dropped[BW_DROP_RECORD_RATE],
             (unsigned)bw->dropped[BW_DROP_BYTE_RATE]);
    ESP_LOGI(TAG, "  sounding: sent=%u failed=%u", (unsigned)ss.sent,
             (unsigned)ss.failed);
}
