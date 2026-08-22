/*
 * csi_batcher.h - accumulate CSI records into one CSI_BATCH plaintext.
 *
 * Implements the flush policy of docs/protocol.md S11 verbatim: a batch is
 * flushed as soon as ANY of these is true, whichever comes first -
 *   1. size  : appending the next record would exceed 1156 plaintext bytes
 *   2. count : the batch reached max_records_per_batch
 *   3. time  : flush_time_budget_ms elapsed since the FIRST record currently
 *              in the batch was captured
 *
 * Time is expressed in esp_timer microseconds (monotonic, node-local) and is
 * taken from each record's rx_timestamp_us, not from "now at append time" -
 * the spec anchors the budget to capture time, and that also makes the
 * behaviour deterministic and testable on the host.
 *
 * The plaintext buffer is embedded in the struct: no allocation, and the
 * uplink task owns exactly one of these.
 */
#ifndef CSI_PROTOCOL_CSI_BATCHER_H
#define CSI_PROTOCOL_CSI_BATCHER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "csi_protocol/csi_wire.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    CSI_BATCH_APPENDED = 0,
    /* No room in this batch. The caller must flush and then retry the same
     * record on the fresh batch. */
    CSI_BATCH_FULL = 1,
    /* proto S11: bigger than an otherwise-empty batch could ever carry.
     * Retrying is pointless - drop it and count it under frames_dropped. */
    CSI_BATCH_RECORD_TOO_LARGE = 2,
    CSI_BATCH_ERR_ARG = 3
} csi_batch_result_t;

typedef struct {
    /* Plaintext under construction. The first HCS_BATCH_HEADER_LEN bytes are
     * reserved and only written at finalize(), once record_count is known. */
    uint8_t plaintext[HCS_MAX_PLAINTEXT_LEN];
    size_t used; /* bytes used, always >= HCS_BATCH_HEADER_LEN */
    uint16_t record_count;
    uint64_t first_rx_timestamp_us;

    uint16_t max_records;     /* proto S11 max_records_per_batch */
    uint32_t flush_budget_ms; /* proto S11 flush_time_budget_ms */

    /* Counter for records that can never fit; reported via the heartbeat. */
    uint32_t records_too_large;
} csi_batcher_t;

/* Pass 0 for either parameter to take the documented protocol default. */
void csi_batcher_init(csi_batcher_t *b, uint16_t max_records,
                      uint32_t flush_budget_ms);
void csi_batcher_reset(csi_batcher_t *b);

csi_batch_result_t csi_batcher_append(csi_batcher_t *b,
                                      const hcs_csi_record_t *r);

bool csi_batcher_is_empty(const csi_batcher_t *b);
uint16_t csi_batcher_record_count(const csi_batcher_t *b);
size_t csi_batcher_plaintext_len(const csi_batcher_t *b);

/* True when any of the three S11 triggers has fired. now_mono_us is
 * esp_timer_get_time() on the device. */
bool csi_batcher_flush_due(const csi_batcher_t *b, uint64_t now_mono_us);

/* Write the batch header in place and hand back a borrowed pointer to the
 * complete plaintext. Returns its length. The batcher is NOT reset - the
 * caller resets it after a successful seal so a crypto failure does not lose
 * the batch silently. */
size_t csi_batcher_finalize(csi_batcher_t *b, uint64_t wall_clock_us,
                            uint64_t mono_us, bool sntp_synced,
                            const uint8_t **out_plaintext);

#ifdef __cplusplus
}
#endif

#endif /* CSI_PROTOCOL_CSI_BATCHER_H */
