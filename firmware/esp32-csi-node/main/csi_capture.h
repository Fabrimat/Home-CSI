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
    uint32_t dropped_invalid;  /* first_word_invalid left nothing usable */
    uint32_t first_word_invalid; /* wifi_csi_info_t.first_word_invalid was
                                   * set (see csi_rx_cb()); counted whether or
                                   * not the record survived it - most do, at
                                   * 4 bytes shorter than the driver's raw
                                   * len */
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

/* Replaces the live bandwidth budget config (main/mode_client.c switching
 * between normal and server-proposed realtime rates, and back on expiry).
 * See bw_budget_reconfigure() - existing bucket state is preserved, only
 * clamped down to whatever the new config's caps allow, so a mode switch
 * itself can never manufacture a free burst.
 *
 * NOT ATOMIC WITH RESPECT TO THE CSI CALLBACK, AND THAT IS DELIBERATE, NOT
 * AN OVERSIGHT. This is called from the mode-client task while csi_rx_cb()
 * (the Wi-Fi task) concurrently reads and writes the same s_budget, with no
 * lock between them. Two things in there are genuinely not single, tearing-
 * free operations on a 32-bit target: bw_bucket_t's tokens_milli/cap_milli/
 * last_us are uint64_t (a 32-bit core stores/loads one in two 32-bit words,
 * so a concurrent reader can observe a torn value), and `b->cfg = new_cfg`
 * is a whole bw_budget_cfg_t struct copy, not a field write, so a concurrent
 * reader of b->cfg can see a mix of old and new fields.
 *
 * This is acceptable, not merely tolerated, because of what bucket_refill()
 * does with whatever it reads: it re-derives tokens from elapsed time and
 * immediately re-clamps the result to cap_milli, every single call. A torn
 * tokens_milli/cap_milli resolves to exactly the old or exactly the new
 * value in practice - every value either field can hold under this
 * project's Kconfig ranges fits in 32 bits, so a torn 64-bit read can only
 * ever combine a zero high word with one or the other half, never a third,
 * bogus number. last_us is a genuine 64-bit microsecond count that outgrows
 * 32 bits after about 71 minutes of uptime, so a torn read of IT, on the
 * astronomically rare occasion a race lands on exactly that rollover, can
 * make bucket_refill() see a huge bogus elapsed time - but the very next
 * line clamps the result to cap_milli regardless, so the worst case is one
 * bucket topping up to its own configured cap early (a single unearned
 * refill, self-correcting the moment the next legitimate refill runs), not
 * an unbounded or growing error.
 *
 * A mixed b->cfg needs a different argument, because admission really does
 * read b->cfg directly - five fields of it: cls[cls].records_per_sec
 * (bw_budget.c:136), bytes_per_sec (:160), and decimate_max_divisor /
 * decimate_start_pct[cls] / decimate_full_pct, read by bw_budget_divisor()
 * (:108, :112-113) which admit() calls at :144. `b->cfg = new_cfg` (:207)
 * is a whole-struct copy rather than one atomic store, so a concurrent
 * reader can genuinely see some of those fields old and some new. What bounds it is that none of the five
 * is used as a MAGNITUDE on this path:
 *   - records_per_sec and bytes_per_sec are only ever compared against
 *     zero here. However a mixed or torn read comes out, it comes out as
 *     "on" or "off" - possibly as neither config's answer, but always a
 *     bare boolean that at worst misroutes one record, never a bogus rate
 *     that anything downstream then meters against.
 *   - the three decimation fields feed bw_budget_divisor(), whose own
 *     guards (maxdiv <= 1, ring_pct <= start, full <= start, ring_pct >=
 *     full, and a round-up that cannot exceed maxdiv) hold the result in
 *     [1, decimate_max_divisor] with no division by zero for ANY
 *     combination of the three - not merely for old/new mixtures. Worst
 *     case is a keep-1-in-N that belongs to neither config for an instant.
 * The numbers that actually meter the stream - rate_per_sec, cap_milli,
 * tokens_milli - are not in b->cfg at all: bucket_reconfigure() writes them
 * from a private, non-shared `new_cfg` local (:210-214), never from b->cfg,
 * so no bucket ever holds a half-installed value.
 *
 * b->cfg and the buckets ARE transiently inconsistent with each other,
 * though, and that is the real window: bw_budget_reconfigure() installs
 * b->cfg (:207) before it reconfigures the buckets (:209-214), so for those
 * few instructions the callback can gate on the new config while spending
 * tokens the old one earned. That is bounded by the old bucket's cap - a
 * ceiling this node was already permitted to emit at.
 *
 * Net effect of any of the above: at most a handful of records misadmitted
 * or misrejected around the exact instant of a reconfigure - never memory
 * corruption (every array index on the admission path is bounds-checked
 * against BW_CLASS_COUNT and none of them comes out of cfg), never a
 * desynchronised batch, and never a sustained rate beyond whichever of the
 * old/new ceilings was momentarily still in effect. Good enough for a rate
 * limiter; NOT a property to build anything stronger on without adding real
 * synchronisation first. */
void csi_capture_reconfigure_bw(const bw_budget_cfg_t *cfg);

#endif /* HCS_CSI_CAPTURE_H */
