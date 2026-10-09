/* Burst/realtime mode decision logic (main/mode_client.c's pure half):
 * clamping every server-proposed knob to a local ceiling, converting an
 * absolute expiry into a local monotonic deadline exactly once, and the
 * ISO-8601 (UTC) parser that feeds it.
 */
#include "harness.h"

#include "csi_protocol/mode_policy.h"

static const uint64_t SEC = 1000000ull;

static hcs_mode_ceilings_t ceilings(void)
{
    hcs_mode_ceilings_t c;
    c.min_poll_interval_s = 10;
    c.min_sounding_interval_ms = 20;
    c.max_sounding_rps = 200;
    c.min_flush_budget_ms = 20;
    c.max_records_per_batch = 64;
    c.max_duration_s = 3600;
    return c;
}

static hcs_mode_proposal_t normal_proposal(void)
{
    hcs_mode_proposal_t p;
    memset(&p, 0, sizeof p);
    p.mode = HCS_NODE_MODE_NORMAL;
    p.revision = 1;
    p.poll_interval_s = 60;
    return p;
}

/* --- clamping ------------------------------------------------------------ */

static void test_within_ceilings_is_untouched(void)
{
    hcs_mode_ceilings_t c = ceilings();
    hcs_mode_proposal_t p = normal_proposal();
    p.mode = HCS_NODE_MODE_REALTIME;
    p.poll_interval_s = 30;
    p.sounding_interval_ms = 50;
    p.sounding_rps = 100;
    p.flush_budget_ms = 100;
    p.max_records_per_batch = 32;

    hcs_mode_applied_t a;
    hcs_mode_clamp(&p, &c, &a);

    CHECK_EQ_U64(a.poll_interval_s, 30);
    CHECK_EQ_U64(a.sounding_interval_ms, 50);
    CHECK_EQ_U64(a.sounding_rps, 100);
    CHECK_EQ_U64(a.flush_budget_ms, 100);
    CHECK_EQ_U64(a.max_records_per_batch, 32);
    CHECK(!a.clamped_poll_interval);
    CHECK(!a.clamped_sounding_interval);
    CHECK(!a.clamped_sounding_rps);
    CHECK(!a.clamped_flush_budget);
    CHECK(!a.clamped_max_records);
    CHECK_EQ_U64(a.mode, HCS_NODE_MODE_REALTIME);
    CHECK_EQ_U64(a.revision, p.revision);
}

static void test_a_hostile_proposal_cannot_cross_any_ceiling(void)
{
    hcs_mode_ceilings_t c = ceilings();
    hcs_mode_proposal_t p = normal_proposal();
    p.mode = HCS_NODE_MODE_REALTIME;
    p.poll_interval_s = 0;           /* would hammer the server */
    p.sounding_interval_ms = 0;      /* would flood the channel */
    p.sounding_rps = 100000;         /* absurd */
    p.flush_budget_ms = 0;           /* would flush every single record */
    p.max_records_per_batch = 100000;

    hcs_mode_applied_t a;
    hcs_mode_clamp(&p, &c, &a);

    CHECK_EQ_U64(a.poll_interval_s, c.min_poll_interval_s);
    CHECK_EQ_U64(a.sounding_interval_ms, c.min_sounding_interval_ms);
    CHECK_EQ_U64(a.sounding_rps, c.max_sounding_rps);
    CHECK_EQ_U64(a.flush_budget_ms, c.min_flush_budget_ms);
    CHECK_EQ_U64(a.max_records_per_batch, c.max_records_per_batch);
    CHECK(a.clamped_poll_interval);
    CHECK(a.clamped_sounding_interval);
    CHECK(a.clamped_sounding_rps);
    CHECK(a.clamped_flush_budget);
    CHECK(a.clamped_max_records);
}

static void test_null_proposal_and_ceilings_are_safe(void)
{
    hcs_mode_applied_t a;
    hcs_mode_clamp(NULL, NULL, &a);
    CHECK_EQ_U64(a.mode, HCS_NODE_MODE_NORMAL);
    CHECK_EQ_U64(a.poll_interval_s, 0);
    CHECK_EQ_U64(a.sounding_rps, 0); /* max_sounding_rps ceiling of 0 = no cap given -> passes 0 through untouched */

    hcs_mode_clamp(NULL, NULL, NULL); /* must not crash */
}

/* --- deadline -------------------------------------------------------------*/

static void test_deadline_is_now_plus_remaining_duration(void)
{
    const uint64_t now_wall = 1000 * SEC;
    const uint64_t now_mono = 500 * SEC;
    const uint64_t expires = now_wall + 120 * SEC;

    const uint64_t deadline = hcs_mode_deadline_mono_us(now_wall, now_mono, expires, 3600);
    CHECK_EQ_U64(deadline, now_mono + 120 * SEC);
    CHECK(!hcs_mode_deadline_expired(deadline, now_mono));
    CHECK(!hcs_mode_deadline_expired(deadline, deadline - 1));
    CHECK(hcs_mode_deadline_expired(deadline, deadline));
    CHECK(hcs_mode_deadline_expired(deadline, deadline + 1));
}

static void test_duration_is_capped_by_max_duration_regardless_of_wall_clock(void)
{
    const uint64_t now_wall = 1000 * SEC;
    const uint64_t now_mono = 500 * SEC;
    /* The server (or a wildly wrong local wall clock) claims a window of a
     * full year. The ceiling still wins. */
    const uint64_t expires = now_wall + 365ull * 86400ull * SEC;

    const uint64_t deadline = hcs_mode_deadline_mono_us(now_wall, now_mono, expires, 3600);
    CHECK_EQ_U64(deadline, now_mono + 3600 * SEC);
}

static void test_already_expired_proposal_collapses_to_zero_length_window(void)
{
    const uint64_t now_wall = 1000 * SEC;
    const uint64_t now_mono = 500 * SEC;
    const uint64_t expires = now_wall - 1; /* already in the past */

    const uint64_t deadline = hcs_mode_deadline_mono_us(now_wall, now_mono, expires, 3600);
    CHECK_EQ_U64(deadline, now_mono);
    CHECK(hcs_mode_deadline_expired(deadline, now_mono));
}

static void test_unsynced_wall_clock_can_only_shorten_never_lengthen(void)
{
    /* A cold, unsynced wall clock reads near zero (time_sync.c's own
     * comment: "converges too slowly from a cold (1970) start"), while
     * expiresAt is a real, far-future UTC instant. The subtraction is huge,
     * but max_duration_s still wins. */
    const uint64_t now_wall = 5 * SEC; /* five seconds after the 1970 epoch */
    const uint64_t now_mono = 42 * SEC;
    const uint64_t expires = 1893456000ull * SEC; /* year ~2030 */

    const uint64_t deadline = hcs_mode_deadline_mono_us(now_wall, now_mono, expires, 3600);
    CHECK_EQ_U64(deadline, now_mono + 3600 * SEC);
}

/* --- ISO-8601 --------------------------------------------------------------*/

static void test_iso8601_epoch(void)
{
    uint64_t us = 0xdeadbeefull;
    CHECK(hcs_iso8601_utc_to_unix_us("1970-01-01T00:00:00Z", &us));
    CHECK_EQ_U64(us, 0);
}

static void test_iso8601_with_milliseconds(void)
{
    uint64_t us = 0;
    CHECK(hcs_iso8601_utc_to_unix_us("1970-01-01T00:00:00.500Z", &us));
    CHECK_EQ_U64(us, 500000);
}

static void test_iso8601_lowercase_z(void)
{
    uint64_t us = 0;
    CHECK(hcs_iso8601_utc_to_unix_us("1970-01-01T00:00:01z", &us));
    CHECK_EQ_U64(us, 1000000);
}

static void test_iso8601_known_instant(void)
{
    /* 2026-08-31T00:00:00Z. Cross-checked independently: days from
     * 1970-01-01 to 2026-08-31 = 20696 (14 leap days - 1972, 76, 80, 84, 88,
     * 92, 96, 2000, 04, 08, 12, 16, 20, 24 - between 1970 and 2026-08-31
     * inclusive of leap-day-affecting years up to Aug), so
     * 20696 * 86400 = 1,788,134,400 seconds. */
    uint64_t us = 0;
    CHECK(hcs_iso8601_utc_to_unix_us("2026-08-31T00:00:00Z", &us));
    CHECK_EQ_U64(us, 1788134400ull * 1000000ull);
}

static void test_iso8601_leap_day(void)
{
    /* 2000-02-29 is a real date (divisible by 400): round-trip it against a
     * hand-computed day count instead of trusting a second implementation.
     * Days from 1970-01-01 to 2000-01-01 = 10957 (30 years, 7 leap: 72 76 80
     * 84 88 92 96). + 31 (Jan) + 28 (to reach Feb 29, i.e. 28 days into Feb)
     * = 10957 + 31 + 28 = 11016. */
    uint64_t us = 0;
    CHECK(hcs_iso8601_utc_to_unix_us("2000-02-29T12:00:00Z", &us));
    CHECK_EQ_U64(us, (11016ull * 86400ull + 12ull * 3600ull) * 1000000ull);
}

static void test_iso8601_rejects_malformed(void)
{
    uint64_t us = 0;
    CHECK(!hcs_iso8601_utc_to_unix_us("not-a-date", &us));
    CHECK(!hcs_iso8601_utc_to_unix_us("2026-08-31T00:00:00", &us)); /* no Z */
    CHECK(!hcs_iso8601_utc_to_unix_us("2026-08-31T00:00:00+02:00", &us)); /* offset, unsupported */
    CHECK(!hcs_iso8601_utc_to_unix_us("2026-13-01T00:00:00Z", &us)); /* month 13 */
    CHECK(!hcs_iso8601_utc_to_unix_us("2026-08-31T24:00:00Z", &us)); /* hour 24 */
    CHECK(!hcs_iso8601_utc_to_unix_us("2026-08-31T00:00:00Zjunk", &us)); /* trailing garbage */
    CHECK(!hcs_iso8601_utc_to_unix_us(NULL, &us));
    CHECK(!hcs_iso8601_utc_to_unix_us("2026-08-31T00:00:00.Z", &us)); /* bare dot */
}

/* A plausible-looking but calendrically impossible date is exactly the
 * input worth rejecting outright: the day-of-month range check (`day > 31`)
 * alone would let all of these through. */
static void test_iso8601_rejects_impossible_calendar_dates(void)
{
    uint64_t us = 0;
    CHECK(!hcs_iso8601_utc_to_unix_us("2026-02-30T00:00:00Z", &us)); /* Feb never has 30 */
    CHECK(!hcs_iso8601_utc_to_unix_us("2026-02-29T00:00:00Z", &us)); /* 2026 is not a leap year */
    CHECK(!hcs_iso8601_utc_to_unix_us("2023-02-29T00:00:00Z", &us)); /* nor is 2023 */
    CHECK(!hcs_iso8601_utc_to_unix_us("1900-02-29T00:00:00Z", &us)); /* century, not /400 */
    CHECK(!hcs_iso8601_utc_to_unix_us("2026-04-31T00:00:00Z", &us)); /* April has 30 days */
    CHECK(!hcs_iso8601_utc_to_unix_us("2026-06-31T00:00:00Z", &us)); /* June has 30 days */
    CHECK(!hcs_iso8601_utc_to_unix_us("2026-09-31T00:00:00Z", &us)); /* September has 30 days */
    CHECK(!hcs_iso8601_utc_to_unix_us("2026-11-31T00:00:00Z", &us)); /* November has 30 days */

    /* The same dates one day earlier, and genuine leap days, must still be
     * accepted - this is a day-of-month check, not an over-broad one. */
    CHECK(hcs_iso8601_utc_to_unix_us("2026-04-30T00:00:00Z", &us));
    CHECK(hcs_iso8601_utc_to_unix_us("2000-02-29T00:00:00Z", &us)); /* /400: leap */
    CHECK(hcs_iso8601_utc_to_unix_us("2024-02-29T00:00:00Z", &us)); /* /4, not /100: leap */
}

int main(void)
{
    TEST_SUITE("realtime mode policy");
    test_within_ceilings_is_untouched();
    test_a_hostile_proposal_cannot_cross_any_ceiling();
    test_null_proposal_and_ceilings_are_safe();
    test_deadline_is_now_plus_remaining_duration();
    test_duration_is_capped_by_max_duration_regardless_of_wall_clock();
    test_already_expired_proposal_collapses_to_zero_length_window();
    test_unsynced_wall_clock_can_only_shorten_never_lengthen();
    test_iso8601_epoch();
    test_iso8601_with_milliseconds();
    test_iso8601_lowercase_z();
    test_iso8601_known_instant();
    test_iso8601_leap_day();
    test_iso8601_rejects_malformed();
    test_iso8601_rejects_impossible_calendar_dates();
    return hcs_test_report();
}
