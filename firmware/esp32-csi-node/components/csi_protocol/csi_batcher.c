/* csi_batcher.c - see csi_batcher.h. Implements docs/protocol.md S11. */

#include "csi_protocol/csi_batcher.h"

#include <string.h>

#include "csi_protocol/csi_codec.h"

void csi_batcher_init(csi_batcher_t *b, uint16_t max_records,
                      uint32_t flush_budget_ms)
{
    if (b == NULL) {
        return;
    }
    memset(b, 0, sizeof(*b));
    b->max_records =
        (max_records == 0u) ? (uint16_t)HCS_DEFAULT_MAX_RECORDS_PER_BATCH
                            : max_records;
    b->flush_budget_ms = (flush_budget_ms == 0u)
                             ? (uint32_t)HCS_DEFAULT_FLUSH_TIME_BUDGET_MS
                             : flush_budget_ms;
    b->used = HCS_BATCH_HEADER_LEN;
}

void csi_batcher_reset(csi_batcher_t *b)
{
    if (b == NULL) {
        return;
    }
    b->used = HCS_BATCH_HEADER_LEN;
    b->record_count = 0u;
    b->first_rx_timestamp_us = 0u;
    /* records_too_large is cumulative-since-boot: deliberately not cleared. */
}

bool csi_batcher_is_empty(const csi_batcher_t *b)
{
    return b == NULL || b->record_count == 0u;
}

uint16_t csi_batcher_record_count(const csi_batcher_t *b)
{
    return (b != NULL) ? b->record_count : 0u;
}

size_t csi_batcher_plaintext_len(const csi_batcher_t *b)
{
    return (b != NULL) ? b->used : 0u;
}

csi_batch_result_t csi_batcher_append(csi_batcher_t *b,
                                      const hcs_csi_record_t *r)
{
    if (b == NULL || r == NULL) {
        return CSI_BATCH_ERR_ARG;
    }

    /* proto S11: a record whose raw CSI cannot fit even in an empty batch is
     * undeliverable by construction. Dropping it is the specified behaviour;
     * retrying would spin forever. */
    if (r->csi_len > HCS_MAX_CSI_LEN_IN_BATCH) {
        b->records_too_large++;
        return CSI_BATCH_RECORD_TOO_LARGE;
    }

    /* Trigger 2 evaluated before appending, so we never exceed the cap. */
    if (b->record_count >= b->max_records) {
        return CSI_BATCH_FULL;
    }

    const size_t need = (size_t)HCS_RECORD_FIXED_LEN + (size_t)r->csi_len;
    /* Trigger 1: size. */
    if (b->used + need > HCS_MAX_PLAINTEXT_LEN) {
        return CSI_BATCH_FULL;
    }

    const size_t written = hcs_record_encode(&b->plaintext[b->used],
                                             HCS_MAX_PLAINTEXT_LEN - b->used, r);
    if (written != need) {
        /* Only reachable on a malformed record (csi_len > 0, csi_data NULL). */
        return CSI_BATCH_ERR_ARG;
    }

    if (b->record_count == 0u) {
        b->first_rx_timestamp_us = r->rx_timestamp_us;
    }
    b->used += written;
    b->record_count++;
    return CSI_BATCH_APPENDED;
}

bool csi_batcher_flush_due(const csi_batcher_t *b, uint64_t now_mono_us)
{
    if (b == NULL || b->record_count == 0u) {
        return false; /* nothing to send; heartbeats are a separate path */
    }
    /* Trigger 2: count. */
    if (b->record_count >= b->max_records) {
        return true;
    }
    /* Trigger 1: size - no further record of any size could be appended. */
    if (b->used + (size_t)HCS_RECORD_FIXED_LEN > HCS_MAX_PLAINTEXT_LEN) {
        return true;
    }
    /* Trigger 3: time budget since the first record in this batch. */
    if (now_mono_us >= b->first_rx_timestamp_us) {
        const uint64_t age_us = now_mono_us - b->first_rx_timestamp_us;
        if (age_us >= (uint64_t)b->flush_budget_ms * 1000ull) {
            return true;
        }
    }
    return false;
}

size_t csi_batcher_finalize(csi_batcher_t *b, uint64_t wall_clock_us,
                            uint64_t mono_us, bool sntp_synced,
                            const uint8_t **out_plaintext)
{
    if (b == NULL) {
        return 0u;
    }
    hcs_batch_header_t bh = {
        .wall_clock_us = wall_clock_us,
        .mono_us = mono_us,
        .sntp_synced = sntp_synced ? 1u : 0u,
        .record_count = b->record_count,
    };
    if (hcs_batch_header_encode(b->plaintext, HCS_MAX_PLAINTEXT_LEN, &bh)
        != HCS_BATCH_HEADER_LEN) {
        return 0u;
    }
    if (out_plaintext != NULL) {
        *out_plaintext = b->plaintext;
    }
    return b->used;
}
