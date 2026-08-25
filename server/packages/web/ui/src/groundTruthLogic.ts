/**
 * DOM-free logic behind the unified ground-truth view
 * (`views/groundTruth.ts`): the training-mode state-machine decisions, the
 * `label_sessions.notes` marker convention, and the mission-list derivation
 * from `GET /api/coverage`.
 *
 * Split out from the view for the same reason as `labelRanges.ts`: these are
 * the rules that must not regress (a mis-ordered declaration silently
 * corrupts the corpus this whole mode exists to build), and they are only
 * testable if they don't need a document.
 */

/** The coarse occupancy STATE this view declares -- never a people count (see `docs/architecture.md` "Motion, not people"). */
export type DeclaredState = 0 | 1 | 2;

export const STATE_LABELS: Record<DeclaredState, string> = {
  0: 'House empty',
  1: 'Just me',
  2: 'Two or more of us',
};

export const STATE_BUTTON_LABELS: Record<DeclaredState, string> = {
  0: '0',
  1: '1',
  2: '2+',
};

export type MotionTag = '' | 'still' | 'moving';

/**
 * Marks `label_sessions.notes` as created by this view's Live mode, so
 * re-entering it can find an already-open training session to resume
 * instead of orphaning it.
 *
 * Deliberately NOT `WEAK_LABEL_PREFIX` (`'[weak:phone-presence]'`,
 * `@homecsi/labeling/src/sessions.ts`) and never allowed to start with it:
 * `trainingPreservation.ts`'s `preserveSessionFeatures` skips raw per-link
 * feature preservation for any weak-flagged session, so a weak-prefixed
 * training session's underlying features would silently evaporate once the
 * 7-day `features` retention window passes -- poisoning exactly the corpus
 * this mode exists to build.
 */
export const TRAINING_MARKER = '[training]';

export function isTrainingSession(notes: string | null): boolean {
  return notes !== null && notes.startsWith(TRAINING_MARKER);
}

export function composeSessionNotes(operatorNotes: string): string {
  const trimmed = operatorNotes.trim();
  return trimmed ? `${TRAINING_MARKER} ${trimmed}` : TRAINING_MARKER;
}

export function composeLabelNotes(contextNote: string, motion: MotionTag): string | undefined {
  const trimmed = contextNote.trim();
  const parts = [trimmed, motion ? `(${motion})` : ''].filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** The subset of a `labels` row the declaration state machine reasons about. */
export interface OpenDeclaration {
  id: number;
  occupancyCount: number;
  time: string;
  endTime: string | null;
}

/**
 * What tapping `newState` must do, given the currently open declaration.
 *
 * `'noop'` is the load-bearing case: tapping the already-declared state must
 * never close-and-reopen, which would write a zero-length interval nothing
 * downstream can interpret. `'declare'` carries the id to close FIRST -- the
 * caller must PATCH that id's `endTime` and only then POST the new label, at
 * the same instant, so the intervals abut with no gap and no overlap, and
 * must NOT post if the close fails (two open declarations at once would be
 * unrecoverable from the client's side).
 */
export type DeclarationPlan = { kind: 'noop' } | { kind: 'declare'; closeLabelId: number | null };

export function planDeclaration(open: OpenDeclaration | null, newState: DeclaredState): DeclarationPlan {
  if (open !== null && open.occupancyCount === newState) return { kind: 'noop' };
  return { kind: 'declare', closeLabelId: open === null ? null : open.id };
}

/** The subset of a `label_sessions` row the guards below reason about. */
export interface SessionState {
  endedAt: string | null;
}

/**
 * Whether there is a session that is genuinely still open. A stopped session
 * is not "a session" for writing purposes: `stopSession` keeps the stopped
 * row in view state (to show when it ended), so a non-null check alone is not
 * the same question.
 */
export function isSessionOpen(session: SessionState | null): boolean {
  return session !== null && session.endedAt === null;
}

/**
 * Whether a state declaration may be written at all.
 *
 * The `endedAt` half is load-bearing, not defensive padding. `labels` is
 * append-only -- there is no delete route -- and a stopped session has
 * already had its window preserved into `training_features`, so a declaration
 * written after the stop is a permanent, open-ended (`end_time IS NULL`)
 * `source: 'training'` label sitting outside the preserved window, invisible
 * in a UI that has already hidden the declare panel. That is false ground
 * truth in the corpus, and nothing downstream can tell it apart from a real
 * declaration.
 *
 * Panel visibility must never be the thing that prevents it: the keyboard
 * shortcut path reaches `declare()` whether or not the panel is on screen,
 * and so will the next entry point somebody adds.
 */
export function canDeclare(session: SessionState | null, busy: boolean): boolean {
  return !busy && isSessionOpen(session);
}

/**
 * Shortest span recorded as a real interval annotation. Below this, the two
 * taps were the operator double-tapping one button, not bracketing an event.
 */
export const MIN_INTERVAL_MS = 1000;

/**
 * What a just-closed interval tap actually writes: `endTime: null` means
 * "record a point annotation at `time`", anything else is a real interval.
 *
 * The degradation is not a nicety. `POST /api/annotations` refuses
 * `endTime <= time` (migration 009's `end_time > time` CHECK), so a
 * sub-threshold double-tap sent as an interval would come back a 400 and the
 * operator's tap would be lost outright. Recording the honest instant they
 * did tap is strictly better than discarding it. Exactly `MIN_INTERVAL_MS`
 * counts as an interval -- the threshold is the shortest span kept, not the
 * longest one dropped.
 */
export function planAnnotationSpan(startMs: number, endMs: number): { time: number; endTime: number | null } {
  return { time: startMs, endTime: endMs - startMs >= MIN_INTERVAL_MS ? endMs : null };
}

/**
 * The still-open declaration in a session's transcript, if any. The
 * transcript arrives `time`-ascending from
 * `GET /api/labels/sessions/:id/labels`, and only its final row can be open
 * (every earlier one was closed by the declaration that followed it) --
 * anything else means the server state diverged from this rule, in which
 * case there is no honest "current" declaration to tick a held-duration
 * against, so this reports none.
 */
export function openDeclarationOf<T extends { endTime: string | null }>(ascendingByTime: readonly T[]): T | null {
  const last = ascendingByTime[ascendingByTime.length - 1];
  return last !== undefined && last.endTime === null ? last : null;
}

/** "2m 14s" / "45s" -- coarser formatters elsewhere (`occupancySeries.ts`'s `formatDuration`) round to whole minutes, too coarse for a live ticking readout the operator glances at while walking. */
export function formatHeldDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m === 0 ? `${s}s` : `${m}m ${String(s).padStart(2, '0')}s`;
}

/** "2d 4h" / "5h 12m" / "18m" -- retention deadlines are hour-to-day scale, unlike `formatHeldDuration`'s seconds. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'gone';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/**
 * `event_annotations.category` (migration 009) with the one-line prompt each
 * button shows. There is deliberately NO `activity` category: "a person
 * cooking" is occupancy signal and belongs in the correction flow on the
 * occupancy timeline, not in a confounder palette -- an annotation carries
 * no occupancy count at all, so recording human activity here would record
 * the presence of a person as a non-occupancy event.
 */
export const ANNOTATION_CATEGORIES = [
  { id: 'appliance', label: 'Appliance', hint: 'microwave, kettle, washing machine' },
  { id: 'door', label: 'Door', hint: 'opened, closed, slammed' },
  { id: 'hvac', label: 'HVAC', hint: 'fan, AC, heating cycling' },
  { id: 'pet', label: 'Pet', hint: 'cat/dog moving through' },
  { id: 'interference', label: 'Interference', hint: 'neighbour Wi-Fi, microwave RF, other 2.4 GHz' },
  { id: 'other', label: 'Other', hint: 'anything else worth marking' },
] as const;

/** Mirrors `AnnotationCategory` (packages/api/src/db/types.ts) exactly. */
export type AnnotationCategory = (typeof ANNOTATION_CATEGORIES)[number]['id'];

/** Mirrors `GET /api/annotations`' `AnnotationRow` (packages/api/src/db/types.ts). */
export interface AnnotationRow {
  id: number;
  time: string;
  endTime: string | null;
  category: AnnotationCategory;
  label: string | null;
  notes: string | null;
  source: 'manual';
  createdAt: string;
}

/**
 * Distinct free-text labels from the most recent annotations, newest first --
 * the "recently used" chips that make a repeat of the same real-world event
 * (the same microwave, again) a single tap instead of retyping.
 */
export function recentLabelChips(annotations: readonly AnnotationRow[], max: number): string[] {
  const seen = new Set<string>();
  const chips: string[] = [];
  for (const a of [...annotations].sort((x, y) => Date.parse(y.time) - Date.parse(x.time))) {
    const label = a.label?.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    chips.push(label);
    if (chips.length >= max) break;
  }
  return chips;
}

/**
 * The window to review on the occupancy timeline for an annotation the
 * operator decided is worth a real occupancy correction. An interval
 * annotation reviews exactly its own span; a point annotation has no span,
 * so it gets a symmetric `padMs` window around it -- a *selection* to review,
 * never a fabricated label.
 */
export function annotationReviewWindow(
  annotation: Pick<AnnotationRow, 'time' | 'endTime'>,
  padMs: number,
): { fromMs: number; toMs: number } | null {
  const fromMs = Date.parse(annotation.time);
  if (Number.isNaN(fromMs)) return null;
  if (annotation.endTime === null) return { fromMs: fromMs - padMs, toMs: fromMs + padMs };
  const toMs = Date.parse(annotation.endTime);
  if (Number.isNaN(toMs) || toMs <= fromMs) return { fromMs: fromMs - padMs, toMs: fromMs + padMs };
  return { fromMs, toMs };
}

/** One `expiringSoon` entry from `GET /api/coverage` (packages/api/src/routes/coverage.ts). */
export interface ExpiringGap {
  from: string;
  to: string;
  reason: 'unreviewed';
}

/** Mirrors `GET /api/coverage`'s `CoverageResponse`. Note what it deliberately does NOT have: any total or streak. */
export interface CoverageSnapshot {
  reviewedFraction: number;
  expiringSoon: ExpiringGap[];
  confirmations: number;
  corrections: number;
  annotations: number;
  categoriesUsed: string[];
}

/** One unreviewed stretch worth reviewing before retention drops the raw features behind it. */
export interface Mission {
  fromIso: string;
  toIso: string;
  spanMs: number;
  /**
   * ms until this stretch is *entirely* outside the retention window (its
   * newest edge falls off), i.e. the point after which no correction here can
   * ever preserve raw features. `null` when the window length is unknown
   * (`GET /api/config` failed) -- rendered as "unknown", never as a
   * comfortable-looking number, same discipline as `RetentionAvailability`
   * in `labelRanges.ts`.
   */
  msUntilGone: number | null;
}

/**
 * `expiringSoon` turned into an ordered work list: most urgent (oldest
 * newest-edge) first, malformed and already-unrecoverable entries dropped.
 *
 * Dropping `msUntilGone <= 0` entries matters: a response held while the
 * page sat idle can describe a stretch retention has since dropped, and
 * offering "go save this" for something already gone is worse than showing
 * nothing -- the operator would spend the one thing this mode is actually
 * short of (their attention) on a window whose features no longer exist.
 */
export function deriveMissions(
  expiringSoon: readonly ExpiringGap[],
  retentionMaxAgeMs: number | null,
  nowMs: number,
): Mission[] {
  const missions: Mission[] = [];
  for (const gap of expiringSoon) {
    const fromMs = Date.parse(gap.from);
    const toMs = Date.parse(gap.to);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) continue;
    const msUntilGone = retentionMaxAgeMs === null ? null : toMs + retentionMaxAgeMs - nowMs;
    if (msUntilGone !== null && msUntilGone <= 0) continue;
    missions.push({ fromIso: gap.from, toIso: gap.to, spanMs: toMs - fromMs, msUntilGone });
  }
  return missions.sort((a, b) => Date.parse(a.toIso) - Date.parse(b.toIso));
}

/**
 * Whether a bare-key shortcut (`0`/`1`/`2`/`z`) must be ignored for this
 * keydown. Typing "0" into the context-note field must never also declare
 * "house empty", and a browser/OS chord (Ctrl+Z, Cmd+0) must never be
 * swallowed by a single-letter handler. Takes a plain record rather than a
 * `KeyboardEvent` so the rule is testable without a DOM.
 */
export function isShortcutSuppressed(ev: {
  tagName: string;
  isContentEditable: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return true;
  if (ev.isContentEditable) return true;
  return ev.tagName === 'INPUT' || ev.tagName === 'TEXTAREA' || ev.tagName === 'SELECT';
}
