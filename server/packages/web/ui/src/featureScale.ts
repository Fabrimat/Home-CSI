/**
 * The time domain a feature chart is drawn against.
 *
 * WHY THIS IS NOT JUST `[now - RANGE, now]`: the feature inspector asks the
 * API for a fixed lookback window, but the pipeline only has rows for as
 * long as it has been running. Scaling the x axis to the *requested* window
 * rather than the *returned* data draws every point crushed against the
 * right-hand edge with a wide empty stretch to its left -- which reads as
 * "the chart is shifted", and is exactly what a freshly-started pipeline (or
 * a link that only just woke up) looks like. Scaling to the data instead
 * means a chart always fills itself, and the axis labels say honestly what
 * span is on screen.
 */

export interface TimeDomain {
  fromMs: number;
  toMs: number;
}

export interface TimedPoint {
  time: string;
}

/** Below this, a chart is drawn against a padded window instead of a near-zero span that would put every point on one pixel column. */
export const MIN_SPAN_MS = 30_000;

/** Fraction of the span added at each end so the first and last sample are not glued to the axis. */
const PAD_FRACTION = 0.02;

/**
 * Fits a domain to the points actually present.
 *
 * `nowMs` is only used when there are no usable points at all -- the empty
 * chart still needs *some* axis, and anchoring it to now is the least
 * misleading choice available. It is deliberately NOT used to stretch the
 * domain to "now" when data exists: a link that stopped reporting five
 * minutes ago should show its data filling the chart with the axis saying
 * when it ended, not a mostly-blank chart implying the reader missed
 * something.
 */
export function seriesDomain(
  points: readonly TimedPoint[],
  nowMs: number,
  minSpanMs: number = MIN_SPAN_MS,
): TimeDomain {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    const t = new Date(p.time).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }

  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { fromMs: nowMs - minSpanMs, toMs: nowMs };
  }

  let span = hi - lo;
  if (span < minSpanMs) {
    // Centre the too-narrow data in a minimum-width window rather than
    // letting the axis collapse -- one sample, or ten samples a second
    // apart, both still get a readable chart.
    const mid = (lo + hi) / 2;
    lo = mid - minSpanMs / 2;
    hi = mid + minSpanMs / 2;
    span = minSpanMs;
  }

  const pad = span * PAD_FRACTION;
  return { fromMs: lo - pad, toMs: hi + pad };
}

/**
 * "13:20:04 → 13:34:11 (14m 7s)" -- the caption under a chart whose x axis
 * is data-fitted, so the reader can tell at a glance how much time is on
 * screen instead of assuming it is the range they asked for.
 */
export function describeDomain(domain: TimeDomain): string {
  const fmt = (ms: number): string =>
    new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${fmt(domain.fromMs)} → ${fmt(domain.toMs)} (${formatSpan(domain.toMs - domain.fromMs)})`;
}

/** Compact span: `42s`, `7m 12s`, `3h 05m`. */
export function formatSpan(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}
