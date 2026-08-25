/**
 * Pure, DOM-free logic backing the occupancy timeline's correction UI
 * (docs/roadmap.md "Web dashboard" -- "The feedback loop: correction as
 * the primary interaction"). Everything here operates on plain numbers/ms
 * and the `StepSegment`s already computed by `occupancySeries.ts`, so it is
 * unit-testable without a browser (labelRanges.test.ts) and reusable by any
 * future view that needs the same reasoning.
 */

import type { StepSegment } from './occupancySeries.js';

/** The subset of `GET /api/labels`' `LabelRow` shape this module needs. */
export interface LabelRangeInput {
  id: number;
  sessionId: number;
  /** ISO timestamp, interval start (or the instant, for a point label). */
  time: string;
  /** ISO timestamp, EXCLUSIVE end. `null` means a point label -- never fabricate a width for it. */
  endTime: string | null;
  occupancyCount: number;
  source: string;
  notes: string | null;
}

/** `LabelRangeInput` reduced to millisecond bounds. `toMs === null` marks a point label. */
export interface LabelMsInterval {
  id: number;
  fromMs: number;
  toMs: number | null;
  occupancyCount: number;
  source: string;
  notes: string | null;
}

export function labelToMsInterval(label: LabelRangeInput): LabelMsInterval {
  return {
    id: label.id,
    fromMs: Date.parse(label.time),
    toMs: label.endTime === null ? null : Date.parse(label.endTime),
    occupancyCount: label.occupancyCount,
    source: label.source,
    notes: label.notes,
  };
}

// --- Overlap / clamping helpers -------------------------------------------

/** Half-open interval overlap test: [aFromMs, aToMs) intersects [bFromMs, bToMs). */
export function intervalsOverlap(aFromMs: number, aToMs: number, bFromMs: number, bToMs: number): boolean {
  return aFromMs < bToMs && bFromMs < aToMs;
}

/**
 * Intersects [fromMs, toMs) with [windowFromMs, windowToMs), or `null` when
 * they don't overlap at all. Used to clamp a label span (which may extend
 * outside the visible window) to what's actually drawable.
 */
export function clampInterval(
  fromMs: number,
  toMs: number,
  windowFromMs: number,
  windowToMs: number,
): { fromMs: number; toMs: number } | null {
  const clampedFrom = Math.max(fromMs, windowFromMs);
  const clampedTo = Math.min(toMs, windowToMs);
  if (clampedFrom >= clampedTo) return null;
  return { fromMs: clampedFrom, toMs: clampedTo };
}

// --- System estimate over a selection --------------------------------------

/**
 * What the latched state machine claimed over a selected range, derived
 * from the same step segments the chart already draws -- never a second,
 * divergent read of the data. "Constant" is the load-bearing question: a
 * selection cannot be honestly "confirmed correct" with one number if the
 * system said several different things across it (docs/roadmap.md
 * "confirm stretches it got right").
 */
export interface SelectionEstimate {
  /** False when no segment overlaps the selection at all (e.g. selection sits entirely before any occupancy event). */
  hasData: boolean;
  /** True iff exactly one distinct estimate value was seen across the selection. */
  constant: boolean;
  /** The single estimate, only meaningful when `constant && hasData`. */
  estimate: number | null;
  /** Distinct estimates seen, in the order they first occur across the selection. Empty when `!hasData`. */
  distinctEstimates: number[];
}

export function systemEstimateOverSelection(
  segments: readonly StepSegment[],
  selFromMs: number,
  selToMs: number,
): SelectionEstimate {
  const seen = new Set<number>();
  const order: number[] = [];
  let hasData = false;
  for (const segment of segments) {
    const overlapFrom = Math.max(segment.startMs, selFromMs);
    const overlapTo = Math.min(segment.endMs, selToMs);
    if (overlapFrom >= overlapTo) continue;
    hasData = true;
    if (!seen.has(segment.row.estimate)) {
      seen.add(segment.row.estimate);
      order.push(segment.row.estimate);
    }
  }
  return {
    hasData,
    constant: order.length === 1,
    estimate: order.length === 1 ? (order[0] as number) : null,
    distinctEstimates: order,
  };
}

// --- Label vs. system disagreement -----------------------------------------

/** A sub-interval where a ground-truth label's count differs from the system's estimate at the same instant. */
export interface LabelDisagreement {
  labelId: number;
  fromMs: number;
  /** Equal to `fromMs` for a disagreement anchored at a point label. */
  toMs: number;
  labelCount: number;
  systemEstimate: number;
}

/**
 * Finds every stretch where a label's declared count disagrees with the
 * step segment covering the same instant -- the whole point of overlaying
 * labels on the prediction (docs/roadmap.md: "highlight disagreement").
 * A point label (`toMs === null`) is checked against the single segment
 * that holds at its instant; an interval label is checked against every
 * segment it overlaps, producing one disagreement per overlapping segment
 * so a label spanning a system transition is flagged precisely where it
 * disagrees, not across its whole span.
 */
export function findLabelDisagreements(
  labels: readonly LabelMsInterval[],
  segments: readonly StepSegment[],
): LabelDisagreement[] {
  const result: LabelDisagreement[] = [];
  for (const label of labels) {
    if (label.toMs === null) {
      const segment = segments.find((s) => label.fromMs >= s.startMs && label.fromMs < s.endMs);
      if (segment && segment.row.estimate !== label.occupancyCount) {
        result.push({
          labelId: label.id,
          fromMs: label.fromMs,
          toMs: label.fromMs,
          labelCount: label.occupancyCount,
          systemEstimate: segment.row.estimate,
        });
      }
      continue;
    }
    for (const segment of segments) {
      const overlapFrom = Math.max(label.fromMs, segment.startMs);
      const overlapTo = Math.min(label.toMs, segment.endMs);
      if (overlapFrom < overlapTo && segment.row.estimate !== label.occupancyCount) {
        result.push({
          labelId: label.id,
          fromMs: overlapFrom,
          toMs: overlapTo,
          labelCount: label.occupancyCount,
          systemEstimate: segment.row.estimate,
        });
      }
    }
  }
  return result;
}

// --- Retention classification -----------------------------------------------

/** Mirrors `GET /api/config`'s `ClientConfig` shape (server/packages/api/src/routes/config.ts). */
export interface RetentionConfig {
  retentionMaxAgeMs: number;
  retentionSafetyMarginMs: number;
}

export type RetentionZone = 'ok' | 'approaching' | 'past-deadline';

/**
 * Classifies a single instant's age against the retention window. Mirrors
 * `@homecsi/labeling`'s `retentionEdgeWarning` cutover logic (same two
 * thresholds: `maxAgeMs`, and `maxAgeMs - safetyMarginMs`), reapplied here
 * for the dashboard's own rendering needs rather than importing a
 * server-side package into the browser bundle.
 */
export function retentionZoneAt(atMs: number, config: RetentionConfig, nowMs: number): RetentionZone {
  const ageMs = nowMs - atMs;
  if (ageMs >= config.retentionMaxAgeMs) return 'past-deadline';
  if (ageMs >= config.retentionMaxAgeMs - config.retentionSafetyMarginMs) return 'approaching';
  return 'ok';
}

/**
 * The worst (most severe) retention zone touched anywhere within
 * [fromMs, toMs). Age strictly decreases moving toward `nowMs`, so the
 * oldest instant in the range -- its `fromMs` (or `toMs` if the range runs
 * backwards) -- is always the binding constraint.
 */
export function retentionZoneForRange(
  fromMs: number,
  toMs: number,
  config: RetentionConfig,
  nowMs: number,
): RetentionZone {
  return retentionZoneAt(Math.min(fromMs, toMs), config, nowMs);
}

/**
 * Absolute-ms boundaries of the two retention zones, so a timeline can
 * shade fixed regions once per render instead of classifying every pixel.
 * Times at or before `deadlineMs` are past-deadline; times at or before
 * `approachingStartMs` (but after `deadlineMs`) are in the softer
 * approaching-the-edge warning zone.
 */
export function retentionBoundaries(config: RetentionConfig, nowMs: number): { deadlineMs: number; approachingStartMs: number } {
  return {
    deadlineMs: nowMs - config.retentionMaxAgeMs,
    approachingStartMs: nowMs - (config.retentionMaxAgeMs - config.retentionSafetyMarginMs),
  };
}

// --- Retention-config fetch availability ------------------------------------

/**
 * The client only learns `RetentionConfig` via an async `GET /api/config`
 * fetch, which can fail. Overloading a bare `RetentionConfig | null` to mean
 * both "still loading" and "the fetch failed" is exactly the bug this type
 * exists to prevent: a caller cannot tell "no answer yet" from "no answer
 * ever coming" from a null check alone, and neither may render the same as
 * "loaded, and comfortably within the retention window" -- unknown must
 * never be silently treated as safe.
 */
export type RetentionAvailability =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'loaded'; config: RetentionConfig };

/**
 * A selection's retention status, extending `RetentionZone` with the two
 * states that mean "we cannot classify this at all" -- `'loading'` (the
 * initial config fetch hasn't resolved) and `'unavailable'` (it failed).
 * Neither is ever conflated with `'ok'`: this type can only be produced by
 * `classifySelectionRetention`, which forces the caller to go through
 * `RetentionAvailability` rather than reach for a stray `null` check.
 */
export type SelectionRetentionStatus = RetentionZone | 'loading' | 'unavailable';

export function classifySelectionRetention(
  availability: RetentionAvailability,
  fromMs: number,
  toMs: number,
  nowMs: number,
): SelectionRetentionStatus {
  if (availability.status === 'loading') return 'loading';
  if (availability.status === 'failed') return 'unavailable';
  return retentionZoneForRange(fromMs, toMs, availability.config, nowMs);
}

// --- Occupancy-timeline deep links ------------------------------------------

/**
 * The `#/occupancy?from=<iso>&to=<iso>` hash a "Go" action links to when it
 * wants the occupancy timeline to open with a stretch already selected (the
 * ground-truth view's Missions mode). Kept next to its parser below so the
 * two halves of the contract can't drift.
 */
export function occupancyDeepLinkHash(fromMs: number, toMs: number): string {
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  return `#/occupancy?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

/**
 * The preselected range in a `#/occupancy?from=&to=` hash, or `null` when
 * there isn't a usable one -- an absent, malformed, or non-ordered pair must
 * leave the timeline's own default (no selection) untouched rather than
 * applying a garbage selection the operator then has to notice and clear.
 */
export function parseSelectionFromHash(hash: string): { fromMs: number; toMs: number } | null {
  const queryStart = hash.indexOf('?');
  if (queryStart === -1) return null;
  const params = new URLSearchParams(hash.slice(queryStart + 1));
  const from = params.get('from');
  const to = params.get('to');
  if (from === null || to === null) return null;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) return null;
  return { fromMs, toMs };
}
