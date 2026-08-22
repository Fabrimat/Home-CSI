import { describe, expect, it } from 'vitest';
import {
  dopplerProxy,
  laggedAutocorrelation,
  mean,
  median,
  medianAbsoluteDeviation,
  rootMeanSquare,
  variance,
} from './dsp.js';

describe('mean/variance/median/mad', () => {
  it('computes mean and variance of a simple series', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(variance([2, 2, 2, 2])).toBe(0);
    expect(variance([1, 2, 3, 4])).toBeCloseTo(1.25, 10);
  });

  it('returns 0 for empty input rather than NaN', () => {
    expect(mean([])).toBe(0);
    expect(variance([])).toBe(0);
    expect(medianAbsoluteDeviation([])).toBe(0);
    expect(median([])).toBe(0);
  });

  it('computes median for even/odd length arrays', () => {
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('MAD is robust to a single large outlier, unlike variance', () => {
    const clean = [10, 10, 11, 9, 10];
    const withOutlier = [10, 10, 11, 9, 1000];
    const madClean = medianAbsoluteDeviation(clean);
    const madOutlier = medianAbsoluteDeviation(withOutlier);
    // MAD barely moves...
    expect(Math.abs(madOutlier - madClean)).toBeLessThan(2);
    // ...while variance blows up.
    expect(variance(withOutlier)).toBeGreaterThan(variance(clean) * 100);
  });
});

describe('rootMeanSquare', () => {
  it('computes RMS', () => {
    expect(rootMeanSquare([3, 4])).toBeCloseTo(Math.sqrt((9 + 16) / 2), 10);
  });
  it('is 0 for an all-zero series', () => {
    expect(rootMeanSquare([0, 0, 0])).toBe(0);
  });
});

describe('laggedAutocorrelation', () => {
  it('is 1 for a perfectly static (constant) series', () => {
    // constant series has zero variance; defined as "no evidence of decorrelation" -> 1
    expect(laggedAutocorrelation([5, 5, 5, 5, 5])).toBe(1);
  });

  it('is high for a smooth, slowly-varying series', () => {
    const smooth = [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6];
    expect(laggedAutocorrelation(smooth)).toBeGreaterThan(0.9);
  });

  it('is lower for a noisy, rapidly-alternating series', () => {
    const noisy = [1, 5, 1, 5, 1, 5, 1, 5];
    const smooth = [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6];
    expect(laggedAutocorrelation(noisy)).toBeLessThan(laggedAutocorrelation(smooth));
  });

  it('defaults to 1 for series shorter than 2 samples', () => {
    expect(laggedAutocorrelation([])).toBe(1);
    expect(laggedAutocorrelation([42])).toBe(1);
  });
});

describe('dopplerProxy', () => {
  it('is 0 for a constant series (no fluctuation at all)', () => {
    expect(dopplerProxy([3, 3, 3, 3])).toBe(0);
  });

  it('is higher for a rapidly alternating series than a slowly drifting one with the same spread', () => {
    const rapid = [0, 10, 0, 10, 0, 10];
    const slow = [0, 2, 4, 6, 8, 10];
    expect(dopplerProxy(rapid)).toBeGreaterThan(dopplerProxy(slow));
  });

  it('defaults to 0 for series shorter than 2 samples', () => {
    expect(dopplerProxy([])).toBe(0);
    expect(dopplerProxy([1])).toBe(0);
  });
});
