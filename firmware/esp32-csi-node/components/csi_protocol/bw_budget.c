/* bw_budget.c - see bw_budget.h. Integer-only token buckets + decimation. */

#include "csi_protocol/bw_budget.h"

#include <string.h>

#define MILLI 1000ull

void bw_budget_default_cfg(bw_budget_cfg_t *cfg)
{
    if (cfg == NULL) {
        return;
    }
    memset(cfg, 0, sizeof(*cfg));

    /* ~50 sounding-derived records/s per node. With 4 nodes that is the
     * node's own AP link plus 3 peer links; at 9 nodes the mesh gets denser
     * but the per-node emission stays capped here, which is the point. */
    cfg->cls[BW_CLASS_SOUNDING].records_per_sec = 50;
    cfg->cls[BW_CLASS_SOUNDING].burst_records = 100;

    /* Foreign frames are garnish: a small trickle, never a flood. */
    cfg->cls[BW_CLASS_FOREIGN].records_per_sec = 5;
    cfg->cls[BW_CLASS_FOREIGN].burst_records = 20;

    /* 32 kB/s of plaintext record bytes ~= 260 kbit/s before crypto and
     * UDP/IP overhead. Comfortably inside a home uplink even with 9 nodes. */
    cfg->bytes_per_sec = 32768;
    cfg->burst_bytes = 65536;

    /* Foreign traffic yields first, soundings only under real pressure. */
    cfg->decimate_start_pct[BW_CLASS_FOREIGN] = 40;
    cfg->decimate_start_pct[BW_CLASS_SOUNDING] = 70;
    cfg->decimate_full_pct = 95;
    cfg->decimate_max_divisor = 8;
}

static void bucket_init(bw_bucket_t *bk, uint32_t rate_per_sec, uint32_t burst,
                        uint64_t now_us)
{
    bk->rate_per_sec = rate_per_sec;
    const uint32_t depth = (burst != 0u) ? burst : rate_per_sec;
    bk->cap_milli = (uint64_t)depth * MILLI;
    bk->tokens_milli = bk->cap_milli; /* start full: allow an initial burst */
    bk->last_us = now_us;
}

/* Each bucket keeps its own last_us so that a bucket whose refill rounds down
 * to zero this tick does not lose the elapsed time to a faster neighbour. */
static void bucket_refill(bw_bucket_t *bk, uint64_t now_us)
{
    if (bk->rate_per_sec == 0u || now_us <= bk->last_us) {
        return;
    }
    const uint64_t elapsed_us = now_us - bk->last_us;
    /* rate/s * elapsed_us / 1e6 units == rate * elapsed_us / 1000 milli. */
    const uint64_t add_milli = ((uint64_t)bk->rate_per_sec * elapsed_us) / MILLI;
    if (add_milli == 0u) {
        return; /* keep last_us so the remainder accumulates */
    }
    bk->tokens_milli += add_milli;
    if (bk->tokens_milli > bk->cap_milli) {
        bk->tokens_milli = bk->cap_milli;
    }
    bk->last_us = now_us;
}

static bool bucket_has(const bw_bucket_t *bk, uint64_t units)
{
    return bk->tokens_milli >= units * MILLI;
}

static void bucket_take(bw_bucket_t *bk, uint64_t units)
{
    const uint64_t cost = units * MILLI;
    bk->tokens_milli = (bk->tokens_milli > cost) ? (bk->tokens_milli - cost) : 0u;
}

void bw_budget_init(bw_budget_t *b, const bw_budget_cfg_t *cfg,
                    uint64_t now_us)
{
    if (b == NULL) {
        return;
    }
    memset(b, 0, sizeof(*b));
    if (cfg != NULL) {
        b->cfg = *cfg;
    } else {
        bw_budget_default_cfg(&b->cfg);
    }
    if (b->cfg.decimate_max_divisor == 0u) {
        b->cfg.decimate_max_divisor = 1u;
    }
    for (int i = 0; i < BW_CLASS_COUNT; i++) {
        bucket_init(&b->rec_bucket[i], b->cfg.cls[i].records_per_sec,
                    b->cfg.cls[i].burst_records, now_us);
    }
    bucket_init(&b->byte_bucket, b->cfg.bytes_per_sec, b->cfg.burst_bytes,
                now_us);
}

uint32_t bw_budget_divisor(const bw_budget_t *b, bw_class_t cls,
                           uint32_t ring_pct)
{
    if (b == NULL || cls >= BW_CLASS_COUNT) {
        return 1u;
    }
    const uint32_t maxdiv = b->cfg.decimate_max_divisor;
    if (maxdiv <= 1u) {
        return 1u;
    }
    const uint32_t start = b->cfg.decimate_start_pct[cls];
    const uint32_t full = b->cfg.decimate_full_pct;
    if (ring_pct <= start) {
        return 1u;
    }
    if (full <= start || ring_pct >= full) {
        return maxdiv;
    }
    /* Round UP, so that crossing the start threshold at all immediately
     * halves the class rather than doing nothing for another 10 percent. */
    const uint32_t span = full - start;
    const uint32_t over = ring_pct - start;
    const uint32_t extra = (((maxdiv - 1u) * over) + (span - 1u)) / span;
    return 1u + extra;
}

bw_decision_t bw_budget_admit(bw_budget_t *b, bw_class_t cls,
                              uint32_t wire_bytes, uint64_t now_us,
                              uint32_t ring_pct)
{
    if (b == NULL || cls >= BW_CLASS_COUNT) {
        return BW_DROP_CLASS_DISABLED;
    }

    if (b->cfg.cls[cls].records_per_sec == 0u) {
        b->dropped[BW_DROP_CLASS_DISABLED]++;
        return BW_DROP_CLASS_DISABLED;
    }

    /* Decimation first: it is the cheapest check and it is what keeps the
     * surviving stream evenly spaced in time. The counter advances on every
     * offered record so the "keep 1 in N" pattern is deterministic. */
    const uint32_t divisor = bw_budget_divisor(b, cls, ring_pct);
    const uint32_t tick = b->decim_counter[cls]++;
    if (divisor > 1u && (tick % divisor) != 0u) {
        b->dropped[BW_DROP_DECIMATED]++;
        return BW_DROP_DECIMATED;
    }

    bucket_refill(&b->rec_bucket[cls], now_us);
    bucket_refill(&b->byte_bucket, now_us);

    /* Check both buckets before consuming either, so a record refused on
     * bytes does not silently burn a record token (and vice versa). */
    if (!bucket_has(&b->rec_bucket[cls], 1u)) {
        b->dropped[BW_DROP_RECORD_RATE]++;
        return BW_DROP_RECORD_RATE;
    }
    const bool byte_capped = (b->cfg.bytes_per_sec != 0u);
    if (byte_capped && !bucket_has(&b->byte_bucket, wire_bytes)) {
        b->dropped[BW_DROP_BYTE_RATE]++;
        return BW_DROP_BYTE_RATE;
    }

    bucket_take(&b->rec_bucket[cls], 1u);
    if (byte_capped) {
        bucket_take(&b->byte_bucket, wire_bytes);
    }
    b->admitted[cls]++;
    return BW_ADMIT;
}

uint32_t bw_budget_total_dropped(const bw_budget_t *b)
{
    if (b == NULL) {
        return 0u;
    }
    uint32_t total = 0u;
    for (int i = 1; i < BW_DECISION_COUNT; i++) {
        total += b->dropped[i];
    }
    return total;
}
