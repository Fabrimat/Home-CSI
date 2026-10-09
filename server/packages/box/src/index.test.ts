import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runBoxSubcommand, type BoxCliDeps } from './index.js';
import { createInMemoryBoxTakeStore, type BoxTakeRecord } from './preservation.js';
import { createInMemoryBoxSessionStore } from './sessions.js';

const LLTF = 0;

function csiData(amplitudes: readonly number[]): Buffer {
  const buf = Buffer.alloc(amplitudes.length * 2);
  amplitudes.forEach((a, i) => {
    buf.writeInt8(a, i * 2);
    buf.writeInt8(0, i * 2 + 1);
  });
  return buf;
}

function record(overrides: Partial<BoxTakeRecord> & { amplitudes?: readonly number[] } = {}): BoxTakeRecord {
  const { amplitudes, ...rest } = overrides;
  return {
    timeMs: 1000,
    nodeId: 1,
    linkMac: 'aa:aa:aa:aa:aa:01',
    rssi: -50,
    csiFormat: LLTF,
    csiData: csiData(amplitudes ?? [10, 20, 30]),
    ...rest,
  };
}

async function silence<T>(fn: () => Promise<T>): Promise<T> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    return await fn();
  } finally {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  }
}

const CONFIG = { leadInMs: 0, leadOutMs: 0 };

describe('runBoxSubcommand: list', () => {
  it('prints nothing-yet when there are no sessions', async () => {
    const deps: BoxCliDeps = {
      sessionStore: createInMemoryBoxSessionStore(),
      takeStore: createInMemoryBoxTakeStore(),
      preservation: CONFIG,
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runBoxSubcommand(['list'], {}, deps);
    expect(logSpy).toHaveBeenCalledWith('no box sessions yet');
    logSpy.mockRestore();
  });

  it('lists sessions with their preserved record count', async () => {
    const sessionStore = createInMemoryBoxSessionStore();
    const session = await sessionStore.createSession({
      startedAtMs: 1000,
      gestureClass: 'fist',
      geometryNote: null,
      notes: null,
    });
    await sessionStore.stopSession(session.id, 5000);
    const takeStore = createInMemoryBoxTakeStore([record({ timeMs: 2000 })]);
    await takeStore.preserveWindow(session.id, 0, 10_000);

    const deps: BoxCliDeps = { sessionStore, takeStore, preservation: CONFIG };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runBoxSubcommand(['list'], {}, deps);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('fist') && String(c[0]).includes('records=1'))).toBe(
      true,
    );
    logSpy.mockRestore();
  });
});

describe('runBoxSubcommand: train', () => {
  it('refuses to report accuracy with no takes at all', async () => {
    const deps: BoxCliDeps = {
      sessionStore: createInMemoryBoxSessionStore(),
      takeStore: createInMemoryBoxTakeStore(),
      preservation: CONFIG,
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runBoxSubcommand(['train'], {}, deps);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('refusing to report an accuracy figure'))).toBe(true);
    logSpy.mockRestore();
  });

  it('writes report.json/report.txt when --out is given', async () => {
    const deps: BoxCliDeps = {
      sessionStore: createInMemoryBoxSessionStore(),
      takeStore: createInMemoryBoxTakeStore(),
      preservation: CONFIG,
    };
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'homecsi-box-test-'));
    await silence(() => runBoxSubcommand(['train'], { out: outDir }, deps));
    const report = JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8')) as { status: string };
    expect(report.status).toBe('insufficient-data');
    expect(readFileSync(path.join(outDir, 'report.txt'), 'utf8')).toMatch(/refusing to report/);
  });
});

describe('runBoxSubcommand: export', () => {
  it('requires --out', async () => {
    const deps: BoxCliDeps = {
      sessionStore: createInMemoryBoxSessionStore(),
      takeStore: createInMemoryBoxTakeStore(),
      preservation: CONFIG,
    };
    await expect(runBoxSubcommand(['export'], {}, deps)).rejects.toThrow(/missing required --out/);
  });

  it('writes one CSV row per closed, feature-computable session', async () => {
    const sessionStore = createInMemoryBoxSessionStore();
    const session = await sessionStore.createSession({
      startedAtMs: 0,
      gestureClass: 'fist',
      geometryNote: 'north wall',
      notes: null,
    });
    await sessionStore.stopSession(session.id, 10_000);
    const takeStore = createInMemoryBoxTakeStore([record({ timeMs: 2000 })]);
    await takeStore.preserveWindow(session.id, 0, 10_000);

    const deps: BoxCliDeps = { sessionStore, takeStore, preservation: CONFIG };
    const outFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'homecsi-box-export-')), 'out.csv');
    await silence(() => runBoxSubcommand(['export'], { out: outFile }, deps));

    const csv = readFileSync(outFile, 'utf8').trim().split('\n');
    expect(csv[0]).toMatch(/^sessionId,gestureClass,geometryNote,recordCount,usable,feature_0/);
    expect(csv).toHaveLength(2);
    expect(csv[1]).toMatch(/^1,fist,north wall,1,0,/); // usable=0: 1 record is below DEFAULT_MIN_TAKE_RECORDS
  });
});

describe('runBoxSubcommand: preserve', () => {
  it('preserves a closed session and skips an open one', async () => {
    const sessionStore = createInMemoryBoxSessionStore();
    const closed = await sessionStore.createSession({ startedAtMs: 0, gestureClass: 'fist', geometryNote: null, notes: null });
    await sessionStore.stopSession(closed.id, 5000);
    await sessionStore.createSession({ startedAtMs: 0, gestureClass: 'open', geometryNote: null, notes: null });

    const takeStore = createInMemoryBoxTakeStore([record({ timeMs: 2000 })]);
    const deps: BoxCliDeps = { sessionStore, takeStore, preservation: CONFIG };

    await silence(() => runBoxSubcommand(['preserve'], {}, deps));
    expect(await takeStore.countPreserved(closed.id)).toBe(1);
  });

  it('warns (does not throw) naming both node counts on a partial node dropout', async () => {
    const sessionStore = createInMemoryBoxSessionStore();
    const session = await sessionStore.createSession({ startedAtMs: 0, gestureClass: 'fist', geometryNote: null, notes: null });
    await sessionStore.stopSession(session.id, 5000);
    // 2 registered box nodes, but only node 1 reported CSI for this window.
    const takeStore = createInMemoryBoxTakeStore([record({ timeMs: 2000, nodeId: 1 })], 2);
    const deps: BoxCliDeps = { sessionStore, takeStore, preservation: CONFIG };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let warnCalls: unknown[][];
    try {
      await runBoxSubcommand(['preserve'], {}, deps);
      // Captured BEFORE mockRestore(), which also clears recorded calls.
      warnCalls = warnSpy.mock.calls;
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(warnCalls.some((c) => String(c[0]).includes('1 of 2'))).toBe(true);
  });

  it('throws naming the failing session(s) when preservation fails for at least one', async () => {
    const sessionStore = createInMemoryBoxSessionStore();
    const lost = await sessionStore.createSession({ startedAtMs: 0, gestureClass: 'fist', geometryNote: null, notes: null });
    await sessionStore.stopSession(lost.id, 5000);
    const takeStore = createInMemoryBoxTakeStore([]); // nothing seeded anywhere
    const deps: BoxCliDeps = { sessionStore, takeStore, preservation: CONFIG };

    await expect(silence(() => runBoxSubcommand(['preserve'], {}, deps))).rejects.toThrow(
      /box take preservation failed for 1 of 1 session/,
    );
  });
});

describe('runBoxSubcommand: unknown', () => {
  it('throws a clear error listing the known sub-commands', async () => {
    const deps: BoxCliDeps = {
      sessionStore: createInMemoryBoxSessionStore(),
      takeStore: createInMemoryBoxTakeStore(),
      preservation: CONFIG,
    };
    await expect(runBoxSubcommand(['bogus'], {}, deps)).rejects.toThrow(/unknown box sub-command/);
  });
});
