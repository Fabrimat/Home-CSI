import type { Config } from '@homecsi/config';
import { createPool, type DbPool } from '@homecsi/db';
import type { BaselineSnapshot } from './baseline.js';
import { computeWindowFeature, type CsiSample, type LinkFeatureVector } from './featureVector.js';
import { buildWindows, type TimedSample } from './windowing.js';

/** One raw CSI record read from `csi_records`, reduced to what this pipeline needs. */
export interface CsiRecordRow {
  timeMs: number;
  nodeId: number;
  /**
   * The "other end" of this vantage point: the MAC that transmitted the
   * captured frame (`src_mac`). A link is identified by (nodeId, linkMac) —
   * the *observing* node plus the *transmitting* peer — which is exactly
   * the per-link granularity docs/architecture.md describes (a node-to-node
   * or node-to-AP directional vantage point), not a per-node aggregate.
   */
  linkMac: string;
  rssi: number;
  csiFormat: number;
  csiData: Buffer;
}

/** Injectable source of raw CSI records, so tests never need a live Postgres (see packages/db's existing pattern). */
export interface CsiRecordSource {
  /**
   * Returns records strictly after `sinceExclusiveMs` (or from the
   * beginning of the table if `null`), ordered ascending by time, capped at
   * `limit` rows. Callers page through by repeatedly calling this with the
   * last returned record's `timeMs` until an array shorter than `limit`
   * comes back.
   */
  fetchRecords(sinceExclusiveMs: number | null, limit: number): Promise<CsiRecordRow[]>;
}

/** One row of the `features` hypertable. */
export interface FeatureRow {
  /** Stored as the window's *end* time — the moment the feature became fully known. */
  timeMs: number;
  nodeId: number;
  linkMac: string;
  windowMs: number;
  featureVector: LinkFeatureVector;
}

/** Injectable sink for computed features. */
export interface FeatureSink {
  writeFeatures(rows: readonly FeatureRow[]): Promise<void>;
  /**
   * Returns the most recently written feature row for every (nodeId,
   * linkMac) link. The pipeline uses this instead of a dedicated
   * checkpoint table: each row's own `featureVector` already carries the
   * adaptive baseline's mean/variance/frozen state, so resuming a link's
   * baseline and knowing where to pick up windowing from are both
   * reconstructible from data already in the `features` hypertable.
   */
  loadLatestPerLink(): Promise<FeatureRow[]>;
}

export interface FeaturePipelineDeps {
  source: CsiRecordSource;
  sink: FeatureSink;
  /** Page size for fetchRecords calls. Defaults to 10,000. */
  fetchBatchSize?: number;
}

export interface FeaturePipelineResult {
  linksProcessed: number;
  windowsWritten: number;
  recordsDropped: number;
}

function linkKey(nodeId: number, linkMac: string): string {
  return `${nodeId}:${linkMac}`;
}

function parseLinkKey(key: string): { nodeId: number; linkMac: string } {
  const sep = key.indexOf(':');
  return { nodeId: Number(key.slice(0, sep)), linkMac: key.slice(sep + 1) };
}

/**
 * Core pipeline logic, decoupled from Postgres via `deps` — this is what
 * tests drive with in-memory fakes. `runFeaturePipeline` below wires this
 * up to real `csi_records`/`features` tables for CLI use.
 */
export async function runFeaturePipelineCore(
  config: Config,
  deps: FeaturePipelineDeps,
): Promise<FeaturePipelineResult> {
  const { windowMs, hopMs, subcarrierSelection, baselineAdaptationRate } = config.features;
  const baselineThresholds = config.occupancy.thresholds;
  const batchSize = deps.fetchBatchSize ?? 10_000;

  // 1. Reconstruct per-link checkpoint + baseline state from the most
  //    recently persisted feature row for each link (see FeatureSink docs).
  const latest = await deps.sink.loadLatestPerLink();
  const linkState = new Map<string, { checkpointEndMs: number; baseline: BaselineSnapshot }>();
  for (const row of latest) {
    linkState.set(linkKey(row.nodeId, row.linkMac), {
      checkpointEndMs: row.timeMs,
      baseline: {
        mean: row.featureVector.baselineMean,
        variance: row.featureVector.baselineVariance,
        motionActive: row.featureVector.baselineFrozen,
      },
    });
  }

  // Fetch starting one full window before the earliest link checkpoint, so
  // every link has enough leading context to correctly recompute the
  // windows immediately after its own checkpoint (buildWindows then
  // discards any window whose end is <= that link's own checkpoint, so no
  // duplicates are written).
  const earliestCheckpointMs =
    linkState.size > 0 ? Math.min(...[...linkState.values()].map((s) => s.checkpointEndMs)) : null;
  const fetchSinceMs = earliestCheckpointMs === null ? null : earliestCheckpointMs - windowMs;

  // 2. Page through new records, bucketing them per link.
  const bufferByLink = new Map<string, TimedSample<CsiSample>[]>();
  let cursor = fetchSinceMs;
  let maxSeenMs = fetchSinceMs ?? Number.NEGATIVE_INFINITY;

  for (;;) {
    const batch = await deps.source.fetchRecords(cursor, batchSize);
    if (batch.length === 0) break;
    for (const rec of batch) {
      const key = linkKey(rec.nodeId, rec.linkMac);
      const arr = bufferByLink.get(key) ?? [];
      arr.push({
        timeMs: rec.timeMs,
        value: { timeMs: rec.timeMs, rssi: rec.rssi, csiFormat: rec.csiFormat, csiData: rec.csiData },
      });
      bufferByLink.set(key, arr);
      if (rec.timeMs > maxSeenMs) maxSeenMs = rec.timeMs;
    }
    // NOTE: csi_records has no surrogate id column, only (time, node_id, ...);
    // pagination advances the cursor to the last row's own timestamp. If
    // more rows than `fetchBatchSize` share that exact timestamp, the
    // surplus would be skipped — acceptable in practice given the
    // microsecond-resolution timestamps assigned at ingest, but noted here
    // rather than silently assumed safe.
    cursor = batch[batch.length - 1]!.timeMs;
    if (batch.length < batchSize) break;
  }

  if (bufferByLink.size === 0) {
    return { linksProcessed: 0, windowsWritten: 0, recordsDropped: 0 };
  }

  // 3. Build closed windows per link and compute features, advancing each
  //    link's baseline exactly once per new window in time order.
  const rowsToWrite: FeatureRow[] = [];
  let recordsDropped = 0;

  for (const [key, samples] of bufferByLink) {
    const { nodeId, linkMac } = parseLinkKey(key);
    const state = linkState.get(key);
    const windows = buildWindows(samples, { windowMs, hopMs }, maxSeenMs, state?.checkpointEndMs ?? null);

    let baselineSnapshot = state?.baseline;
    for (const w of windows) {
      const result = computeWindowFeature(w.samples, {
        subcarrierSelection,
        baselineAdaptationRate,
        baselineThresholds,
        previousBaseline: baselineSnapshot,
      });
      if (result === null) continue; // every record in this window was unusable
      baselineSnapshot = result.baselineSnapshot;
      recordsDropped += result.droppedSampleCount;
      rowsToWrite.push({ timeMs: w.endMs, nodeId, linkMac, windowMs, featureVector: result.vector });
    }
  }

  if (rowsToWrite.length > 0) {
    await deps.sink.writeFeatures(rowsToWrite);
  }

  return { linksProcessed: bufferByLink.size, windowsWritten: rowsToWrite.length, recordsDropped };
}

// ---------------------------------------------------------------------
// Real Postgres-backed source/sink, used by the CLI entry point.
// ---------------------------------------------------------------------

interface RawCsiRecordRow {
  time: Date;
  node_id: number;
  src_mac: string;
  rssi: number;
  csi_format: number;
  csi_data: Buffer;
}

function createPgCsiRecordSource(pool: DbPool): CsiRecordSource {
  return {
    async fetchRecords(sinceExclusiveMs, limit) {
      const sinceIso = sinceExclusiveMs === null ? null : new Date(sinceExclusiveMs).toISOString();
      const result = await pool.query<RawCsiRecordRow>(
        `SELECT time, node_id, src_mac, rssi, csi_format, csi_data
         FROM csi_records
         WHERE ($1::timestamptz IS NULL OR time > $1::timestamptz)
         ORDER BY time ASC
         LIMIT $2`,
        [sinceIso, limit],
      );
      return result.rows.map((r) => ({
        timeMs: r.time.getTime(),
        nodeId: r.node_id,
        linkMac: r.src_mac,
        rssi: r.rssi,
        csiFormat: r.csi_format,
        csiData: r.csi_data,
      }));
    },
  };
}

interface RawFeatureRow {
  time: Date;
  node_id: number;
  link_mac: string;
  window_ms: number;
  feature_vector: LinkFeatureVector;
}

function createPgFeatureSink(pool: DbPool): FeatureSink {
  return {
    async writeFeatures(rows) {
      if (rows.length === 0) return;
      const values: unknown[] = [];
      const tuples: string[] = [];
      rows.forEach((row, i) => {
        const base = i * 5;
        tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
        values.push(
          new Date(row.timeMs).toISOString(),
          row.nodeId,
          row.linkMac,
          row.windowMs,
          JSON.stringify(row.featureVector),
        );
      });
      await pool.query(
        `INSERT INTO features (time, node_id, link_mac, window_ms, feature_vector) VALUES ${tuples.join(', ')}`,
        values,
      );
    },

    async loadLatestPerLink() {
      const result = await pool.query<RawFeatureRow>(
        `SELECT DISTINCT ON (node_id, link_mac) time, node_id, link_mac, window_ms, feature_vector
         FROM features
         ORDER BY node_id, link_mac, time DESC`,
      );
      return result.rows.map((r) => ({
        timeMs: r.time.getTime(),
        nodeId: r.node_id,
        linkMac: r.link_mac,
        windowMs: r.window_ms,
        featureVector: r.feature_vector,
      }));
    },
  };
}

/**
 * Runs the windowed amplitude feature extraction pipeline against real
 * TimescaleDB tables: reads `csi_records`, computes per-link windows per
 * `config.features`, and writes `features`. See runFeaturePipelineCore for
 * the DB-independent logic and packages/cli/CONTRACTS.md ("features") for
 * this function's contract.
 */
export async function runFeaturePipeline(config: Config): Promise<void> {
  const pool = createPool(config.database);
  try {
    await runFeaturePipelineCore(config, {
      source: createPgCsiRecordSource(pool),
      sink: createPgFeatureSink(pool),
    });
  } finally {
    await pool.end();
  }
}
