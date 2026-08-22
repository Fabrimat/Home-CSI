import { describe, expect, it } from 'vitest';
import { alignToHopGrid, buildWindows, type TimedSample } from './windowing.js';

describe('alignToHopGrid', () => {
  it('floors to the nearest hop boundary', () => {
    expect(alignToHopGrid(1234, 500)).toBe(1000);
    expect(alignToHopGrid(1000, 500)).toBe(1000);
    expect(alignToHopGrid(999, 500)).toBe(500);
  });
});

function samples(times: number[]): TimedSample<number>[] {
  return times.map((t) => ({ timeMs: t, value: t }));
}

describe('buildWindows', () => {
  const spec = { windowMs: 2000, hopMs: 500 };

  it('produces no windows for an empty sample list', () => {
    expect(buildWindows([], spec, 100_000, null)).toEqual([]);
  });

  it('only emits windows that are fully closed (end <= closedUpToMs)', () => {
    // Samples span 0..3000ms; with a 2000ms window only windows ending at or
    // before closedUpToMs should appear.
    const s = samples([0, 500, 1000, 1500, 2000, 2500, 3000]);
    const windows = buildWindows(s, spec, 3000, null);
    for (const w of windows) {
      expect(w.endMs).toBeLessThanOrEqual(3000);
    }
    // The grid-aligned window [0, 2000) should be present.
    expect(windows.some((w) => w.startMs === 0 && w.endMs === 2000)).toBe(true);
    // A window ending after closedUpToMs (e.g. [1500, 3500)) must not appear.
    expect(windows.some((w) => w.endMs > 3000)).toBe(false);
  });

  it('skips windows already emitted (end <= sinceExclusiveEndMs), enabling resumable runs', () => {
    const s = samples([0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000]);
    const first = buildWindows(s, spec, 4000, null);
    const firstEnds = first.map((w) => w.endMs);
    const lastCheckpoint = Math.max(...firstEnds);

    // Simulate a second run with the same underlying data plus a checkpoint
    // from the first run — should produce no duplicate windows.
    const second = buildWindows(s, spec, 4000, lastCheckpoint);
    expect(second).toEqual([]);
  });

  it('hops by hopMs, producing overlapping windows', () => {
    const s = samples(Array.from({ length: 11 }, (_, i) => i * 500)); // 0..5000
    const windows = buildWindows(s, spec, 5000, null);
    const starts = windows.map((w) => w.startMs);
    for (let i = 1; i < starts.length; i++) {
      expect((starts[i] as number) - (starts[i - 1] as number)).toBe(500);
    }
  });

  it('aligns windows to an absolute grid regardless of the first sample time (cross-link comparability)', () => {
    const linkA = samples([1200, 1700, 2200, 2700, 3200]);
    const linkB = samples([1300, 1800, 2300, 2800, 3300]);
    const windowsA = buildWindows(linkA, spec, 4000, null);
    const windowsB = buildWindows(linkB, spec, 4000, null);
    // Both should land on the same hop-grid boundaries (multiples of 500ms).
    for (const w of [...windowsA, ...windowsB]) {
      expect(w.startMs % spec.hopMs).toBe(0);
    }
  });
});
