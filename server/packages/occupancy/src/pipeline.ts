import type { Config } from '@homecsi/config';
import { createPool, type DbPool } from '@homecsi/db';
import {
  INITIAL_LATCH_STATE,
  stepLatch,
  type LatchState,
  type LatchThresholds,
  type LinkObservation,
  type MultiOccupancyResult,
} from './stateMachine.js';

/**
 * How long the log may stay silent before the pipeline records a
 * "nothing changed, and I was here" row.
 *
 * `occupancy_states` is a sparse *event* log — one row per transition, kept
 * essentially forever (see README.md). A pure diff stream cannot distinguish
 * "nobody moved for eight hours" from "the pipeline was down for eight
 * hours", so a keepalive row is emitted when the last written row is older
 * than this interval **in tick time**. Tick time, not wall-clock: the
 * pipeline is a one-shot batch CLI, not a daemon, so "now" is meaningless to
 * it — the only honest clock is the timestamp of the feature ticks it is
 * actually processing. A batch with zero ticks therefore emits nothing at
 * all, and the resulting gap honestly means "no whole-house observations".
 */
export const KEEPALIVE_INTERVAL_MS = 15 * 60 * 1000;

/** One row read from the `features` hypertable, reduced to what this pipeline needs. */
export interface FeatureRow {
  timeMs: number;
  nodeId: number;
  linkMac: string;
  /** From @homecsi/features' LinkFeatureVector.baselineDeviation — the primary motion signal. */
  baselineDeviation: number;
}

export interface FeatureSource {
  /** Same paging contract as @homecsi/features' CsiRecordSource: rows strictly after `sinceExclusiveMs`, ascending by time, capped at `limit`. */
  fetchFeatures(sinceExclusiveMs: number | null, limit: number): Promise<FeatureRow[]>;
}

/**
 * Why a row exists, machine-readably (`occupancy_states.row_kind`):
 *  - `transition` — the estimate and/or the latch's internal state label
 *    actually changed at this tick. These are the semantic events the log
 *    exists to record.
 *  - `keepalive` — nothing changed, but KEEPALIVE_INTERVAL_MS of tick time
 *    has passed since the last row, so this one proves the pipeline was
 *    running and observing. Deliberately thin: no `details` payload.
 */
export type OccupancyRowKind = 'transition' | 'keepalive';

/** Details persisted alongside each *transition* row — the latch's own internal state, for the debug UI to explain "why". Resume no longer reads this (see `occupancy_checkpoint`). */
export interface OccupancyDetails {
  latchState: LatchState;
  activeLinks: string[];
  multiOccupancy: MultiOccupancyResult;
  dataSufficiency: number;
}

export interface OccupancyStateRow {
  timeMs: number;
  estimate: 0 | 1 | 2;
  confidence: number;
  state: string;
  kind: OccupancyRowKind;
  /** Always null on `keepalive` rows. */
  details: OccupancyDetails | null;
}

/** The last row this pipeline wrote — what the change detector compares against, and what the keepalive clock counts from. */
export interface LastWrittenRow {
  timeMs: number;
  estimate: 0 | 1 | 2;
  state: string;
}

/**
 * The singleton `occupancy_checkpoint` row.
 *
 * This used to be derived from the most recent `occupancy_states` row
 * ("resume the latch and the read checkpoint without a separate table").
 * That stopped being safe the moment rows became sparse: `occupancy_states`
 * has no unique constraint on `time` and the write is a plain INSERT, so a
 * checkpoint of "time of the last written row" makes every rerun replay
 * every tick since the last *transition* — and since the latch is
 * deterministic, re-detect and re-INSERT those same transitions as
 * duplicates, corrupting the forever-log. The read cursor must therefore be
 * the last tick *processed*, which is a different thing from the last tick
 * *written*.
 */
export interface OccupancyCheckpoint {
  /** Exclusive read cursor into `features`: the timestamp of the last tick processed. */
  lastTickMs: number;
  /** The latch's internal state after that tick — how a fresh process resumes. */
  latchState: LatchState;
  /** The last row written to `occupancy_states`, or null if none has ever been written. */
  lastWritten: LastWrittenRow | null;
}

export interface OccupancySink {
  /** The singleton checkpoint, or null on a virgin install. */
  loadCheckpoint(): Promise<OccupancyCheckpoint | null>;
  /**
   * Appends `rows` to `occupancy_states` and advances the checkpoint **in a
   * single transaction**. Both or neither: a failure between the two would
   * otherwise leave rows written but the cursor un-advanced, and the next
   * run would re-derive and re-insert the very same transitions.
   */
  commit(rows: readonly OccupancyStateRow[], checkpoint: OccupancyCheckpoint): Promise<void>;
}

export interface OccupancyPipelineDeps {
  source: FeatureSource;
  sink: OccupancySink;
  fetchBatchSize?: number;
}

export interface OccupancyPipelineResult {
  ticksProcessed: number;
  /** transitionsWritten + keepalivesWritten. */
  statesWritten: number;
  transitionsWritten: number;
  keepalivesWritten: number;
}

function thresholdsFromConfig(config: Config): LatchThresholds {
  return {
    motionOnThreshold: config.occupancy.thresholds.motionOnThreshold,
    motionOffThreshold: config.occupancy.thresholds.motionOffThreshold,
    latchDecayHorizonMs: config.occupancy.latchDecayHorizonMs,
    hysteresisMs: config.occupancy.hysteresisMs,
    crossNodeSimultaneityThresholdMs: config.occupancy.multiOccupancy.crossNodeSimultaneityThresholdMs,
  };
}

/**
 * Expected number of distinct links for the configured mesh: N node-to-AP
 * links + N*(N-1) directional node-to-node links = N^2 (see
 * docs/architecture.md "broadcast-sounding mesh"). Used only to scale the
 * `dataSufficiency` component of confidence — not a hard requirement.
 */
function expectedLinkCount(config: Config): number {
  const n = config.nodes.length;
  return n * n;
}

/**
 * Core pipeline logic, decoupled from Postgres via `deps` — this is what
 * tests drive with in-memory fakes. `runOccupancyPipeline` below wires this
 * up to the real `features`/`occupancy_states` tables for CLI use.
 *
 * Write semantics (see README.md): one row per *change*, plus a keepalive
 * every KEEPALIVE_INTERVAL_MS of tick time. Every run that processed at
 * least one tick advances the checkpoint, even if it wrote no rows.
 */
export async function runOccupancyPipelineCore(
  config: Config,
  deps: OccupancyPipelineDeps,
): Promise<OccupancyPipelineResult> {
  const thresholds = thresholdsFromConfig(config);
  const linkCount = expectedLinkCount(config);
  const batchSize = deps.fetchBatchSize ?? 10_000;

  const checkpoint = await deps.sink.loadCheckpoint();
  let latchState: LatchState = checkpoint?.latchState ?? INITIAL_LATCH_STATE;
  let lastWritten: LastWrittenRow | null = checkpoint?.lastWritten ?? null;

  const rows: FeatureRow[] = [];
  let cursor = checkpoint?.lastTickMs ?? null;
  for (;;) {
    const batch = await deps.source.fetchFeatures(cursor, batchSize);
    if (batch.length === 0) break;
    rows.push(...batch);
    cursor = batch[batch.length - 1]!.timeMs;
    if (batch.length < batchSize) break;
  }

  if (rows.length === 0) {
    // Zero observations: write nothing, not even a keepalive, and do not
    // touch the checkpoint. The resulting gap in the log means exactly what
    // it looks like — the pipeline had nothing to look at.
    return { ticksProcessed: 0, statesWritten: 0, transitionsWritten: 0, keepalivesWritten: 0 };
  }

  // Group into ticks: every features row sharing the same window-end
  // timestamp is one whole-house observation instant. Feature windows are
  // computed on a shared hop-grid (see @homecsi/features windowing.ts), so
  // links using the same config.features.windowMs/hopMs naturally align.
  const byTick = new Map<number, LinkObservation[]>();
  for (const row of rows) {
    const list = byTick.get(row.timeMs) ?? [];
    list.push({ linkKey: `${row.nodeId}:${row.linkMac}`, baselineDeviation: row.baselineDeviation });
    byTick.set(row.timeMs, list);
  }
  const tickTimes = [...byTick.keys()].sort((a, b) => a - b);

  const outputRows: OccupancyStateRow[] = [];
  let transitionsWritten = 0;
  let keepalivesWritten = 0;

  for (const timeMs of tickTimes) {
    const observations = byTick.get(timeMs) as LinkObservation[];
    const result = stepLatch(latchState, observations, timeMs, thresholds, linkCount);
    latchState = result.state;

    const changed =
      lastWritten === null || lastWritten.estimate !== result.estimate || lastWritten.state !== result.state.state;
    const keepaliveDue = lastWritten !== null && timeMs - lastWritten.timeMs >= KEEPALIVE_INTERVAL_MS;

    if (!changed && !keepaliveDue) continue;

    if (changed) {
      transitionsWritten += 1;
      outputRows.push({
        timeMs,
        estimate: result.estimate,
        confidence: result.confidence,
        state: result.state.state,
        kind: 'transition',
        details: {
          latchState: result.state,
          activeLinks: result.activeLinks,
          multiOccupancy: result.multiOccupancy,
          dataSufficiency: result.dataSufficiency,
        },
      });
    } else {
      keepalivesWritten += 1;
      outputRows.push({
        timeMs,
        estimate: result.estimate,
        confidence: result.confidence,
        state: result.state.state,
        kind: 'keepalive',
        details: null,
      });
    }

    lastWritten = { timeMs, estimate: result.estimate, state: result.state.state };
  }

  await deps.sink.commit(outputRows, {
    lastTickMs: tickTimes[tickTimes.length - 1] as number,
    latchState,
    lastWritten,
  });

  return {
    ticksProcessed: tickTimes.length,
    statesWritten: outputRows.length,
    transitionsWritten,
    keepalivesWritten,
  };
}

// ---------------------------------------------------------------------
// Real Postgres-backed source/sink, used by the CLI entry point.
// ---------------------------------------------------------------------

interface RawFeatureRow {
  time: Date;
  node_id: number;
  link_mac: string;
  feature_vector: { baselineDeviation?: number };
}

function createPgFeatureSource(pool: DbPool): FeatureSource {
  return {
    async fetchFeatures(sinceExclusiveMs, limit) {
      const sinceIso = sinceExclusiveMs === null ? null : new Date(sinceExclusiveMs).toISOString();
      const result = await pool.query<RawFeatureRow>(
        `SELECT time, node_id, link_mac, feature_vector
         FROM features
         WHERE ($1::timestamptz IS NULL OR time > $1::timestamptz)
           AND link_mac IS NOT NULL
         ORDER BY time ASC
         LIMIT $2`,
        [sinceIso, limit],
      );
      return result.rows.map((r) => ({
        timeMs: r.time.getTime(),
        nodeId: r.node_id,
        linkMac: r.link_mac,
        baselineDeviation: r.feature_vector.baselineDeviation ?? 0,
      }));
    },
  };
}

interface RawCheckpointRow {
  last_tick_ms: string;
  latch_state: Partial<LatchState> | null;
  last_written_tick_ms: string | null;
  last_estimate: number | null;
  last_state: string | null;
}

interface RawLegacyStateRow {
  time: Date;
  estimate: number;
  state: string;
  details: { latchState?: Partial<LatchState> } | null;
}

/**
 * Fills in any field missing from a `latch_state` JSONB blob written by an
 * older build. This is a trust boundary — the value comes back from the
 * database as untyped JSON — so every field is defaulted rather than
 * assumed present.
 */
function latchStateFromJson(raw: Partial<LatchState> | null | undefined): LatchState {
  return {
    state: raw?.state ?? INITIAL_LATCH_STATE.state,
    lastEstimateChangeAtMs: raw?.lastEstimateChangeAtMs ?? null,
    lastMotionAtMs: raw?.lastMotionAtMs ?? null,
    linkActive: raw?.linkActive ?? {},
    activeSinceMs: raw?.activeSinceMs ?? {},
    lastSeenMs: raw?.lastSeenMs ?? {},
  };
}

function clampEstimate(value: number): 0 | 1 | 2 {
  return value <= 0 ? 0 : value === 1 ? 1 : 2;
}

/**
 * Postgres-backed sink over `occupancy_states` (append-only event log) plus
 * the singleton `occupancy_checkpoint` row (migration 006). Exported so its
 * transactionality can be tested against a fake client — see
 * pipeline.test.ts.
 */
export function createPgOccupancySink(pool: DbPool): OccupancySink {
  return {
    async loadCheckpoint() {
      const result = await pool.query<RawCheckpointRow>(
        `SELECT last_tick_ms, latch_state, last_written_tick_ms, last_estimate, last_state
         FROM occupancy_checkpoint
         WHERE singleton`,
      );
      const row = result.rows[0];
      if (row) {
        return {
          lastTickMs: Number(row.last_tick_ms),
          latchState: latchStateFromJson(row.latch_state),
          lastWritten:
            row.last_written_tick_ms === null || row.last_estimate === null || row.last_state === null
              ? null
              : {
                  timeMs: Number(row.last_written_tick_ms),
                  estimate: clampEstimate(row.last_estimate),
                  state: row.last_state,
                },
        };
      }

      // No checkpoint row yet. If `occupancy_states` already has history
      // (an install that ran before migration 006), bootstrap from its most
      // recent row rather than starting from scratch — starting over would
      // re-derive every past transition and append it a second time.
      const legacy = await pool.query<RawLegacyStateRow>(
        `SELECT time, estimate, state, details FROM occupancy_states ORDER BY time DESC LIMIT 1`,
      );
      const last = legacy.rows[0];
      if (!last) return null;
      return {
        lastTickMs: last.time.getTime(),
        latchState: latchStateFromJson(last.details?.latchState),
        lastWritten: {
          timeMs: last.time.getTime(),
          estimate: clampEstimate(last.estimate),
          state: last.state,
        },
      };
    },

    async commit(rows, checkpoint) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (rows.length > 0) {
          const values: unknown[] = [];
          const tuples: string[] = [];
          rows.forEach((row, i) => {
            const base = i * 6;
            tuples.push(
              `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
            );
            values.push(
              new Date(row.timeMs).toISOString(),
              row.estimate,
              row.confidence,
              row.state,
              row.kind,
              row.details === null ? null : JSON.stringify(row.details),
            );
          });
          // ON CONFLICT DO NOTHING against the unique (time) index added in
          // migration 006: belt and braces on top of the transaction below,
          // so even a hand-run duplicate batch cannot double-write history.
          await client.query(
            `INSERT INTO occupancy_states (time, estimate, confidence, state, row_kind, details)
             VALUES ${tuples.join(', ')}
             ON CONFLICT (time) DO NOTHING`,
            values,
          );
        }

        await client.query(
          `INSERT INTO occupancy_checkpoint
             (singleton, last_tick_ms, latch_state, last_written_tick_ms, last_estimate, last_state, updated_at)
           VALUES (true, $1, $2, $3, $4, $5, now())
           ON CONFLICT (singleton) DO UPDATE SET
             last_tick_ms = EXCLUDED.last_tick_ms,
             latch_state = EXCLUDED.latch_state,
             last_written_tick_ms = EXCLUDED.last_written_tick_ms,
             last_estimate = EXCLUDED.last_estimate,
             last_state = EXCLUDED.last_state,
             updated_at = EXCLUDED.updated_at`,
          [
            checkpoint.lastTickMs,
            JSON.stringify(checkpoint.latchState),
            checkpoint.lastWritten?.timeMs ?? null,
            checkpoint.lastWritten?.estimate ?? null,
            checkpoint.lastWritten?.state ?? null,
          ],
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Runs the latched occupancy state machine pipeline against real
 * TimescaleDB tables: reads `features`, integrates motion transitions per
 * `config.occupancy`, and appends transition/keepalive rows to
 * `occupancy_states`. See runOccupancyPipelineCore for the DB-independent
 * logic, README.md for the write semantics, and
 * packages/cli/CONTRACTS.md ("occupancy") for this function's contract.
 */
export async function runOccupancyPipeline(config: Config): Promise<void> {
  const pool = createPool(config.database);
  try {
    await runOccupancyPipelineCore(config, {
      source: createPgFeatureSource(pool),
      sink: createPgOccupancySink(pool),
    });
  } finally {
    await pool.end();
  }
}
