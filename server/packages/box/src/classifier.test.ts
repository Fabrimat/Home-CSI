import { describe, expect, it } from 'vitest';
import {
  computeTakeFeatureVector,
  formatTrainReport,
  knnLeaveOneOut,
  type TakeExample,
} from './classifier.js';
import type { BoxTakeRecord } from './preservation.js';

const LLTF = 0;

/** Signed-8-bit (I, Q) pairs -- Q always 0, so amplitude == |I|. Mirrors @homecsi/features' own csiParsing.test.ts convention. */
function csiData(amplitudes: readonly number[]): Buffer {
  const buf = Buffer.alloc(amplitudes.length * 2);
  amplitudes.forEach((a, i) => {
    buf.writeInt8(a, i * 2);
    buf.writeInt8(0, i * 2 + 1);
  });
  return buf;
}

function makeRecord(overrides: Partial<BoxTakeRecord> & { amplitudes?: readonly number[] } = {}): BoxTakeRecord {
  const { amplitudes, ...rest } = overrides;
  return {
    timeMs: 1000,
    nodeId: 1,
    linkMac: 'aa:aa:aa:aa:aa:01',
    rssi: -50,
    csiFormat: LLTF,
    csiData: csiData(amplitudes ?? [10, 20, 30, 40]),
    ...rest,
  };
}

describe('computeTakeFeatureVector', () => {
  const window = { fromMs: 0, toMs: 10_000 };

  it('returns null when no records fall inside the window', () => {
    const records = [makeRecord({ timeMs: 20_000 })];
    expect(computeTakeFeatureVector(records, window)).toBeNull();
  });

  it('returns null when every record is unparseable', () => {
    const records = [makeRecord({ timeMs: 100, csiData: Buffer.alloc(0) })];
    expect(computeTakeFeatureVector(records, window)).toBeNull();
  });

  it('produces a fixed-length vector regardless of how many links are present', () => {
    const oneLink = [
      makeRecord({ timeMs: 100, linkMac: 'aa:aa:aa:aa:aa:01', amplitudes: [10, 20, 30] }),
      makeRecord({ timeMs: 200, linkMac: 'aa:aa:aa:aa:aa:01', amplitudes: [11, 19, 29] }),
    ];
    const twoLinks = [
      ...oneLink,
      makeRecord({ timeMs: 150, linkMac: 'bb:bb:bb:bb:bb:02', nodeId: 2, amplitudes: [1, 2] }),
      makeRecord({ timeMs: 250, linkMac: 'bb:bb:bb:bb:bb:02', nodeId: 2, amplitudes: [2, 1] }),
    ];

    const vecOneLink = computeTakeFeatureVector(oneLink, window);
    const vecTwoLinks = computeTakeFeatureVector(twoLinks, window);

    expect(vecOneLink).not.toBeNull();
    expect(vecTwoLinks).not.toBeNull();
    expect(vecTwoLinks!.length).toBe(vecOneLink!.length);
  });

  it('tolerates records with different subcarrier counts within the same take (never assumes a fixed count)', () => {
    const records = [
      makeRecord({ timeMs: 100, amplitudes: [10, 20, 30, 40] }), // 4 subcarriers
      makeRecord({ timeMs: 200, amplitudes: [5, 15, 25, 35, 45, 55] }), // 6 subcarriers
    ];
    expect(computeTakeFeatureVector(records, window)).not.toBeNull();
  });

  it('excludes records outside [fromMs, toMs)', () => {
    const inside = makeRecord({ timeMs: 5000 });
    const before = makeRecord({ timeMs: -1 });
    const atEnd = makeRecord({ timeMs: window.toMs }); // exclusive end
    const vecWithAll = computeTakeFeatureVector([inside, before, atEnd], window);
    const vecInsideOnly = computeTakeFeatureVector([inside], window);
    expect(vecWithAll).toEqual(vecInsideOnly);
  });
});

describe('knnLeaveOneOut', () => {
  function example(sessionId: number, gestureClass: string, vector: number[]): TakeExample {
    return { sessionId, gestureClass, vector };
  }

  it('refuses to report accuracy with fewer than 2 distinct classes', () => {
    const examples = Array.from({ length: 10 }, (_, i) => example(i, 'fist', [i, i]));
    const report = knnLeaveOneOut(examples, 3, 5);
    expect(report.status).toBe('insufficient-data');
    if (report.status === 'insufficient-data') {
      expect(report.reason).toMatch(/at least 2 distinct gesture classes/);
    }
  });

  it('refuses to report accuracy when a class is below minTakesPerClass', () => {
    const examples = [
      ...Array.from({ length: 5 }, (_, i) => example(i, 'fist', [0, 0])),
      ...Array.from({ length: 3 }, (_, i) => example(100 + i, 'open', [10, 10])), // only 3, below default min of 5
    ];
    const report = knnLeaveOneOut(examples, 3, 5);
    expect(report.status).toBe('insufficient-data');
    if (report.status === 'insufficient-data') {
      expect(report.reason).toMatch(/"open" has only 3 usable take/);
      expect(report.perClassCounts).toEqual({ fist: 5, open: 3 });
    }
  });

  it('reports accuracy, both baselines, per-class counts, and a confusion matrix for well-separated classes', () => {
    // Two obviously-separable clusters, 6 takes each.
    const examples = [
      ...Array.from({ length: 6 }, (_, i) => example(i, 'fist', [0 + i * 0.01, 0 + i * 0.01])),
      ...Array.from({ length: 6 }, (_, i) => example(100 + i, 'open', [100 + i * 0.01, 100 + i * 0.01])),
    ];

    const report = knnLeaveOneOut(examples, 3, 5);
    expect(report.status).toBe('ok');
    if (report.status !== 'ok') return;

    expect(report.takeCount).toBe(12);
    expect(report.perClassCounts).toEqual({ fist: 6, open: 6 });
    expect(report.majorityBaseline).toBeCloseTo(0.5);
    expect(report.randomBaseline).toBeCloseTo(0.5);
    expect(report.accuracy).toBeGreaterThan(report.randomBaseline);
    expect(report.confusion.classes).toEqual(['fist', 'open']);
    expect(report.confusion.matrix).toHaveLength(2);
    // Diagonal-heavy: well-separated clusters should mostly classify correctly.
    const totalDiagonal = report.confusion.matrix[0]![0]! + report.confusion.matrix[1]![1]!;
    expect(totalDiagonal).toBeGreaterThanOrEqual(10);
  });

  it('random-chance baseline reflects the number of classes, not a fixed 50%', () => {
    const examples = [
      ...Array.from({ length: 5 }, (_, i) => example(i, 'a', [0, i])),
      ...Array.from({ length: 5 }, (_, i) => example(10 + i, 'b', [10, i])),
      ...Array.from({ length: 5 }, (_, i) => example(20 + i, 'c', [20, i])),
    ];
    const report = knnLeaveOneOut(examples, 3, 5);
    expect(report.status).toBe('ok');
    if (report.status === 'ok') expect(report.randomBaseline).toBeCloseTo(1 / 3);
  });
});

describe('formatTrainReport', () => {
  it('explains why, for an insufficient-data report', () => {
    const text = formatTrainReport({
      status: 'insufficient-data',
      minTakesPerClass: 5,
      perClassCounts: { fist: 2 },
      reason: 'need at least 2 distinct gesture classes with usable takes to report an accuracy figure; found 1.',
    });
    expect(text).toMatch(/refusing to report an accuracy figure/);
    expect(text).toMatch(/fist=2/);
  });

  it('includes accuracy, both baselines, and the confusion matrix for an ok report', () => {
    const text = formatTrainReport({
      status: 'ok',
      k: 3,
      takeCount: 10,
      perClassCounts: { fist: 5, open: 5 },
      accuracy: 0.8,
      majorityBaseline: 0.5,
      randomBaseline: 0.5,
      confusion: { classes: ['fist', 'open'], matrix: [[4, 1], [1, 4]] },
    });
    expect(text).toMatch(/80\.0%/);
    expect(text).toMatch(/majority-class baseline: 50\.0%/);
    expect(text).toMatch(/random-chance baseline \(2 classes\): 50\.0%/);
    expect(text).toMatch(/confusion matrix/);
  });
});
