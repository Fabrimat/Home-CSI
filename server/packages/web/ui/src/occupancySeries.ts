/**
 * Step semantics for the sparse occupancy event log.
 *
 * `/api/occupancy` returns *events*, not samples: one row per transition of
 * the latch state machine, plus a keepalive every 15 minutes of tick time,
 * plus a carry-in row from before the requested window (which therefore has
 * a timestamp earlier than `from`). A row's value holds until the next row —
 * last value carried forward. Nothing here may interpolate between rows or
 * assume a fixed cadence, and a window with no events inside it is *not*
 * empty: it is one long segment carried in from before.
 *
 * Kept DOM-free and pure so it can be unit-tested (occupancySeries.test.ts)
 * without a browser environment.
 */

export type OccupancyRowKind = 'transition' | 'keepalive';

export interface OccupancyRow {
  time: string;
  estimate: number;
  confidence: number;
  state: string;
  kind: OccupancyRowKind;
  details: Record<string, unknown> | null;
}

/** One held value over a half-open time span, clamped to the requested window. */
export interface StepSegment {
  startMs: number;
  endMs: number;
  /** The event that holds over this span. Its own `time` may predate `startMs` (carry-in). */
  row: OccupancyRow;
}

/**
 * Turns time-ascending events into contiguous held segments covering
 * [fromMs, toMs). The first event is clamped forward to `fromMs` (keeping
 * its real timestamp on the row, so callers can still render "occupied
 * since ..."), and the last event is held to `toMs`.
 */
export function buildStepSegments(
  rows: readonly OccupancyRow[],
  fromMs: number,
  toMs: number,
): StepSegment[] {
  const segments: StepSegment[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as OccupancyRow;
    const next = rows[i + 1];
    const startMs = Math.max(Date.parse(row.time), fromMs);
    const endMs = next === undefined ? toMs : Math.min(Date.parse(next.time), toMs);
    if (endMs <= startMs) continue; // superseded at the same instant, or entirely outside the window
    segments.push({ startMs, endMs, row });
  }
  return segments;
}

/**
 * When the *current* state started, by walking the history back over every
 * row that reports the same state (keepalives included) to the transition
 * that began the run. Returns null for an empty history.
 */
export function currentRunStartMs(rows: readonly OccupancyRow[]): number | null {
  if (rows.length === 0) return null;
  const current = rows[rows.length - 1] as OccupancyRow;
  let startMs = Date.parse(current.time);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] as OccupancyRow;
    if (row.state !== current.state) break;
    startMs = Date.parse(row.time);
  }
  return startMs;
}

/** Coarse "3h 12m" / "44m" / "<1m" duration, for "time in state" readouts. */
export function formatDuration(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60_000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * Mirror of @homecsi/occupancy's KEEPALIVE_INTERVAL_MS. While the pipeline is
 * running it writes at least one row per interval of tick time, so the
 * absence of one is information.
 */
export const KEEPALIVE_INTERVAL_MS = 15 * 60_000;

/**
 * True when a held span is longer than the pipeline could have left it while
 * observing — i.e. the flat line here means "nobody was looking", not
 * "nothing happened". Two intervals of slack, so an ordinary late batch does
 * not get labelled an outage.
 */
export function isUnobservedGap(segment: StepSegment): boolean {
  return segment.endMs - segment.startMs > 2 * KEEPALIVE_INTERVAL_MS;
}
