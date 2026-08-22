/*
 * bw_budget.h - hard, configurable on-node cap on how much CSI a node emits.
 *
 * Three mechanisms, all counted:
 *
 *   1. Per-class token buckets on RECORD rate. The two classes exist because
 *      they are worth different amounts: peer/AP soundings are the primary
 *      sensing signal (docs/architecture.md, the broadcast-sounding mesh),
 *      whereas foreign frames from the household's own devices are
 *      best-effort garnish that the ESP32 can only partly decode anyway.
 *      Giving foreign traffic its own small budget stops a chatty neighbour
 *      from crowding out the mesh.
 *
 *   2. A single token bucket on BYTES, applied across both classes, because
 *      the real constraints are uplink bandwidth and airtime, and a record's
 *      csi_len varies by a factor of three between formats.
 *
 *   3. Back-pressure DECIMATION keyed on ring-buffer occupancy. When the
 *      uplink cannot drain the ring, the node deliberately keeps 1 record in
 *      N (N rising with occupancy) so the surviving stream stays evenly
 *      sampled in time. Without this the ring simply overflows and the
 *      dropped records are whichever ones happened to arrive in a burst -
 *      unpredictable, and much worse for downstream feature extraction.
 *      Foreign traffic starts being thinned at a lower occupancy than
 *      soundings do.
 *
 * Every rejection increments a reason-tagged counter; the heartbeat reports
 * the total under frames_dropped (proto S10).
 *
 * Host-compilable, integer-only (no floating point on the hot path).
 */
#ifndef CSI_PROTOCOL_BW_BUDGET_H
#define CSI_PROTOCOL_BW_BUDGET_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    BW_CLASS_SOUNDING = 0, /* peer node soundings + the dedicated AP */
    BW_CLASS_FOREIGN = 1,  /* everything else heard on the channel */
    BW_CLASS_COUNT = 2
} bw_class_t;

typedef enum {
    BW_ADMIT = 0,
    BW_DROP_CLASS_DISABLED = 1, /* class rate configured to 0 */
    BW_DROP_DECIMATED = 2,      /* thinned because the ring is backing up */
    BW_DROP_RECORD_RATE = 3,    /* per-class records/s cap */
    BW_DROP_BYTE_RATE = 4,      /* overall bytes/s cap */
    BW_DECISION_COUNT = 5
} bw_decision_t;

typedef struct {
    uint32_t records_per_sec; /* 0 disables the class entirely */
    uint32_t burst_records;   /* bucket depth; 0 means "one second worth" */
} bw_class_cfg_t;

typedef struct {
    bw_class_cfg_t cls[BW_CLASS_COUNT];

    uint32_t bytes_per_sec; /* 0 = no byte cap */
    uint32_t burst_bytes;   /* 0 means "one second worth" */

    /* Ring occupancy (percent) at which each class starts being thinned. */
    uint8_t decimate_start_pct[BW_CLASS_COUNT];
    /* Occupancy at which the maximum divisor is reached. */
    uint8_t decimate_full_pct;
    /* Keep 1 record in N at/above decimate_full_pct. 1 disables decimation. */
    uint8_t decimate_max_divisor;
} bw_budget_cfg_t;

typedef struct {
    uint64_t tokens_milli; /* 1000 milli-tokens == 1 unit */
    uint64_t cap_milli;
    uint64_t last_us;
    uint32_t rate_per_sec;
} bw_bucket_t;

typedef struct {
    bw_budget_cfg_t cfg;
    bw_bucket_t rec_bucket[BW_CLASS_COUNT];
    bw_bucket_t byte_bucket;
    uint32_t decim_counter[BW_CLASS_COUNT];

    uint32_t admitted[BW_CLASS_COUNT];
    uint32_t dropped[BW_DECISION_COUNT]; /* index by bw_decision_t */
} bw_budget_t;

/* Sensible starting point for a 4-9 node deployment. Tuned for "the mesh
 * always gets through, foreign traffic yields first"; every field is
 * overridable from NVS/Kconfig. */
void bw_budget_default_cfg(bw_budget_cfg_t *cfg);

void bw_budget_init(bw_budget_t *b, const bw_budget_cfg_t *cfg,
                    uint64_t now_us);

/* Decide whether to keep one captured record.
 *   wire_bytes  - HCS_RECORD_FIXED_LEN + csi_len, i.e. what it will cost.
 *   now_us      - monotonic microseconds (esp_timer_get_time()).
 *   ring_pct    - current ring occupancy 0-100 (csi_ring_used_pct()).
 * Consumes budget only when the answer is BW_ADMIT. */
bw_decision_t bw_budget_admit(bw_budget_t *b, bw_class_t cls,
                              uint32_t wire_bytes, uint64_t now_us,
                              uint32_t ring_pct);

/* Current decimation divisor for a class at a given occupancy (1 = keep
 * everything). Exposed for tests and for logging. */
uint32_t bw_budget_divisor(const bw_budget_t *b, bw_class_t cls,
                           uint32_t ring_pct);

uint32_t bw_budget_total_dropped(const bw_budget_t *b);

#ifdef __cplusplus
}
#endif

#endif /* CSI_PROTOCOL_BW_BUDGET_H */
