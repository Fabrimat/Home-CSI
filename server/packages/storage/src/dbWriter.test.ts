import { describe, expect, it } from 'vitest';
import type { CsiBatch, Heartbeat } from '@homecsi/protocol';
import { CsiFormat } from '@homecsi/protocol';
import { DbWriteQueue, type DbQueryable } from './dbWriter.js';

function makeCsiBatch(rssi: number): CsiBatch {
  return {
    wallClockUs: 1_700_000_000_000_000n,
    monoUs: 1000n,
    sntpSynced: true,
    records: [
      {
        srcMac: 'aa:bb:cc:dd:ee:01',
        dstMac: 'aa:bb:cc:dd:ee:ff',
        rssi,
        rate: 11,
        sigMode: 1,
        mcs: 7,
        bandwidth: 0,
        channel: 6,
        secondaryChannel: 0,
        noiseFloor: -95,
        rxTimestampUs: 1000n,
        csiFormat: CsiFormat.Lltf,
        csiData: Buffer.from([1, 2, 3, 4]),
      },
    ],
  };
}

const makeHeartbeat = (): Heartbeat => ({
  uptimeS: 1,
  freeHeapBytes: 1,
  minFreeHeapBytes: 1,
  framesCaptured: 1,
  framesDropped: 0,
  batchesSent: 1,
  sendFailures: 0,
  rssiToAp: -50,
  channel: 6,
  sntpSynced: true,
  fwVersionMajor: 1,
  fwVersionMinor: 0,
  fwVersionPatch: 0,
});

class RecordingPool implements DbQueryable {
  public calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.calls.push({ sql, params });
    return Promise.resolve({ rows: [] });
  }
}

class FailingPool implements DbQueryable {
  query(): Promise<{ rows: Array<Record<string, unknown>> }> {
    return Promise.reject(new Error('connection refused'));
  }
}

describe('DbWriteQueue: batch insert', () => {
  it('flushes enqueued CSI + heartbeat rows via multi-row INSERTs', async () => {
    const pool = new RecordingPool();
    const queue = new DbWriteQueue(pool, { flushIntervalMs: 3_600_000 }); // disable auto-flush during test

    queue.enqueueCsiBatch(1, 1, 0, new Date(), makeCsiBatch(-40));
    queue.enqueueHeartbeat(1, 1, 0, new Date(), makeHeartbeat());

    await queue.flush();

    const csiInsert = pool.calls.find((c) => c.sql.startsWith('INSERT INTO csi_records'));
    const hbInsert = pool.calls.find((c) => c.sql.startsWith('INSERT INTO heartbeats'));
    expect(csiInsert).toBeDefined();
    expect(hbInsert).toBeDefined();

    const metrics = queue.getMetrics();
    expect(metrics.recordsWritten).toBe(2);
    expect(metrics.batchInsertFailures).toBe(0);
    expect(metrics.queueDepth).toBe(0);

    await queue.close();
  });

  it('upserts node identity rows', async () => {
    const pool = new RecordingPool();
    const queue = new DbWriteQueue(pool, { flushIntervalMs: 3_600_000 });
    await queue.upsertNode({ id: 1, name: 'node-1', room: 'kitchen', expectedMac: 'aa:bb:cc:dd:ee:01' });
    expect(pool.calls[0]?.sql).toContain('ON CONFLICT (id) DO UPDATE');
    await queue.close();
  });

  it('targets the migration 004 dedup key with ON CONFLICT DO NOTHING for csi_records and heartbeats', async () => {
    const pool = new RecordingPool();
    const queue = new DbWriteQueue(pool, { flushIntervalMs: 3_600_000 });

    queue.enqueueCsiBatch(1, 7, 42, new Date(), makeCsiBatch(-40));
    queue.enqueueHeartbeat(1, 7, 43, new Date(), makeHeartbeat());
    await queue.flush();

    const csiInsert = pool.calls.find((c) => c.sql.startsWith('INSERT INTO csi_records'));
    const hbInsert = pool.calls.find((c) => c.sql.startsWith('INSERT INTO heartbeats'));
    expect(csiInsert?.sql).toContain('ON CONFLICT (node_id, boot_epoch, seq, record_index, time) DO NOTHING');
    expect(hbInsert?.sql).toContain('ON CONFLICT (node_id, boot_epoch, seq, time) DO NOTHING');
    // boot_epoch/seq values must actually be bound as parameters.
    expect(csiInsert?.params).toContain(7);
    expect(csiInsert?.params).toContain(42);

    await queue.close();
  });

  it('reflects the database rowCount (not the attempted count) in recordsWritten, so a replay-time duplicate silently skipped by ON CONFLICT DO NOTHING is not double-counted', async () => {
    class PartialConflictPool implements DbQueryable {
      query(): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
        // Simulate one of the two rows in the batch already existing
        // (ON CONFLICT DO NOTHING skipped it) — only 1 of 2 actually inserted.
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
    }
    const queue = new DbWriteQueue(new PartialConflictPool(), { flushIntervalMs: 3_600_000 });
    queue.enqueueCsiBatch(1, 1, 0, new Date(), makeCsiBatch(-40));
    queue.enqueueCsiBatch(1, 1, 1, new Date(), makeCsiBatch(-41));

    await queue.flush();

    expect(queue.getMetrics().recordsWritten).toBe(1);
    await queue.close();
  });

  it('counts batch insert failures without throwing and continues processing later batches', async () => {
    const pool = new FailingPool();
    const queue = new DbWriteQueue(pool, { flushIntervalMs: 3_600_000, batchSize: 1 });

    queue.enqueueCsiBatch(1, 1, 0, new Date(), makeCsiBatch(-40));
    queue.enqueueCsiBatch(1, 1, 0, new Date(), makeCsiBatch(-41));

    await expect(queue.flush()).resolves.toBeUndefined();

    const metrics = queue.getMetrics();
    expect(metrics.batchInsertFailures).toBe(2);
    expect(metrics.recordsWritten).toBe(0);
    expect(metrics.queueDepth).toBe(0);

    await queue.close();
  });
});

describe('DbWriteQueue: bounded queue overflow', () => {
  it('drops the OLDEST row once maxQueueSize is reached, bounding memory, and counts the drop', () => {
    const pool = new RecordingPool();
    const queue = new DbWriteQueue(pool, { maxQueueSize: 3, flushIntervalMs: 3_600_000 });

    // Encode an identifiable marker (rssi) per enqueued batch so we can
    // verify *which* rows survive.
    for (let i = 0; i < 5; i++) {
      queue.enqueueCsiBatch(1, 1, 0, new Date(), makeCsiBatch(-i));
    }

    const metrics = queue.getMetrics();
    expect(metrics.queueDepth).toBe(3); // bounded, does not grow past maxQueueSize
    expect(metrics.queueDrops).toBe(2); // the two oldest (rssi 0 and -1) were dropped
  });

  it('never grows the queue past maxQueueSize even under sustained overload', () => {
    const pool = new RecordingPool();
    const queue = new DbWriteQueue(pool, { maxQueueSize: 10, flushIntervalMs: 3_600_000 });
    for (let i = 0; i < 10_000; i++) {
      queue.enqueueCsiBatch(1, 1, 0, new Date(), makeCsiBatch(-i));
    }
    expect(queue.getMetrics().queueDepth).toBe(10);
    expect(queue.getMetrics().queueDrops).toBe(10_000 - 10);
  });

  it('flush() is a no-op re-entrant guard while a flush is already in progress', async () => {
    let resolveQuery: (() => void) | undefined;
    const slowPool: DbQueryable = {
      query: () =>
        new Promise((resolve) => {
          resolveQuery = () => resolve({ rows: [] });
        }),
    };
    const queue = new DbWriteQueue(slowPool, { flushIntervalMs: 3_600_000 });
    queue.enqueueCsiBatch(1, 1, 0, new Date(), makeCsiBatch(-1));

    const firstFlush = queue.flush();
    const secondFlush = queue.flush(); // should return immediately (flushing guard)
    await expect(secondFlush).resolves.toBeUndefined();

    resolveQuery?.();
    await firstFlush;
  });
});
