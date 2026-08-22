/*
 * csi_capture.h - CSI callback -> ring buffer. Nothing else.
 *
 * The callback runs in the Wi-Fi task. Its entire job is: filter cheaply,
 * ask the bandwidth budget, memcpy into the ring, return. No allocation, no
 * logging, no locks, no crypto, no sockets.
 */
#ifndef HCS_CSI_CAPTURE_H
#define HCS_CSI_CAPTURE_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#include "csi_protocol/bw_budget.h"
#include "csi_protocol/csi_ring.h"
#include "node_config.h"

typedef struct {
    uint32_t frames_seen;      /* every CSI callback invocation */
    uint32_t dropped_rssi;     /* below the configured RSSI floor */
    uint32_t dropped_notallow; /* source MAC not in the allowlist */
    uint32_t dropped_budget;   /* refused by bandwidth_budget */
    uint32_t dropped_ring;     /* ring full or payload oversize */
    uint32_t admitted;         /* copied into the ring */
} csi_capture_stats_t;

/* Configures and enables CSI. MUST be called after wifi_link_start() (i.e.
 * after esp_wifi_start() and after promiscuous mode is on) - see the ordering
 * comment at the top of wifi_link.c. */
esp_err_t csi_capture_start(const node_config_t *cfg);

/* The ring the uplink task drains. Valid after csi_capture_start(). */
csi_ring_t *csi_capture_ring(void);

void csi_capture_get_stats(csi_capture_stats_t *out);

/* Cumulative frames captured / dropped for the heartbeat (proto S10). */
uint32_t csi_capture_frames_captured(void);
uint32_t csi_capture_frames_dropped(void);

/* Snapshot of the budget counters, for logging and diagnosis. */
const bw_budget_t *csi_capture_budget(void);

#endif /* HCS_CSI_CAPTURE_H */
