import { describe, expect, it } from 'vitest';
import { EmaBaseline, MIN_STD_DEV } from './baseline.js';

const THRESHOLDS = { motionOnThreshold: 3.0, motionOffThreshold: 1.5 };

describe('EmaBaseline', () => {
  it('seeds from the first observation with zero deviation', () => {
    const baseline = new EmaBaseline(0.1);
    const result = baseline.update(10, THRESHOLDS);
    expect(result.deviation).toBe(0);
    expect(result.motionActive).toBe(false);
    expect(result.snapshot.mean).toBe(10);
  });

  it('tracks a stable signal with low deviation over time', () => {
    const baseline = new EmaBaseline(0.2);
    baseline.update(10, THRESHOLDS);
    let last;
    for (let i = 0; i < 20; i++) {
      last = baseline.update(10 + (i % 2 === 0 ? 0.01 : -0.01), THRESHOLDS);
    }
    expect(last!.motionActive).toBe(false);
    expect(Math.abs(last!.deviation)).toBeLessThan(THRESHOLDS.motionOnThreshold);
  });

  it('flags motion once deviation crosses the on-threshold', () => {
    const baseline = new EmaBaseline(0.1);
    baseline.update(10, THRESHOLDS);
    // A handful of stable samples to build up a small non-zero variance.
    for (let i = 0; i < 10; i++) baseline.update(10 + (i % 2 === 0 ? 0.05 : -0.05), THRESHOLDS);
    const spike = baseline.update(100, THRESHOLDS);
    expect(spike.motionActive).toBe(true);
    expect(spike.deviation).toBeGreaterThan(THRESHOLDS.motionOnThreshold);
  });

  it('CRITICAL: does not adapt the baseline mean while motion is active', () => {
    const baseline = new EmaBaseline(0.5); // aggressive rate to make drift obvious if it happened
    baseline.update(10, THRESHOLDS);
    for (let i = 0; i < 10; i++) baseline.update(10 + (i % 2 === 0 ? 0.02 : -0.02), THRESHOLDS);
    const meanBeforeMotion = baseline.snapshot().mean;

    // Sustained motion (large spike, repeated) — with adaptationRate=0.5 this
    // would drag the mean sharply toward 100 within a couple of samples if
    // the baseline were (incorrectly) still adapting.
    for (let i = 0; i < 5; i++) {
      const r = baseline.update(100, THRESHOLDS);
      expect(r.motionActive).toBe(true);
    }

    const meanAfterMotion = baseline.snapshot().mean;
    expect(meanAfterMotion).toBeCloseTo(meanBeforeMotion, 6);
    expect(meanAfterMotion).not.toBeGreaterThan(meanBeforeMotion + 1);
  });

  it('resumes adapting once motion clears below the off-threshold', () => {
    const baseline = new EmaBaseline(0.5);
    baseline.update(10, THRESHOLDS);
    for (let i = 0; i < 10; i++) baseline.update(10 + (i % 2 === 0 ? 0.02 : -0.02), THRESHOLDS);
    const frozenMean = baseline.snapshot().mean;
    baseline.update(100, THRESHOLDS); // triggers motion
    expect(baseline.snapshot().motionActive).toBe(true);

    // Return to (very close to) the frozen baseline mean — deviation should
    // drop back below the *off* threshold and clear the local motion latch.
    const cleared = baseline.update(frozenMean, THRESHOLDS);
    expect(cleared.motionActive).toBe(false);

    const { mean: meanBeforeResume, variance: varianceBeforeResume } = baseline.snapshot();
    // A small nudge, scaled to this link's own (tiny, pre-motion) noise
    // floor, that stays under the on-threshold so it reads as "quiet" and
    // lets the EMA resume tracking.
    const nudge = Math.sqrt(varianceBeforeResume) * (THRESHOLDS.motionOnThreshold - 1);
    baseline.update(meanBeforeResume + nudge, THRESHOLDS);
    const meanAfterResume = baseline.snapshot().mean;
    expect(meanAfterResume).not.toBe(meanBeforeResume);
  });

  it('can be constructed from a persisted snapshot (resumability across pipeline runs)', () => {
    const baseline = new EmaBaseline(0.1, { mean: 42, variance: 4, motionActive: false });
    const result = baseline.update(42, THRESHOLDS);
    expect(result.deviation).toBe(0);
  });

  describe('REGRESSION: a link settling quiet for a long time must not make the stddev divisor vanish', () => {
    it('bounds the deviation for a small, realistic perturbation after a long near-zero-variance settling period', () => {
      // Mirrors the reported repro: seed at a steady value, then feed many
      // ticks of that value with only floating-point-scale jitter — the EMA
      // variance recurrence drives `varianceValue` asymptotically toward
      // (but never exactly) zero, well below MIN_STD_DEV^2, without ever
      // triggering the exact-zero `=== 0` case a naive `||` fallback would
      // rely on.
      const baseline = new EmaBaseline(0.3);
      baseline.update(1.0, THRESHOLDS);
      for (let i = 0; i < 50; i++) {
        baseline.update(1.0 + (i % 2 === 0 ? 1e-9 : -1e-9), THRESHOLDS);
      }

      const settled = baseline.snapshot();
      expect(settled.motionActive).toBe(false);
      // Confirm the test actually reaches the vulnerable regime: variance
      // must have decayed far below the floor's square, not just "small".
      expect(settled.variance).toBeLessThan(MIN_STD_DEV ** 2);

      // A modest, realistic fluctuation (sensor noise / a draft / an A/C
      // cycle), not a dramatic spike.
      const perturbed = baseline.update(settled.mean + 0.001, THRESHOLDS);

      // It's legitimate for this to register as motion (0.001 is large
      // relative to a near-silent link) — the bug was never "does it flag
      // motion", it was the deviation magnitude becoming untunable.
      expect(perturbed.motionActive).toBe(true);

      // The floored stddev caps the deviation at (perturbation / MIN_STD_DEV)
      // — bounded and precisely predictable, not the reported 1,003,971.
      const expectedDeviation = 0.001 / MIN_STD_DEV;
      expect(perturbed.deviation).toBeCloseTo(expectedDeviation, 0);
      expect(perturbed.deviation).toBeLessThan(2000); // sane order of magnitude, nowhere near the millions the bug produced
      expect(Number.isFinite(perturbed.deviation)).toBe(true);
    });

    it('the exact-zero variance case (a perfectly repeated value) is still handled, as a sanity check on the floor logic', () => {
      const baseline = new EmaBaseline(0.3);
      baseline.update(1.0, THRESHOLDS);
      for (let i = 0; i < 10; i++) baseline.update(1.0, THRESHOLDS); // no jitter at all -> variance stays exactly 0
      expect(baseline.snapshot().variance).toBe(0);

      const perturbed = baseline.update(1.001, THRESHOLDS);
      expect(perturbed.deviation).toBeCloseTo(0.001 / MIN_STD_DEV, 0);
      expect(Number.isFinite(perturbed.deviation)).toBe(true);
    });
  });
});
