import { describe, expect, it } from 'vitest';
import { createInMemoryBoxTakeStore, preserveSessionTake, sweepPreserveBoxTakes, type BoxTakeRecord } from './preservation.js';

const CONFIG = { leadInMs: 200, leadOutMs: 200 };

function record(overrides: Partial<BoxTakeRecord> = {}): BoxTakeRecord {
  return {
    timeMs: 1500,
    nodeId: 1,
    linkMac: 'aa:aa:aa:aa:aa:01',
    rssi: -50,
    csiFormat: 1,
    csiData: Buffer.from([1, 2, 3, 4]),
    ...overrides,
  };
}

/** Dense synthetic records across [fromMs, toMs), one per hopMs tick, all on one link. */
function denseRecords(fromMs: number, toMs: number, hopMs: number): BoxTakeRecord[] {
  const rows: BoxTakeRecord[] = [];
  for (let t = fromMs; t < toMs; t += hopMs) rows.push(record({ timeMs: t }));
  return rows;
}

describe('preserveSessionTake', () => {
  it('skips an open session (endedAtMs is null) without touching the store', async () => {
    const store = createInMemoryBoxTakeStore([record()]);
    const result = await preserveSessionTake({ id: 1, startedAtMs: 1000, endedAtMs: null }, store, CONFIG);
    expect(result).toEqual({ status: 'skipped-open', sessionId: 1 });
  });

  it('reports empty-window when the lead-in/lead-out trim consumes the entire hold', async () => {
    const store = createInMemoryBoxTakeStore([]);
    const result = await preserveSessionTake({ id: 1, startedAtMs: 1000, endedAtMs: 1300 }, store, CONFIG);
    expect(result).toEqual({ status: 'empty-window', sessionId: 1 });
  });

  it('preserves a take with records inside its trimmed window', async () => {
    // Window after trim: [1200, 2800).
    const seed = denseRecords(1200, 2800, 50);
    const store = createInMemoryBoxTakeStore(seed);
    const result = await preserveSessionTake({ id: 1, startedAtMs: 1000, endedAtMs: 3000 }, store, CONFIG);

    expect(result.status).toBe('preserved');
    if (result.status === 'preserved') {
      expect(result.inserted).toBeGreaterThan(0);
      expect(result.found).toBe(result.inserted);
    }
  });

  it('is idempotent: preserving the same take twice inserts no duplicates the second time', async () => {
    const seed = denseRecords(1200, 2800, 50);
    const store = createInMemoryBoxTakeStore(seed);
    const session = { id: 1, startedAtMs: 1000, endedAtMs: 3000 };

    const first = await preserveSessionTake(session, store, CONFIG);
    const second = await preserveSessionTake(session, store, CONFIG);

    expect(first.status).toBe('preserved');
    expect(second.status).toBe('preserved');
    if (first.status === 'preserved' && second.status === 'preserved') {
      expect(first.inserted).toBeGreaterThan(0);
      expect(second.inserted).toBe(0);
      expect(second.found).toBe(first.found); // already-preserved rows still count as found
    }
  });

  it('throws with a clear message when the window has ZERO rows anywhere (never captured or genuinely lost)', async () => {
    const store = createInMemoryBoxTakeStore([]); // nothing seeded at all
    await expect(preserveSessionTake({ id: 7, startedAtMs: 1000, endedAtMs: 3000 }, store, CONFIG)).rejects.toThrow(
      /session #7/,
    );
    await expect(preserveSessionTake({ id: 7, startedAtMs: 1000, endedAtMs: 3000 }, store, CONFIG)).rejects.toThrow(
      /ZERO CSI rows/,
    );
  });

  it('a take already preserved, then aged out of the live seed, still reads as found (not lost)', async () => {
    // `liveSeed` stands in for the CURRENT live csi_records rows for this
    // window -- mutated (cleared) below to simulate the 7-day retention
    // policy (migration 007) dropping them after this take was already
    // safely preserved into box_take_records.
    const liveSeed: BoxTakeRecord[] = denseRecords(1200, 2800, 50);
    const store = createInMemoryBoxTakeStore(liveSeed);
    const session = { id: 9, startedAtMs: 1000, endedAtMs: 3000 };

    const firstRun = await preserveSessionTake(session, store, CONFIG);
    expect(firstRun.status).toBe('preserved');
    if (firstRun.status !== 'preserved') throw new Error('unreachable');
    const preservedCount = firstRun.inserted;
    expect(preservedCount).toBeGreaterThan(0);

    // Simulate retention dropping every live csi_records row for this window.
    liveSeed.length = 0;

    const secondRun = await preserveSessionTake(session, store, CONFIG);
    expect(secondRun.status).toBe('preserved');
    if (secondRun.status === 'preserved') {
      expect(secondRun.found).toBe(preservedCount); // still found, via box_take_records
      expect(secondRun.inserted).toBe(0); // nothing left live to (re-)copy
    }
  });
});

describe('preserveSessionTake: partial node dropout', () => {
  it('reports a nodeDropoutWarning naming both counts when only some registered box nodes reported', async () => {
    // 3 nodes are registered as role='box' (expectedBoxNodeCount below stands
    // in for that), but only node 1 actually produced any CSI for this
    // window -- e.g. the other two were powered off or hit a UDP loss burst.
    const seed = denseRecords(1200, 2800, 50); // all default to nodeId: 1
    const store = createInMemoryBoxTakeStore(seed, 3);
    const result = await preserveSessionTake({ id: 1, startedAtMs: 1000, endedAtMs: 3000 }, store, CONFIG);

    expect(result.status).toBe('preserved');
    if (result.status === 'preserved') {
      expect(result.nodeDropoutWarning).toBeDefined();
      expect(result.nodeDropoutWarning).toMatch(/1 of 3/);
      expect(result.nodeDropoutWarning).toMatch(/session #1/);
      // Still preserved -- a partial dropout is a warning, not a failure.
      expect(result.inserted).toBeGreaterThan(0);
    }
  });

  it('reports no nodeDropoutWarning when every registered box node reported', async () => {
    const seed = [1, 2, 3].flatMap((nodeId) =>
      denseRecords(1200, 2800, 200).map((r) => ({ ...r, nodeId, linkMac: `aa:aa:aa:aa:aa:0${nodeId}` })),
    );
    const store = createInMemoryBoxTakeStore(seed, 3);
    const result = await preserveSessionTake({ id: 2, startedAtMs: 1000, endedAtMs: 3000 }, store, CONFIG);

    expect(result.status).toBe('preserved');
    if (result.status === 'preserved') {
      expect(result.nodeDropoutWarning).toBeUndefined();
    }
  });

  it('does not warn when expectedBoxNodeCount is unknown/zero (no registered-node signal to compare against)', async () => {
    const seed = denseRecords(1200, 2800, 50);
    const store = createInMemoryBoxTakeStore(seed, 0);
    const result = await preserveSessionTake({ id: 3, startedAtMs: 1000, endedAtMs: 3000 }, store, CONFIG);

    expect(result.status).toBe('preserved');
    if (result.status === 'preserved') {
      expect(result.nodeDropoutWarning).toBeUndefined();
    }
  });
});

describe('sweepPreserveBoxTakes', () => {
  it('preserves multiple sessions and continues past one that errors', async () => {
    const seed = denseRecords(1200, 2800, 50);
    const store = createInMemoryBoxTakeStore(seed);
    const good = { id: 1, startedAtMs: 1000, endedAtMs: 3000 };
    const bad = { id: 2, startedAtMs: 100_000, endedAtMs: 103_000 }; // no seed data for this window at all
    const open = { id: 3, startedAtMs: 1000, endedAtMs: null };

    const results = await sweepPreserveBoxTakes([good, bad, open], store, CONFIG);

    expect(results.find((r) => r.sessionId === 1)?.status).toBe('preserved');
    expect(results.find((r) => r.sessionId === 2)?.status).toBe('error');
    expect(results.find((r) => r.sessionId === 3)?.status).toBe('skipped-open');
  });
});
