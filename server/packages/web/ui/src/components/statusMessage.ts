import { h } from '../dom.js';

/** Severity of a one-off feedback message reporting the outcome of a user action. */
export type StatusKind = 'ok' | 'info' | 'warn' | 'error';

const PREFIX: Record<StatusKind, string> = {
  ok: '',
  info: '',
  warn: 'Warning: ',
  error: 'Error: ',
};

/**
 * A single, screen-reader-announced feedback message reporting the outcome
 * of a user action -- a correction submitted on the Occupancy timeline, a
 * training session started/stopped/resumed, and so on. Before this
 * component existed each view drew its own visual-only box, so a screen
 * reader user had no way to learn a correction failed, or to catch a
 * `preservationWarning` -- the one message an operator must not miss
 * (docs/roadmap.md "surface the preservation warning prominently").
 *
 * Politeness is chosen per kind, not globally, and deliberately NOT the
 * same for every message:
 *  - 'warn' / 'error' get `role="alert"` (implicit `aria-live="assertive"`):
 *    these are exactly the messages that must interrupt whatever the screen
 *    reader is currently doing -- a missed preservation warning or a failed
 *    correction/session action is worse than an interruption.
 *  - 'ok' / 'info' get `role="status"` (implicit `aria-live="polite"`): a
 *    routine confirmation ("Correction saved.") should still be announced,
 *    but queued rather than cutting off whatever is being read.
 *
 * `withPrefix` reproduces the "Warning: " / "Error: " lead-in some callers
 * want (e.g. the training view's banner); callers that already word the
 * message clearly on their own (e.g. the occupancy correction outcome) omit it.
 */
export function statusMessage(kind: StatusKind, text: string, withPrefix = false): HTMLElement {
  const role = kind === 'warn' || kind === 'error' ? 'alert' : 'status';
  const prefix = withPrefix ? PREFIX[kind] : '';
  return h('div', { class: `correction-message ${kind}`, role }, prefix ? h('strong', {}, prefix) : null, text);
}
