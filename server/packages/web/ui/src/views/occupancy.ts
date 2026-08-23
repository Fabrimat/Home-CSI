import { apiGet, apiPost, ApiError } from '../api.js';
import { clear, formatTimestamp, h } from '../dom.js';
import { emptyState, errorState, loadingState } from '../components/asyncState.js';
import { statusMessage } from '../components/statusMessage.js';
import {
  buildStepSegments,
  currentRunStartMs,
  formatDuration,
  isUnobservedGap,
  type OccupancyRow,
  type StepSegment,
} from '../occupancySeries.js';
import {
  classifySelectionRetention,
  clampInterval,
  findLabelDisagreements,
  labelToMsInterval,
  retentionBoundaries,
  systemEstimateOverSelection,
  type LabelDisagreement,
  type LabelRangeInput,
  type RetentionAvailability,
  type RetentionConfig,
  type SelectionEstimate,
} from '../labelRanges.js';

interface LabelSessionRow {
  id: number;
  startedAt: string;
  endedAt: string | null;
  notes: string | null;
}

/** Mirrors `GET /api/labels`' `LabelRow` (server/packages/api/src/routes/labels.ts). */
interface LabelRow extends LabelRangeInput {
  source: 'manual' | 'weak:phone-presence' | 'confirmed' | 'training';
}

/** A user-selected [fromMs, toMs) stretch of the timeline to review/correct. */
interface Selection {
  fromMs: number;
  toMs: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const WIDTH = 1000;
/** Height of the step-chart proper (estimate line + axes) -- unchanged from before the label lane was added below it. */
const HEIGHT = 320;
const MARGIN = { top: 16, right: 16, bottom: 30, left: 40 };

/** Ground-truth label lane, drawn as its own row under the chart rather than diamonds inline on it (see "Render existing labels as intervals" in docs/roadmap.md). */
const LABEL_LANE_TOP = HEIGHT + 14;
const LABEL_LANE_HEIGHT = 34;
/** Total SVG height: the step chart, plus the label lane and its own caption/margin below it. */
const TOTAL_HEIGHT = LABEL_LANE_TOP + LABEL_LANE_HEIGHT + 8;

const PAST_DEADLINE_PATTERN_ID = 'occ-past-deadline-hatch';
const RETENTION_UNAVAILABLE_PATTERN_ID = 'occ-retention-unavailable-hatch';

const RANGE_PRESETS: Array<{ label: string; ms: number }> = [
  { label: '1h', ms: 3600_000 },
  { label: '6h', ms: 6 * 3600_000 },
  { label: '24h', ms: 24 * 3600_000 },
  { label: '7d', ms: 7 * 24 * 3600_000 },
];

const STATE_COLORS: Record<string, string> = {
  unoccupied: '#93a0b8',
  occupied: '#3ddc97',
  decaying: '#f5c451',
};

/** One color per `labels.source` value (migration 008), so the label lane distinguishes provenance at a glance. */
const SOURCE_COLORS: Record<string, string> = {
  manual: '#5dc8fa',
  confirmed: '#3ddc97',
  'weak:phone-presence': '#93a0b8',
  training: '#f5c451',
};

const DISAGREE_COLOR = '#f5615c';

function stateColor(state: string): string {
  return STATE_COLORS[state.toLowerCase()] ?? '#5dc8fa';
}

function sourceColor(source: string): string {
  return SOURCE_COLORS[source] ?? '#e6e9f0';
}

/** "0" / "1" / "2+" -- the coarse occupancy scale (docs/architecture.md "Motion, not people"), never a raw >2 number. */
function occupancyLabelText(count: number): string {
  return count >= 2 ? '2+' : String(count);
}

function svgEl(name: string, attrs: Record<string, string | number> = {}): SVGElement {
  const el = document.createElementNS(SVG_NS, name) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** `datetime-local`'s value format expresses LOCAL wall-clock time with no zone -- round-tripped by hand rather than via `toISOString` (which is UTC). */
function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fromLocalInputValue(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function orderSelection(a: number, b: number): Selection {
  return { fromMs: Math.min(a, b), toMs: Math.max(a, b) };
}

/**
 * "7.0d" / "18.0h" -- retention windows are day-scale, unlike the
 * minutes/hours `formatDuration` from occupancySeries.ts is tuned for (run
 * lengths, keepalive gaps). Mirrors @homecsi/labeling's retentionWarning.ts
 * formatting convention (days first) rather than importing that
 * server-side package into the browser bundle just for this.
 */
function formatRetentionDuration(ms: number): string {
  const days = ms / 86_400_000;
  if (Math.abs(days) >= 1) return `${days.toFixed(1)}d`;
  const hours = ms / 3_600_000;
  return `${hours.toFixed(1)}h`;
}

export function renderOccupancy(container: HTMLElement): () => void {
  let disposed = false;
  const root = h('div', { class: 'view-scroll' });
  container.append(root);

  // --- Mutable view state -----------------------------------------------
  // Kept as closures rather than re-fetched on every interaction: dragging
  // a selection or editing the time inputs must feel instant and must not
  // re-hit the API on every pointermove.
  let currentSegments: StepSegment[] = [];
  // Explicitly three states, not a bare `RetentionConfig | null` -- "the
  // GET /api/config fetch hasn't resolved yet" and "it failed" must never
  // collapse into the same falsy value: both would otherwise render
  // identically to "loaded, and this selection has plenty of retention
  // headroom", which is the exact failure mode this feature exists to
  // prevent (see classifySelectionRetention in labelRanges.ts).
  let retentionAvailability: RetentionAvailability = { status: 'loading' };
  let selection: Selection | null = null;
  let applySelectionToChart: ((sel: Selection | null) => void) | null = null;
  let lastResult: { kind: 'ok' | 'warn' | 'error'; text: string } | null = null;

  const rangeSelect = h('select', { 'aria-label': 'Time range', disabled: true }) as HTMLSelectElement;
  for (const preset of RANGE_PRESETS) rangeSelect.append(h('option', { value: String(preset.ms) }, `last ${preset.label}`));
  rangeSelect.value = String(RANGE_PRESETS[2]!.ms);

  // Session filter for the label lane -- folds the old "pick one session to
  // overlay" control into a filter over the cross-session `GET /api/labels`
  // result rather than a second, session-scoped fetch. "no filter" (the
  // default) shows every session's labels at once, which is what makes
  // disagreement-highlighting useful across e.g. both a training-mode
  // session and later manual corrections.
  const sessionSelect = h('select', { 'aria-label': 'Filter ground-truth labels by session', disabled: true }) as HTMLSelectElement;
  sessionSelect.append(h('option', { value: '' }, 'all sessions'));

  const chartArea = h('div', { class: 'panel' });

  const selFromInput = h('input', { type: 'datetime-local', step: '1', 'aria-label': 'Selection start' }) as HTMLInputElement;
  const selToInput = h('input', { type: 'datetime-local', step: '1', 'aria-label': 'Selection end' }) as HTMLInputElement;
  const clearSelectionBtn = h('button', { onclick: () => setSelection(null) }, 'Clear selection');
  const correctionBody = h('div', {});

  const selectionPanel = h(
    'div',
    { class: 'panel' },
    h('h2', {}, 'Selected range'),
    h(
      'p',
      { class: 'sub' },
      'Drag horizontally across the chart above to select a stretch, or set the exact start/end here -- both stay in sync, so this is fully usable without a mouse.',
    ),
    h(
      'div',
      { class: 'controls' },
      h('label', {}, 'Start', selFromInput),
      h('label', {}, 'End', selToInput),
      clearSelectionBtn,
    ),
    correctionBody,
  );

  root.append(
    h('div', { class: 'controls' }, h('label', {}, 'Range', rangeSelect), h('label', {}, 'Ground truth', sessionSelect)),
    chartArea,
    selectionPanel,
  );
  chartArea.append(h('h2', {}, 'Occupancy timeline'), loadingState('Loading occupancy history…'));

  // --- Selection plumbing --------------------------------------------------

  function syncSelectionInputs(sel: Selection | null): void {
    selFromInput.value = sel ? toLocalInputValue(sel.fromMs) : '';
    selToInput.value = sel ? toLocalInputValue(sel.toMs) : '';
  }

  function setSelection(sel: Selection | null): void {
    selection = sel;
    lastResult = null;
    applySelectionToChart?.(sel);
    syncSelectionInputs(sel);
    renderCorrectionPanel();
  }

  selFromInput.addEventListener('change', () => {
    const ms = fromLocalInputValue(selFromInput.value);
    if (ms === null) return;
    setSelection(orderSelection(ms, selection ? selection.toMs : ms));
  });
  selToInput.addEventListener('change', () => {
    const ms = fromLocalInputValue(selToInput.value);
    if (ms === null) return;
    setSelection(orderSelection(selection ? selection.fromMs : ms, ms));
  });

  // --- Correction panel ------------------------------------------------------

  function renderCorrectionPanel(): void {
    clear(correctionBody);

    if (!selection) {
      correctionBody.append(emptyState('No range selected yet. Drag across the chart, or set start/end above, to review a stretch.'));
      return;
    }

    const durationMs = selection.toMs - selection.fromMs;
    correctionBody.append(
      h(
        'p',
        {},
        `Selected ${formatTimestamp(new Date(selection.fromMs).toISOString())} → ${formatTimestamp(new Date(selection.toMs).toISOString())} (${formatDuration(durationMs)})`,
      ),
    );

    const est: SelectionEstimate = systemEstimateOverSelection(currentSegments, selection.fromMs, selection.toMs);
    if (!est.hasData) {
      correctionBody.append(h('p', { class: 'sub' }, 'The system has no prediction at all for this selection -- no occupancy_states event covers it.'));
    } else if (est.constant) {
      correctionBody.append(h('p', {}, `The system claimed ${occupancyLabelText(est.estimate as number)} throughout this selection.`));
    } else {
      correctionBody.append(
        h(
          'p',
          {},
          `The system's estimate was NOT constant across this selection -- it reported ${est.distinctEstimates.map(occupancyLabelText).join(' → ')}. ` +
            'Narrow the selection to a single stretch to confirm it, or use "Mark wrong" below to record the true count for the whole range.',
        ),
      );
    }

    // Retention status must be a real three-way answer: 'loading' (the
    // config fetch has not resolved yet -- rangeSelect/sessionSelect being
    // disabled until init() settles closes the common race for THIS panel
    // being visible at all, but this branch stays explicit and shows a
    // neutral, visible line rather than nothing), 'unavailable' (the fetch
    // failed -- say so loudly, since "unknown" must never render as
    // "safely correctable"), or a real RetentionZone once loaded. See
    // classifySelectionRetention (labelRanges.ts).
    const retentionStatus = classifySelectionRetention(retentionAvailability, selection.fromMs, selection.toMs, Date.now());
    if (retentionStatus === 'loading') {
      correctionBody.append(loadingState('Checking retention status…'));
    } else if (retentionStatus === 'unavailable') {
      correctionBody.append(
        statusMessage(
          'warn',
          'Retention status unknown (could not reach /api/config) -- this selection may be past the point where its raw features can be preserved for training.',
        ),
      );
    } else if (retentionStatus === 'past-deadline' && retentionAvailability.status === 'loaded') {
      correctionBody.append(
        statusMessage(
          'warn',
          `Past the ${formatRetentionDuration(retentionAvailability.config.retentionMaxAgeMs)} debug window: this selection's raw per-link features are likely already gone. ` +
            'The correction will still be recorded, but it cannot be preserved into the permanent training set.',
        ),
      );
    } else if (retentionStatus === 'approaching' && retentionAvailability.status === 'loaded') {
      correctionBody.append(
        statusMessage(
          'warn',
          `Approaching the ${formatRetentionDuration(retentionAvailability.config.retentionMaxAgeMs)} debug window (within ${formatRetentionDuration(retentionAvailability.config.retentionSafetyMarginMs)} of the edge) -- correct this stretch soon if you want its raw features preserved.`,
        ),
      );
    }

    const notesInput = h('input', { type: 'text', placeholder: 'optional note, e.g. "guests just arrived"' }) as HTMLInputElement;

    // Confirmations are as valuable as corrections (docs/roadmap.md) --
    // "Confirm correct" is a primary action, not a greyed-out afterthought,
    // and is only ever disabled for a stated, visible reason.
    const confirmDisabledReason = !est.hasData
      ? 'no prediction exists for this selection yet'
      : !est.constant
        ? "the system's estimate was not constant across this selection -- cannot confirm a single number"
        : null;
    const confirmButton = h(
      'button',
      {
        class: 'btn-confirm',
        disabled: confirmDisabledReason !== null,
        title: confirmDisabledReason ?? "Record that the system's estimate was correct for this whole selection",
        onclick: () =>
          void submitCorrection({
            occupancyCount: est.estimate as number,
            source: 'confirmed',
            notes: notesInput.value || undefined,
          }),
      },
      est.constant && est.hasData ? `Confirm correct (${occupancyLabelText(est.estimate as number)})` : 'Confirm correct',
    );

    const wrongCount = h('select', { 'aria-label': 'True occupancy count for this selection' }) as HTMLSelectElement;
    wrongCount.append(h('option', { value: '0' }, '0 -- empty'), h('option', { value: '1' }, '1'), h('option', { value: '2' }, '2+'));
    const wrongButton = h(
      'button',
      {
        onclick: () =>
          void submitCorrection({
            occupancyCount: Number(wrongCount.value),
            source: 'manual',
            notes: notesInput.value || undefined,
          }),
      },
      'Submit correction',
    );

    correctionBody.append(
      h('div', { class: 'controls' }, h('label', {}, 'Note', notesInput)),
      h('div', { class: 'controls' }, confirmButton, h('label', {}, 'True count', wrongCount), wrongButton),
    );

    if (lastResult) {
      // Announced to assistive tech via statusMessage's role/politeness
      // logic (components/statusMessage.ts) -- this is the one place a
      // `preservationWarning` (kind 'warn') surfaces, and it must not be
      // visual-only: a screen reader user submitting a correction has no
      // other way to learn the raw features could not be preserved.
      correctionBody.append(statusMessage(lastResult.kind, lastResult.text));
    }
  }

  async function submitCorrection(input: { occupancyCount: number; source: 'manual' | 'confirmed'; notes?: string }): Promise<void> {
    if (!selection) return;
    try {
      // Exactly one POST /api/labels/corrections call per correction -- this
      // single composite endpoint creates the per-correction label session,
      // writes the interval label, stops the session, and attempts
      // training-set preservation. Never create a session directly here.
      const res = await apiPost<{ session: unknown; label: unknown; preservationWarning?: string }>('/api/labels/corrections', {
        from: new Date(selection.fromMs).toISOString(),
        to: new Date(selection.toMs).toISOString(),
        occupancyCount: input.occupancyCount,
        source: input.source,
        notes: input.notes,
      });
      // A preservationWarning means the label landed but its raw per-link
      // features could NOT be archived for training -- distinct from
      // success, never folded into the same "saved" message/style.
      lastResult = res.preservationWarning
        ? { kind: 'warn', text: `Correction recorded -- preservation warning: ${res.preservationWarning}` }
        : { kind: 'ok', text: 'Correction saved.' };
      if (disposed) return;
      await load();
    } catch (err) {
      lastResult = { kind: 'error', text: err instanceof ApiError ? err.message : String(err) };
      if (disposed) return;
      renderCorrectionPanel();
    }
  }

  // --- Data loading ----------------------------------------------------------

  async function loadSessions(): Promise<void> {
    try {
      const res = await apiGet<{ sessions: LabelSessionRow[] }>('/api/labels/sessions?limit=100');
      if (disposed) return;
      for (const s of res.sessions) {
        sessionSelect.append(h('option', { value: String(s.id) }, `#${s.id} — ${formatTimestamp(s.startedAt)}${s.notes ? ` (${s.notes})` : ''}`));
      }
    } catch {
      // Non-fatal: the timeline still works without the session filter populated.
    }
  }

  async function loadConfig(): Promise<void> {
    try {
      const config = await apiGet<RetentionConfig>('/api/config');
      retentionAvailability = { status: 'loaded', config };
    } catch {
      // NOT the same as "loading" or "loaded with headroom" -- a failed
      // fetch means retention status is genuinely unknown, and the chart
      // and correction panel must say so rather than rendering clean/quiet
      // (see the `retentionAvailability` comment above and
      // classifySelectionRetention in labelRanges.ts).
      retentionAvailability = { status: 'failed' };
    }
  }

  async function load(): Promise<void> {
    const rangeMs = Number(rangeSelect.value);
    const to = new Date();
    const from = new Date(to.getTime() - rangeMs);

    let states: OccupancyRow[];
    try {
      const res = await apiGet<{ states: OccupancyRow[] }>(
        `/api/occupancy?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&limit=10000`,
      );
      states = res.states;
    } catch (err) {
      if (disposed) return;
      clear(chartArea);
      chartArea.append(h('h2', {}, 'Occupancy timeline'), errorState(err instanceof ApiError ? err.message : String(err)));
      return;
    }

    // Cross-session labels overlapping the window (GET /api/labels?from&to) --
    // no session picker required to see ground truth at all; the session
    // filter above narrows this set down rather than replacing the fetch.
    let labels: LabelRow[] = [];
    try {
      const res = await apiGet<{ labels: LabelRow[] }>(
        `/api/labels?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&limit=5000`,
      );
      labels = sessionSelect.value ? res.labels.filter((l) => String(l.sessionId) === sessionSelect.value) : res.labels;
    } catch {
      // Non-fatal: render the prediction without the label overlay rather than failing the whole view.
    }

    if (disposed) return;
    clear(chartArea);
    chartArea.append(h('h2', {}, 'Occupancy timeline'));

    if (states.length === 0) {
      currentSegments = [];
      chartArea.append(
        emptyState(
          'No occupancy events at or before the end of this window — the occupancy pipeline (brief B4) has not produced an estimate yet, or the range is before it started. This is not the same as "nothing happened in this window": occupancy_states is a sparse event log and the API returns a carry-in event from before the window whenever one exists, so an empty result really does mean there is no history at all.',
        ),
      );
      renderCorrectionPanel();
      return;
    }

    chartArea.append(currentStateCaption(states));
    const { el, applySelection, segments } = renderChart(states, labels, from, to);
    currentSegments = segments;
    applySelectionToChart = applySelection;
    chartArea.append(el);
    chartArea.append(legend());
    applySelectionToChart(selection);
    renderCorrectionPanel();
  }

  function xScale(t: number, from: Date, to: Date): number {
    const span = to.getTime() - from.getTime() || 1;
    return MARGIN.left + ((t - from.getTime()) / span) * (WIDTH - MARGIN.left - MARGIN.right);
  }

  function yScale(estimate: number): number {
    // 0 (bottom) .. 2+ (top), clamped so a future >2 value still renders sensibly.
    const clamped = Math.min(2, Math.max(0, estimate));
    const usable = HEIGHT - MARGIN.top - MARGIN.bottom;
    return MARGIN.top + usable - (clamped / 2) * usable;
  }

  /** Inverse of `xScale`, clamped to the plotted range -- used to turn a drag's pointer position back into a timestamp. */
  function timeFromSvgX(svgX: number, from: Date, to: Date): number {
    const span = to.getTime() - from.getTime() || 1;
    const usable = WIDTH - MARGIN.left - MARGIN.right;
    const clamped = Math.min(WIDTH - MARGIN.right, Math.max(MARGIN.left, svgX));
    return from.getTime() + ((clamped - MARGIN.left) / usable) * span;
  }

  function timeFromClientX(svg: SVGElement, clientX: number, from: Date, to: Date): number {
    const rect = svg.getBoundingClientRect();
    const ratio = rect.width === 0 ? 0 : (clientX - rect.left) / rect.width;
    return timeFromSvgX(ratio * WIDTH, from, to);
  }

  /**
   * Step (last-value-carried-forward) rendering of a *sparse event log*.
   *
   * occupancy_states holds one row per transition plus a keepalive every 15
   * minutes of tick time, not one row per 500 ms tick, so points-and-a-line
   * would draw a near-empty chart for a perfectly healthy quiet house. Each
   * event is therefore drawn as a held span running to the next event (or to
   * the right edge), with the carry-in event held from the left edge.
   *
   * Below the step chart itself: a retention-shaded background (drawn first,
   * so it sits behind everything), a ground-truth label lane (spans/markers
   * per `labels.source`, disagreement with the prediction highlighted), and
   * a drag-to-select overlay drawn last, on top of everything, so a
   * selection is always visible regardless of what it covers.
   */
  function renderChart(
    states: OccupancyRow[],
    labels: LabelRow[],
    from: Date,
    to: Date,
  ): { el: HTMLElement; applySelection: (sel: Selection | null) => void; segments: StepSegment[] } {
    const svg = svgEl('svg', {
      viewBox: `0 0 ${WIDTH} ${TOTAL_HEIGHT}`,
      width: WIDTH,
      height: TOTAL_HEIGHT,
      role: 'img',
      'aria-label': 'Occupancy estimate over time (step), with ground-truth labels below and a selectable range',
    });

    // Retention shading, drawn first (background layer): stretches of the
    // timeline older than the debug window (config.storage.retention.maxAgeMs,
    // fetched live from GET /api/config -- never hardcoded here) can no
    // longer have their raw per-link features preserved into the permanent
    // training set even if corrected. A softer "approaching" band, using the
    // configured safety margin, warns before the edge is actually reached.
    //
    // If the config fetch failed, this must NOT render as a clean, unshaded
    // chart -- that reads as "plenty of headroom", which is not what "we
    // don't know" means. A faint hatch across the whole plot plus a caption
    // makes "retention status unknown" visually distinct from both "ok" and
    // "past deadline". The 'loading' state IS reachable here (rangeSelect/
    // sessionSelect start disabled and only re-enable once init()'s config
    // fetch settles -- see below -- which closes the common race, but this
    // branch does not rely on that alone): it gets its own neutral, visible
    // caption too, never a silent unshaded chart.
    if (retentionAvailability.status === 'loaded') {
      const config = retentionAvailability.config;
      const defs = svgEl('defs');
      const pattern = svgEl('pattern', {
        id: PAST_DEADLINE_PATTERN_ID,
        width: 8,
        height: 8,
        patternTransform: 'rotate(45)',
        patternUnits: 'userSpaceOnUse',
      });
      pattern.append(svgEl('rect', { width: 8, height: 8, fill: '#131722' }));
      pattern.append(svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: DISAGREE_COLOR, 'stroke-width': 2, opacity: 0.5 }));
      defs.append(pattern);
      svg.append(defs);

      const { deadlineMs, approachingStartMs } = retentionBoundaries(config, Date.now());
      const shadeTop = MARGIN.top;
      const shadeBottom = TOTAL_HEIGHT - 4;

      const pastDeadlineEnd = Math.min(to.getTime(), deadlineMs);
      if (pastDeadlineEnd > from.getTime()) {
        const x2 = xScale(pastDeadlineEnd, from, to);
        svg.append(
          svgEl('rect', { x: MARGIN.left, y: shadeTop, width: Math.max(0, x2 - MARGIN.left), height: shadeBottom - shadeTop, fill: `url(#${PAST_DEADLINE_PATTERN_ID})` }),
        );
        if (x2 - MARGIN.left > 60) {
          const label = svgEl('text', { x: MARGIN.left + 4, y: shadeTop + 12, fill: DISAGREE_COLOR, 'font-size': 10 });
          label.textContent = `past the ${formatRetentionDuration(config.retentionMaxAgeMs)} debug window — corrections here can no longer be preserved for training`;
          svg.append(label);
        }
      }

      const approachStart = Math.max(from.getTime(), deadlineMs);
      const approachEnd = Math.min(to.getTime(), approachingStartMs);
      if (approachEnd > approachStart) {
        const x1 = xScale(approachStart, from, to);
        const x2 = xScale(approachEnd, from, to);
        svg.append(svgEl('rect', { x: x1, y: shadeTop, width: Math.max(0, x2 - x1), height: shadeBottom - shadeTop, fill: '#f5c451', opacity: 0.12 }));
        if (x2 - x1 > 60) {
          const label = svgEl('text', { x: x1 + 4, y: shadeTop + 12, fill: '#f5c451', 'font-size': 10 });
          label.textContent = 'approaching the debug window edge';
          svg.append(label);
        }
      }
    } else if (retentionAvailability.status === 'failed') {
      const defs = svgEl('defs');
      const pattern = svgEl('pattern', {
        id: RETENTION_UNAVAILABLE_PATTERN_ID,
        width: 8,
        height: 8,
        patternTransform: 'rotate(45)',
        patternUnits: 'userSpaceOnUse',
      });
      pattern.append(svgEl('rect', { width: 8, height: 8, fill: '#131722' }));
      pattern.append(svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: '#93a0b8', 'stroke-width': 1, opacity: 0.5 }));
      defs.append(pattern);
      svg.append(defs);

      svg.append(
        svgEl('rect', {
          x: MARGIN.left,
          y: MARGIN.top,
          width: WIDTH - MARGIN.left - MARGIN.right,
          height: TOTAL_HEIGHT - MARGIN.top - 4,
          fill: `url(#${RETENTION_UNAVAILABLE_PATTERN_ID})`,
          opacity: 0.6,
        }),
      );
      const label = svgEl('text', { x: MARGIN.left + 4, y: MARGIN.top + 12, fill: '#93a0b8', 'font-size': 10 });
      label.textContent = 'retention overlay unavailable — GET /api/config failed, so past-deadline/approaching stretches cannot be shown';
      svg.append(label);
    } else {
      // retentionAvailability.status === 'loading' -- neutral and visible,
      // never silent: a bare unshaded chart here would be indistinguishable
      // from "loaded, plenty of headroom", exactly the bug this three-state
      // model exists to prevent.
      const label = svgEl('text', { x: MARGIN.left + 4, y: MARGIN.top + 12, fill: '#93a0b8', 'font-size': 10 });
      label.textContent = 'checking retention status…';
      svg.append(label);
    }

    // Y axis gridlines/labels at 0, 1, 2+.
    for (const [value, label] of [[0, '0'], [1, '1'], [2, '2+']] as const) {
      const y = yScale(value);
      svg.append(svgEl('line', { x1: MARGIN.left, x2: WIDTH - MARGIN.right, y1: y, y2: y, stroke: '#2a3142', 'stroke-width': 1 }));
      const text = svgEl('text', { x: MARGIN.left - 8, y: y + 4, fill: '#93a0b8', 'font-size': 11, 'text-anchor': 'end' });
      text.textContent = label;
      svg.append(text);
    }

    const segments = buildStepSegments(states, from.getTime(), to.getTime());

    let previous: StepSegment | null = null;
    for (const segment of segments) {
      const x1 = xScale(segment.startMs, from, to);
      const x2 = xScale(segment.endMs, from, to);
      const y = yScale(segment.row.estimate);
      const color = stateColor(segment.row.state);
      const gap = isUnobservedGap(segment);

      // Uncertainty band, held across the whole span: wider = lower confidence.
      const bandHalfHeight = (1 - segment.row.confidence) * 14;
      svg.append(
        svgEl('rect', {
          x: x1,
          y: y - bandHalfHeight,
          width: Math.max(1, x2 - x1),
          height: bandHalfHeight * 2 || 1,
          fill: color,
          opacity: gap ? 0.08 : 0.25,
        }),
      );

      // The held value itself. A span longer than the pipeline could have
      // left it while observing is drawn dashed and dim: that flat line means
      // "nobody was looking", not "nothing happened".
      const held = svgEl('line', {
        x1,
        x2,
        y1: y,
        y2: y,
        stroke: color,
        'stroke-width': 2,
        opacity: gap ? 0.35 : 1,
      });
      if (gap) held.setAttribute('stroke-dasharray', '6,4');
      const heldTitle = document.createElementNS(SVG_NS, 'title');
      heldTitle.textContent = `${segment.row.state} (estimate ${segment.row.estimate}, confidence ${Math.round(segment.row.confidence * 100)}%) from ${formatTimestamp(segment.row.time)} [${segment.row.kind}]`;
      held.append(heldTitle);
      svg.append(held);

      if (gap) {
        const note = svgEl('text', { x: (x1 + x2) / 2, y: y - 8, fill: '#93a0b8', 'font-size': 10, 'text-anchor': 'middle' });
        note.textContent = 'no observations';
        svg.append(note);
      }

      // Vertical riser connecting the previous held value to this one — the
      // step itself. The carry-in is clamped to the left edge and has no
      // riser, because nothing preceded it on screen.
      if (previous) {
        const previousY = yScale(previous.row.estimate);
        svg.append(svgEl('line', { x1, x2: x1, y1: previousY, y2: y, stroke: color, 'stroke-width': 2 }));
        if (previous.row.state !== segment.row.state) {
          svg.append(svgEl('line', { x1, x2: x1, y1: MARGIN.top, y2: HEIGHT - MARGIN.bottom, stroke: color, 'stroke-width': 1, 'stroke-dasharray': '3,3', opacity: 0.6 }));
          const label = svgEl('text', { x: x1 + 3, y: MARGIN.top + 10, fill: color, 'font-size': 10 });
          label.textContent = segment.row.state;
          svg.append(label);
        }
      }

      // Event marker, with the row kind visible: a transition is a filled
      // dot, a keepalive a small hollow one ("nothing changed, still watching").
      const eventMs = Date.parse(segment.row.time);
      if (eventMs >= from.getTime()) {
        const markerX = xScale(eventMs, from, to);
        svg.append(
          segment.row.kind === 'keepalive'
            ? svgEl('circle', { cx: markerX, cy: y, r: 2, fill: 'none', stroke: color, 'stroke-width': 1 })
            : svgEl('circle', { cx: markerX, cy: y, r: 3, fill: color }),
        );
      }

      previous = segment;
    }

    // Carry-in annotation: the first segment starts at the left edge, but its
    // event is older than the window — say when it actually happened.
    const first = segments[0];
    if (first && Date.parse(first.row.time) < from.getTime()) {
      const label = svgEl('text', { x: MARGIN.left + 3, y: HEIGHT - MARGIN.bottom - 6, fill: '#93a0b8', 'font-size': 10 });
      label.textContent = `carried in from ${formatTimestamp(first.row.time)}`;
      svg.append(label);
    }

    // X axis labels (start/end) for the step chart itself.
    const startLabel = svgEl('text', { x: MARGIN.left, y: HEIGHT - 8, fill: '#93a0b8', 'font-size': 11 });
    startLabel.textContent = formatTimestamp(from.toISOString());
    const endLabel = svgEl('text', { x: WIDTH - MARGIN.right, y: HEIGHT - 8, fill: '#93a0b8', 'font-size': 11, 'text-anchor': 'end' });
    endLabel.textContent = formatTimestamp(to.toISOString());
    svg.append(startLabel, endLabel);

    // Ground-truth label lane: each label from GET /api/labels?from&to drawn
    // as a span [time, endTime) under the prediction, or as a marker with NO
    // fabricated width when endTime is null (a point label). Disagreement
    // with the system's own estimate at the same instant (findLabelDisagreements)
    // is highlighted with a red outline — that comparison is the entire point
    // of overlaying labels on the prediction, not a side detail.
    const laneMidY = LABEL_LANE_TOP + LABEL_LANE_HEIGHT / 2;
    svg.append(svgEl('line', { x1: MARGIN.left, x2: WIDTH - MARGIN.right, y1: laneMidY, y2: laneMidY, stroke: '#2a3142', 'stroke-width': 1 }));
    const laneCaption = svgEl('text', { x: MARGIN.left, y: LABEL_LANE_TOP - 4, fill: '#93a0b8', 'font-size': 10 });
    laneCaption.textContent = 'ground-truth labels';
    svg.append(laneCaption);

    const labelIntervals = labels.map((l) => labelToMsInterval(l));
    const disagreements: LabelDisagreement[] = findLabelDisagreements(labelIntervals, segments);
    const disagreeingLabelIds = new Set(disagreements.map((d) => d.labelId));

    for (const raw of labels) {
      const interval = labelToMsInterval(raw);
      const color = sourceColor(interval.source);
      const disagrees = disagreeingLabelIds.has(interval.id);

      if (interval.toMs === null) {
        if (interval.fromMs < from.getTime() || interval.fromMs > to.getTime()) continue;
        const x = xScale(interval.fromMs, from, to);
        const marker = svgEl('circle', {
          cx: x,
          cy: laneMidY,
          r: 5,
          fill: color,
          stroke: disagrees ? DISAGREE_COLOR : 'none',
          'stroke-width': disagrees ? 2 : 0,
        });
        const title = document.createElementNS(SVG_NS, 'title');
        title.textContent =
          `${interval.source} label: ${occupancyLabelText(interval.occupancyCount)} at ${formatTimestamp(raw.time)}` +
          (disagrees ? ' — DISAGREES with the system estimate at this instant' : '') +
          (raw.notes ? ` — ${raw.notes}` : '');
        marker.append(title);
        svg.append(marker);
        continue;
      }

      const clamped = clampInterval(interval.fromMs, interval.toMs, from.getTime(), to.getTime());
      if (!clamped) continue;
      const x1 = xScale(clamped.fromMs, from, to);
      const x2 = xScale(clamped.toMs, from, to);
      const span = svgEl('rect', {
        x: x1,
        y: LABEL_LANE_TOP + 4,
        width: Math.max(1, x2 - x1),
        height: LABEL_LANE_HEIGHT - 8,
        fill: color,
        opacity: disagrees ? 0.85 : 0.5,
        stroke: disagrees ? DISAGREE_COLOR : 'none',
        'stroke-width': disagrees ? 2 : 0,
      });
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent =
        `${interval.source} label: ${occupancyLabelText(interval.occupancyCount)} from ${formatTimestamp(raw.time)} to ${raw.endTime ? formatTimestamp(raw.endTime) : '?'}` +
        (disagrees ? ' — DISAGREES with the system estimate over part of this span' : '') +
        (raw.notes ? ` — ${raw.notes}` : '');
      span.append(title);
      svg.append(span);
    }

    // Drag-to-select overlay, drawn last (on top of everything else). Click
    // without dragging clears the selection; dragging sets it. The two
    // `datetime-local` inputs in the panel below are the keyboard-reachable
    // equivalent of this drag and stay in sync with it via `applySelection`.
    const selectionRect = svgEl('rect', {
      x: MARGIN.left,
      y: MARGIN.top,
      width: 0,
      height: TOTAL_HEIGHT - MARGIN.top - 4,
      fill: '#5dc8fa',
      opacity: 0.18,
      visibility: 'hidden',
    });
    const selectionLabel = svgEl('text', { x: MARGIN.left, y: MARGIN.top - 4, fill: '#5dc8fa', 'font-size': 10, visibility: 'hidden' });
    svg.append(selectionRect, selectionLabel);

    function applySelection(sel: Selection | null): void {
      if (!sel) {
        selectionRect.setAttribute('visibility', 'hidden');
        selectionLabel.setAttribute('visibility', 'hidden');
        return;
      }
      const clamped = clampInterval(sel.fromMs, sel.toMs, from.getTime(), to.getTime());
      if (!clamped) {
        selectionRect.setAttribute('visibility', 'hidden');
        selectionLabel.setAttribute('visibility', 'hidden');
        return;
      }
      const x1 = xScale(clamped.fromMs, from, to);
      const x2 = xScale(clamped.toMs, from, to);
      selectionRect.setAttribute('x', String(x1));
      selectionRect.setAttribute('width', String(Math.max(1, x2 - x1)));
      selectionRect.setAttribute('visibility', 'visible');
      selectionLabel.textContent = `${formatTimestamp(new Date(sel.fromMs).toISOString())} → ${formatTimestamp(new Date(sel.toMs).toISOString())} (${formatDuration(sel.toMs - sel.fromMs)})`;
      selectionLabel.setAttribute('x', String(x1));
      selectionLabel.setAttribute('visibility', 'visible');
    }

    let dragAnchorClientX: number | null = null;
    let dragAnchorMs = 0;
    let dragMoved = false;
    const DRAG_THRESHOLD_PX = 3;

    svg.addEventListener('pointerdown', (ev) => {
      const pe = ev as PointerEvent;
      svg.setPointerCapture(pe.pointerId);
      dragAnchorClientX = pe.clientX;
      dragAnchorMs = timeFromClientX(svg, pe.clientX, from, to);
      dragMoved = false;
      setSelection({ fromMs: dragAnchorMs, toMs: dragAnchorMs });
    });
    svg.addEventListener('pointermove', (ev) => {
      if (dragAnchorClientX === null) return;
      const pe = ev as PointerEvent;
      if (Math.abs(pe.clientX - dragAnchorClientX) > DRAG_THRESHOLD_PX) dragMoved = true;
      const currentMs = timeFromClientX(svg, pe.clientX, from, to);
      setSelection(orderSelection(dragAnchorMs, currentMs));
    });
    svg.addEventListener('pointerup', (ev) => {
      const pe = ev as PointerEvent;
      svg.releasePointerCapture(pe.pointerId);
      if (!dragMoved) setSelection(null);
      dragAnchorClientX = null;
    });

    const wrap = h('div', {});
    wrap.append(svg);
    return { el: wrap, applySelection, segments };
  }

  /** "OCCUPIED since 09:14 (3h 12m)" — the step-semantics readout a timeline alone cannot give. */
  function currentStateCaption(states: OccupancyRow[]): HTMLElement {
    const latest = states[states.length - 1] as OccupancyRow;
    const startMs = currentRunStartMs(states);
    const since =
      startMs === null
        ? '—'
        : `${formatTimestamp(new Date(startMs).toISOString())} (${formatDuration(Date.now() - startMs)})`;
    return h(
      'p',
      { class: 'sub' },
      `Current: ${latest.state} — estimate ${occupancyLabelText(latest.estimate)}, confidence ${Math.round(latest.confidence * 100)}% as recorded at ${formatTimestamp(latest.time)}. In this state since ${since}.`,
    );
  }

  function legend(): HTMLElement {
    return h(
      'p',
      { class: 'sub' },
      'occupancy_states is a sparse event log: one row per transition plus a keepalive every 15 minutes of tick time, never one row per window. Horizontal line: the estimate, held until the next event (step / last-value-carried-forward, never interpolated). Shaded band: uncertainty, wider = lower confidence. Filled dot: a transition. Hollow dot: a keepalive ("nothing changed, and the pipeline was watching"). Dimmed dashed span labelled "no observations": a stretch longer than a keepalive interval with no row at all, meaning the pipeline was not observing — not that the house was quiet. Dashed vertical markers: state transitions, labelled with the new state. Hatched red band: past the retention debug window — corrections there can no longer preserve raw features. Softer yellow band: approaching that edge. Faint grey hatch across the whole chart: retention status is unknown (GET /api/config failed) — this is deliberately NOT the same as a clean, unshaded chart, because "unknown" must never read as "safe". Below the chart: the ground-truth label lane — spans for interval labels, dots for point labels (never given a fabricated width), colored by source (manual/confirmed/weak/training), outlined in red where a label disagrees with the system\'s own estimate at that instant. Drag across the chart to select a stretch for the correction panel below.',
    );
  }

  rangeSelect.addEventListener('change', () => void load());
  sessionSelect.addEventListener('change', () => void load());

  // rangeSelect/sessionSelect start `disabled` (see their creation above) so
  // a `change` event -- and therefore `load()` -- cannot fire before
  // `retentionAvailability` has left the loading state below. `loadSessions`
  // and `loadConfig` both catch their own errors internally, so
  // `Promise.all` here always resolves: the selects are re-enabled on BOTH
  // the success and the failure path of the config fetch, never left
  // disabled forever just because a fetch failed.
  async function init(): Promise<void> {
    await Promise.all([loadSessions(), loadConfig()]);
    if (disposed) return;
    rangeSelect.disabled = false;
    sessionSelect.disabled = false;
    await load();
  }

  void init();

  return () => {
    disposed = true;
  };
}
