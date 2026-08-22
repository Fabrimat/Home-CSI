/* Batch accumulation and the three flush triggers of docs/protocol.md S11:
 * size, record count, and time budget - whichever comes first.
 */
#include "harness.h"

#include "csi_protocol/csi_batcher.h"
#include "csi_protocol/csi_codec.h"

/* Big enough for the largest record the protocol allows, so the encoder can
 * legitimately read csi_len bytes out of it. */
static uint8_t g_csi[HCS_MAX_CSI_LEN_IN_BATCH + 8];

static hcs_csi_record_t rec(uint16_t csi_len, uint64_t rx_ts)
{
    hcs_csi_record_t r;
    memset(&r, 0, sizeof r);
    r.mcs = HCS_MCS_NOT_APPLICABLE;
    r.csi_format = HCS_CSI_FORMAT_LLTF;
    r.csi_len = csi_len;
    r.csi_data = g_csi;
    r.rx_timestamp_us = rx_ts;
    return r;
}

static void test_empty_batch_finalizes_to_header_only(void)
{
    csi_batcher_t b;
    csi_batcher_init(&b, 16, 200);
    CHECK(csi_batcher_is_empty(&b));
    CHECK_EQ_U64(csi_batcher_plaintext_len(&b), HCS_BATCH_HEADER_LEN);

    const uint8_t *pt = NULL;
    size_t n = csi_batcher_finalize(&b, 1234, 5678, true, &pt);
    CHECK_EQ_U64(n, HCS_BATCH_HEADER_LEN);
    CHECK(pt != NULL);
    if (pt) {
        CHECK_EQ_U64(hcs_get_u64le(&pt[0]), 1234);
        CHECK_EQ_U64(hcs_get_u64le(&pt[8]), 5678);
        CHECK_EQ_U64(pt[16], 1);
        CHECK_EQ_U64(pt[17], 0);
        CHECK_EQ_U64(pt[18], 0);
        CHECK_EQ_U64(pt[19], 0);
        CHECK_EQ_U64(hcs_get_u16le(&pt[20]), 0);
    }
}

static void test_append_grows_plaintext_and_count(void)
{
    csi_batcher_t b;
    csi_batcher_init(&b, 16, 200);
    hcs_csi_record_t r = rec(4, 100);
    CHECK_EQ_I64(csi_batcher_append(&b, &r), CSI_BATCH_APPENDED);
    CHECK_EQ_U64(csi_batcher_record_count(&b), 1);
    CHECK_EQ_U64(csi_batcher_plaintext_len(&b),
                 HCS_BATCH_HEADER_LEN + HCS_RECORD_FIXED_LEN + 4);
    CHECK(!csi_batcher_is_empty(&b));

    const uint8_t *pt = NULL;
    size_t n = csi_batcher_finalize(&b, 1, 2, false, &pt);
    CHECK_EQ_U64(n, HCS_BATCH_HEADER_LEN + HCS_RECORD_FIXED_LEN + 4);
    if (pt) {
        CHECK_EQ_U64(hcs_get_u16le(&pt[20]), 1);
        CHECK_EQ_U64(pt[16], 0); /* sntp_synced false */
    }
}

/* Trigger 2: record count. */
static void test_flush_due_on_record_count(void)
{
    csi_batcher_t b;
    csi_batcher_init(&b, 3, 200);
    hcs_csi_record_t r = rec(4, 1000);
    CHECK(!csi_batcher_flush_due(&b, 1000));
    csi_batcher_append(&b, &r);
    CHECK(!csi_batcher_flush_due(&b, 1000));
    csi_batcher_append(&b, &r);
    CHECK(!csi_batcher_flush_due(&b, 1000));
    csi_batcher_append(&b, &r);
    CHECK(csi_batcher_flush_due(&b, 1000));
}

/* Trigger 3: time budget, measured from the FIRST record in the batch. */
static void test_flush_due_on_time_budget_from_first_record(void)
{
    csi_batcher_t b;
    csi_batcher_init(&b, 100, 200); /* 200 ms */
    hcs_csi_record_t first = rec(4, 1000000);
    csi_batcher_append(&b, &first);

    hcs_csi_record_t later = rec(4, 1150000);
    csi_batcher_append(&b, &later);

    CHECK(!csi_batcher_flush_due(&b, 1199999));
    CHECK(csi_batcher_flush_due(&b, 1200000));
}

static void test_empty_batch_never_flushes_on_time(void)
{
    csi_batcher_t b;
    csi_batcher_init(&b, 16, 200);
    CHECK(!csi_batcher_flush_due(&b, 0));
    CHECK(!csi_batcher_flush_due(&b, 999999999ull));
}

/* Trigger 1: size. Appending must refuse rather than exceed 1156 bytes. */
static void test_append_refuses_when_it_would_exceed_plaintext_limit(void)
{
    csi_batcher_t b;
    csi_batcher_init(&b, 1000, 200);
    hcs_csi_record_t r = rec(256, 0);
    int appended = 0;
    for (;;) {
        csi_batch_result_t res = csi_batcher_append(&b, &r);
        if (res == CSI_BATCH_APPENDED) {
            appended++;
            continue;
        }
        CHECK_EQ_I64(res, CSI_BATCH_FULL);
        break;
    }
    /* 22 + n*(31+256) <= 1156  ->  n <= 3 */
    CHECK_EQ_U64(appended, 3);
    CHECK(csi_batcher_plaintext_len(&b) <= HCS_MAX_PLAINTEXT_LEN);
    /* CSI_BATCH_FULL is itself the flush signal for the caller: this record
     * did not fit. A *smaller* record still might, so flush_due() stays
     * false here by design - see the next test for the saturated case. */
    CHECK(csi_batcher_plaintext_len(&b) + HCS_RECORD_FIXED_LEN + 256
          > HCS_MAX_PLAINTEXT_LEN);
}

/* Once not even a zero-length record could be appended, the idle flush check
 * must report the batch as due regardless of the time budget. */
static void test_flush_due_when_no_record_of_any_size_could_fit(void)
{
    csi_batcher_t b;
    csi_batcher_init(&b, 1000, 3600000);
    hcs_csi_record_t r = rec(0, 0);
    int appended = 0;
    while (csi_batcher_append(&b, &r) == CSI_BATCH_APPENDED) {
        appended++;
    }
    /* 22 + n*31 <= 1156 -> n <= 36 */
    CHECK_EQ_U64(appended, 36);
    CHECK(csi_batcher_flush_due(&b, 0));
}

/* proto S11: a record too big to ever fit must be dropped and counted, not
 * retried forever. */
static void test_record_larger_than_any_batch_is_dropped_and_counted(void)
{
    csi_batcher_t b;
    csi_batcher_init(&b, 16, 200);
    hcs_csi_record_t r = rec(HCS_MAX_CSI_LEN_IN_BATCH + 1, 0);
    r.csi_data = g_csi; /* content irrelevant; only the length matters */
    CHECK_EQ_I64(csi_batcher_append(&b, &r), CSI_BATCH_RECORD_TOO_LARGE);
    CHECK_EQ_U64(b.records_too_large, 1);
    CHECK(csi_batcher_is_empty(&b));

    /* exactly at the limit still fits in an empty batch */
    hcs_csi_record_t ok = rec(HCS_MAX_CSI_LEN_IN_BATCH, 0);
    CHECK_EQ_I64(csi_batcher_append(&b, &ok), CSI_BATCH_APPENDED);
    CHECK_EQ_U64(csi_batcher_plaintext_len(&b), HCS_MAX_PLAINTEXT_LEN);
}

static void test_reset_clears_state_for_reuse(void)
{
    csi_batcher_t b;
    csi_batcher_init(&b, 16, 200);
    hcs_csi_record_t r = rec(4, 500);
    csi_batcher_append(&b, &r);
    csi_batcher_reset(&b);
    CHECK(csi_batcher_is_empty(&b));
    CHECK_EQ_U64(csi_batcher_record_count(&b), 0);
    CHECK_EQ_U64(csi_batcher_plaintext_len(&b), HCS_BATCH_HEADER_LEN);
    CHECK(!csi_batcher_flush_due(&b, 999999999ull));
}

/* Records must be laid out back-to-back with no padding (proto S9.2). */
static void test_records_are_contiguous(void)
{
    csi_batcher_t b;
    csi_batcher_init(&b, 16, 200);
    for (int i = 0; i < 3; i++) {
        g_csi[0] = (uint8_t)(0xF0 + i);
        hcs_csi_record_t r = rec(1, (uint64_t)i);
        r.channel = (uint8_t)(1 + i);
        CHECK_EQ_I64(csi_batcher_append(&b, &r), CSI_BATCH_APPENDED);
    }
    const uint8_t *pt = NULL;
    size_t n = csi_batcher_finalize(&b, 0, 0, false, &pt);
    CHECK_EQ_U64(n, HCS_BATCH_HEADER_LEN + 3 * (HCS_RECORD_FIXED_LEN + 1));
    if (pt) {
        for (int i = 0; i < 3; i++) {
            const uint8_t *r = pt + HCS_BATCH_HEADER_LEN
                               + (size_t)i * (HCS_RECORD_FIXED_LEN + 1);
            CHECK_EQ_U64(r[HCS_REC_OFF_CHANNEL], (uint8_t)(1 + i));
            CHECK_EQ_U64(hcs_get_u16le(&r[HCS_REC_OFF_CSI_LEN]), 1);
            CHECK_EQ_U64(r[HCS_REC_OFF_CSI_DATA], (uint8_t)(0xF0 + i));
        }
    }
}

/* A zero/absurd configuration must fall back to the documented defaults
 * rather than producing a batcher that never flushes. */
static void test_init_clamps_bad_config(void)
{
    csi_batcher_t b;
    csi_batcher_init(&b, 0, 0);
    CHECK_EQ_U64(b.max_records, HCS_DEFAULT_MAX_RECORDS_PER_BATCH);
    CHECK_EQ_U64(b.flush_budget_ms, HCS_DEFAULT_FLUSH_TIME_BUDGET_MS);
}

int main(void)
{
    TEST_SUITE("batcher (proto S11 flush)");
    test_empty_batch_finalizes_to_header_only();
    test_append_grows_plaintext_and_count();
    test_flush_due_on_record_count();
    test_flush_due_on_time_budget_from_first_record();
    test_empty_batch_never_flushes_on_time();
    test_append_refuses_when_it_would_exceed_plaintext_limit();
    test_flush_due_when_no_record_of_any_size_could_fit();
    test_record_larger_than_any_batch_is_dropped_and_counted();
    test_reset_clears_state_for_reuse();
    test_records_are_contiguous();
    test_init_clamps_bad_config();
    return hcs_test_report();
}
