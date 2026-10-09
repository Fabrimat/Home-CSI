/*
 * mode_policy.h - pure decision logic behind the burst/realtime mode client
 * (main/mode_client.c). GET /device/mode (docs/device-api.md, brief B1) lets
 * the server ask a node to run temporarily "hot" (faster sounding, tighter
 * batching) for an experiment. Two properties make that safe to accept from
 * a server this node does not otherwise trust with a command channel:
 *
 *   1. HARD CEILINGS. Every knob the server can move is clamped to an
 *      independent, compile-time ceiling (Kconfig, "Realtime (burst) mode").
 *      A proposal beyond a ceiling is clamped to it and logged by the
 *      caller - never applied verbatim, never rejected outright (rejecting
 *      the whole proposal over one out-of-range field would either wedge a
 *      legitimate experiment over a typo or, worse, train an operator to
 *      raise the ceiling instead of fixing the proposal). A buggy or
 *      actively hostile server therefore cannot make this node do anything
 *      worse than "run at its own configured ceiling", which is a rate this
 *      deployment is already provisioned to sustain.
 *
 *   2. A LOCAL, MONOTONIC DEADLINE. `expiresAt` is converted to this node's
 *      own esp_timer timeline exactly once, at the moment realtime mode is
 *      applied (hcs_mode_deadline_mono_us()), using a duration that is
 *      itself clamped to HCS_REALTIME_MAX_DURATION_S regardless of what the
 *      wall clock or the server claims. Every check after that is a pure
 *      monotonic comparison (hcs_mode_deadline_expired()) - no server round
 *      trip, and no second look at the wall clock, which is exactly what
 *      makes reversion work even when the server has gone away: a wedged or
 *      unreachable server cannot leave the mesh flooding indefinitely,
 *      because the node was never depending on hearing from it again.
 *
 * This header (and mode_policy.c) is plain C11 with no ESP-IDF or FreeRTOS
 * dependency, compiled both by the firmware and by firmware/tests - like
 * everything else under components/csi_protocol.
 */
#ifndef CSI_PROTOCOL_MODE_POLICY_H
#define CSI_PROTOCOL_MODE_POLICY_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    HCS_NODE_MODE_NORMAL = 0,
    HCS_NODE_MODE_REALTIME = 1
} hcs_node_mode_t;

/* Hard, node-local ceilings. None of these come from the server; they come
 * from this node's own Kconfig, chosen once at build/provisioning time by
 * whoever deploys the fleet. See main/Kconfig.projbuild, "Realtime (burst)
 * mode". */
typedef struct {
    uint32_t min_poll_interval_s;        /* floor on pollIntervalS */
    uint32_t min_sounding_interval_ms;   /* floor on soundingIntervalMs */
    uint32_t max_sounding_rps;           /* ceiling on soundingRps */
    uint32_t min_flush_budget_ms;        /* floor on flushBudgetMs */
    uint32_t max_records_per_batch;      /* ceiling on maxRecordsPerBatch */
    uint32_t max_duration_s;             /* ceiling on the realtime window */
} hcs_mode_ceilings_t;

/* What GET /device/mode returned, parsed but not yet clamped. */
typedef struct {
    hcs_node_mode_t mode;
    uint32_t revision;
    uint32_t poll_interval_s;
    uint32_t sounding_interval_ms;
    uint32_t sounding_rps;
    uint32_t flush_budget_ms;
    uint32_t max_records_per_batch;
    /* UTC microseconds since the Unix epoch. Only meaningful when
     * has_expires_at is true, which should be exactly when mode ==
     * HCS_NODE_MODE_REALTIME - a realtime proposal with no expiry is
     * refused upstream in main/mode_client.c (see its header comment):
     * this module has no opinion on that policy, it just carries whatever
     * it is given. */
    uint64_t expires_at_wall_us;
    bool has_expires_at;
} hcs_mode_proposal_t;

/* The same shape, after every field has been clamped to `ceilings`, plus one
 * flag per field recording whether clamping actually changed it - so the
 * caller can log a single loud line exactly when a server proposal tried to
 * cross a line, and stay quiet otherwise. */
typedef struct {
    hcs_node_mode_t mode;
    uint32_t revision;
    uint32_t poll_interval_s;
    uint32_t sounding_interval_ms;
    uint32_t sounding_rps;
    uint32_t flush_budget_ms;
    uint32_t max_records_per_batch;
    uint64_t expires_at_wall_us;
    bool has_expires_at;

    bool clamped_poll_interval;
    bool clamped_sounding_interval;
    bool clamped_sounding_rps;
    bool clamped_flush_budget;
    bool clamped_max_records;
} hcs_mode_applied_t;

/* Clamps every knob in `proposal` to `ceilings`. Pure, integer-only,
 * allocation-free. `revision`, `mode`, `expires_at_wall_us` and
 * `has_expires_at` pass through unchanged - they are not rate/size knobs and
 * have nothing to clamp against. NULL `out` is a no-op; NULL `proposal` or
 * `ceilings` produces every field at its safest (ceiling/floor) value. */
void hcs_mode_clamp(const hcs_mode_proposal_t *proposal,
                    const hcs_mode_ceilings_t *ceilings,
                    hcs_mode_applied_t *out);

/* Converts an absolute wall-clock expiry into this node's own monotonic
 * timeline, ONCE, at the moment realtime mode is applied.
 *
 *   now_wall_us       - this node's current best estimate of UTC wall-clock
 *                       time (time_sync_wall_clock_us() on-device). May be
 *                       wrong or unsynced; see below.
 *   now_mono_us       - esp_timer_get_time() at the same moment.
 *   expires_at_wall_us - the server's claimed UTC expiry instant.
 *   max_duration_s    - HCS_REALTIME_MAX_DURATION_S, independent of anything
 *                       wall-clock derived.
 *
 * The window length is (expires_at_wall_us - now_wall_us), clamped to
 * [0, max_duration_s]: a proposal already in the past (by this node's wall
 * clock) collapses to a zero-length window, and nothing can make the window
 * longer than the ceiling no matter how far in the future expires_at_wall_us
 * claims to be. This is precisely why an unsynced or wildly wrong wall clock
 * is not a safety hole: it can only make this function decide the window is
 * SHORTER (or already over) than intended, never longer than the ceiling
 * allows - the one direction that matters is already closed off by
 * max_duration_s, independent of the wall clock entirely.
 *
 * The returned deadline is the only wall-clock-derived value the caller
 * should ever compute for this activation. Every subsequent liveness check
 * must go through hcs_mode_deadline_expired() against esp_timer, not through
 * this function again - recomputing it later (e.g. on every poll of an
 * unchanged server directive) would let a wall-clock step, or simply
 * re-polling, quietly re-arm a deadline that was supposed to be fixed at
 * apply time. See main/mode_client.c's use of `revision` to decide when a
 * genuinely NEW activation (and therefore a new call to this function) has
 * occurred. */
uint64_t hcs_mode_deadline_mono_us(uint64_t now_wall_us, uint64_t now_mono_us,
                                   uint64_t expires_at_wall_us,
                                   uint32_t max_duration_s);

/* True once `now_mono_us` has reached or passed `deadline_mono_us`. Pure
 * monotonic comparison: no server round trip, no wall clock, callable as
 * often as the caller likes (main/mode_client.c calls it every tick,
 * independent of the - possibly much longer - poll interval). */
bool hcs_mode_deadline_expired(uint64_t deadline_mono_us, uint64_t now_mono_us);

/* Parses a UTC ISO-8601 instant of the exact shape
 * "YYYY-MM-DDTHH:MM:SS[.fff...]Z" (the shape a JSON `Date.toISOString()`
 * produces, and what docs/device-api.md's /device/mode route is expected to
 * send) into UTC microseconds since the Unix epoch. Any other shape - a
 * numeric UTC offset instead of "Z", a missing field, an out-of-range
 * component - is rejected (returns false, `*out_us` untouched).
 *
 * Hand-rolled rather than strptime()/mktime(): those interpret broken-down
 * time in the process's local timezone, which is not set (and must not
 * matter) on this device, and pulling in a timezone database is not
 * something an OTA-sized task should do to parse one field of one HTTP
 * response a minute. The date/day arithmetic is Howard Hinnant's
 * days_from_civil algorithm (public domain, integer-only, exact for the
 * proleptic Gregorian calendar over any year this format can express). */
bool hcs_iso8601_utc_to_unix_us(const char *s, uint64_t *out_us);

#ifdef __cplusplus
}
#endif

#endif /* CSI_PROTOCOL_MODE_POLICY_H */
