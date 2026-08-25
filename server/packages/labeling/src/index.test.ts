import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryFeaturesReader } from './featuresSource.js';
import { runLabelSubcommand, runTrainCore, type LabelCliDeps, type TrainWriter } from './index.js';
import { WEAK_SESSION_NOTES, createInMemoryLabelStore, isWeakLabel } from './sessions.js';
import { createInMemoryTrainingFeaturesStore, preserveSessionFeatures } from './trainingPreservation.js';

async function silence<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

/**
 * Default test deps: no seed features, generous retention window (never
 * warns/errors unless a test overrides it), and the training-set density
 * sanity-check DISABLED (`minDensityFraction: 0`) by default -- most tests
 * in this file exercise CLI dispatch/wiring, not the density-check
 * algorithm itself (see trainingPreservation.test.ts for that). Tests that
 * specifically need the check to fire override `preservation` themselves.
 */
function testDeps(overrides: Partial<LabelCliDeps> = {}): LabelCliDeps {
  return {
    trainingStore: createInMemoryTrainingFeaturesStore([]),
    preservation: { toleranceMs: 2000, baselineWindowMs: 3_600_000, minDensityFraction: 0 },
    retentionWarning: { maxAgeMs: 7 * 86_400_000, safetyMarginMs: 86_400_000 },
    datasetExport: { hopMs: 1000 },
    ...overrides,
  };
}

describe('runLabelSubcommand: session lifecycle', () => {
  it('starts, lists, and stops a session', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);

    await silence(() => runLabelSubcommand(['session', 'start'], { notes: 'evening test' }, store, features, testDeps()));
    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.endedAtMs).toBeNull();

    await silence(() => runLabelSubcommand(['session', 'stop'], {}, store, features, testDeps()));
    const stopped = await store.listSessions();
    expect(stopped[0]!.endedAtMs).not.toBeNull();
  });

  it('session stop throws a clear error when there is no open session', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await expect(runLabelSubcommand(['session', 'stop'], {}, store, features, testDeps())).rejects.toThrow(/no open session/);
  });

  it('refuses a bare `session stop` (no --session) when the default-resolved open session is a training-mode walk', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    // Mirrors web/ui/src/groundTruthLogic.ts's TRAINING_MARKER convention.
    const session = await store.createSession(Date.now(), '[training] walking the house');

    await expect(runLabelSubcommand(['session', 'stop'], {}, store, features, testDeps())).rejects.toThrow(
      /training-mode walk/,
    );
    // Refused, not stopped.
    const sessions = await store.listSessions();
    expect(sessions.find((s) => s.id === session.id)!.endedAtMs).toBeNull();
  });

  it('allows stopping a training-mode session when --session is passed explicitly', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    const session = await store.createSession(Date.now(), '[training] walking the house');

    await silence(() =>
      runLabelSubcommand(['session', 'stop'], { session: String(session.id) }, store, features, testDeps()),
    );

    const sessions = await store.listSessions();
    expect(sessions.find((s) => s.id === session.id)!.endedAtMs).not.toBeNull();
  });

  it('a non-training session is unaffected by the guard (bare stop works as before)', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await store.createSession(Date.now(), 'manual: evening test');

    await silence(() => runLabelSubcommand(['session', 'stop'], {}, store, features, testDeps()));
    const sessions = await store.listSessions();
    expect(sessions[0]!.endedAtMs).not.toBeNull();
  });
});

describe('runLabelSubcommand: add / list', () => {
  it('adds a manual label to the currently open session', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await silence(() => runLabelSubcommand(['session', 'start'], {}, store, features, testDeps()));
    await silence(() => runLabelSubcommand(['add'], { count: '2', notes: 'two people' }, store, features, testDeps()));

    const labels = await store.listLabels();
    expect(labels).toHaveLength(1);
    expect(labels[0]!.occupancyCount).toBe(2);
    expect(isWeakLabel(labels[0]!.notes)).toBe(false);
  });

  it('add throws a clear error when there is no open session and none was specified', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await expect(runLabelSubcommand(['add'], { count: '1' }, store, features, testDeps())).rejects.toThrow(/no open session/);
  });

  it('rejects a non-integer --count', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await silence(() => runLabelSubcommand(['session', 'start'], {}, store, features, testDeps()));
    await expect(runLabelSubcommand(['add'], { count: 'two' }, store, features, testDeps())).rejects.toThrow(
      /must be an integer/,
    );
  });

  it('add --until writes an interval label (endTimeMs set)', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await silence(() => runLabelSubcommand(['session', 'start'], {}, store, features, testDeps()));
    const timeIso = new Date(Date.now() - 3_600_000).toISOString();
    const untilIso = new Date(Date.now() - 1_800_000).toISOString();
    await silence(() =>
      runLabelSubcommand(['add'], { count: '2', time: timeIso, until: untilIso }, store, features, testDeps()),
    );

    const labels = await store.listLabels();
    expect(labels).toHaveLength(1);
    expect(labels[0]!.endTimeMs).toBe(Date.parse(untilIso));
  });

  it('add without --until stays a point label (endTimeMs null), unchanged from before', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await silence(() => runLabelSubcommand(['session', 'start'], {}, store, features, testDeps()));
    await silence(() => runLabelSubcommand(['add'], { count: '1' }, store, features, testDeps()));

    const labels = await store.listLabels();
    expect(labels[0]!.endTimeMs).toBeNull();
  });

  it('rejects --until at or before --time with a clear message', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await silence(() => runLabelSubcommand(['session', 'start'], {}, store, features, testDeps()));

    await expect(
      runLabelSubcommand(
        ['add'],
        { count: '1', time: '2024-01-01T01:00:00.000Z', until: '2024-01-01T00:00:00.000Z' },
        store,
        features,
        testDeps(),
      ),
    ).rejects.toThrow(/--until.*must be after --time/);

    await expect(
      runLabelSubcommand(
        ['add'],
        { count: '1', time: '2024-01-01T00:00:00.000Z', until: '2024-01-01T00:00:00.000Z' },
        store,
        features,
        testDeps(),
      ),
    ).rejects.toThrow(/--until.*must be after --time/);

    expect(await store.listLabels()).toHaveLength(0);
  });
});

describe('runLabelSubcommand: export sub-command', () => {
  it('fetches features across an interval label\'s FULL span, not just its start (regression)', async () => {
    // If the fetch range were derived from `l.timeMs` alone (the bug this
    // guards against), a feature row near the END of a long interval label
    // would fall outside the fetched [minMs, maxMs] window and the label
    // would silently produce zero rows.
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await silence(() => runLabelSubcommand(['session', 'start'], {}, store, features, testDeps()));
    const [session] = await store.listSessions();
    await store.addLabel(session!.id, 0, 1, null, 10_000); // interval: 0..10000ms

    const featuresNearEnd = createInMemoryFeaturesReader([
      {
        timeMs: 9000, // well past timeMs(0) + toleranceMs(500)
        nodeId: 1,
        linkMac: 'aa:aa:aa:aa:aa:01',
        baselineDeviation: 5,
        motionEnergy: 0,
        temporalCorrelation: 1,
        dopplerProxy: 0,
      },
    ]);

    const outPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'homecsi-export-')), 'out.csv');
    await silence(() =>
      runLabelSubcommand(['export'], { out: outPath, 'tolerance-ms': '500' }, store, featuresNearEnd, testDeps()),
    );

    const csv = readFileSync(outPath, 'utf8');
    const lines = csv.trim().split('\n');
    expect(lines.length).toBeGreaterThan(1); // header + at least the row at 9000ms
  });
});

describe('runLabelSubcommand: presence probe produces a distinguishable weak label', () => {
  it('probe with no devices configured does not throw or write a label', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await silence(() =>
      runLabelSubcommand(['presence', 'probe'], { file: `${process.cwd()}/__nonexistent-devices.json` }, store, features, testDeps()),
    );
    expect(await store.listLabels()).toHaveLength(0);
  });
});

describe('runLabelSubcommand: session-close training-feature preservation hook', () => {
  it('preserves raw per-link features for a manual session on stop', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await silence(() => runLabelSubcommand(['session', 'start'], {}, store, features, testDeps()));
    const [session] = await store.listSessions();

    const seed = [
      { timeMs: session!.startedAtMs, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01' },
      { timeMs: session!.startedAtMs + 500, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01' },
    ];
    const trainingStore = createInMemoryTrainingFeaturesStore(seed);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let calls: unknown[][];
    try {
      await runLabelSubcommand(['session', 'stop'], {}, store, features, testDeps({ trainingStore }));
    } finally {
      // Snapshot calls before mockRestore(), which also clears them (like mockReset()).
      calls = [...logSpy.mock.calls];
      logSpy.mockRestore();
    }

    expect(calls.some((call) => String(call[0]).includes('preserved'))).toBe(true);
  });

  it('does NOT preserve raw per-link features when stopping a weak/presence-probe session', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    const session = await store.createSession(0, WEAK_SESSION_NOTES);

    const seed = [{ timeMs: 0, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01' }];
    const trainingStore = createInMemoryTrainingFeaturesStore(seed);
    const preservation = { toleranceMs: 2000, baselineWindowMs: 3_600_000, minDensityFraction: 0 };

    await silence(() =>
      runLabelSubcommand(
        ['session', 'stop'],
        { session: String(session.id) },
        store,
        features,
        testDeps({ trainingStore, preservation }),
      ),
    );

    // Re-run against a manual session over the same seeded window to prove the seed WOULD have matched.
    const manualStopResult = await preserveSessionFeatures(
      { id: 999, startedAtMs: 0, endedAtMs: 0, notes: 'manual' },
      trainingStore,
      preservation,
    );
    expect(manualStopResult.status).toBe('preserved');
    if (manualStopResult.status !== 'preserved') throw new Error('unreachable');
    expect(manualStopResult.inserted).toBeGreaterThan(0);
  });

  it('propagates a fail-loud error from stop when the window is already past retention, even though the deployment is otherwise healthy right now', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    const nowMs = Date.now();

    // A session from long ago -- well outside the (much shorter) live
    // baseline lookback used below.
    const session = await store.createSession(nowMs - 10_000_000, 'manual: old session');

    // Healthy baseline right now, but nothing at all for the session's own window.
    const trainingStore = createInMemoryTrainingFeaturesStore([
      { timeMs: nowMs - 1000, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01' },
    ]);
    const preservation = { toleranceMs: 0, baselineWindowMs: 3_600_000, minDensityFraction: 0.5 };

    await expect(
      runLabelSubcommand(
        ['session', 'stop'],
        { session: String(session.id) },
        store,
        features,
        testDeps({ trainingStore, preservation }),
      ),
    ).rejects.toThrow(/expected >=/);

    // The session itself was still stopped, even though preservation failed.
    const stopped = (await store.listSessions()).find((s) => s.id === session.id);
    expect(stopped!.endedAtMs).not.toBeNull();
  });

  // NOTE: the session-close hook cannot realistically exercise the
  // 'permanently-lost' branch through THIS CLI path -- `session stop`
  // always closes with `endedAtMs = Date.now()`, so the window's end is
  // always "now" at the moment of the call, and `entirelyPastRetention`
  // (nowMs - toMs > retentionMaxAgeMs) can never be true for a window that
  // just closed. The branch exists in index.ts purely for correct,
  // exhaustive handling of `preserveSessionFeatures`'s return type (shared
  // with the `preserve` sweep below, where an ALREADY-closed old session's
  // `endedAtMs` is a real historical timestamp and the branch is genuinely
  // reachable -- see the "preserve sweep" describe block). The underlying
  // downgrade logic itself is unit-tested directly in
  // trainingPreservation.test.ts.
});

describe('runLabelSubcommand: label add warns near the retention edge', () => {
  it('warns when --time is already inside the retention safety margin', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await silence(() => runLabelSubcommand(['session', 'start'], {}, store, features, testDeps()));

    const oldTimeIso = new Date(Date.now() - 6.9 * 86_400_000).toISOString();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let wasWarned: boolean;
    try {
      await runLabelSubcommand(
        ['add'],
        { count: '1', time: oldTimeIso },
        store,
        features,
        testDeps({ retentionWarning: { maxAgeMs: 7 * 86_400_000, safetyMarginMs: 86_400_000 } }),
      );
    } finally {
      // Read before mockRestore(), which also clears call history (like mockReset()).
      wasWarned = warnSpy.mock.calls.length > 0;
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
    expect(wasWarned).toBe(true);
  });

  it('does not warn for a recent --time', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await silence(() => runLabelSubcommand(['session', 'start'], {}, store, features, testDeps()));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await silence(() => runLabelSubcommand(['add'], { count: '1' }, store, features, testDeps()));
    } finally {
      warnSpy.mockRestore();
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('runLabelSubcommand: preserve sweep', () => {
  it('preserves a closed manual session and reports it', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    const session = await store.createSession(0, 'manual');
    await store.stopSession(session.id, 10_000);

    const seed = [{ timeMs: 0, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01' }];
    const trainingStore = createInMemoryTrainingFeaturesStore(seed);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let calls: unknown[][];
    try {
      await runLabelSubcommand(['preserve'], {}, store, features, testDeps({ trainingStore }));
    } finally {
      // Snapshot calls before mockRestore(), which also clears them (like mockReset()).
      calls = [...logSpy.mock.calls];
      logSpy.mockRestore();
    }
    expect(calls.some((call) => String(call[0]).includes('preserved'))).toBe(true);
  });

  it('throws an aggregate error when a session in the sweep is past retention, but still reports others', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    const nowMs = Date.now();

    const good = await store.createSession(nowMs - 20_000, 'manual');
    await store.stopSession(good.id, nowMs - 10_000);
    const bad = await store.createSession(nowMs - 10_000_000, 'manual');
    await store.stopSession(bad.id, nowMs - 9_990_000);

    // Healthy baseline right now, plus a row inside `good`'s recent window
    // -- `bad`'s much older window has nothing, so it fails regardless of
    // what the current baseline says.
    const trainingStore = createInMemoryTrainingFeaturesStore([
      { timeMs: nowMs - 15_000, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01' },
      { timeMs: nowMs - 1000, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01' },
    ]);
    const preservation = { toleranceMs: 2000, baselineWindowMs: 3_600_000, minDensityFraction: 0.5 };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        runLabelSubcommand(['preserve'], {}, store, features, testDeps({ trainingStore, preservation })),
      ).rejects.toThrow(/failed for 1 of 2/);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('does NOT fail the sweep for a session that is entirely past retentionMaxAgeMs with zero rows found (permanently-lost), but still fails for a genuinely fresh problem', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    const nowMs = Date.now();
    const retentionMaxAgeMs = 7 * 86_400_000;

    // `ancient`: window entirely past the 7-day retention deadline, zero
    // rows found anywhere -- must be reported but NOT fail the sweep.
    const longAgoMs = nowMs - retentionMaxAgeMs - 1_000_000;
    const ancient = await store.createSession(longAgoMs, 'manual: ancient');
    await store.stopSession(ancient.id, longAgoMs + 10_000);

    // `fresh`: recent window, healthy baseline, but genuinely nothing
    // found for its own window -- still a real, actionable failure.
    const fresh = await store.createSession(nowMs - 20_000, 'manual: fresh problem');
    await store.stopSession(fresh.id, nowMs - 10_000);

    const trainingStore = createInMemoryTrainingFeaturesStore([{ timeMs: nowMs - 1000, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01' }]);
    const preservation = { toleranceMs: 0, baselineWindowMs: 3_600_000, minDensityFraction: 0.5, retentionMaxAgeMs };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let warnCalls: unknown[][];
    try {
      // Only the genuinely-fresh failure should count -- "failed for 1 of
      // 2", not 2 of 2, even though BOTH sessions failed the density check.
      await expect(
        runLabelSubcommand(['preserve'], {}, store, features, testDeps({ trainingStore, preservation })),
      ).rejects.toThrow(/failed for 1 of 2/);
    } finally {
      warnCalls = [...warnSpy.mock.calls];
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(warnCalls.some((call) => String(call[0]).includes('permanently lost'))).toBe(true);
  });

  it('exits zero (does not throw) on a healthy deployment whose sessions are all already preserved', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    const nowMs = Date.now();

    // A session old enough that its `features` rows would be past the
    // 7-day retention window, but it was ALREADY preserved into
    // training_features by an earlier run.
    const session = await store.createSession(nowMs - 10_000_000, 'manual: old, already preserved');
    await store.stopSession(session.id, nowMs - 9_990_000);

    const baselineSeed = [{ timeMs: nowMs - 1000, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01' }];
    const alreadyPreservedSeed = [
      { timeMs: nowMs - 10_000_000, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01' },
      { timeMs: nowMs - 9_995_000, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01' },
    ];
    const trainingStore = createInMemoryTrainingFeaturesStore(baselineSeed, alreadyPreservedSeed);
    const preservation = { toleranceMs: 2000, baselineWindowMs: 3_600_000, minDensityFraction: 0.5 };

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(
        runLabelSubcommand(['preserve'], {}, store, features, testDeps({ trainingStore, preservation })),
      ).resolves.toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('warns about a still-open session nearing the retention edge, independent of whether preservation itself succeeds', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    // Left open on purpose -- never stopped. Started long enough ago to be
    // inside the default testDeps() retention safety margin (maxAgeMs=7d,
    // safetyMarginMs=1d), so this should warn even though nothing ever
    // called `label add` or `session stop` on it.
    await store.createSession(Date.now() - 6.95 * 86_400_000, 'manual: long-running');

    // Density check disabled -- this test is specifically about the
    // proactive open-session warning, not preservation's own success/failure.
    const trainingStore = createInMemoryTrainingFeaturesStore([]);
    const preservation = { toleranceMs: 2000, baselineWindowMs: 3_600_000, minDensityFraction: 0 };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let warnCalls: unknown[][];
    try {
      await runLabelSubcommand(['preserve'], {}, store, features, testDeps({ trainingStore, preservation }));
    } finally {
      warnCalls = [...warnSpy.mock.calls];
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(warnCalls.some((call) => String(call[0]).includes('still open'))).toBe(true);
  });
});

describe('runTrainCore', () => {
  class FakeWriter implements TrainWriter {
    public files = new Map<string, string>();
    public dirs: string[] = [];
    mkdir(dirPath: string): void {
      this.dirs.push(dirPath);
    }
    writeFile(filePath: string, contents: string): void {
      this.files.set(filePath, contents);
    }
  }

  it('reports no-labels when there is nothing to export, without touching the filesystem', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    const writer = new FakeWriter();
    const result = await runTrainCore(
      { outDir: '/tmp/out', trainRatio: 0.8, sessionId: undefined, toleranceMs: 2000, motionOnThreshold: 3.0, hopMs: 1000 },
      store,
      features,
      writer,
    );
    expect(result.status).toBe('no-labels');
    expect(writer.files.size).toBe(0);
  });

  it('exports a temporally-split dataset with a README when labels and features are present', async () => {
    const store = createInMemoryLabelStore();
    const session = await store.createSession(0, null);
    for (let t = 0; t < 10_000; t += 1000) {
      await store.addLabel(session.id, t, t < 5000 ? 0 : 1, null);
    }
    const featureRows = [];
    for (let t = 0; t < 10_000; t += 1000) {
      featureRows.push({
        timeMs: t,
        nodeId: 1,
        linkMac: 'aa:aa:aa:aa:aa:01',
        baselineDeviation: t < 5000 ? 0 : 5,
        motionEnergy: 0,
        temporalCorrelation: 1,
        dopplerProxy: 0,
      });
    }
    const features = createInMemoryFeaturesReader(featureRows);
    const writer = new FakeWriter();

    const result = await runTrainCore(
      { outDir: '/tmp/out', trainRatio: 0.8, sessionId: undefined, toleranceMs: 500, motionOnThreshold: 3.0, hopMs: 1000 },
      store,
      features,
      writer,
    );

    const trainPath = path.join('/tmp/out', 'train.csv');
    const testPath = path.join('/tmp/out', 'test.csv');
    const readmePath = path.join('/tmp/out', 'README.md');

    expect(result.status).toBe('written');
    expect(result.trainRowCount + result.testRowCount).toBe(10);
    expect(writer.files.has(trainPath)).toBe(true);
    expect(writer.files.has(testPath)).toBe(true);
    expect(writer.files.has(readmePath)).toBe(true);
    expect(writer.files.get(readmePath)).toContain('never trains a model in-process');

    // Chronological split: every train timestamp <= every test timestamp.
    const trainCsv = writer.files.get(trainPath) as string;
    const testCsv = writer.files.get(testPath) as string;
    const lastTrainLine = trainCsv.trim().split('\n').at(-1) as string;
    const firstTestLine = testCsv.trim().split('\n')[1] as string;
    expect(lastTrainLine.split(',')[0]! <= firstTestLine.split(',')[0]!).toBe(true);
  });

  it('fetches features across an interval label\'s FULL span, not just its start (regression)', async () => {
    // Same regression as the `export` sub-command's test above, exercised
    // through runTrainCore's separate minMs/maxMs computation.
    const store = createInMemoryLabelStore();
    const session = await store.createSession(0, null);
    await store.addLabel(session.id, 0, 1, null, 10_000); // interval: 0..10000ms

    const features = createInMemoryFeaturesReader([
      {
        timeMs: 9000, // well past timeMs(0) + toleranceMs(500)
        nodeId: 1,
        linkMac: 'aa:aa:aa:aa:aa:01',
        baselineDeviation: 5,
        motionEnergy: 0,
        temporalCorrelation: 1,
        dopplerProxy: 0,
      },
    ]);
    const writer = new FakeWriter();

    const result = await runTrainCore(
      { outDir: '/tmp/out', trainRatio: 0.8, sessionId: undefined, toleranceMs: 500, motionOnThreshold: 3.0, hopMs: 1000 },
      store,
      features,
      writer,
    );

    expect(result.status).toBe('written');
    expect(result.trainRowCount + result.testRowCount).toBeGreaterThan(0);
  });

  it('reports partiallyCoveredIntervalCount for an interval label with a mid-window gap', async () => {
    const store = createInMemoryLabelStore();
    const session = await store.createSession(0, null);
    await store.addLabel(session.id, 0, 1, null, 6000); // interval: 0..6000ms, hopMs 1000 => 6 expected ticks

    const features = createInMemoryFeaturesReader([
      { timeMs: 0, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01', baselineDeviation: 0, motionEnergy: 0, temporalCorrelation: 1, dopplerProxy: 0 },
      { timeMs: 1000, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01', baselineDeviation: 0, motionEnergy: 0, temporalCorrelation: 1, dopplerProxy: 0 },
    ]);
    const writer = new FakeWriter();

    const result = await runTrainCore(
      { outDir: '/tmp/out', trainRatio: 0.8, sessionId: undefined, toleranceMs: 500, motionOnThreshold: 3.0, hopMs: 1000 },
      store,
      features,
      writer,
    );

    expect(result.status).toBe('written');
    expect(result.partiallyCoveredIntervalCount).toBe(1);
    const readme = writer.files.get(path.join('/tmp/out', 'README.md')) as string;
    expect(readme).toContain('PARTIALLY covered');
  });
});
