import type { Config } from '@homecsi/config';
import type { DbPool } from '@homecsi/db';
import {
  computeStorageStatus,
  writeMetricsSnapshot,
  writeStorageStatus,
  type MetricsSnapshotEntry,
} from '@homecsi/storage';
import type { Logger } from './logger.js';
import type { IngestMetrics } from './metrics.js';

/**
 * Flattens `IngestMetrics` into the generic `(reason, count)` shape
 * `@homecsi/storage`'s `writeMetricsSnapshot` persists (migration 005):
 * every top-level counter, plus one entry per distinct rejection reason
 * as `rejected.<reason>` (e.g. `rejected.auth_failed` for a bad AEAD tag,
 * `rejected.stale_epoch`/`rejected.too_old`/`rejected.duplicate` for
 * replay-window rejects, `rejected.malformed_payload`,
 * `rejected.unknown_node`, etc).
 */
export function flattenMetrics(metrics: IngestMetrics): MetricsSnapshotEntry[] {
  const entries: MetricsSnapshotEntry[] = [
    { reason: 'datagrams_received', count: metrics.datagramsReceived },
    { reason: 'bytes_received', count: metrics.bytesReceived },
    { reason: 'accepted', count: metrics.accepted },
    { reason: 'records_written', count: metrics.recordsWritten },
    { reason: 'batch_insert_failures', count: metrics.batchInsertFailures },
    { reason: 'queue_depth', count: metrics.queueDepth },
    { reason: 'queue_drops', count: metrics.queueDrops },
    { reason: 'capture_write_failures', count: metrics.captureWriteFailures },
  ];
  for (const [reason, count] of Object.entries(metrics.rejected)) {
    entries.push({ reason: `rejected.${reason}`, count });
  }
  return entries;
}

/**
 * No config knob exists for this yet (packages/config has none for
 * ingest's observability cadence) — one minute is a reasonable default
 * balance between UI freshness and write volume. Flagged as a candidate
 * future config key, same as DbWriteQueue's internal batching constants.
 */
const DEFAULT_SNAPSHOT_INTERVAL_MS = 60_000;

export interface MetricsSnapshotLoopOptions {
  intervalMs?: number;
}

/**
 * Starts a periodic timer that snapshots ingest's in-process counters and
 * the raw-capture disk budget into Postgres (migration 005's
 * `ingest_metrics_snapshots` / `storage_status`) — the durable,
 * cross-process path for brief B5's debug UI, since `getIngestMetrics()`
 * only works for a caller in the same process (see its doc comment).
 * Returns a function that stops the timer. Snapshot failures are logged
 * (rate-limiting is unnecessary here — this runs at most once per
 * `intervalMs`) and never crash ingest; durability of these snapshots is
 * an observability nicety, not a correctness requirement for ingest
 * itself.
 */
export function startMetricsSnapshotLoop(
  pool: DbPool,
  config: Config,
  getMetrics: () => IngestMetrics,
  logger: Logger,
  options: MetricsSnapshotLoopOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  const timer = setInterval(() => {
    void snapshotOnce(pool, config, getMetrics, logger);
  }, intervalMs).unref();
  return () => clearInterval(timer);
}

async function snapshotOnce(
  pool: DbPool,
  config: Config,
  getMetrics: () => IngestMetrics,
  logger: Logger,
): Promise<void> {
  try {
    const time = new Date();
    await writeMetricsSnapshot(pool, flattenMetrics(getMetrics()), time);
    const status = await computeStorageStatus(config);
    await writeStorageStatus(pool, status, time);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to write periodic metrics snapshot',
    );
  }
}
