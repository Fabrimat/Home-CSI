/**
 * Small, dependency-free numeric helpers used by the feature pipeline.
 *
 * Deliberately hand-written rather than pulling in a DSP/stats package: the
 * feature set here is a handful of simple scalar reductions over a window of
 * (irregularly time-spaced) samples, not a general-purpose signal-processing
 * toolkit. See docs/architecture.md ("Amplitude-first") for why nothing here
 * touches phase.
 */

/** Arithmetic mean. Returns 0 for an empty input (callers guard length > 0 where it matters). */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Population variance (not sample variance — we care about "spread of this exact window", not inference). */
export function variance(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  let sumSq = 0;
  for (const v of values) sumSq += (v - m) ** 2;
  return sumSq / values.length;
}

/** Median absolute deviation from the median — robust spread estimate, less sensitive to a single outlier sample than variance. */
export function medianAbsoluteDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const med = median(values);
  const deviations = values.map((v) => Math.abs(v - med));
  return median(deviations);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  }
  return sorted[mid] as number;
}

/** Root-mean-square, used to normalise a single record's amplitude vector against AGC-driven gain scaling (see csiParsing.ts). */
export function rootMeanSquare(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sumSq = 0;
  for (const v of values) sumSq += v * v;
  return Math.sqrt(sumSq / values.length);
}

/**
 * Lag-1 autocorrelation of a scalar time series (Pearson correlation between
 * the series and itself shifted by one sample). This is a *temporal
 * correlation / decorrelation* feature: a channel dominated by a static
 * multipath environment stays highly self-similar from one capture to the
 * next (autocorrelation near 1); motion perturbing the multipath
 * decorrelates the channel faster, pulling this toward 0 (or negative).
 *
 * Returns 1 for series too short to have a lag-1 pair (defined as "no
 * evidence of decorrelation yet", which is the safe/quiet default).
 *
 * Near-zero-divisor safety note (see baseline.ts's MIN_STD_DEV fix for the
 * pattern this guards against): unlike EmaBaseline's z-score, this ratio is
 * a Pearson correlation coefficient, which Cauchy-Schwarz guarantees lies
 * in [-1, 1] *for any* nonzero denom, however small — `cov` shrinks in
 * lockstep with `denom` because both are computed from the very same
 * window in one pass, not (as in the baseline bug) a numerator sampled
 * fresh against a denominator that is stale, independently-decayed EMA
 * state. So there is no scenario here where the divisor quietly decays
 * toward zero while the numerator does not. The `Math.min`/`Math.max`
 * clamp below exists only for floating-point rounding at the boundary
 * (denom computed from a running sum can round to fractionally over 1),
 * not as a safety net for an unbounded blow-up.
 */
export function laggedAutocorrelation(values: readonly number[]): number {
  if (values.length < 2) return 1;
  const a = values.slice(0, -1);
  const b = values.slice(1);
  const meanA = mean(a);
  const meanB = mean(b);
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = (a[i] as number) - meanA;
    const db = (b[i] as number) - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  const denom = Math.sqrt(varA * varB);
  if (denom === 0) return 1;
  return Math.max(-1, Math.min(1, cov / denom));
}

/**
 * Mean absolute successive difference, normalised by the series' own
 * standard deviation. This is a crude, sampling-irregularity-tolerant proxy
 * for "how fast is this signal wiggling" — a stand-in for spectral
 * width/Doppler spread. It is deliberately *not* an FFT-based spectral
 * estimate: CSI records arrive at irregular, event-driven timestamps (see
 * docs/architecture.md — broadcast soundings, not a fixed sample clock), so
 * a classic periodogram would need resampling/interpolation to be valid.
 * Normalising by std-dev makes the value comparable across links/windows
 * with different absolute amplitude scale: a slow, big wiggle and a fast,
 * small wiggle with the same *shape* of successive-difference-to-spread
 * ratio read similarly on this proxy.
 *
 * Returns 0 for series too short or with zero spread (static signal).
 *
 * Near-zero-divisor safety note (see the comment on laggedAutocorrelation
 * above, and baseline.ts's MIN_STD_DEV fix for the pattern this is *not*
 * susceptible to): `sd` and `meanAbsDiff` are both derived from the same
 * `values` array in one shot, so they cannot become decoupled the way a
 * long-lived EMA divisor and a freshly-sampled numerator can — a window
 * whose successive differences are tiny necessarily also has a tiny
 * standard deviation (both scale with the same underlying signal), so this
 * ratio stays a well-behaved, roughly-O(1) shape descriptor rather than
 * blowing up as `sd` shrinks.
 */
export function dopplerProxy(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const sd = Math.sqrt(variance(values));
  if (sd === 0) return 0;
  let sumAbsDiff = 0;
  for (let i = 1; i < values.length; i++) {
    sumAbsDiff += Math.abs((values[i] as number) - (values[i - 1] as number));
  }
  const meanAbsDiff = sumAbsDiff / (values.length - 1);
  return meanAbsDiff / sd;
}
