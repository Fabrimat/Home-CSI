import { describe, expect, it } from 'vitest';
import type { StepSegment } from './occupancySeries.js';
import {
  classifySelectionRetention,
  clampInterval,
  findLabelDisagreements,
  intervalsOverlap,
  labelToMsInterval,
  retentionBoundaries,
  retentionZoneAt,
  retentionZoneForRange,
  systemEstimateOverSelection,
  type LabelMsInterval,
  type LabelRangeInput,
  type RetentionAvailability,
} from './labelRanges.js';

const T = (iso: string): number => Date.parse(iso);

function segment(startIso: string, endIso: string, estimate: number, state = 'OCCUPIED'): StepSegment {
  return {
    startMs: T(startIso),
    endMs: T(endIso),
    row: { time: startIso, estimate, confidence: 0.9, state, kind: 'transition', details: null },
  };
}

describe('labelToMsInterval', () => {
  it('converts an interval label to ms bounds', () => {
    const input: LabelRangeInput = {
      id: 1,
      sessionId: 1,
      time: '2026-01-01T12:00:00.000Z',
      endTime: '2026-01-01T13:00:00.000Z',
      occupancyCount: 1,
      source: 'manual',
      notes: null,
    };
    expect(labelToMsInterval(input)).toEqual({
      id: 1,
      fromMs: T('2026-01-01T12:00:00.000Z'),
      toMs: T('2026-01-01T13:00:00.000Z'),
      occupancyCount: 1,
      source: 'manual',
      notes: null,
    });
  });

  it('leaves toMs null for a point label', () => {
    const input: LabelRangeInput = {
      id: 2,
      sessionId: 1,
      time: '2026-01-01T12:00:00.000Z',
      endTime: null,
      occupancyCount: 0,
      source: 'confirmed',
      notes: null,
    };
    expect(labelToMsInterval(input).toMs).toBeNull();
  });
});

describe('intervalsOverlap / clampInterval', () => {
  it('detects overlap and non-overlap of half-open intervals', () => {
    expect(intervalsOverlap(0, 10, 5, 15)).toBe(true);
    expect(intervalsOverlap(0, 10, 10, 20)).toBe(false); // half-open, touching edges don't overlap
    expect(intervalsOverlap(0, 10, 20, 30)).toBe(false);
  });

  it('clamps a range to a window, returning null when there is no overlap', () => {
    expect(clampInterval(5, 15, 0, 10)).toEqual({ fromMs: 5, toMs: 10 });
    expect(clampInterval(-5, 3, 0, 10)).toEqual({ fromMs: 0, toMs: 3 });
    expect(clampInterval(20, 30, 0, 10)).toBeNull();
    expect(clampInterval(10, 20, 0, 10)).toBeNull(); // half-open: touching at the boundary is not an overlap
  });
});

describe('systemEstimateOverSelection', () => {
  const segments: StepSegment[] = [
    segment('2026-01-01T09:00:00.000Z', '2026-01-01T10:00:00.000Z', 0, 'UNOCCUPIED'),
    segment('2026-01-01T10:00:00.000Z', '2026-01-01T11:00:00.000Z', 1, 'OCCUPIED'),
    segment('2026-01-01T11:00:00.000Z', '2026-01-01T12:00:00.000Z', 1, 'OCCUPIED'),
  ];

  it('reports constant when every overlapping segment shares one estimate', () => {
    const result = systemEstimateOverSelection(segments, T('2026-01-01T10:15:00.000Z'), T('2026-01-01T11:45:00.000Z'));
    expect(result).toEqual({ hasData: true, constant: true, estimate: 1, distinctEstimates: [1] });
  });

  it('reports not-constant when the selection spans a transition', () => {
    const result = systemEstimateOverSelection(segments, T('2026-01-01T09:30:00.000Z'), T('2026-01-01T10:30:00.000Z'));
    expect(result.constant).toBe(false);
    expect(result.estimate).toBeNull();
    expect(result.distinctEstimates).toEqual([0, 1]);
  });

  it('reports no data when the selection does not overlap any segment', () => {
    const result = systemEstimateOverSelection(segments, T('2026-01-01T13:00:00.000Z'), T('2026-01-01T14:00:00.000Z'));
    expect(result).toEqual({ hasData: false, constant: false, estimate: null, distinctEstimates: [] });
  });

  it('does not count the next segment when the selection ends exactly at its boundary (half-open)', () => {
    const result = systemEstimateOverSelection(segments, T('2026-01-01T09:00:00.000Z'), T('2026-01-01T10:00:00.000Z'));
    expect(result).toEqual({ hasData: true, constant: true, estimate: 0, distinctEstimates: [0] });
  });
});

describe('findLabelDisagreements', () => {
  const segments: StepSegment[] = [
    segment('2026-01-01T09:00:00.000Z', '2026-01-01T10:00:00.000Z', 0, 'UNOCCUPIED'),
    segment('2026-01-01T10:00:00.000Z', '2026-01-01T11:00:00.000Z', 1, 'OCCUPIED'),
  ];

  it('finds no disagreement when an interval label matches the system estimate throughout', () => {
    const label: LabelMsInterval = {
      id: 1,
      fromMs: T('2026-01-01T10:00:00.000Z'),
      toMs: T('2026-01-01T10:30:00.000Z'),
      occupancyCount: 1,
      source: 'manual',
      notes: null,
    };
    expect(findLabelDisagreements([label], segments)).toEqual([]);
  });

  it('flags the disagreeing sub-interval when a label spans a system transition it does not match', () => {
    const label: LabelMsInterval = {
      id: 2,
      fromMs: T('2026-01-01T09:30:00.000Z'),
      toMs: T('2026-01-01T10:30:00.000Z'),
      occupancyCount: 0, // matches the first segment, disagrees with the second
      source: 'manual',
      notes: null,
    };
    const disagreements = findLabelDisagreements([label], segments);
    expect(disagreements).toEqual([
      {
        labelId: 2,
        fromMs: T('2026-01-01T10:00:00.000Z'),
        toMs: T('2026-01-01T10:30:00.000Z'),
        labelCount: 0,
        systemEstimate: 1,
      },
    ]);
  });

  it('checks a point label against the single segment holding at its instant', () => {
    const agree: LabelMsInterval = {
      id: 3,
      fromMs: T('2026-01-01T09:30:00.000Z'),
      toMs: null,
      occupancyCount: 0,
      source: 'confirmed',
      notes: null,
    };
    const disagree: LabelMsInterval = {
      id: 4,
      fromMs: T('2026-01-01T10:30:00.000Z'),
      toMs: null,
      occupancyCount: 0,
      source: 'manual',
      notes: null,
    };
    expect(findLabelDisagreements([agree], segments)).toEqual([]);
    expect(findLabelDisagreements([disagree], segments)).toEqual([
      { labelId: 4, fromMs: T('2026-01-01T10:30:00.000Z'), toMs: T('2026-01-01T10:30:00.000Z'), labelCount: 0, systemEstimate: 1 },
    ]);
  });

  it('does not fabricate a disagreement for a point label outside any segment', () => {
    const outside: LabelMsInterval = {
      id: 5,
      fromMs: T('2026-01-01T12:00:00.000Z'),
      toMs: null,
      occupancyCount: 2,
      source: 'manual',
      notes: null,
    };
    expect(findLabelDisagreements([outside], segments)).toEqual([]);
  });
});

describe('retention classification', () => {
  const config = { retentionMaxAgeMs: 7 * 86_400_000, retentionSafetyMarginMs: 86_400_000 };
  const now = T('2026-01-10T00:00:00.000Z');

  it('classifies a recent instant as ok', () => {
    expect(retentionZoneAt(now - 1_000, config, now)).toBe('ok');
  });

  it('classifies an instant inside the safety margin as approaching', () => {
    expect(retentionZoneAt(now - 6.5 * 86_400_000, config, now)).toBe('approaching');
  });

  it('classifies an instant past the retention window as past-deadline', () => {
    expect(retentionZoneAt(now - 8 * 86_400_000, config, now)).toBe('past-deadline');
  });

  it('classifies exactly at the maxAge boundary as past-deadline (inclusive)', () => {
    expect(retentionZoneAt(now - 7 * 86_400_000, config, now)).toBe('past-deadline');
  });

  it('retentionZoneForRange uses the oldest instant in the range as the binding constraint', () => {
    const fromMs = now - 8 * 86_400_000; // past-deadline
    const toMs = now - 1_000; // ok
    expect(retentionZoneForRange(fromMs, toMs, config, now)).toBe('past-deadline');
    expect(retentionZoneForRange(toMs, fromMs, config, now)).toBe('past-deadline'); // order-independent
  });

  it('computes absolute boundary timestamps', () => {
    const { deadlineMs, approachingStartMs } = retentionBoundaries(config, now);
    expect(deadlineMs).toBe(now - 7 * 86_400_000);
    expect(approachingStartMs).toBe(now - 6 * 86_400_000);
  });
});

describe('classifySelectionRetention', () => {
  const config = { retentionMaxAgeMs: 7 * 86_400_000, retentionSafetyMarginMs: 86_400_000 };
  const now = T('2026-01-10T00:00:00.000Z');

  it('reports loading (never "ok") while the config fetch has not resolved', () => {
    const status = classifySelectionRetention({ status: 'loading' }, now - 1_000, now, now);
    expect(status).toBe('loading');
  });

  it('reports unavailable (never "ok") when the config fetch failed', () => {
    const status = classifySelectionRetention({ status: 'failed' }, now - 1_000, now, now);
    expect(status).toBe('unavailable');
  });

  it('delegates to retentionZoneForRange once loaded', () => {
    const loaded: RetentionAvailability = { status: 'loaded', config };
    expect(classifySelectionRetention(loaded, now - 1_000, now, now)).toBe('ok');
    expect(classifySelectionRetention(loaded, now - 6.5 * 86_400_000, now - 6 * 86_400_000, now)).toBe('approaching');
    expect(classifySelectionRetention(loaded, now - 8 * 86_400_000, now - 7.5 * 86_400_000, now)).toBe('past-deadline');
  });

  it('never returns "ok" for a loading or failed availability regardless of the range given', () => {
    // Even a range that would classify as comfortably "ok" once loaded must
    // not silently read as fine while unknown -- this is the exact bug the
    // three-state model exists to prevent.
    const wellWithinWindow = { fromMs: now - 1_000, toMs: now };
    expect(classifySelectionRetention({ status: 'loading' }, wellWithinWindow.fromMs, wellWithinWindow.toMs, now)).not.toBe('ok');
    expect(classifySelectionRetention({ status: 'failed' }, wellWithinWindow.fromMs, wellWithinWindow.toMs, now)).not.toBe('ok');
  });
});
