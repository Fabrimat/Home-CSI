/**
 * Take semantics (docs/box-experiment.md "Take semantics"): gestures are
 * sub-second and the 5 box nodes are not time-synchronised, so a take's
 * window is defined explicitly here rather than improvised ad hoc at each
 * call site.
 *
 *   - A take's window is [started_at, ended_at) on SERVER RECEIVE TIME --
 *     the same clock every `csi_records.time` value already uses, so no
 *     cross-node clock alignment is needed or attempted.
 *   - A configurable lead-in/lead-out trim is applied when selecting a
 *     take's records, so the operator's hand entering/leaving the box at
 *     the start and end of a hold doesn't get labelled as the gesture
 *     itself.
 *   - A take is only "usable" (for training) once its resulting record
 *     count clears a configurable minimum -- see `isTakeUsable`.
 */

export const DEFAULT_LEAD_TRIM_MS = 200;

/** Below this many preserved records, a take is refused as unusable for training -- a handful of stray rows is noise, not a gesture. */
export const DEFAULT_MIN_TAKE_RECORDS = 20;

export interface TakeWindow {
  /** Inclusive start of the trimmed window, server receive time (ms since epoch). */
  fromMs: number;
  /** Exclusive end of the trimmed window, server receive time (ms since epoch). */
  toMs: number;
}

/**
 * Computes a take's trimmed record-selection window. Returns `null` when the
 * window isn't well-defined yet (the take is still open -- `endedAtMs` is
 * `null`, so its true end isn't known) or when the lead-in/lead-out trim
 * consumes the entire hold (a hold shorter than `leadInMs + leadOutMs`,
 * which cannot have any un-trimmed gesture content).
 */
export function computeTakeWindow(
  session: { startedAtMs: number; endedAtMs: number | null },
  leadInMs: number,
  leadOutMs: number,
): TakeWindow | null {
  if (session.endedAtMs === null) return null;
  const fromMs = session.startedAtMs + leadInMs;
  const toMs = session.endedAtMs - leadOutMs;
  if (toMs <= fromMs) return null;
  return { fromMs, toMs };
}

/** A take with fewer than `minRecords` preserved rows is refused as unusable -- see docs/box-experiment.md. */
export function isTakeUsable(recordCount: number, minRecords: number): boolean {
  return recordCount >= minRecords;
}
