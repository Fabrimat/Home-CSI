import { h } from '../dom.js';

/**
 * The one shared loading/empty/error convention for every view (brief B18
 * "dashboard design system + accessibility").
 *
 * These three states must stay visually AND programmatically distinct from
 * each other and from a normal loaded view -- collapsing "we don't know yet"
 * or "the fetch failed" into something that looks like an ordinary, quiet
 * result is exactly the bug this convention exists to prevent. See
 * `labelRanges.ts`'s `RetentionAvailability` for the concrete incident: a
 * failed `GET /api/config` once rendered identically to "loaded, plenty of
 * headroom." The same discipline applies here, generalised to every async
 * view in the dashboard, not just that one endpoint.
 */

/** Shown while a fetch this view depends on is still in flight -- never leave the view blank instead. */
export function loadingState(message = 'Loading…'): HTMLElement {
  return h('div', { class: 'loading-state', role: 'status' }, message);
}

/** Shown in place of a chart/table when a fetch succeeded but genuinely returned no data -- never a placeholder graphic. */
export function emptyState(message: string): HTMLElement {
  return h('div', { class: 'empty-state' }, message);
}

/**
 * Shown when a fetch failed. `role="alert"` (implicit `aria-live="assertive"`)
 * deliberately, not `role="status"`: a failure must interrupt, because a
 * screen reader user who never hears it has no other way to learn that what
 * follows (or the lack of it) is not a benign empty result.
 */
export function errorState(message: string): HTMLElement {
  return h('div', { class: 'error-state', role: 'alert' }, `Error: ${message}`);
}
