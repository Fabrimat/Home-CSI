import { describe, expect, it } from 'vitest';
import type { Config } from '@homecsi/config';
import { CsiFormat } from '@homecsi/protocol';
import {
  runFeaturePipelineCore,
  type CsiRecordRow,
  type CsiRecordSource,
  type FeatureRow,
  type FeatureSink,
} from './pipeline.js';

function baseConfig(): Config {
  return {
    server: { udp: { host: '0.0.0.0', port: 1 }, http: { host: '0.0.0.0', port: 2 }, apiToken: 'x'.repeat(16) },
    database: {
      host: 'localhost',
      port: 5432,
      database: 'db',
      user: 'u',
      password: 'p',
      ssl: false,
      pool: { min: 1, max: 1 },
    },
    nodes: [
      { id: 1, name: 'a', room: 'r1', psk: Buffer.alloc(32).toString('base64'), floor: 0 },
      { id: 2, name: 'b', room: 'r2', psk: Buffer.alloc(32).toString('base64'), floor: 0 },
    ],
    storage: {
      captureDir: '.',
      rotation: { maxBytes: 1, maxIntervalMs: 1 },
      retention: { maxAgeMs: 1, maxTotalBytes: 1 },
      compression: { enabled: false, afterMs: 1 },
    },
    features: {
      windowMs: 2000,
      hopMs: 500,
      subcarrierSelection: 'all',
      baselineAdaptationRate: 0.1,
    },
    occupancy: {
      thresholds: { motionOnThreshold: 3.0, motionOffThreshold: 1.5 },
      latchDecayHorizonMs: 1_800_000,
      hysteresisMs: 30_000,
      multiOccupancy: { crossNodeSimultaneityThresholdMs: 5000 },
    },
    logging: { level: 'info', file: { path: '.', maxFiles: 1, maxSizeMb: 1 } },
  };
}

function iqBuffer(pairs: Array<[number, number]>): Buffer {
  const buf = Buffer.alloc(pairs.length * 2);
  pairs.forEach(([i, q], idx) => {
    buf.writeInt8(i, idx * 2);
    buf.writeInt8(q, idx * 2 + 1);
  });
  return buf;
}

function record(timeMs: number, nodeId: number, linkMac: string, jitter = 0): CsiRecordRow {
  return {
    timeMs,
    nodeId,
    linkMac,
    rssi: -50,
    csiFormat: CsiFormat.Lltf,
    csiData: iqBuffer([
      [10 + jitter, 0],
      [8 - jitter, 0],
      [6 + jitter, 0],
      [4 - jitter, 0],
    ]),
  };
}

/** In-memory fake standing in for a Postgres `csi_records` cursor. No network, no DB. */
class FakeCsiRecordSource implements CsiRecordSource {
  constructor(private readonly rows: CsiRecordRow[]) {}
  async fetchRecords(sinceExclusiveMs: number | null, limit: number): Promise<CsiRecordRow[]> {
    const filtered = this.rows.filter((r) => sinceExclusiveMs === null || r.timeMs > sinceExclusiveMs);
    return filtered.slice(0, limit);
  }
}

/** In-memory fake standing in for the `features` hypertable. No network, no DB. */
class FakeFeatureSink implements FeatureSink {
  public rows: FeatureRow[] = [];
  async writeFeatures(rows: readonly FeatureRow[]): Promise<void> {
    this.rows.push(...rows);
  }
  async loadLatestPerLink(): Promise<FeatureRow[]> {
    const byLink = new Map<string, FeatureRow>();
    for (const row of this.rows) {
      const key = `${row.nodeId}:${row.linkMac}`;
      const existing = byLink.get(key);
      if (!existing || row.timeMs > existing.timeMs) byLink.set(key, row);
    }
    return [...byLink.values()];
  }
}

describe('runFeaturePipelineCore', () => {
  it('computes and writes feature windows for a link from raw records', async () => {
    const records: CsiRecordRow[] = [];
    for (let t = 0; t <= 4000; t += 250) {
      records.push(record(t, 1, 'aa:aa:aa:aa:aa:01', t % 500 === 0 ? 0.1 : -0.1));
    }
    const source = new FakeCsiRecordSource(records);
    const sink = new FakeFeatureSink();

    const result = await runFeaturePipelineCore(baseConfig(), { source, sink });

    expect(result.linksProcessed).toBe(1);
    expect(result.windowsWritten).toBeGreaterThan(0);
    expect(sink.rows.length).toBe(result.windowsWritten);
    for (const row of sink.rows) {
      expect(row.nodeId).toBe(1);
      expect(row.linkMac).toBe('aa:aa:aa:aa:aa:01');
      expect(row.windowMs).toBe(2000);
    }
  });

  it('computes features PER LINK, not per node: two links on the same node get independent feature rows', async () => {
    const records: CsiRecordRow[] = [];
    for (let t = 0; t <= 3000; t += 250) {
      records.push(record(t, 1, 'aa:aa:aa:aa:aa:01', 0.1));
      records.push(record(t, 1, 'bb:bb:bb:bb:bb:02', 0.1));
    }
    const source = new FakeCsiRecordSource(records);
    const sink = new FakeFeatureSink();

    const result = await runFeaturePipelineCore(baseConfig(), { source, sink });

    expect(result.linksProcessed).toBe(2);
    const linkMacsSeen = new Set(sink.rows.map((r) => r.linkMac));
    expect(linkMacsSeen).toEqual(new Set(['aa:aa:aa:aa:aa:01', 'bb:bb:bb:bb:bb:02']));
    // Both links produced their own windows independently (not merged into one node-level row).
    const rowsForLinkA = sink.rows.filter((r) => r.linkMac === 'aa:aa:aa:aa:aa:01');
    const rowsForLinkB = sink.rows.filter((r) => r.linkMac === 'bb:bb:bb:bb:bb:02');
    expect(rowsForLinkA.length).toBeGreaterThan(0);
    expect(rowsForLinkB.length).toBeGreaterThan(0);
  });

  it('is resumable: a second run against the same underlying data + prior output produces no duplicate windows', async () => {
    const records: CsiRecordRow[] = [];
    for (let t = 0; t <= 6000; t += 250) {
      records.push(record(t, 1, 'aa:aa:aa:aa:aa:01', 0.1));
    }
    const source = new FakeCsiRecordSource(records);
    const sink = new FakeFeatureSink();

    const first = await runFeaturePipelineCore(baseConfig(), { source, sink });
    expect(first.windowsWritten).toBeGreaterThan(0);
    const countAfterFirst = sink.rows.length;

    const second = await runFeaturePipelineCore(baseConfig(), { source, sink });
    // No new records were added, so a second run must not recompute/duplicate.
    expect(second.windowsWritten).toBe(0);
    expect(sink.rows.length).toBe(countAfterFirst);
  });

  it('resuming after new records arrive only processes the new windows, carrying baseline state forward', async () => {
    const firstBatch: CsiRecordRow[] = [];
    for (let t = 0; t <= 4000; t += 250) {
      firstBatch.push(record(t, 1, 'aa:aa:aa:aa:aa:01', 0.1));
    }
    const sink = new FakeFeatureSink();
    await runFeaturePipelineCore(baseConfig(), { source: new FakeCsiRecordSource(firstBatch), sink });
    const countAfterFirst = sink.rows.length;
    expect(countAfterFirst).toBeGreaterThan(0);

    const moreRecords: CsiRecordRow[] = [...firstBatch];
    for (let t = 4250; t <= 8000; t += 250) {
      moreRecords.push(record(t, 1, 'aa:aa:aa:aa:aa:01', 0.1));
    }
    const result = await runFeaturePipelineCore(baseConfig(), {
      source: new FakeCsiRecordSource(moreRecords),
      sink,
    });
    expect(result.windowsWritten).toBeGreaterThan(0);
    expect(sink.rows.length).toBe(countAfterFirst + result.windowsWritten);

    // All timestamps written are strictly increasing / non-duplicated per link.
    const times = sink.rows.map((r) => r.timeMs).sort((a, b) => a - b);
    expect(new Set(times).size).toBe(times.length);
  });

  it('drops unusable records without failing the whole pipeline run', async () => {
    const records: CsiRecordRow[] = [];
    for (let t = 0; t <= 2000; t += 250) {
      records.push(record(t, 1, 'aa:aa:aa:aa:aa:01', 0.1));
    }
    // One corrupt record mixed in (unknown csi_format).
    records.push({
      timeMs: 1100,
      nodeId: 1,
      linkMac: 'aa:aa:aa:aa:aa:01',
      rssi: -50,
      csiFormat: 250,
      csiData: iqBuffer([[1, 1]]),
    });
    records.sort((a, b) => a.timeMs - b.timeMs);

    const source = new FakeCsiRecordSource(records);
    const sink = new FakeFeatureSink();
    const result = await runFeaturePipelineCore(baseConfig(), { source, sink });

    expect(result.recordsDropped).toBeGreaterThanOrEqual(1);
    expect(result.windowsWritten).toBeGreaterThan(0);
  });

  it('handles an empty csi_records table without error', async () => {
    const result = await runFeaturePipelineCore(baseConfig(), {
      source: new FakeCsiRecordSource([]),
      sink: new FakeFeatureSink(),
    });
    expect(result).toEqual({ linksProcessed: 0, windowsWritten: 0, recordsDropped: 0 });
  });
});
