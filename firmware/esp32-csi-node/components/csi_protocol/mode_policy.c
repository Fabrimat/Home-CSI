/* mode_policy.c - see mode_policy.h. */

#include "csi_protocol/mode_policy.h"

#include <string.h>

/* --- clamping ----------------------------------------------------------- */

static uint32_t clamp_max_u32(uint32_t v, uint32_t ceiling, bool *clamped)
{
    if (ceiling != 0u && v > ceiling) {
        *clamped = true;
        return ceiling;
    }
    return v;
}

static uint32_t clamp_min_u32(uint32_t v, uint32_t floor_, bool *clamped)
{
    if (v < floor_) {
        *clamped = true;
        return floor_;
    }
    return v;
}

void hcs_mode_clamp(const hcs_mode_proposal_t *proposal,
                    const hcs_mode_ceilings_t *ceilings,
                    hcs_mode_applied_t *out)
{
    if (out == NULL) {
        return;
    }
    memset(out, 0, sizeof(*out));

    static const hcs_mode_proposal_t safe_proposal = { .mode = HCS_NODE_MODE_NORMAL };
    static const hcs_mode_ceilings_t safe_ceilings = { 0 };
    if (proposal == NULL) {
        proposal = &safe_proposal;
    }
    if (ceilings == NULL) {
        ceilings = &safe_ceilings;
    }

    out->mode = proposal->mode;
    out->revision = proposal->revision;
    out->expires_at_wall_us = proposal->expires_at_wall_us;
    out->has_expires_at = proposal->has_expires_at;

    out->poll_interval_s = clamp_min_u32(proposal->poll_interval_s,
                                         ceilings->min_poll_interval_s,
                                         &out->clamped_poll_interval);
    out->sounding_interval_ms =
        clamp_min_u32(proposal->sounding_interval_ms,
                     ceilings->min_sounding_interval_ms,
                     &out->clamped_sounding_interval);
    out->sounding_rps = clamp_max_u32(proposal->sounding_rps,
                                      ceilings->max_sounding_rps,
                                      &out->clamped_sounding_rps);
    out->flush_budget_ms = clamp_min_u32(proposal->flush_budget_ms,
                                        ceilings->min_flush_budget_ms,
                                        &out->clamped_flush_budget);
    out->max_records_per_batch =
        clamp_max_u32(proposal->max_records_per_batch,
                     ceilings->max_records_per_batch,
                     &out->clamped_max_records);
}

/* --- deadline ------------------------------------------------------------ */

uint64_t hcs_mode_deadline_mono_us(uint64_t now_wall_us, uint64_t now_mono_us,
                                   uint64_t expires_at_wall_us,
                                   uint32_t max_duration_s)
{
    const uint64_t max_duration_us = (uint64_t)max_duration_s * 1000000ull;
    uint64_t duration_us;

    if (expires_at_wall_us <= now_wall_us) {
        /* Already expired by this node's own wall-clock estimate (or the
         * server's clock and this node's disagree by more than the gap
         * involved) - a zero-length window, immediately eligible for
         * reversion on the very next check. This is a normal outcome, not
         * an error: a server whose clock runs a little ahead of this node's
         * still-converging SNTP estimate looks exactly like this. */
        duration_us = 0u;
    } else {
        duration_us = expires_at_wall_us - now_wall_us;
        if (duration_us > max_duration_us) {
            duration_us = max_duration_us;
        }
    }
    return now_mono_us + duration_us;
}

bool hcs_mode_deadline_expired(uint64_t deadline_mono_us, uint64_t now_mono_us)
{
    return now_mono_us >= deadline_mono_us;
}

/* --- ISO-8601 (UTC only) -------------------------------------------------- */

static bool parse_n_digits(const char **p, int n, long *out)
{
    long v = 0;
    for (int i = 0; i < n; i++) {
        const char c = **p;
        if (c < '0' || c > '9') {
            return false;
        }
        v = v * 10 + (c - '0');
        (*p)++;
    }
    *out = v;
    return true;
}

/* Howard Hinnant's days_from_civil, public domain:
 * https://howardhinnant.github.io/date_algorithms.html#days_from_civil
 * Returns the number of days since 1970-01-01 (civil calendar, proleptic
 * Gregorian) for the given year/month/day. Exact for any year representable
 * by a 4-digit ISO-8601 field; no leap-year table needed. */
static long long days_from_civil(long long y, unsigned m, unsigned d)
{
    y -= (m <= 2) ? 1 : 0;
    const long long era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = (unsigned)(y - era * 400); /* [0, 399] */
    /* Shift so the civil "year" starts in March: Mar=0 .. Dec=9, Jan=10,
     * Feb=11. Written as an explicit branch (rather than Hinnant's
     * `m + (m > 2 ? -3 : 9)`, which relies on signed-to-unsigned wraparound
     * of the -3 literal) so this stays warning-clean under -Wextra. */
    const unsigned mp = (m > 2u) ? (m - 3u) : (m + 9u);
    const unsigned doy = (153u * mp + 2u) / 5u + d - 1u;            /* [0, 365] */
    const unsigned doe = yoe * 365u + yoe / 4u - yoe / 100u + doy; /* [0, 146096] */
    return era * 146097ll + (long long)doe - 719468ll;
}

/* Proleptic Gregorian leap-year rule: divisible by 4, except centuries,
 * except again every 4th century. Used only to validate a parsed date
 * (below) - days_from_civil() above does not need it, it derives day
 * counts arithmetically. */
static bool is_leap_year(long year)
{
    return (year % 4 == 0) && (year % 100 != 0 || year % 400 == 0);
}

/* Days in `month` (1-12) of `year`. Used to reject a syntactically
 * well-formed but calendrically impossible date (e.g. 2026-02-30, or
 * 2023-02-29 in a non-leap year) - a plausible-looking malformed date is
 * exactly the input worth rejecting outright here, since this parser is the
 * one thing standing between a server-controlled string and this node's
 * burst-mode deadline. */
static int days_in_month(long year, long month)
{
    static const int days[12] = { 31, 28, 31, 30, 31, 30,
                                  31, 31, 30, 31, 30, 31 };
    if (month == 2 && is_leap_year(year)) {
        return 29;
    }
    return days[month - 1];
}

bool hcs_iso8601_utc_to_unix_us(const char *s, uint64_t *out_us)
{
    if (s == NULL || out_us == NULL) {
        return false;
    }
    const char *p = s;
    long year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;

    if (!parse_n_digits(&p, 4, &year) || *p++ != '-') {
        return false;
    }
    if (!parse_n_digits(&p, 2, &month) || *p++ != '-') {
        return false;
    }
    if (!parse_n_digits(&p, 2, &day) || *p++ != 'T') {
        return false;
    }
    if (!parse_n_digits(&p, 2, &hour) || *p++ != ':') {
        return false;
    }
    if (!parse_n_digits(&p, 2, &minute) || *p++ != ':') {
        return false;
    }
    if (!parse_n_digits(&p, 2, &second)) {
        return false;
    }

    long micros = 0;
    if (*p == '.') {
        p++;
        int digits = 0;
        long frac = 0;
        while (*p >= '0' && *p <= '9') {
            if (digits < 6) {
                frac = frac * 10 + (*p - '0');
            }
            digits++;
            p++;
        }
        if (digits == 0) {
            return false; /* a bare '.' with no digits is malformed */
        }
        /* Left-pad the fraction out to microsecond width, then drop
         * anything finer than a microsecond - this project has no use for
         * sub-microsecond precision anywhere on the wire. */
        for (int i = digits; i < 6; i++) {
            frac *= 10;
        }
        micros = frac;
    }

    /* This project only accepts UTC ("Z"). A numeric offset would be
     * unambiguous too, but nothing in this codebase needs it, and silently
     * mishandling one would be worse than refusing it outright. */
    if (*p != 'Z' && *p != 'z') {
        return false;
    }
    p++;
    if (*p != '\0') {
        return false; /* trailing garbage */
    }

    if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59
        || second > 59) {
        return false;
    }
    /* Range-checked above (1-12) before this indexes into days_in_month()'s
     * table - order matters here. */
    if (day > days_in_month(year, month)) {
        return false; /* e.g. 2026-02-30, or 2023-02-29 (not a leap year) */
    }

    const long long days = days_from_civil(year, (unsigned)month, (unsigned)day);
    const long long total_seconds =
        days * 86400ll + hour * 3600ll + minute * 60ll + second;
    if (total_seconds < 0) {
        return false; /* pre-1970: not a case this protocol needs to express */
    }

    *out_us = (uint64_t)total_seconds * 1000000ull + (uint64_t)micros;
    return true;
}
