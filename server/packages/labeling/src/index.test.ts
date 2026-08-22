import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryFeaturesReader } from './featuresSource.js';
import { runLabelSubcommand, runTrainCore, type TrainWriter } from './index.js';
import { createInMemoryLabelStore, isWeakLabel } from './sessions.js';

async function silence<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

describe('runLabelSubcommand: session lifecycle', () => {
  it('starts, lists, and stops a session', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);

    await silence(() => runLabelSubcommand(['session', 'start'], { notes: 'evening test' }, store, features));
    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.endedAtMs).toBeNull();

    await silence(() => runLabelSubcommand(['session', 'stop'], {}, store, features));
    const stopped = await store.listSessions();
    expect(stopped[0]!.endedAtMs).not.toBeNull();
  });

  it('session stop throws a clear error when there is no open session', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await expect(runLabelSubcommand(['session', 'stop'], {}, store, features)).rejects.toThrow(/no open session/);
  });
});

describe('runLabelSubcommand: add / list', () => {
  it('adds a manual label to the currently open session', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await silence(() => runLabelSubcommand(['session', 'start'], {}, store, features));
    await silence(() => runLabelSubcommand(['add'], { count: '2', notes: 'two people' }, store, features));

    const labels = await store.listLabels();
    expect(labels).toHaveLength(1);
    expect(labels[0]!.occupancyCount).toBe(2);
    expect(isWeakLabel(labels[0]!.notes)).toBe(false);
  });

  it('add throws a clear error when there is no open session and none was specified', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await expect(runLabelSubcommand(['add'], { count: '1' }, store, features)).rejects.toThrow(/no open session/);
  });

  it('rejects a non-integer --count', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await silence(() => runLabelSubcommand(['session', 'start'], {}, store, features));
    await expect(runLabelSubcommand(['add'], { count: 'two' }, store, features)).rejects.toThrow(
      /must be an integer/,
    );
  });
});

describe('runLabelSubcommand: presence probe produces a distinguishable weak label', () => {
  it('probe with no devices configured does not throw or write a label', async () => {
    const store = createInMemoryLabelStore();
    const features = createInMemoryFeaturesReader([]);
    await silence(() =>
      runLabelSubcommand(['presence', 'probe'], { file: `${process.cwd()}/__nonexistent-devices.json` }, store, features),
    );
    expect(await store.listLabels()).toHaveLength(0);
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
      { outDir: '/tmp/out', trainRatio: 0.8, sessionId: undefined, toleranceMs: 2000, motionOnThreshold: 3.0 },
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
      { outDir: '/tmp/out', trainRatio: 0.8, sessionId: undefined, toleranceMs: 500, motionOnThreshold: 3.0 },
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
});
