import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from '@homecsi/config';
import type { DbQueryable } from './dbWriter.js';
import { resolveCaptureDir } from './paths.js';

export interface MetricsSnapshotEntry {
  /** A named counter, e.g. 'accepted', 'datagrams_received', or 'rejected.<reason>'. */
  reason: string;
  /** The counter's cumulative value at `time` (not a delta since the last snapshot). */
  count: number;
}

/**
 * Appends one row per entry to `ingest_metrics_snapshots` (migration 005)
 * at `time` (defaults to now). Generic over "reason" so `@homecsi/ingest`
 * can persist any of its named counters without this package needing to
 * depend on ingest's metrics types (avoiding a storage -> ingest
 * dependency, which would be circular since ingest already depends on
 * storage).
 *
 * This exists because `@homecsi/ingest`'s in-process `getIngestMetrics()`
 * cannot be read cross-process: `ingest` and `serve` (brief B5's API) are
 * separate CLI commands / separate containers. Periodically snapshotting
 * here is what makes ingest's counters visible to B5's debug UI.
 */
export async function writeMetricsSnapshot(
  pool: DbQueryable,
  entries: readonly MetricsSnapshotEntry[],
  time: Date = new Date(),
): Promise<void> {
  if (entries.length === 0) return;
  const cols = ['time', 'reason', 'count'];
  const values: unknown[] = [];
  const tuples = entries.map((e, i) => {
    const base = i * cols.length;
    values.push(time, e.reason, e.count);
    return `($${base + 1}, $${base + 2}, $${base + 3})`;
  });
  await pool.query(`INSERT INTO ingest_metrics_snapshots (${cols.join(', ')}) VALUES ${tuples.join(', ')}`, values);
}

export interface StorageStatus {
  bytesUsed: number;
  bytesBudget: number;
}

/** Appends one row to `storage_status` (migration 005) at `time` (defaults to now). */
export async function writeStorageStatus(
  pool: DbQueryable,
  status: StorageStatus,
  time: Date = new Date(),
): Promise<void> {
  await pool.query('INSERT INTO storage_status (time, bytes_used, bytes_budget) VALUES ($1, $2, $3)', [
    time,
    status.bytesUsed,
    status.bytesBudget,
  ]);
}

/**
 * Computes the same two numbers `packages/cli`'s `doctor` command prints
 * (raw-capture directory usage vs. `config.storage.retention.maxTotalBytes`),
 * so they can be made durable/queryable via `writeStorageStatus` instead of
 * only available by running `doctor` or inspecting the filesystem directly.
 * Duplicates `doctor`'s plain recursive directory-size sum deliberately —
 * `packages/cli` is off-limits to this package, and there is no shared
 * utility package to place this in instead.
 */
export async function computeStorageStatus(config: Config): Promise<StorageStatus> {
  const dir = resolveCaptureDir(config);
  const bytesUsed = await directorySizeBytes(dir);
  return { bytesUsed, bytesBudget: config.storage.retention.maxTotalBytes };
}

async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(full);
    } else if (entry.isFile()) {
      const stat = await fs.stat(full).catch(() => undefined);
      if (stat) total += stat.size;
    }
  }
  return total;
}
