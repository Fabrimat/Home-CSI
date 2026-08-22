import type { DbPool } from '@homecsi/db';
import { isWeakLabel, type LabelSession } from './sessions.js';

/**
 * Injectable access to the `features` -> `training_features` copy-out
 * (docs/architecture.md "Data lifecycle", migration 007). Two operations
 * only: count what's currently known for a window across BOTH tables (used
 * for the fail-loud past-retention check in `preserveSessionFeatures`), and
 * copy a window out, idempotently. Injectable so tests never need a live
 * Postgres (see packages/db's existing pattern).
 */
export interface TrainingFeaturesStore {
  /**
   * Number of distinct (time, node_id, link_mac) raw per-link rows within
   * [fromMs, toMs], counted across `features` UNIONed with
   * `training_features` (same dedup trick `featuresSource.ts` uses for
   * reads) -- NOT `features` alone.
   *
   * This matters for the fail-loud density check in
   * `preserveSessionFeatures`: a window that was already preserved and has
   * since aged out of `features` (migration 007's 7-day retention dropped
   * its chunk) must count as "still found" via `training_features`, not as
   * "lost". Counting `features` alone cannot distinguish that case from a
   * window that was NEVER preserved and genuinely lost its rows to
   * retention -- both would read as `found = 0` -- which is exactly the bug
   * this dedup union fixes: every successfully-preserved session older than
   * 7 days would otherwise fail every future `label preserve` sweep
   * forever, once its `features` rows age out.
   */
  countFeatureRows(fromMs: number, toMs: number): Promise<number>;
  /**
   * Copies `features` rows within [fromMs, toMs] into `training_features`,
   * `ON CONFLICT (time, node_id, link_mac) DO NOTHING`. Returns the number
   * of rows actually inserted (0 on a fully-duplicate re-run — this is
   * what makes preservation safe to attempt more than once for the same
   * window, e.g. from both the session-close hook and the CLI sweep).
   */
  preserveWindow(fromMs: number, toMs: number): Promise<number>;
}

/**
 * Real Postgres-backed TrainingFeaturesStore. Both operations are plain
 * SQL against `features`/`training_features` directly — no row ever
 * round-trips through Node, matching migration 007's "copy out, don't
 * hand-roll deletion" design (a single INSERT ... SELECT ... ON CONFLICT,
 * not a fetch-then-insert loop).
 */
export function createPgTrainingFeaturesStore(pool: DbPool): TrainingFeaturesStore {
  return {
    async countFeatureRows(fromMs, toMs) {
      // UNION (not UNION ALL) de-dupes a row that currently exists in both
      // tables (already preserved, not yet aged out of `features`) so it
      // isn't double-counted -- see the interface doc comment above and
      // featuresSource.ts's identical trick for reads.
      const result = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM (
           SELECT time, node_id, link_mac FROM features
           WHERE time >= $1::timestamptz AND time <= $2::timestamptz AND link_mac IS NOT NULL
           UNION
           SELECT time, node_id, link_mac FROM training_features
           WHERE time >= $1::timestamptz AND time <= $2::timestamptz
         ) AS combined`,
        [new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    async preserveWindow(fromMs, toMs) {
      const result = await pool.query(
        `INSERT INTO training_features (time, node_id, link_mac, window_ms, feature_vector)
         SELECT time, node_id, link_mac, window_ms, feature_vector
         FROM features
         WHERE time >= $1::timestamptz AND time <= $2::timestamptz AND link_mac IS NOT NULL
         ON CONFLICT (time, node_id, link_mac) DO NOTHING`,
        [new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
      );
      return result.rowCount ?? 0;
    },
  };
}

/**
 * In-memory TrainingFeaturesStore, used by tests. `seedFeatures` stands in
 * for whatever is currently live in the real `features` table;
 * `seedTrainingFeatures` stands in for rows that already exist in
 * `training_features` before the store is ever used -- e.g. to simulate "a
 * session was preserved in a previous run and its `features` rows have
 * since aged out of retention" without needing two separate stores.
 */
export function createInMemoryTrainingFeaturesStore(
  seedFeatures: readonly { timeMs: number; nodeId: number; linkMac: string }[] = [],
  seedTrainingFeatures: readonly { timeMs: number; nodeId: number; linkMac: string }[] = [],
): TrainingFeaturesStore {
  const key = (f: { timeMs: number; nodeId: number; linkMac: string }): string =>
    `${f.timeMs}:${f.nodeId}:${f.linkMac}`;
  const preserved = new Set<string>(seedTrainingFeatures.map(key));
  return {
    async countFeatureRows(fromMs, toMs) {
      // Mirrors the real store's UNION dedup: a row present in `features`
      // AND already preserved into `training_features` must only count
      // once.
      const keys = new Set<string>();
      for (const f of seedFeatures) {
        if (f.timeMs >= fromMs && f.timeMs <= toMs) keys.add(key(f));
      }
      for (const k of preserved) {
        const timeMs = Number(k.split(':')[0]);
        if (timeMs >= fromMs && timeMs <= toMs) keys.add(k);
      }
      return keys.size;
    },
    async preserveWindow(fromMs, toMs) {
      let inserted = 0;
      for (const f of seedFeatures) {
        if (f.timeMs < fromMs || f.timeMs > toMs) continue;
        const k = key(f);
        if (!preserved.has(k)) {
          preserved.add(k);
          inserted++;
        }
      }
      return inserted;
    },
  };
}

/**
 * config.features.windowMs plus the (optional, defaulted) `training`
 * config section reduced to what preservation needs.
 */
export interface PreservationConfig {
  /** config.features.windowMs — the same join tolerance dataset export/train already use, rather than inventing a second one. */
  toleranceMs: number;
  /**
   * Length of the recent "known-alive" window used as this deployment's
   * live feature-row density baseline (see `checkDensity`) —
   * config.training.preservation.baselineWindowMs, or
   * `DEFAULT_BASELINE_WINDOW_MS` if that section is omitted.
   */
  baselineWindowMs: number;
  /**
   * Minimum fraction of that live baseline's density a preserved window
   * must show to be treated as healthy — config.training.preservation.minDensityFraction,
   * or `DEFAULT_MIN_DENSITY_FRACTION` if omitted. 0 disables the check.
   */
  minDensityFraction: number;
  /**
   * config.storage.retention.maxAgeMs — the same 7-day debug-window clock
   * `retentionWarning.ts` already watches. OPTIONAL: when omitted,
   * `preserveSessionFeatures` keeps its original always-fail-loud
   * behaviour (every existing caller/test that builds this config without
   * knowing about the distinction below keeps working unmodified);
   * production wiring (index.ts) always supplies it. When supplied, a
   * session whose window is entirely past this age with literally zero
   * feature rows found anywhere degrades to a `'permanently-lost'` result
   * instead of throwing — see `preserveSessionFeatures`'s doc comment for
   * why that distinction matters for a scheduled sweep.
   */
  retentionMaxAgeMs?: number;
}

/** Built-in fallback for `PreservationConfig.baselineWindowMs` when `config.training` is omitted: 1 hour. */
export const DEFAULT_BASELINE_WINDOW_MS = 60 * 60 * 1000;
/** Built-in fallback for `PreservationConfig.minDensityFraction` when `config.training` is omitted: 0.5. */
export const DEFAULT_MIN_DENSITY_FRACTION = 0.5;

export interface PreserveResult {
  status: 'preserved' | 'skipped-weak';
  sessionId: number;
  fromMs: number;
  toMs: number;
  found: number;
  inserted: number;
  /**
   * True if the density sanity-check (see `checkDensity`) could not run
   * because no live baseline data was available (e.g. a brand-new
   * deployment, or the features pipeline not currently running) — the
   * window was still preserved using `found` as-is, just without the
   * safety check. Always `false` for `status: 'skipped-weak'` and when
   * `minDensityFraction` is 0 (check deliberately disabled, not merely
   * unavailable).
   */
  densityCheckSkipped: boolean;
}

/**
 * A session's window is entirely past the retention deadline
 * (`config.storage.retention.maxAgeMs`) with literally zero feature rows
 * found anywhere (`features` UNION `training_features`) — re-running
 * `label preserve` against it can never recover anything; the density
 * check's own error text already says as much. Modeled as its own status
 * rather than a thrown error specifically so a scheduled sweep does not
 * exit non-zero FOREVER after the first such session — see
 * `preserveSessionFeatures`'s doc comment.
 */
export interface PermanentlyLostResult {
  status: 'permanently-lost';
  sessionId: number;
  fromMs: number;
  toMs: number;
}

/** Everything `preserveSessionFeatures` can resolve to without throwing. */
export type PreserveOutcome = PreserveResult | PermanentlyLostResult;

export type DensityCheckResult =
  | { kind: 'disabled' }
  | { kind: 'no-baseline' }
  | { kind: 'checked'; expected: number };

/**
 * Sanity-checks a preserved window's row density against this
 * deployment's OWN recent live density, rather than against an assumed
 * mesh topology. Earlier versions of this check used a flat "at least 1
 * row" floor (missed all but near-total data loss) and then a
 * theoretical N^2-link floor (assumed every node hears every other node —
 * false for a real multi-room house with attenuated node-to-node
 * audibility, which would false-alarm on a perfectly healthy, partial
 * mesh). Comparing against a live baseline self-calibrates to whatever
 * this specific deployment's mesh/audibility actually produces, so a
 * partial-but-stable mesh reads as 100% of baseline (no false alarm),
 * while a session that lost rows to an outage or a retention-boundary
 * drop reads as a real shortfall relative to that same baseline.
 *
 * Returns `{ kind: 'disabled' }` if `minDensityFraction <= 0` (operator
 * opt-out), `{ kind: 'no-baseline' }` if the baseline window itself has no
 * rows (bootstrap case — nothing to compare against yet, so the caller
 * should degrade to a warning rather than an error), or
 * `{ kind: 'checked', expected }` with the computed floor otherwise.
 *
 * KNOWN LIMITATIONS of the baseline-relative approach. Both are accepted
 * rather than solved: this check throws *before* `preserveWindow` runs, so
 * a wrong verdict blocks a copy but never destroys anything, and
 * `minDensityFraction` / `baselineWindowMs` are operator-tunable. Neither
 * is a silent-data-loss path.
 *
 * 1. **Self-reference at session close.** The baseline is measured over
 *    `[nowMs - baselineWindowMs, nowMs]`, and preservation normally fires
 *    when a session closes — so the baseline can overlap the session
 *    itself. If the whole deployment was degraded for that entire span
 *    (nodes offline, ingest down), baseline and target are both low, the
 *    ratio looks healthy, and the check passes vacuously on genuinely
 *    degraded data. Running `label preserve` later, once the mesh is
 *    healthy again, gives a meaningful baseline and a real verdict.
 * 2. **Topology changes over time.** The baseline reflects the mesh as it
 *    is *now*; the target window may predate a change to it. Growing the
 *    deployment (this project plans 4 nodes -> 9) makes an older,
 *    legitimately-sparser window read as a false shortfall; shrinking it
 *    gives the opposite, a false pass. This bites the `label preserve`
 *    sweep backstop rather than the session-close hook, since only the
 *    sweep runs against windows old enough for the topology to have moved.
 *    A false positive here is only recoverable while the underlying
 *    `features` rows are still inside their retention window (7 days,
 *    migration 007) — past that, re-running cannot help.
 */
export async function checkDensity(
  store: TrainingFeaturesStore,
  windowDurationMs: number,
  config: PreservationConfig,
  nowMs: number,
): Promise<DensityCheckResult> {
  if (config.minDensityFraction <= 0) {
    return { kind: 'disabled' };
  }

  const baselineFromMs = nowMs - config.baselineWindowMs;
  const baselineCount = await store.countFeatureRows(baselineFromMs, nowMs);
  if (baselineCount <= 0) {
    return { kind: 'no-baseline' };
  }

  const baselineDensityPerMs = baselineCount / config.baselineWindowMs;
  const expected = Math.max(1, Math.ceil(baselineDensityPerMs * windowDurationMs * config.minDensityFraction));
  return { kind: 'checked', expected };
}

function sessionWindow(
  session: Pick<LabelSession, 'startedAtMs' | 'endedAtMs'>,
  toleranceMs: number,
  nowMs: number,
): { fromMs: number; toMs: number } {
  const endMs = session.endedAtMs ?? nowMs;
  return { fromMs: session.startedAtMs - toleranceMs, toMs: endMs + toleranceMs };
}

/**
 * Preserves one MANUAL label session's raw per-link feature rows into
 * `training_features`, for future retraining, before the 7-day `features`
 * retention policy (migration 007) drops them. Called from the
 * `label session stop` hook (the natural moment — data is guaranteed
 * alive if the session is under 7 days old) and from the `label preserve`
 * CLI sweep backstop (index.ts) for sessions the hook missed.
 *
 * Weak/presence-probe sessions (`isWeakLabel`, see sessions.ts) are
 * deliberately skipped, not merely "also preserved to be safe" — an
 * always-on presence-probe cron (`label presence probe`) writes a weak
 * label roughly every time it's run, so preserving raw per-link features
 * for "any labelled window" would make `training_features` converge on
 * ALL of `features`, defeating the retention policy this preservation
 * exists alongside. Weak labels are re-derivable from the labels
 * themselves plus whatever manual-window features are preserved; dataset
 * export still includes them as the reduced whole-house `DatasetRow`
 * (joinLabelsWithFeatures) — they just never get raw per-link
 * preservation here.
 *
 * KNOWN LIMITATION: the manual-vs-weak distinction here is notes-string
 * based (`isWeakLabel` pattern-matches `session.notes`), not provenance
 * based — there is no column recording how a session was actually
 * created (see sessions.ts's own comment on why: avoiding a new
 * `label_sessions` column). A session created via the normal manual flow
 * (`label session start`) whose notes a human happens to type starting
 * with the weak-label prefix (`[weak:phone-presence]`) would be silently
 * excluded from raw per-link preservation here, same as a real weak
 * session. Low probability (that prefix is not something an operator
 * would type by accident), but real — noted here rather than fixed,
 * since fixing it means a schema/provenance change out of this brief's
 * scope.
 *
 * Fails loudly (throws, naming the window and expected-vs-found row
 * counts) rather than silently under-preserving if the window already
 * looks partially or fully past retention, or if a meaningful part of
 * the mesh was down during it — see `checkDensity`. Silent degradation
 * here would produce a silently poisoned training set, directly against
 * the point of this preservation existing at all.
 *
 * EXCEPTION, when `config.retentionMaxAgeMs` is supplied: if the window is
 * entirely past that retention deadline AND `found` is exactly zero (not
 * merely below the density threshold — genuinely nothing anywhere), this
 * returns a `'permanently-lost'` result instead of throwing. The dashboard
 * deliberately allows creating a correction whose time already predates
 * the 7-day retention window ("will still be recorded, but cannot be
 * preserved") — every such correction becomes a closed session that would
 * otherwise fail this exact check on EVERY future `label preserve` sweep
 * forever, burying every genuinely new, actionable failure under a
 * permanent non-zero exit code. A window that is only PARTIALLY past
 * retention, or has some-but-not-enough rows, still throws — that case is
 * still (barely) actionable via `homecsi replay` and must stay loud.
 *

 * IMPORTANT: `found` (via `TrainingFeaturesStore.countFeatureRows`) counts
 * across `features` AND `training_features` together, not `features`
 * alone — otherwise a session that was already safely preserved, whose
 * `features` chunk has since been legitimately dropped by 7-day retention,
 * would read as `found = 0` and throw here forever on every future call
 * (there would be no way to tell "lost" from "already preserved" apart).
 * A genuinely-lost window — never preserved, and past retention in
 * `features` — still has zero rows in *either* table and still throws.
 */
export async function preserveSessionFeatures(
  session: Pick<LabelSession, 'id' | 'startedAtMs' | 'endedAtMs' | 'notes'>,
  store: TrainingFeaturesStore,
  config: PreservationConfig,
  nowMs: number = Date.now(),
): Promise<PreserveOutcome> {
  if (isWeakLabel(session.notes)) {
    return {
      status: 'skipped-weak',
      sessionId: session.id,
      fromMs: 0,
      toMs: 0,
      found: 0,
      inserted: 0,
      densityCheckSkipped: false,
    };
  }

  const { fromMs, toMs } = sessionWindow(session, config.toleranceMs, nowMs);
  const durationMs = Math.max(toMs - fromMs, 0);
  const found = await store.countFeatureRows(fromMs, toMs);

  const density = await checkDensity(store, durationMs, config, nowMs);
  const densityCheckSkipped = density.kind === 'no-baseline';

  if (density.kind === 'checked' && found < density.expected) {
    const entirelyPastRetention =
      config.retentionMaxAgeMs !== undefined && nowMs - toMs > config.retentionMaxAgeMs;
    if (entirelyPastRetention && found === 0) {
      return { status: 'permanently-lost', sessionId: session.id, fromMs, toMs };
    }
    throw new Error(
      `training-set preservation for label session #${session.id} ` +
        `(${new Date(fromMs).toISOString()} .. ${new Date(toMs).toISOString()}) found fewer feature rows ` +
        `than expected: expected >= ${density.expected}, found ${found} (counted across \`features\` AND ` +
        `\`training_features\`, so this is not simply "not yet preserved") -- based on this deployment's own ` +
        `live \`features\` density over the last ${config.baselineWindowMs}ms, not an assumed link count. This ` +
        `window is likely partially or fully past the features retention window (migration 007, 7 days) AND was ` +
        `never preserved, or a meaningful part of the mesh was down during it. This session's raw per-link ` +
        `features may be permanently lost for retraining; if the raw captures for this window are still within ` +
        `their own retention window, replay them now (\`homecsi replay\`) before they age out too. If this deployment's ` +
        `mesh legitimately never reaches this density (e.g. right after installing new nodes), tune or disable ` +
        `the check via config.training.preservation.minDensityFraction.`,
    );
  }

  const inserted = await store.preserveWindow(fromMs, toMs);
  return { status: 'preserved', sessionId: session.id, fromMs, toMs, found, inserted, densityCheckSkipped };
}

export interface SweepErrorResult {
  status: 'error';
  sessionId: number;
  error: string;
}

export type SweepResult = PreserveOutcome | SweepErrorResult;

/**
 * CLI-sweep backstop (`homecsi label preserve`, index.ts): attempts to
 * preserve every given session's window, independent of whether the
 * session-close hook already ran for it (`preserveSessionFeatures` is
 * idempotent via `ON CONFLICT DO NOTHING`, so re-attempting an
 * already-preserved session is cheap and harmless — this holds regardless
 * of session age: `countFeatureRows` counts across `features` AND
 * `training_features`, so a session preserved long enough ago that its
 * `features` chunk has since aged out of the 7-day retention window still
 * reads as fully found, not lost). This exists because sessions sometimes
 * get left open (no `session stop` ever called) or the close hook itself
 * fails after the session row is already updated (see
 * `preserveSessionFeatures`'s fail-loud behaviour) — either way, this
 * sweep is the backstop that still gets the window preserved once run, and
 * is safe to run standing (e.g. on a timer) against an entire deployment's
 * session history without alarming on sessions it already preserved.
 *
 * Unlike calling `preserveSessionFeatures` directly from the close hook,
 * one session's failure here does not stop the others from being
 * attempted — errors are collected per-session and reported at the end,
 * rather than aborting the whole sweep at the first bad session.
 */
export async function sweepPreserveTrainingFeatures(
  sessions: readonly Pick<LabelSession, 'id' | 'startedAtMs' | 'endedAtMs' | 'notes'>[],
  store: TrainingFeaturesStore,
  config: PreservationConfig,
  nowMs: number = Date.now(),
): Promise<SweepResult[]> {
  const results: SweepResult[] = [];
  for (const session of sessions) {
    try {
      results.push(await preserveSessionFeatures(session, store, config, nowMs));
    } catch (err) {
      results.push({
        status: 'error',
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
