import { describe, expect, it } from 'vitest';
import { CsiFormat } from '@homecsi/protocol';
import { computeWindowFeature, type CsiSample } from './featureVector.js';

const THRESHOLDS = { motionOnThreshold: 3.0, motionOffThreshold: 1.5 };

function iqBuffer(pairs: Array<[number, number]>): Buffer {
  const buf = Buffer.alloc(pairs.length * 2);
  pairs.forEach(([i, q], idx) => {
    buf.writeInt8(i, idx * 2);
    buf.writeInt8(q, idx * 2 + 1);
  });
  return buf;
}

/** A "quiet" static-channel record: same amplitude pattern every time, small deterministic jitter. */
function staticSample(timeMs: number, jitter: number): CsiSample {
  return {
    timeMs,
    rssi: -50,
    csiFormat: CsiFormat.Lltf,
    csiData: iqBuffer([
      [10 + jitter, 0],
      [8 - jitter, 0],
      [6 + jitter, 0],
      [4 - jitter, 0],
    ]),
  };
}

/**
 * A "motion" record: the *shape* of the per-subcarrier amplitude pattern
 * alternates sharply between a "peaky" distribution (multipath energy
 * concentrated on one path) and a "flat" one, from one record to the next.
 * Note this is deliberately not just a bigger overall magnitude — since
 * amplitude is RMS-normalised per record (AGC-invariance), a uniformly
 * scaled-up version of the same *shape* normalises right back down to the
 * same feature values as the static case. Real motion perturbs multipath
 * *shape*, which is what should move meanSubcarrierVariance/temporalVariance.
 */
function motionSample(timeMs: number, peaky: boolean): CsiSample {
  const pattern: Array<[number, number]> = peaky
    ? [
        [40, 0],
        [2, 0],
        [2, 0],
        [2, 0],
      ]
    : [
        [10, 0],
        [11, 0],
        [9, 0],
        [10, 0],
      ];
  return { timeMs, rssi: -50, csiFormat: CsiFormat.Lltf, csiData: iqBuffer(pattern) };
}

describe('computeWindowFeature', () => {
  it('computes a feature vector for a window of well-formed samples', () => {
    const samples = [
      staticSample(0, 0.1),
      staticSample(500, -0.1),
      staticSample(1000, 0.1),
      staticSample(1500, -0.1),
    ];
    const result = computeWindowFeature(samples, {
      subcarrierSelection: 'all',
      baselineAdaptationRate: 0.1,
      baselineThresholds: THRESHOLDS,
    });
    expect(result).not.toBeNull();
    expect(result!.vector.sampleCount).toBe(4);
    expect(result!.vector.subcarrierCount).toBe(4);
    expect(result!.droppedSampleCount).toBe(0);
    // First-ever window for a link seeds the baseline: zero deviation by definition.
    expect(result!.vector.baselineDeviation).toBe(0);
  });

  it('a window dominated by motion has much higher motion energy than a static window', () => {
    const staticWindow = [staticSample(0, 0.05), staticSample(500, -0.05), staticSample(1000, 0.05)];
    const motionWindow = [motionSample(0, true), motionSample(500, false), motionSample(1000, true)];

    const staticResult = computeWindowFeature(staticWindow, {
      subcarrierSelection: 'all',
      baselineAdaptationRate: 0.1,
      baselineThresholds: THRESHOLDS,
    })!;
    const motionResult = computeWindowFeature(motionWindow, {
      subcarrierSelection: 'all',
      baselineAdaptationRate: 0.1,
      baselineThresholds: THRESHOLDS,
    })!;

    expect(motionResult.vector.motionEnergy).toBeGreaterThan(staticResult.vector.motionEnergy);
  });

  it('drops corrupt/unusable records but still computes from the survivors', () => {
    const corrupt: CsiSample = {
      timeMs: 250,
      rssi: -50,
      csiFormat: 250, // unassigned csi_format
      csiData: iqBuffer([[1, 1]]),
    };
    const samples = [staticSample(0, 0.1), corrupt, staticSample(500, -0.1)];
    const result = computeWindowFeature(samples, {
      subcarrierSelection: 'all',
      baselineAdaptationRate: 0.1,
      baselineThresholds: THRESHOLDS,
    });
    expect(result).not.toBeNull();
    expect(result!.vector.sampleCount).toBe(2);
    expect(result!.droppedSampleCount).toBe(1);
  });

  it('drops a record when the explicit subcarrierSelection is out of range for its actual layout, without crashing the window', () => {
    // staticSample has 4 subcarriers; selection assumes at least 10.
    const samples = [staticSample(0, 0.1), staticSample(500, -0.1)];
    const result = computeWindowFeature(samples, {
      subcarrierSelection: [0, 1, 9],
      baselineAdaptationRate: 0.1,
      baselineThresholds: THRESHOLDS,
    });
    expect(result).toBeNull(); // every record dropped -> no honest feature for this window
  });

  it('returns null when every record in the window is unusable', () => {
    const allCorrupt: CsiSample[] = [
      { timeMs: 0, rssi: -50, csiFormat: 250, csiData: iqBuffer([[1, 1]]) },
    ];
    const result = computeWindowFeature(allCorrupt, {
      subcarrierSelection: 'all',
      baselineAdaptationRate: 0.1,
      baselineThresholds: THRESHOLDS,
    });
    expect(result).toBeNull();
  });

  it('carries baseline state forward across windows via previousBaseline (resumability)', () => {
    const first = computeWindowFeature([staticSample(0, 0.1), staticSample(500, -0.1)], {
      subcarrierSelection: 'all',
      baselineAdaptationRate: 0.2,
      baselineThresholds: THRESHOLDS,
    })!;

    const second = computeWindowFeature([staticSample(1000, 0.1), staticSample(1500, -0.1)], {
      subcarrierSelection: 'all',
      baselineAdaptationRate: 0.2,
      baselineThresholds: THRESHOLDS,
      previousBaseline: first.baselineSnapshot,
    })!;

    // Second window isn't re-seeded from scratch — its deviation reflects a
    // baseline that already has some history (not necessarily exactly 0).
    expect(second.vector.baselineMean).not.toBe(0);
  });
});
