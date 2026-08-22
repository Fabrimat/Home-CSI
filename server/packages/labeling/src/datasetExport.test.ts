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

describe('joinLabelsWithFeatures', () => {
  it('joins a label to the nearest sample per link within tolerance', () => {
    const labels: LabelForExport[] = [{ timeMs: 1000, occupancyCount: 1, notes: 'manual: someone home' }];
    const features: FeatureSampleForExport[] = [
      feature(850, 1, 'aa:aa:aa:aa:aa:01', { baselineDeviation: 5 }),
      feature(1050, 1, 'aa:aa:aa:aa:aa:01', { baselineDeviation: 4 }), // strictly closer to label time
      feature(950, 2, 'bb:bb:bb:bb:bb:02', { baselineDeviation: 0 }),
    ];

    const { rows, skippedLabelCount } = joinLabelsWithFeatures(labels, features, TOLERANCE_MS, MOTION_ON_THRESHOLD);

    expect(skippedLabelCount).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.linkCountObserved).toBe(2);
    expect(rows[0]!.labelSource).toBe('manual');
    expect(rows[0]!.occupancyCount).toBe(1);
    // Nearest sample for link 1 was the 1100ms one (deviation 4), not the 900ms one.
    expect(rows[0]!.maxBaselineDeviation).toBe(4);
  });

  it('marks a label with the weak-label prefix as labelSource "weak"', () => {
    const labels: LabelForExport[] = [
      { timeMs: 1000, occupancyCount: 1, notes: `${WEAK_LABEL_PREFIX} devices=alice-phone` },
    ];
    const features: FeatureSampleForExport[] = [feature(1000, 1, 'aa:aa:aa:aa:aa:01')];
    const { rows } = joinLabelsWithFeatures(labels, features, TOLERANCE_MS, MOTION_ON_THRESHOLD);
    expect(rows[0]!.labelSource).toBe('weak');
  });

  it('skips a label with no feature data within tolerance, without dropping others', () => {
    const labels: LabelForExport[] = [
      { timeMs: 1000, occupancyCount: 0, notes: null }, // no nearby features
      { timeMs: 5000, occupancyCount: 1, notes: null },
    ];
    const features: FeatureSampleForExport[] = [feature(5000, 1, 'aa:aa:aa:aa:aa:01')];
    const { rows, skippedLabelCount } = joinLabelsWithFeatures(labels, features, TOLERANCE_MS, MOTION_ON_THRESHOLD);
    expect(skippedLabelCount).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occupancyCount).toBe(1);
  });

  it('counts activeLinkCount using the motionOnThreshold', () => {
    const labels: LabelForExport[] = [{ timeMs: 0, occupancyCount: 1, notes: null }];
    const features: FeatureSampleForExport[] = [
      feature(0, 1, 'aa:aa:aa:aa:aa:01', { baselineDeviation: 5 }), // active
      feature(0, 2, 'bb:bb:bb:bb:bb:02', { baselineDeviation: 1 }), // not active
    ];
    const { rows } = joinLabelsWithFeatures(labels, features, TOLERANCE_MS, MOTION_ON_THRESHOLD);
    expect(rows[0]!.activeLinkCount).toBe(1);
    expect(rows[0]!.linkCountObserved).toBe(2);
  });
});

describe('temporalSplit', () => {
  function row(iso: string): DatasetRow {
    return {
      timestampIso: iso,
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
      row('2024-01-01T00:00:00.000Z'),
      row('2024-01-01T00:01:00.000Z'),
      row('2024-01-01T00:02:00.000Z'),
      row('2024-01-01T00:03:00.000Z'),
      row('2024-01-01T00:04:00.000Z'),
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
});

describe('toCsv', () => {
  it('writes a header row followed by one line per dataset row', () => {
    const csv = toCsv([
      {
        timestampIso: '2024-01-01T00:00:00.000Z',
        labelSource: 'manual',
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
      'timestampIso,labelSource,occupancyCount,linkCountObserved,activeLinkCount,maxBaselineDeviation,meanBaselineDeviation,maxMotionEnergy,meanMotionEnergy,meanTemporalCorrelation,meanDopplerProxy',
    );
    expect(lines[1]).toBe('2024-01-01T00:00:00.000Z,manual,1,2,1,5,2.5,1,0.5,0.9,0.1');
  });
});
