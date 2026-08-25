import type { FastifyInstance } from 'fastify';
import type { CoverageInputs, HomeCsiDb, LabelSource } from '../db/types.js';

/**
 * Hard cap on `expiringSoon` -- this endpoint exists to point an operator at
 * a short, actionable list of "review this before it ages out", not to
 * enumerate every unreviewed second in the retention window (that number
 * could be the whole window on a quiet deployment and would be useless as
 * a todo list).
 */
const EXPIRING_SOON_LIMIT = 20;

export interface CoverageOptions {
  /** config.storage.retention.maxAgeMs -- the window this endpoint reports coverage over (same source of truth as routes/config.ts's ClientConfig). */
  retentionMaxAgeMs: number;
  /**
   * How close to the window's oldest edge (`from`) an unreviewed stretch
   * must be to count as `expiringSoon` -- mirrors `@homecsi/labeling`'s
   * `DEFAULT_RETENTION_SAFETY_MARGIN_MS`, the same margin the CLI already
   * warns at for a training-preservation deadline, so the dashboard's
   * "review this soon" signal lines up with the one the operator may
   * already know from the CLI.
   */
  safetyMarginMs: number;
}

interface Interval {
  fromMs: number;
  toMs: number;
}

interface ExpiringGap {
  from: string;
  to: string;
  /**
   * Only `'unreviewed'` is emitted today. `'estimate-changed'` (an
   * occupancy_states transition inside an unreviewed stretch) was
   * considered -- it would need a second query joining transitions against
   * these same gaps, and "which transition counts" is genuinely ambiguous
   * (a keepalive row never should, but where's the line for a low-
   * confidence transition that flips back a few seconds later?) -- shipped
   * as `'unreviewed'` only rather than guessing at that rule.
   */
  reason: 'unreviewed';
}

export interface CoverageResponse {
  /** Fraction of the retention window covered by a human-reviewed (manual/confirmed/training) `labels` interval. */
  reviewedFraction: number;
  expiringSoon: ExpiringGap[];
  /** Count of `labels` rows with `source: 'confirmed'` in the window. */
  confirmations: number;
  /** Count of `labels` rows with `source: 'manual'` in the window. */
  corrections: number;
  /** Count of `event_annotations` rows in the window. */
  annotations: number;
  /** Distinct `event_annotations.category` values seen in the window. */
  categoriesUsed: string[];
}

/** Merges overlapping/touching intervals; drops zero-width ones (point labels), which cover no span. */
function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].filter((iv) => iv.toMs > iv.fromMs).sort((a, b) => a.fromMs - b.fromMs);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged.at(-1);
    if (last && iv.fromMs <= last.toMs) {
      last.toMs = Math.max(last.toMs, iv.toMs);
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}

/** The gaps in `merged` within [fromMs, toMs) -- the unreviewed stretches. */
function complementIntervals(merged: readonly Interval[], fromMs: number, toMs: number): Interval[] {
  const gaps: Interval[] = [];
  let cursor = fromMs;
  for (const iv of merged) {
    if (iv.fromMs > cursor) gaps.push({ fromMs: cursor, toMs: iv.fromMs });
    cursor = Math.max(cursor, iv.toMs);
  }
  if (cursor < toMs) gaps.push({ fromMs: cursor, toMs });
  return gaps;
}

/**
 * Pure computation over `CoverageInputs`, split out from the route handler
 * so the merge/gap/margin logic is directly testable without an HTTP layer.
 */
export function computeCoverage(
  inputs: CoverageInputs,
  window: { from: Date; to: Date },
  safetyMarginMs: number,
): CoverageResponse {
  const fromMs = window.from.getTime();
  const toMs = window.to.getTime();
  const windowMs = Math.max(0, toMs - fromMs);

  const merged = mergeIntervals(inputs.reviewedIntervals);
  const reviewedMs = merged.reduce((sum, iv) => sum + (iv.toMs - iv.fromMs), 0);
  const reviewedFraction = windowMs === 0 ? 0 : Math.min(1, reviewedMs / windowMs);

  // Only the slice of each unreviewed gap within one safety margin of
  // `from` is genuinely imminent: `from` itself slides forward with the
  // clock, so the oldest edge of the window is what's closest to being
  // dropped by retention next. A gap that starts further into the window
  // isn't urgent yet -- it will surface here on a later poll, once it
  // slides into the margin.
  const cutoffMs = fromMs + safetyMarginMs;
  const expiringSoon: ExpiringGap[] = complementIntervals(merged, fromMs, toMs)
    .filter((gap) => gap.fromMs < cutoffMs)
    .map((gap) => ({
      from: new Date(gap.fromMs).toISOString(),
      to: new Date(Math.min(gap.toMs, cutoffMs)).toISOString(),
      reason: 'unreviewed' as const,
    }))
    .slice(0, EXPIRING_SOON_LIMIT);

  const reviewedSourceCount = (source: LabelSource): number => inputs.labelSourceCounts[source] ?? 0;

  return {
    reviewedFraction,
    expiringSoon,
    confirmations: reviewedSourceCount('confirmed'),
    corrections: reviewedSourceCount('manual'),
    annotations: inputs.annotationCount,
    categoriesUsed: inputs.annotationCategories,
  };
}

/**
 * `GET /api/coverage`: backs the dashboard's "missions" panel -- what, in
 * the retention window, is worth reviewing before it ages out. Deliberately
 * has NO total-labels counter and NO streak: this endpoint points at corpus
 * *value* (how much of the forever-relevant window has a human judgement
 * attached, and what's about to stop being reviewable), not at label
 * *volume* -- a volume incentive on a training corpus produces junk labels.
 */
export function registerCoverageRoutes(app: FastifyInstance, db: HomeCsiDb, options: CoverageOptions): void {
  app.get('/api/coverage', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - options.retentionMaxAgeMs);
    const inputs = await db.getCoverageInputs({ from, to });
    return computeCoverage(inputs, { from, to }, options.safetyMarginMs);
  });
}
