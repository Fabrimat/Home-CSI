/*
 * time_sync.h - SNTP, non-blocking (docs/protocol.md S7).
 *
 * Data must keep flowing before SNTP converges. Every batch carries BOTH a
 * monotonic esp_timer timestamp (always trustworthy, node-local) and a wall
 * clock (only meaningful once synced), plus an explicit sntp_synced flag so
 * the server can down-weight or exclude unsynced records from cross-node
 * alignment. Nothing here ever blocks capture or the uplink.
 */
#ifndef HCS_TIME_SYNC_H
#define HCS_TIME_SYNC_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/* Starts the SNTP client. Call after the link has an IP; safe to call once.
 * Never waits for convergence. */
esp_err_t time_sync_start(const char *server);

/* proto S7: has at least one successful sync happened since boot? */
bool time_sync_is_synced(void);

/* UTC microseconds since the Unix epoch, from the system clock. Meaningless
 * (and flagged as such) until time_sync_is_synced() is true. */
uint64_t time_sync_wall_clock_us(void);

/* Free-running microseconds since boot. Never stepped or adjusted - this is
 * the timestamp downstream code should use for anything within one node. */
uint64_t time_sync_mono_us(void);

#endif /* HCS_TIME_SYNC_H */
