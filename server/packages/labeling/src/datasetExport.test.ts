import { describe, expect, it } from 'vitest';
import { WEAK_LABEL_PREFIX } from './sessions.js';
import {
  joinLabelsWithFeatures,
  temporalSplit,
  toCsv,
  type DatasetRow,
  type FeatureSampleForExport,
  type LabelForExport,
} from './datasetExport.js';

const MOTION_ON_THRESHOLD = 3.0;
const TOLERANCE_MS = 1000;
const HOP_MS = 1000;

function feature(
  timeMs: number,
  nodeId: number,
  linkMac: string,
  overrides: Partial<FeatureSampleForExport> = {},
): FeatureSampleForExport {
  return {
    timeMs,
    nodeId,
    linkMac,
    baselineDeviation: 0,
    motionEnergy: 0,
    temporalCorrelation: 1,
    dopplerProxy: 0,
    ...overrides,
  };
}

/** Point label by default (`endTimeMs: null`) -- pass `endTimeMs` to make it an interval. */
function pointLabel(overrides: Partial<LabelForExport> & { timeMs: number }): LabelForExport {
  return {
    labelId: 1,
    endTimeMs: null,
    occupancyCount: 1,
    source: 'manual',
    notes: null,
    ...overrides,
  };
}

describe('joinLabelsWithFeatures: point labels (unchanged behaviour)', () => {
  it('joins a label to the nearest sample per link within tolerance', () => {
    const labels: LabelForExport[] = [
      pointLabel({ labelId: 1, timeMs: 1000, occupancyCount: 1, notes: 'manual: someone home' }),
    ];
    const features: FeatureSampleForExport[] = [
      feature(850, 1, 'aa:aa:aa:aa:aa:01', { baselineDeviation: 5 }),
      feature(1050, 1, 'aa:aa:aa:aa:aa:01', { baselineDeviation: 4 }), // strictly closer to label time
      feature(950, 2, 'bb:bb:bb:bb:bb:02', { baselineDeviation: 0 }),
    ];

    const { rows, skippedLabelCount } = joinLabelsWithFeatures(
      labels,
      features,
      TOLERANCE_MS,
      MOTION_ON_THRESHOLD,
      HOP_MS,
    );

    expect(skippedLabelCount).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.labelId).toBe(1);
    expect(rows[0]!.labelDurationMs).toBe(0);
    expect(rows[0]!.linkCountObserved).toBe(2);
    expect(rows[0]!.labelSource).toBe('manual');
    expect(rows[0]!.occupancyCount).toBe(1);
    // Nearest sample for link 1 was the 1050ms one (deviation 4), not the 850ms one.
    expect(rows[0]!.maxBaselineDeviation).toBe(4);
  });

  it('marks a label with the weak-label prefix as labelSource "weak:phone-presence" (legacy fallback)', () => {
    // Simulates a pre-migration-008 row: `source` still defaults to 'manual'
    // but the legacy notes-prefix convention says otherwise.
    const labels: LabelForExport[] = [
      pointLabel({ labelId: 1, timeMs: 1000, occupancyCount: 1, notes: `${WEAK_LABEL_PREFIX} devices=alice-phone` }),
    ];
    const features: FeatureSampleForExport[] = [feature(1000, 1, 'aa:aa:aa:aa:aa:01')];
    const { rows } = joinLabelsWithFeatures(labels, features, TOLERANCE_MS, MOTION_ON_THRESHOLD, HOP_MS);
    expect(rows[0]!.labelSource).toBe('weak:phone-presence');
  });

  it('passes through real source column provenance untouched', () => {
    const labels: LabelForExport[] = [
      pointLabel({ labelId: 1, timeMs: 1000, occupancyCount: 1, source: 'confirmed', notes: null }),
    ];
    const features: FeatureSampleForExport[] = [feature(1000, 1, 'aa:aa:aa:aa:aa:01')];
    const { rows } = joinLabelsWithFeatures(labels, features, TOLERANCE_MS, MOTION_ON_THRESHOLD, HOP_MS);
    expect(rows[0]!.labelSource).toBe('confirmed');
  });

  it('skips a label with no feature data within tolerance, without dropping others', () => {
    const labels: LabelForExport[] = [
      pointLabel({ labelId: 1, timeMs: 1000, occupancyCount: 0, notes: null }), // no nearby features
      pointLabel({ labelId: 2, timeMs: 5000, occupancyCount: 1, notes: null }),
    ];
    const features: FeatureSampleForExport[] = [feature(5000, 1, 'aa:aa:aa:aa:aa:01')];
    const { rows, skippedLabelCount, coverage } = joinLabelsWithFeatures(
      labels,
      features,
      TOLERANCE_MS,
      MOTION_ON_THRESHOLD,
      HOP_MS,
    );
    expect(skippedLabelCount).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occupancyCount).toBe(1);
    expect(coverage.find((c) => c.labelId === 1)!.rowsEmitted).toBe(0);
    expect(coverage.find((c) => c.labelId === 2)!.rowsEmitted).toBe(1);
  });

  it('counts activeLinkCount using the motionOnThreshold', () => {
    const labels: LabelForExport[] = [pointLabel({ labelId: 1, timeMs: 0, occupancyCount: 1, notes: null })];
    const features: FeatureSampleForExport[] = [
      feature(0, 1, 'aa:aa:aa:aa:aa:01', { baselineDeviation: 5 }), // active
      feature(0, 2, 'bb:bb:bb:bb:bb:02', { baselineDeviation: 1 }), // not active
    ];
    const { rows } = joinLabelsWithFeatures(labels, features, TOLERANCE_MS, MOTION_ON_THRESHOLD, HOP_MS);
    expect(rows[0]!.activeLinkCount).toBe(1);
    expect(rows[0]!.linkCountObserved).toBe(2);
  });
});

describe('joinLabelsWithFeatures: interval labels', () => {
  it('expands an interval label into one row per shared hop-grid tick, not one row per (tick, link) pair', () => {
    // 4 ticks (0, 1000, 2000, 3000ms), 3 links each -- a naive per-link join
    // would produce 12 rows; the correct behaviour is 4, one per tick.
    const labels: LabelForExport[] = [
      { labelId: 42, timeMs: 0, endTimeMs: 4000, occupancyCount: 2, source: 'training', notes: null },
    ];
    const linkMacs = ['aa:aa:aa:aa:aa:01', 'aa:aa:aa:aa:aa:02', 'aa:aa:aa:aa:aa:03'];
    const features: FeatureSampleForExport[] = [];
    for (const tickMs of [0, 1000, 2000, 3000]) {
      for (const [i, mac] of linkMacs.entries()) {
        features.push(feature(tickMs, i + 1, mac, { baselineDeviation: 5 }));
      }
    }

    const { rows, skippedLabelCount, coverage, partiallyCoveredIntervalCount } = joinLabelsWithFeatures(
      labels,
      features,
      TOLERANCE_MS,
      MOTION_ON_THRESHOLD,
      HOP_MS,
    );

    expect(skippedLabelCount).toBe(0);
    expect(rows).toHaveLength(4); // NOT 12
    for (const row of rows) {
      expect(row.linkCountObserved).toBe(3);
      expect(row.labelId).toBe(42);
      expect(row.labelDurationMs).toBe(4000);
      expect(row.labelSource).toBe('training');
      expect(row.occupancyCount).toBe(2);
    }
    expect(rows.map((r) => r.timestampIso)).toEqual([
      new Date(0).toISOString(),
      new Date(1000).toISOString(),
      new Date(2000).toISOString(),
      new Date(3000).toISOString(),
    ]);
    expect(coverage).toEqual([{ labelId: 42, rowsEmitted: 4, expectedTicks: 4, coverageFraction: 1 }]);
    expect(partiallyCoveredIntervalCount).toBe(0);
  });

  it('excludes the exclusive end boundary: a feature tick exactly at endTimeMs is not included', () => {
    const labels: LabelForExport[] = [
      { labelId: 1, timeMs: 0, endTimeMs: 2000, occupancyCount: 1, source: 'manual', notes: null },
    ];
    const features: FeatureSampleForExport[] = [
      feature(0, 1, 'aa:aa:aa:aa:aa:01'),
      feature(1000, 1, 'aa:aa:aa:aa:aa:01'),
      feature(2000, 1, 'aa:aa:aa:aa:aa:01'), // == endTimeMs, must be excluded
    ];
    const { rows } = joinLabelsWithFeatures(labels, features, TOLERANCE_MS, MOTION_ON_THRESHOLD, HOP_MS);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.timestampIso)).toEqual([new Date(0).toISOString(), new Date(1000).toISOString()]);
  });

  it('reports partial coverage (not silently dropped, not padded) when an interval has a mid-window gap', () => {
    // A 6-tick interval (0..6000ms at 1000ms hop) with only 2 ticks of
    // actual feature data -- simulates the feature pipeline being down for
    // part of the labelled window.
    const labels: LabelForExport[] = [
      { labelId: 7, timeMs: 0, endTimeMs: 6000, occupancyCount: 2, source: 'manual', notes: null },
    ];
    const features: FeatureSampleForExport[] = [feature(0, 1, 'aa:aa:aa:aa:aa:01'), feature(1000, 1, 'aa:aa:aa:aa:aa:01')];
    const { rows, skippedLabelCount, coverage, partiallyCoveredIntervalCount } = joinLabelsWithFeatures(
      labels,
      features,
      TOLERANCE_MS,
      MOTION_ON_THRESHOLD,
      HOP_MS,
    );

    // Not skipped (it produced real rows)...
    expect(skippedLabelCount).toBe(0);
    expect(rows).toHaveLength(2);
    // ...but flagged as only partially covered, not silently treated as fully joined.
    expect(partiallyCoveredIntervalCount).toBe(1);
    const cov = coverage[0]!;
    expect(cov.rowsEmitted).toBe(2);
    expect(cov.expectedTicks).toBe(6);
    expect(cov.coverageFraction).toBeCloseTo(2 / 6);
  });

  it('counts a fully-empty interval as skipped, with zero coverage', () => {
    const labels: LabelForExport[] = [
      { labelId: 9, timeMs: 10_000, endTimeMs: 16_000, occupancyCount: 1, source: 'manual', notes: null },
    ];
    const features: FeatureSampleForExport[] = [feature(0, 1, 'aa:aa:aa:aa:aa:01')]; // nowhere near the interval
    const { rows, skippedLabelCount, coverage } = joinLabelsWithFeatures(
      labels,
      features,
      TOLERANCE_MS,
      MOTION_ON_THRESHOLD,
      HOP_MS,
    );
    expect(rows).toHaveLength(0);
    expect(skippedLabelCount).toBe(1);
    expect(coverage[0]).toEqual({ labelId: 9, rowsEmitted: 0, expectedTicks: 6, coverageFraction: 0 });
  });
});

describe('joinLabelsWithFeatures: overlapping, contradictory labels (append-only corrections)', () => {
  it('resolves a tick claimed by two labels with DIFFERENT occupancyCount by keeping the highest labelId, and counts it as a conflict', () => {
    // Label 1 (an earlier, wrong correction) says occupancyCount=0 over
    // 0..3000ms. Label 2 (a later correction of that mistake) says
    // occupancyCount=2 over 1000..2000ms -- fully inside label 1's span.
    // Ticks 1000ms is claimed by BOTH labels with different counts.
    const labels: LabelForExport[] = [
      { labelId: 1, timeMs: 0, endTimeMs: 3000, occupancyCount: 0, source: 'manual', notes: null },
      { labelId: 2, timeMs: 1000, endTimeMs: 2000, occupancyCount: 2, source: 'manual', notes: null },
    ];
    const features: FeatureSampleForExport[] = [
      feature(0, 1, 'aa:aa:aa:aa:aa:01'),
      feature(1000, 1, 'aa:aa:aa:aa:aa:01'),
      feature(2000, 1, 'aa:aa:aa:aa:aa:01'),
    ];

    const { rows, conflictingTickCount, conflictingLabelIds } = joinLabelsWithFeatures(
      labels,
      features,
      TOLERANCE_MS,
      MOTION_ON_THRESHOLD,
      HOP_MS,
    );

    // Never both: exactly one row for the 1000ms tick, not two.
    const rowsAt1000 = rows.filter((r) => r.timestampIso === new Date(1000).toISOString());
    expect(rowsAt1000).toHaveLength(1);
    // Highest labelId (2, the correction) wins.
    expect(rowsAt1000[0]!.labelId).toBe(2);
    expect(rowsAt1000[0]!.occupancyCount).toBe(2);

    // Ticks 0 and 2000ms are uncontested (only label 1 claims them).
    const rowAt0 = rows.find((r) => r.timestampIso === new Date(0).toISOString());
    const rowAt2000 = rows.find((r) => r.timestampIso === new Date(2000).toISOString());
    expect(rowAt0!.labelId).toBe(1);
    expect(rowAt2000!.labelId).toBe(1);

    expect(rows).toHaveLength(3); // NOT 4 -- the contested tick collapses to one row
    expect(conflictingTickCount).toBe(1);
    expect(conflictingLabelIds).toEqual([1, 2]);
  });

  it('does NOT count an overlap as conflicting when the overlapping labels AGREE on occupancyCount, but still collapses to one row', () => {
    const labels: LabelForExport[] = [
      { labelId: 1, timeMs: 0, endTimeMs: 2000, occupancyCount: 1, source: 'manual', notes: null },
      { labelId: 2, timeMs: 1000, endTimeMs: 2000, occupancyCount: 1, source: 'confirmed', notes: null }, // agrees
    ];
    const features: FeatureSampleForExport[] = [feature(1000, 1, 'aa:aa:aa:aa:aa:01')];

    const { rows, conflictingTickCount, conflictingLabelIds } = joinLabelsWithFeatures(
      labels,
      features,
      TOLERANCE_MS,
      MOTION_ON_THRESHOLD,
      HOP_MS,
    );

    expect(rows).toHaveLength(1); // collapsed, not duplicated
    expect(rows[0]!.labelId).toBe(2); // still highest labelId, for determinism
    expect(conflictingTickCount).toBe(0); // no disagreement -- not a conflict
    expect(conflictingLabelIds).toEqual([]);
  });

  it('a point label and an interval label can conflict on the same instant', () => {
    const labels: LabelForExport[] = [
      { labelId: 5, timeMs: 500, endTimeMs: null, occupancyCount: 0, source: 'manual', notes: null },
      { labelId: 6, timeMs: 0, endTimeMs: 1000, occupancyCount: 2, source: 'confirmed', notes: null },
    ];
    const features: FeatureSampleForExport[] = [feature(500, 1, 'aa:aa:aa:aa:aa:01')];

    const { rows, conflictingTickCount } = joinLabelsWithFeatures(
      labels,
      features,
      TOLERANCE_MS,
      MOTION_ON_THRESHOLD,
      HOP_MS,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.labelId).toBe(6); // higher labelId wins even though it's the interval, not the point label
    expect(conflictingTickCount).toBe(1);
  });
});

describe('temporalSplit', () => {
  function row(iso: string, labelId: number): DatasetRow {
    return {
      timestampIso: iso,
      labelId,
      labelDurationMs: 0,
      labelSource: 'manual',
      occupancyCount: 1,
      linkCountObserved: 1,
      activeLinkCount: 1,
      maxBaselineDeviation: 1,
      meanBaselineDeviation: 1,
      maxMotionEnergy: 1,
      meanMotionEnergy: 1,
      meanTemporalCorrelation: 1,
      meanDopplerProxy: 1,
    };
  }

  it('splits chronologically, not randomly: train is entirely earlier than test', () => {
    const rows = [
      row('2024-01-01T00:00:00.000Z', 1),
      row('2024-01-01T00:01:00.000Z', 2),
      row('2024-01-01T00:02:00.000Z', 3),
      row('2024-01-01T00:03:00.000Z', 4),
      row('2024-01-01T00:04:00.000Z', 5),
    ];
    // Shuffle input order to prove the function sorts by time itself.
    const shuffled = [rows[3]!, rows[0]!, rows[4]!, rows[1]!, rows[2]!];
    const { train, test } = temporalSplit(shuffled, 0.8);

    expect(train).toHaveLength(4);
    expect(test).toHaveLength(1);
    const maxTrainTime = train[train.length - 1]!.timestampIso;
    const minTestTime = test[0]!.timestampIso;
    expect(maxTrainTime <= minTestTime).toBe(true);
    expect(train.map((r) => r.timestampIso)).toEqual([
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T00:01:00.000Z',
      '2024-01-01T00:02:00.000Z',
      '2024-01-01T00:03:00.000Z',
    ]);
  });

  it('never splits one label spanning multiple rows across the train/test boundary', () => {
    // label A (1 row), label B (1 row), label C (2 rows -- one interval
    // label expanded into two ticks), label D (1 row). A naive split-by-row-
    // count at ratio 0.6 (floor(5*0.6)=3) would put rows [A, B, C-tick0] in
    // train and [C-tick1, D] in test, splitting label C across the
    // boundary -- exactly the leakage this test guards against.
    const rows = [
      row('2024-01-01T00:00:00.000Z', 100), // A
      row('2024-01-01T00:01:00.000Z', 200), // B
      row('2024-01-01T00:02:00.000Z', 300), // C tick 0
      row('2024-01-01T00:03:00.000Z', 300), // C tick 1 (same labelId!)
      row('2024-01-01T00:04:00.000Z', 400), // D
    ];
    const { train, test } = temporalSplit(rows, 0.6);

    const labelIdsIn = (side: DatasetRow[]): Set<number> => new Set(side.map((r) => r.labelId));
    const trainIds = labelIdsIn(train);
    const testIds = labelIdsIn(test);

    // No labelId appears on both sides.
    for (const id of trainIds) expect(testIds.has(id)).toBe(false);

    // Label C's two rows are together, wherever they landed.
    const cRows = [...train, ...test].filter((r) => r.labelId === 300);
    expect(cRows).toHaveLength(2);
    const cInTrain = train.filter((r) => r.labelId === 300).length;
    expect(cInTrain === 0 || cInTrain === 2).toBe(true);
  });
});

describe('toCsv', () => {
  it('writes a header row followed by one line per dataset row, including the new label columns', () => {
    const csv = toCsv([
      {
        timestampIso: '2024-01-01T00:00:00.000Z',
        labelId: 5,
        labelDurationMs: 3_600_000,
        labelSource: 'confirmed',
        occupancyCount: 1,
        linkCountObserved: 2,
        activeLinkCount: 1,
        maxBaselineDeviation: 5,
        meanBaselineDeviation: 2.5,
        maxMotionEnergy: 1,
        meanMotionEnergy: 0.5,
        meanTemporalCorrelation: 0.9,
        meanDopplerProxy: 0.1,
      },
    ]);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      'timestampIso,labelId,labelDurationMs,labelSource,occupancyCount,linkCountObserved,activeLinkCount,maxBaselineDeviation,meanBaselineDeviation,maxMotionEnergy,meanMotionEnergy,meanTemporalCorrelation,meanDopplerProxy',
    );
    expect(lines[1]).toBe('2024-01-01T00:00:00.000Z,5,3600000,confirmed,1,2,1,5,2.5,1,0.5,0.9,0.1');
  });
});
