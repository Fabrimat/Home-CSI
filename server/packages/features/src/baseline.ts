/**
 * Per-link adaptive baseline for "amplitude motion energy" — the scalar this
 * package tracks over time to decide "does this window look different from
 * normal for this link".
 *
 * Why adaptive: a one-shot empty-house calibration goes stale within days
 * (furniture moves, doors open, humidity shifts — docs/architecture.md via
 * the brief). An exponential moving average (rate = `features.
 * baselineAdaptationRate`) keeps tracking "normal" as it drifts.
 *
 * Why frozen during motion: an EMA that keeps updating *while a person is
 * present* will, given enough dwell time, learn the person's motion as the
 * new "normal" and stop reporting them as a deviation — exactly the every-
 * night-reports-empty failure mode the architecture review called out. So
 * baseline adaptation here is gated on this class's *own* local motion
 * classification (see `update`), independent of (and simpler/faster than)
 * the whole-house latched state machine in `@homecsi/occupancy` — this is
 * strictly a "is my own baseline safe to update right now" decision.
 */
export interface BaselineThresholds {
  /** Same units as the tracked scalar's z-score; see below. Local Schmitt-trigger "on" bound. */
  motionOnThreshold: number;
  /** Local Schmitt-trigger "off" bound (must be <= motionOnThreshold to form real hysteresis). */
  motionOffThreshold: number;
}

export interface BaselineSnapshot {
  mean: number;
  variance: number;
  /** Whether this link was locally classified as "in motion" as of the last `update` call (baseline frozen while true). */
  motionActive: boolean;
}

export interface BaselineUpdateResult {
  /** (value - mean) / stddev of the baseline *before* this update — the primary motion signal, in baseline-relative standard-deviation units. Comparable across links regardless of each link's absolute noise floor. */
  deviation: number;
  motionActive: boolean;
  snapshot: BaselineSnapshot;
}

/**
 * Floor applied to the baseline's standard deviation before it is used as a
 * divisor. Without this, a link that settles quiet for long enough drives
 * `varianceValue` asymptotically toward (but never exactly) zero via the EMA
 * recurrence below, and dividing by a near-zero stddev turns any tiny real
 * fluctuation — sensor noise, a draft, an A/C cycle — into an astronomically
 * large z-score that blows straight through `motionOnThreshold` regardless
 * of its configured value. See baseline.test.ts's "quiet link settling"
 * scenario for the regression this guards.
 *
 * Units: `motionEnergy` (what this class tracks) is computed from amplitude
 * that has already been RMS-normalised per record (see
 * csiParsing.normalizeAmplitudes), so it is dimensionless and typically
 * O(1e-3)-O(1) for real hardware noise once a link is quiet — 1e-6 is
 * chosen as roughly three to six orders of magnitude below that observed
 * quiet-link floor, i.e. small enough to never mask a real (even very
 * subtle) motion signal, but large enough that the EMA-variance recurrence
 * settling toward zero can never make the *divisor* itself vanish. This is
 * an absolute floor rather than one relative to the baseline mean because
 * `motionEnergy` can legitimately be at or near zero for a link with a
 * flat, silent channel — a mean-relative floor would degenerate exactly
 * when it's needed most. It is not exposed via config: it is a numerical
 * safety rail, not a tuning knob — `occupancy.thresholds.motionOnThreshold`
 * is the operator-facing sensitivity control.
 *
 * Exported (not just an internal constant) so the regression test in
 * baseline.test.ts can assert the floored deviation precisely, rather than
 * against an arbitrary re-derived magic number.
 */
export const MIN_STD_DEV = 1e-6;

export class EmaBaseline {
  private mean: number;
  private varianceValue: number;
  private motionActive: boolean;
  private readonly adaptationRate: number;
  private seeded: boolean;

  constructor(adaptationRate: number, initial?: BaselineSnapshot) {
    this.adaptationRate = adaptationRate;
    this.mean = initial?.mean ?? 0;
    this.varianceValue = initial?.variance ?? 0;
    this.motionActive = initial?.motionActive ?? false;
    this.seeded = initial !== undefined;
  }

  snapshot(): BaselineSnapshot {
    return { mean: this.mean, variance: this.varianceValue, motionActive: this.motionActive };
  }

  /**
   * Feeds one window's motion-energy value through the baseline. Returns the
   * baseline-relative deviation computed *before* any adaptation, and
   * whether the value is locally classified as motion (Schmitt-trigger
   * hysteresis on the deviation, using `thresholds`). The EMA is only
   * updated (folded toward this value) when the result is NOT motion —
   * this is the "adapts, but not while motion is present" rule.
   */
  update(value: number, thresholds: BaselineThresholds): BaselineUpdateResult {
    if (!this.seeded) {
      // First-ever observation for this link: seed the baseline directly
      // rather than computing a deviation against an arbitrary mean=0,
      // variance=0 starting point (which would otherwise read as an
      // enormous, meaningless deviation on sample one).
      this.mean = value;
      this.varianceValue = 0;
      this.motionActive = false;
      this.seeded = true;
      return { deviation: 0, motionActive: false, snapshot: this.snapshot() };
    }

    // Floor the stddev itself (not just the exact-zero case): variance
    // decays toward zero asymptotically, never landing on it exactly, so a
    // `||` fallback (which only substitutes on exactly `0`/`NaN`) would let
    // an arbitrarily small-but-nonzero stddev straight through.
    const stdDev = Math.max(Math.sqrt(Math.max(this.varianceValue, 0)), MIN_STD_DEV);
    const deviation = (value - this.mean) / stdDev;

    const motionActive = this.motionActive
      ? deviation > thresholds.motionOffThreshold
      : deviation >= thresholds.motionOnThreshold;

    if (!motionActive) {
      const rate = this.adaptationRate;
      const delta = value - this.mean;
      this.mean += rate * delta;
      // EMA variance update (standard exponentially-weighted variance recurrence).
      this.varianceValue = (1 - rate) * (this.varianceValue + rate * delta * delta);
    }
    this.motionActive = motionActive;

    return { deviation, motionActive, snapshot: this.snapshot() };
  }
}
