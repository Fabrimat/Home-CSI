import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DbPool } from '@homecsi/db';
import type { DbQueryable } from '@homecsi/storage';
import { createEmptyMetrics } from './metrics.js';
import { flattenMetrics, startMetricsSnapshotLoop } from './metricsSnapshotLoop.js';
import { makeTestConfig } from './testHelpers.js';
import type { Logger } from './logger.js';

function makeFakeLogger(): Logger {
  const noop = (): void => undefined;
  return { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop } as unknown as Logger;
}

const tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'homecsi-metrics-snapshot-test-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('flattenMetrics', () => {
  it('includes every top-level counter and one entry per distinct rejection reason', () => {
    const metrics = createEmptyMetrics();
    metrics.datagramsReceived = 10;
    metrics.accepted = 7;
    metrics.rejected.auth_failed = 2;
    metrics.rejected.duplicate = 1;

    const entries = flattenMetrics(metrics);
    const byReason = Object.fromEntries(entries.map((e) => [e.reason, e.count]));

    expect(byReason.datagrams_received).toBe(10);
    expect(byReason.accepted).toBe(7);
    expect(byReason['rejected.auth_failed']).toBe(2);
    expect(byReason['rejected.duplicate']).toBe(1);
    expect(byReason['rejected.stale_epoch']).toBe(0); // zero-initialized reasons still present
    expect(byReason['rejected.too_old']).toBe(0);
    expect(byReason['rejected.malformed_payload']).toBe(0);
    expect(byReason['rejected.unknown_node']).toBe(0);
  });
});

describe('startMetricsSnapshotLoop', () => {
  it('periodically writes a metrics snapshot and a storage_status row, and stops cleanly', async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const pool: DbQueryable = {
      query: (sql, params) => {
        calls.push({ sql, params });
        return Promise.resolve({ rows: [] });
      },
    };
    const dir = await makeTmpDir();
    await fs.writeFile(path.join(dir, 'some-shard.hcscap'), Buffer.alloc(100));
    const config = makeTestConfig([]);
    config.storage.captureDir = dir;
    config.storage.retention.maxTotalBytes = 5000;

    const logger = makeFakeLogger();
    const stop = startMetricsSnapshotLoop(pool as unknown as DbPool, config, () => createEmptyMetrics(), logger, {
      intervalMs: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    stop();
    // Let any single tick that had already fired (but whose async
    // snapshotOnce() work was still in flight) drain before taking the
    // "stopped" baseline, so this isn't racy against clearInterval only
    // preventing *future* ticks.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const callCountAtStop = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.length).toBe(callCountAtStop); // no further writes after stop()

    expect(calls.length).toBeGreaterThan(0);
    const metricsInsert = calls.find((c) => c.sql.includes('INSERT INTO ingest_metrics_snapshots'));
    const statusInsert = calls.find((c) => c.sql.includes('INSERT INTO storage_status'));
    expect(metricsInsert).toBeDefined();
    expect(statusInsert).toBeDefined();
    // storage_status bytes_used should reflect the 100-byte shard file we wrote.
    expect(statusInsert?.params).toContain(100);
    expect(statusInsert?.params).toContain(5000);
  });
});
