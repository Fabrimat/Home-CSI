/*
 * sounding.h - periodic BROADCAST frames so every other node gets a CSI
 * sample of this node's link, for free.
 *
 * This is the cheapest sensitivity multiplier in the whole system: with N
 * nodes, one broadcast per node per interval yields N*(N-1) directional
 * node-to-node links plus N node-to-AP links, at the airtime cost of N tiny
 * frames. See docs/architecture.md, "the broadcast-sounding mesh".
 */
#ifndef HCS_SOUNDING_H
#define HCS_SOUNDING_H

#include <stdint.h>

#include "esp_err.h"

#include "node_config.h"

typedef struct {
    uint32_t sent;
    uint32_t failed;
} sounding_stats_t;

/* Starts the sounding task. Safe to call before association: transmissions
 * simply fail and are counted until the link is up. */
esp_err_t sounding_start(const node_config_t *cfg);

void sounding_get_stats(sounding_stats_t *out);

/* Changes the broadcast interval at runtime (main/mode_client.c switching
 * between normal and server-proposed realtime rates, and back on expiry).
 * Jitter percentage is untouched. Takes effect on the task's next scheduled
 * wake - there is no lock, matching this codebase's existing convention for
 * cross-task config fields (e.g. net_uplink's stats structs); a plain
 * uint32_t store is as atomic as this needs. A value of 0 disables sounding
 * entirely, same as passing 0 at sounding_start(). */
void sounding_set_interval_ms(uint32_t interval_ms);

#endif /* HCS_SOUNDING_H */
