/* On-node bandwidth budget: per-class record rate limits, an overall byte
 * cap, and back-pressure decimation driven by ring occupancy.
 *
 * The point of this module is that a node degrades *predictably*: when it
 * cannot keep up it thins its stream on purpose (and says so in counters)
 * instead of letting the ring overflow at random.
 */
#include "harness.h"

#include "csi_protocol/bw_budget.h"

static const uint64_t SEC = 1000000ull;

static bw_budget_cfg_t base_cfg(void)
{
    bw_budget_cfg_t c;
    bw_budget_default_cfg(&c);
    /* Make the numbers small and exact for testing. */
    c.cls[BW_CLASS_SOUNDING].records_per_sec = 10;
    c.cls[BW_CLASS_SOUNDING].burst_records = 10;
    c.cls[BW_CLASS_FOREIGN].records_per_sec = 2;
    c.cls[BW_CLASS_FOREIGN].burst_records = 2;
    c.bytes_per_sec = 0; /* byte cap off unless a test enables it */
    c.burst_bytes = 0;
    /* decimation off unless a test enables it */
    c.decimate_start_pct[BW_CLASS_SOUNDING] = 101;
    c.decimate_start_pct[BW_CLASS_FOREIGN] = 101;
    c.decimate_full_pct = 101;
    c.decimate_max_divisor = 1;
    return c;
}

static void test_bucket_starts_full_and_then_limits(void)
{
    bw_budget_t b;
    bw_budget_cfg_t c = base_cfg();
    bw_budget_init(&b, &c, 0);

    for (int i = 0; i < 10; i++) {
        CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_SOUNDING, 100, 0, 0),
                     BW_ADMIT);
    }
    CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_SOUNDING, 100, 0, 0),
                 BW_DROP_RECORD_RATE);
    CHECK_EQ_U64(b.admitted[BW_CLASS_SOUNDING], 10);
    CHECK_EQ_U64(b.dropped[BW_DROP_RECORD_RATE], 1);
}

static void test_bucket_refills_over_time(void)
{
    bw_budget_t b;
    bw_budget_cfg_t c = base_cfg();
    bw_budget_init(&b, &c, 0);

    for (int i = 0; i < 10; i++) {
        bw_budget_admit(&b, BW_CLASS_SOUNDING, 100, 0, 0);
    }
    CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_SOUNDING, 100, 0, 0),
                 BW_DROP_RECORD_RATE);

    /* 10 records/s: 100 ms buys exactly one more. */
    CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_SOUNDING, 100, SEC / 10, 0),
                 BW_ADMIT);
    CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_SOUNDING, 100, SEC / 10, 0),
                 BW_DROP_RECORD_RATE);
}

/* Sub-microsecond-rate calls must not starve the bucket through integer
 * truncation: the elapsed time has to accumulate until it is worth a token. */
static void test_tiny_time_steps_still_refill(void)
{
    bw_budget_t b;
    bw_budget_cfg_t c = base_cfg();
    bw_budget_init(&b, &c, 0);
    for (int i = 0; i < 10; i++) {
        bw_budget_admit(&b, BW_CLASS_SOUNDING, 100, 0, 0);
    }
    /* Poll every microsecond for 100 ms; one token must appear. */
    bw_decision_t last = BW_DROP_RECORD_RATE;
    for (uint64_t t = 1; t <= SEC / 10; t++) {
        last = bw_budget_admit(&b, BW_CLASS_SOUNDING, 100, t, 0);
        if (last == BW_ADMIT) {
            break;
        }
    }
    CHECK_EQ_I64(last, BW_ADMIT);
}

static void test_classes_have_independent_budgets(void)
{
    bw_budget_t b;
    bw_budget_cfg_t c = base_cfg();
    bw_budget_init(&b, &c, 0);

    for (int i = 0; i < 2; i++) {
        CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_FOREIGN, 100, 0, 0),
                     BW_ADMIT);
    }
    /* Foreign is exhausted... */
    CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_FOREIGN, 100, 0, 0),
                 BW_DROP_RECORD_RATE);
    /* ...but soundings, the primary signal, are untouched. */
    CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_SOUNDING, 100, 0, 0), BW_ADMIT);
}

static void test_class_with_zero_rate_is_disabled(void)
{
    bw_budget_t b;
    bw_budget_cfg_t c = base_cfg();
    c.cls[BW_CLASS_FOREIGN].records_per_sec = 0;
    bw_budget_init(&b, &c, 0);
    CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_FOREIGN, 100, 0, 0),
                 BW_DROP_CLASS_DISABLED);
    CHECK_EQ_U64(b.dropped[BW_DROP_CLASS_DISABLED], 1);
    CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_SOUNDING, 100, 0, 0), BW_ADMIT);
}

static void test_byte_cap_applies_across_classes(void)
{
    bw_budget_t b;
    bw_budget_cfg_t c = base_cfg();
    c.bytes_per_sec = 1000;
    c.burst_bytes = 1000;
    bw_budget_init(&b, &c, 0);

    CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_SOUNDING, 600, 0, 0), BW_ADMIT);
    CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_SOUNDING, 300, 0, 0), BW_ADMIT);
    /* only 100 byte-tokens left */
    CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_SOUNDING, 300, 0, 0),
                 BW_DROP_BYTE_RATE);
    CHECK_EQ_U64(b.dropped[BW_DROP_BYTE_RATE], 1);
    /* A record refused on bytes must not have consumed a record token. */
    CHECK_EQ_U64(b.admitted[BW_CLASS_SOUNDING], 2);
    CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_SOUNDING, 50, 0, 0), BW_ADMIT);
}

/* --- decimation under ring back-pressure ----------------------------- */

static void test_no_decimation_below_start_threshold(void)
{
    bw_budget_t b;
    bw_budget_cfg_t c = base_cfg();
    c.decimate_start_pct[BW_CLASS_SOUNDING] = 50;
    c.decimate_full_pct = 100;
    c.decimate_max_divisor = 4;
    bw_budget_init(&b, &c, 0);

    for (int i = 0; i < 10; i++) {
        CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_SOUNDING, 10, 0, 49),
                     BW_ADMIT);
    }
    CHECK_EQ_U64(b.dropped[BW_DROP_DECIMATED], 0);
}

static void test_full_ring_pressure_applies_max_divisor(void)
{
    bw_budget_t b;
    bw_budget_cfg_t c = base_cfg();
    c.cls[BW_CLASS_SOUNDING].records_per_sec = 1000;
    c.cls[BW_CLASS_SOUNDING].burst_records = 1000;
    c.decimate_start_pct[BW_CLASS_SOUNDING] = 50;
    c.decimate_full_pct = 100;
    c.decimate_max_divisor = 4;
    bw_budget_init(&b, &c, 0);

    int admitted = 0;
    for (int i = 0; i < 40; i++) {
        if (bw_budget_admit(&b, BW_CLASS_SOUNDING, 10, 0, 100) == BW_ADMIT) {
            admitted++;
        }
    }
    CHECK_EQ_U64(admitted, 10); /* keep 1 in 4 */
    CHECK_EQ_U64(b.dropped[BW_DROP_DECIMATED], 30);
}

static void test_decimation_scales_between_thresholds(void)
{
    bw_budget_t b;
    bw_budget_cfg_t c = base_cfg();
    c.cls[BW_CLASS_SOUNDING].records_per_sec = 1000;
    c.cls[BW_CLASS_SOUNDING].burst_records = 1000;
    c.decimate_start_pct[BW_CLASS_SOUNDING] = 50;
    c.decimate_full_pct = 90;
    c.decimate_max_divisor = 5;
    bw_budget_init(&b, &c, 0);

    /* halfway between 50% and 90% -> divisor 3 (1 + (5-1)*20/40) */
    CHECK_EQ_U64(bw_budget_divisor(&b, BW_CLASS_SOUNDING, 70), 3);
    CHECK_EQ_U64(bw_budget_divisor(&b, BW_CLASS_SOUNDING, 50), 1);
    CHECK_EQ_U64(bw_budget_divisor(&b, BW_CLASS_SOUNDING, 90), 5);
    CHECK_EQ_U64(bw_budget_divisor(&b, BW_CLASS_SOUNDING, 99), 5);
    CHECK_EQ_U64(bw_budget_divisor(&b, BW_CLASS_SOUNDING, 10), 1);
}

/* Foreign traffic is garnish; it must be thinned before the sounding mesh. */
static void test_foreign_is_decimated_before_sounding_by_default(void)
{
    bw_budget_cfg_t c;
    bw_budget_default_cfg(&c);
    CHECK(c.decimate_start_pct[BW_CLASS_FOREIGN]
          < c.decimate_start_pct[BW_CLASS_SOUNDING]);

    bw_budget_t b;
    bw_budget_init(&b, &c, 0);
    const uint32_t occ = c.decimate_start_pct[BW_CLASS_FOREIGN] + 1;
    CHECK(bw_budget_divisor(&b, BW_CLASS_FOREIGN, occ) > 1);
    CHECK_EQ_U64(bw_budget_divisor(&b, BW_CLASS_SOUNDING, occ), 1);
}

static void test_every_drop_is_counted_exactly_once(void)
{
    bw_budget_t b;
    bw_budget_cfg_t c = base_cfg();
    c.bytes_per_sec = 100;
    c.burst_bytes = 100;
    bw_budget_init(&b, &c, 0);

    uint32_t offered = 0, admitted = 0;
    for (int i = 0; i < 50; i++) {
        offered++;
        if (bw_budget_admit(&b, BW_CLASS_SOUNDING, 40, 0, 0) == BW_ADMIT) {
            admitted++;
        }
    }
    uint32_t total_dropped = 0;
    for (int i = 1; i < BW_DECISION_COUNT; i++) {
        total_dropped += b.dropped[i];
    }
    CHECK_EQ_U64(admitted + total_dropped, offered);
    CHECK_EQ_U64(bw_budget_total_dropped(&b), total_dropped);
}

/* --- reconfigure (burst/realtime mode switching, main/mode_client.c) --- */

/* Widening the rate must not hand out a free burst: tokens already
 * depleted stay depleted, they are not topped up to the new (bigger) cap. */
static void test_reconfigure_widening_does_not_grant_free_tokens(void)
{
    bw_budget_t b;
    bw_budget_cfg_t c = base_cfg(); /* sounding: 10 rps, burst 10 */
    bw_budget_init(&b, &c, 0);

    for (int i = 0; i < 10; i++) {
        CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_SOUNDING, 100, 0, 0), BW_ADMIT);
    }
    CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_SOUNDING, 100, 0, 0),
                 BW_DROP_RECORD_RATE); /* fully depleted */

    /* Switch to a much faster "burst" rate at the same instant. */
    bw_budget_cfg_t burst = c;
    burst.cls[BW_CLASS_SOUNDING].records_per_sec = 1000;
    burst.cls[BW_CLASS_SOUNDING].burst_records = 1000;
    bw_budget_reconfigure(&b, &burst, 0);

    /* No time has passed, so no tokens have been earned - the widened cap
     * must not itself have manufactured any. */
    CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_SOUNDING, 100, 0, 0),
                 BW_DROP_RECORD_RATE);

    /* But the new, faster rate governs refill from here on: at 1000/s, 1 ms
     * buys one token, where the old 10/s config would have needed 100 ms. */
    CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_SOUNDING, 100, SEC / 1000, 0),
                 BW_ADMIT);
}

/* Narrowing the rate mid-flight must clamp existing tokens down to the new,
 * smaller cap - otherwise a node could accumulate a large burst reserve
 * under a generous config and then "spend" it all at once right after the
 * server (or expiry) drops it back to the normal rate. */
static void test_reconfigure_narrowing_clamps_existing_tokens(void)
{
    bw_budget_t b;
    bw_budget_cfg_t burst = base_cfg();
    burst.cls[BW_CLASS_SOUNDING].records_per_sec = 1000;
    burst.cls[BW_CLASS_SOUNDING].burst_records = 1000;
    bw_budget_init(&b, &burst, 0); /* starts full: 1000 tokens available */

    bw_budget_cfg_t normal = base_cfg(); /* sounding: 10 rps, burst 10 */
    bw_budget_reconfigure(&b, &normal, 0);

    /* Exactly 10 tokens must survive the reconfigure - not 1000. */
    int admitted = 0;
    for (int i = 0; i < 1000; i++) {
        if (bw_budget_admit(&b, BW_CLASS_SOUNDING, 1, 0, 0) == BW_ADMIT) {
            admitted++;
        }
    }
    CHECK_EQ_U64(admitted, 10);
}

/* No more than the configured rate gets through across a reconfigure
 * boundary, over real elapsed time, switching up and back down again. */
static void test_reconfigure_round_trip_never_exceeds_configured_rate(void)
{
    bw_budget_t b;
    bw_budget_cfg_t normal = base_cfg(); /* 10 rps, burst 10 */
    bw_budget_init(&b, &normal, 0);

    uint32_t admitted = 0;
    for (int i = 0; i < 10; i++) {
        if (bw_budget_admit(&b, BW_CLASS_SOUNDING, 1, 0, 0) == BW_ADMIT) {
            admitted++;
        }
    }
    CHECK_EQ_U64(admitted, 10); /* initial full bucket spent */

    bw_budget_cfg_t burst = base_cfg();
    burst.cls[BW_CLASS_SOUNDING].records_per_sec = 100;
    burst.cls[BW_CLASS_SOUNDING].burst_records = 100;
    bw_budget_reconfigure(&b, &burst, SEC); /* one second later */

    /* One second at the OLD 10 rps earned 10 tokens before the switch; the
     * new 100/s cap is bigger than that, so all 10 are preserved (not
     * topped up to 100) and nothing more is manufactured by the switch
     * itself. */
    admitted = 0;
    for (int i = 0; i < 100; i++) {
        if (bw_budget_admit(&b, BW_CLASS_SOUNDING, 1, SEC, 0) == BW_ADMIT) {
            admitted++;
        }
    }
    CHECK_EQ_U64(admitted, 10);

    /* Revert to normal a bit later: whatever the burst rate refilled in the
     * meantime is clamped back down to the normal cap of 10 on the way back
     * down, never handing out more than 10 at the moment of reversion. */
    bw_budget_reconfigure(&b, &normal, 2 * SEC);
    admitted = 0;
    for (int i = 0; i < 100; i++) {
        if (bw_budget_admit(&b, BW_CLASS_SOUNDING, 1, 2 * SEC, 0) == BW_ADMIT) {
            admitted++;
        }
    }
    CHECK(admitted <= 10);
}

static void test_reconfigure_null_args_are_safe(void)
{
    bw_budget_reconfigure(NULL, NULL, 0);
    bw_budget_t b;
    bw_budget_cfg_t c = base_cfg();
    bw_budget_init(&b, &c, 0);
    bw_budget_reconfigure(&b, NULL, 0); /* must not crash or corrupt state */
    CHECK_EQ_I64(bw_budget_admit(&b, BW_CLASS_SOUNDING, 100, 0, 0), BW_ADMIT);
}

int main(void)
{
    TEST_SUITE("bandwidth budget");
    test_bucket_starts_full_and_then_limits();
    test_bucket_refills_over_time();
    test_tiny_time_steps_still_refill();
    test_classes_have_independent_budgets();
    test_class_with_zero_rate_is_disabled();
    test_byte_cap_applies_across_classes();
    test_no_decimation_below_start_threshold();
    test_full_ring_pressure_applies_max_divisor();
    test_decimation_scales_between_thresholds();
    test_foreign_is_decimated_before_sounding_by_default();
    test_every_drop_is_counted_exactly_once();
    test_reconfigure_widening_does_not_grant_free_tokens();
    test_reconfigure_narrowing_clamps_existing_tokens();
    test_reconfigure_round_trip_never_exceeds_configured_rate();
    test_reconfigure_null_args_are_safe();
    return hcs_test_report();
}
