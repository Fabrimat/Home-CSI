import type { DbPool } from '@homecsi/db';
import type { BasicLogger } from '@homecsi/storage';

/**
 * Per-(node_id, link_mac) token-bucket ceiling on CSI records reaching
 * `DbWriteQueue` -- the "the save rate never changes" invariant from
 * docs/architecture.md's data lifecycle, enforced structurally rather than
 * by any cross-process coordination with the API process's realtime mode
 * (a different OS process -- see @homecsi/api's realtime control plane).
 *
 * Mirrors, but does not share code with,
 * `firmware/esp32-csi-node/components/csi_protocol/bw_budget.c`'s integer
 * token-bucket pattern: refill by elapsed wall-clock time, count what gets
 * dropped. Reimplemented here (in TypeScript, against `number` rather than
 * fixed-point integers -- JS has no native fixed-point need) rather than
 * shared across the language boundary, per this brief's own instruction.
 *
 * Deliberately gates ONLY the DbWriteQueue path -- see engine.ts's
 * `finalizeAccepted`, which filters `CsiBatch.records` through `admit()`
 * before calling `enqueueCsiBatch`, but always hands `CaptureWriter` the
 * full, unfiltered batch. The capture tree is the replay/disaster-recovery
 * path (docs/architecture.md "Data lifecycle" step 1); decimating it would
 * destroy the ability to reprocess a burst and would require synthesizing
 * per-datagram envelopes that never existed on the wire.
 */
export interface PersistedRateCeilingConfig {
  /** Steady-state refill rate, per (node_id, link_mac) key. */
  recordsPerSec: number;
  /** Bucket depth -- also the size of the initial burst a fresh key gets. */
  burstRecords: number;
}

/**
 * Built-in default when `config.realtime` (or its `persistedRateCeiling`
 * sub-key) is omitted -- see packages/config/src/schema.ts's `realtimeSchema`
 * comment for why the whole section is optional. ~50 records/s per link
 * mirrors bw_budget.c's own default `BW_CLASS_SOUNDING` rate (the node-side
 * ceiling this is the server-side counterpart to); a burst of 200 lets a
 * link that was briefly idle catch up without immediately tripping the
 * ceiling on the next few records.
 */
export const DEFAULT_PERSISTED_RATE_CEILING: PersistedRateCeilingConfig = {
  recordsPerSec: 50,
  burstRecords: 200,
};

interface Bucket {
  tokensMilli: number;
  capMilli: number;
  lastMs: number;
}

/**
 * Injectable surface `engine.ts` gates the DbWriteQueue path through --
 * real (`PersistedRateLimiter`) or a permissive/hostile fake in tests.
 */
export interface PersistedRateLimiterLike {
  /** Returns whether one more record for this (nodeId, linkMac) key may be admitted right now, consuming a token if so. */
  admit(nodeId: number, linkMac: string, nowMs: number): boolean;
}

/** Integer(-ish) token bucket per (node_id, link_mac) key, refilled lazily on `admit()` by elapsed time since that key's own last touch. */
export class PersistedRateLimiter implements PersistedRateLimiterLike {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly cfg: PersistedRateCeilingConfig) {}

  admit(nodeId: number, linkMac: string, nowMs: number): boolean {
    const key = `${nodeId}:${linkMac}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      // Starts full, mirroring bw_budget.c's bucket_init -- a key seen for
      // the first time (or after this process's restart) gets to spend its
      // whole burst allowance immediately rather than trickling in.
      const capMilli = this.cfg.burstRecords * 1000;
      bucket = { tokensMilli: capMilli, capMilli, lastMs: nowMs };
      this.buckets.set(key, bucket);
    } else if (nowMs > bucket.lastMs) {
      const elapsedMs = nowMs - bucket.lastMs;
      const addMilli = this.cfg.recordsPerSec * elapsedMs;
      bucket.tokensMilli = Math.min(bucket.capMilli, bucket.tokensMilli + addMilli);
      bucket.lastMs = nowMs;
    }
    if (bucket.tokensMilli >= 1000) {
      bucket.tokensMilli -= 1000;
      return true;
    }
    return false;
  }
}

/**
 * Injectable surface for "is at least one box_sessions row currently open"
 * -- real (`createBoxSessionGate`) or a fixed-answer fake in tests.
 * House-role nodes never consult this at all (see engine.ts); it only ever
 * changes behaviour for role='box' nodes.
 */
export interface BoxSessionGateLike {
  isOpen(): boolean;
}

/** Always reports closed -- the safe default when no live pool is wired up (e.g. a test that never injects one). */
export const CLOSED_BOX_SESSION_GATE: BoxSessionGateLike = { isOpen: () => false };

const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Built-in fallback when `config.realtime` (or its `device.maxDurationS`
 * sub-key) is omitted -- 3600s / 1 hour, the SAME literal
 * `@homecsi/api`'s `DEFAULT_DEVICE_MODE_CONFIG.maxDurationS` uses
 * (realtime/deviceModeStore.ts), reimplemented rather than shared across
 * the package boundary (no dependency edge between @homecsi/ingest and
 * @homecsi/api exists or should exist) but kept numerically identical so
 * an operator who never sets `config.realtime` still gets one consistent
 * answer to "how long can a realtime/box-take window possibly last"
 * everywhere it's enforced.
 */
export const DEFAULT_MAX_BOX_SESSION_AGE_MS = 3_600_000;

export interface BoxSessionGateOptions {
  /** How often to poll `box_sessions`. Defaults to ~once a second (per this brief). */
  intervalMs?: number;
  /**
   * An open (`ended_at IS NULL`) row older than this is treated as CLOSED,
   * not open -- reuses `config.realtime.device.maxDurationS` (the
   * realtime control plane's own hard cap on how long a realtime/box-take
   * window may run, converted to milliseconds) rather than inventing a
   * second timeout constant, so there is exactly one number an operator
   * reasons about. Without this, a session an operator forgot to close
   * (closed the tab mid-take, a crash, etc. -- migration 011 has no
   * automatic closing mechanism of its own) would bypass the
   * persisted-rate ceiling FOREVER, silently violating the "dense data
   * reaches disk only inside an explicit, short box take" invariant
   * indefinitely rather than just for the length of one take.
   */
  maxOpenAgeMs?: number;
}

/**
 * Polls `box_sessions` roughly once a second (per this brief) for an open
 * (`ended_at IS NULL`) row started no longer ago than `maxOpenAgeMs`,
 * caching the last known answer so `isOpen()` itself is a synchronous,
 * non-blocking read from the hot ingest path. An abandoned session (older
 * than the cap, `ended_at` still NULL) therefore self-heals into "closed"
 * on its own, without anyone noticing it was ever left open -- see
 * `BoxSessionGateOptions.maxOpenAgeMs`'s own comment for why this matters.
 * A poll failure logs (rate-limit is unnecessary at this cadence) and
 * keeps the last known answer rather than flipping to "closed" on a
 * transient DB hiccup -- a brief false "still open" only means a box-role
 * node keeps bypassing the ceiling a little longer, never anything that
 * touches the house pipeline. (A gate that has never once successfully
 * polled -- e.g. `box_sessions` doesn't exist yet -- starts, and stays,
 * closed: `open` is only ever set `true` by a successful poll.)
 */
export function createBoxSessionGate(
  pool: DbPool,
  logger: BasicLogger,
  options: BoxSessionGateOptions = {},
): BoxSessionGateLike & { stop(): void } {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxOpenAgeMs = options.maxOpenAgeMs ?? DEFAULT_MAX_BOX_SESSION_AGE_MS;
  let open = false;
  async function pollOnce(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - maxOpenAgeMs);
      const result = await pool.query(
        'SELECT 1 FROM box_sessions WHERE ended_at IS NULL AND started_at > $1 LIMIT 1',
        [cutoff],
      );
      open = result.rows.length > 0;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'box_sessions open-row poll failed; keeping last known answer',
      );
    }
  }
  const timer = setInterval(() => {
    void pollOnce();
  }, intervalMs).unref();

  return {
    isOpen: () => open,
    stop: () => clearInterval(timer),
  };
}
