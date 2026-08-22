import { describe, expect, it } from 'vitest';
import type { Config } from '@homecsi/config';
import {
  runOccupancyPipelineCore,
  type FeatureRow,
  type FeatureSource,
  type OccupancySink,
  type OccupancyStateRow,
} from './pipeline.js';

function configWithNodes(nodeCount: number): Config {
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
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      id: i + 1,
      name: `node-${i + 1}`,
      room: `room-${i + 1}`,
      psk: Buffer.alloc(32).toString('base64'),
    })),
    storage: {
      captureDir: '.',
      rotation: { maxBytes: 1, maxIntervalMs: 1 },
      retention: { maxAgeMs: 1, maxTotalBytes: 1 },
      compression: { enabled: false, afterMs: 1 },
    },
    features: { windowMs: 2000, hopMs: 500, subcarrierSelection: 'all', baselineAdaptationRate: 0.1 },
    occupancy: {
      thresholds: { motionOnThreshold: 3.0, motionOffThreshold: 1.5 },
      latchDecayHorizonMs: 1_800_000,
      hysteresisMs: 30_000,
      multiOccupancy: { crossNodeSimultaneityThresholdMs: 5000 },
    },
    logging: { level: 'info', file: { path: '.', maxFiles: 1, maxSizeMb: 1 } },
  };
}

class FakeFeatureSource implements FeatureSource {
  constructor(private readonly rows: FeatureRow[]) {}
  async fetchFeatures(sinceExclusiveMs: number | null, limit: number): Promise<FeatureRow[]> {
    const filtered = this.rows.filter((r) => sinceExclusiveMs === null || r.timeMs > sinceExclusiveMs);
    return filtered.slice(0, limit);
  }
}

class FakeOccupancySink implements OccupancySink {
  public rows: OccupancyStateRow[] = [];
  async writeStates(rows: readonly OccupancyStateRow[]): Promise<void> {
    this.rows.push(...rows);
  }
  async loadLatest(): Promise<OccupancyStateRow | null> {
    if (this.rows.length === 0) return null;
    return this.rows.reduce((a, b) => (b.timeMs > a.timeMs ? b : a));
  }
}

describe('runOccupancyPipelineCore', () => {
  it('turns motion feature rows into an OCCUPIED occupancy_states row', async () => {
    const rows: FeatureRow[] = [{ timeMs: 0, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01', baselineDeviation: 5 }];
    const sink = new FakeOccupancySink();
    const result = await runOccupancyPipelineCore(configWithNodes(2), {
      source: new FakeFeatureSource(rows),
      sink,
    });

    expect(result.statesWritten).toBe(1);
    expect(sink.rows[0]!.estimate).toBe(1);
    expect(sink.rows[0]!.state).toBe('OCCUPIED');
  });

  it('groups multiple links reporting the same tick timestamp into one whole-house state', async () => {
    const rows: FeatureRow[] = [
      { timeMs: 0, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01', baselineDeviation: 5 },
      { timeMs: 0, nodeId: 2, linkMac: 'bb:bb:bb:bb:bb:02', baselineDeviation: 5 },
    ];
    const sink = new FakeOccupancySink();
    const result = await runOccupancyPipelineCore(configWithNodes(2), {
      source: new FakeFeatureSource(rows),
      sink,
    });

    expect(result.ticksProcessed).toBe(1);
    expect(sink.rows.length).toBe(1);
    expect(sink.rows[0]!.estimate).toBe(2); // two distinct-node links, simultaneous
  });

  it('is resumable: reconstructs the latch from the last written occupancy_states row', async () => {
    const sink = new FakeOccupancySink();
    const config = configWithNodes(2);

    // First run: motion turns the latch on.
    await runOccupancyPipelineCore(config, {
      source: new FakeFeatureSource([
        { timeMs: 0, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01', baselineDeviation: 5 },
      ]),
      sink,
    });
    expect(sink.rows[sink.rows.length - 1]!.estimate).toBe(1);

    // Second run (fresh process): only new, quiet feature rows arrive. The
    // latch must remember it was OCCUPIED and only just went quiet — not
    // reset to UNOCCUPIED just because this run started fresh.
    const secondRunRows: FeatureRow[] = [];
    for (let t = 500; t <= 5000; t += 500) {
      secondRunRows.push({ timeMs: t, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01', baselineDeviation: 0 });
    }
    await runOccupancyPipelineCore(config, { source: new FakeFeatureSource(secondRunRows), sink });

    const finalRow = sink.rows[sink.rows.length - 1]!;
    expect(finalRow.estimate).not.toBe(0); // nowhere near the 30-minute decay horizon yet
    expect(finalRow.state).toBe('DECAYING');
  });

  it('does not reprocess ticks already written (no duplicate rows across runs)', async () => {
    const sink = new FakeOccupancySink();
    const config = configWithNodes(2);
    const rows: FeatureRow[] = [
      { timeMs: 0, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01', baselineDeviation: 5 },
      { timeMs: 500, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01', baselineDeviation: 0 },
    ];
    await runOccupancyPipelineCore(config, { source: new FakeFeatureSource(rows), sink });
    const countAfterFirst = sink.rows.length;

    const second = await runOccupancyPipelineCore(config, { source: new FakeFeatureSource(rows), sink });
    expect(second.statesWritten).toBe(0);
    expect(sink.rows.length).toBe(countAfterFirst);
  });

  it('handles an empty features table without error', async () => {
    const result = await runOccupancyPipelineCore(configWithNodes(2), {
      source: new FakeFeatureSource([]),
      sink: new FakeOccupancySink(),
    });
    expect(result).toEqual({ ticksProcessed: 0, statesWritten: 0 });
  });
});
