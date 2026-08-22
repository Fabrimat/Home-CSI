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

/** Details persisted alongside each occupancy_states row — the latch's own internal state, for resumability and for the debug UI to explain "why". */
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
  details: OccupancyDetails;
}

export interface OccupancySink {
  writeStates(rows: readonly OccupancyStateRow[]): Promise<void>;
  /** Most recently written occupancy_states row, if any — used to resume the latch and the read checkpoint without a separate table. */
  loadLatest(): Promise<OccupancyStateRow | null>;
}

export interface OccupancyPipelineDeps {
  source: FeatureSource;
  sink: OccupancySink;
  fetchBatchSize?: number;
}

export interface OccupancyPipelineResult {
  ticksProcessed: number;
  statesWritten: number;
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
 */
export async function runOccupancyPipelineCore(
  config: Config,
  deps: OccupancyPipelineDeps,
): Promise<OccupancyPipelineResult> {
  const thresholds = thresholdsFromConfig(config);
  const linkCount = expectedLinkCount(config);
  const batchSize = deps.fetchBatchSize ?? 10_000;

  const latest = await deps.sink.loadLatest();
  let latchState: LatchState = latest?.details.latchState ?? INITIAL_LATCH_STATE;
  const checkpointMs = latest?.timeMs ?? null;

  const rows: FeatureRow[] = [];
  let cursor = checkpointMs;
  for (;;) {
    const batch = await deps.source.fetchFeatures(cursor, batchSize);
    if (batch.length === 0) break;
    rows.push(...batch);
    cursor = batch[batch.length - 1]!.timeMs;
    if (batch.length < batchSize) break;
  }

  if (rows.length === 0) {
    return { ticksProcessed: 0, statesWritten: 0 };
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
  for (const timeMs of tickTimes) {
    const observations = byTick.get(timeMs) as LinkObservation[];
    const result = stepLatch(latchState, observations, timeMs, thresholds, linkCount);
    latchState = result.state;
    outputRows.push({
      timeMs,
      estimate: result.estimate,
      confidence: result.confidence,
      state: result.state.state,
      details: {
        latchState: result.state,
        activeLinks: result.activeLinks,
        multiOccupancy: result.multiOccupancy,
        dataSufficiency: result.dataSufficiency,
      },
    });
  }

  if (outputRows.length > 0) {
    await deps.sink.writeStates(outputRows);
  }

  return { ticksProcessed: tickTimes.length, statesWritten: outputRows.length };
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

interface RawOccupancyStateRow {
  time: Date;
  estimate: number;
  confidence: number;
  state: string;
  details: OccupancyDetails | null;
}

function createPgOccupancySink(pool: DbPool): OccupancySink {
  return {
    async writeStates(rows) {
      if (rows.length === 0) return;
      const values: unknown[] = [];
      const tuples: string[] = [];
      rows.forEach((row, i) => {
        const base = i * 5;
        tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
        values.push(
          new Date(row.timeMs).toISOString(),
          row.estimate,
          row.confidence,
          row.state,
          JSON.stringify(row.details),
        );
      });
      await pool.query(
        `INSERT INTO occupancy_states (time, estimate, confidence, state, details) VALUES ${tuples.join(', ')}`,
        values,
      );
    },

    async loadLatest() {
      const result = await pool.query<RawOccupancyStateRow>(
        `SELECT time, estimate, confidence, state, details FROM occupancy_states ORDER BY time DESC LIMIT 1`,
      );
      const row = result.rows[0];
      if (!row || !row.details) return null;
      return {
        timeMs: row.time.getTime(),
        estimate: row.estimate as 0 | 1 | 2,
        confidence: row.confidence,
        state: row.state,
        details: row.details,
      };
    },
  };
}

/**
 * Runs the latched occupancy state machine pipeline against real
 * TimescaleDB tables: reads `features`, integrates motion transitions per
 * `config.occupancy`, and writes `occupancy_states`. See
 * runOccupancyPipelineCore for the DB-independent logic and
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
