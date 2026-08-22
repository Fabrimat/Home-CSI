import { apiGet, ApiError } from '../api.js';
import { clear, emptyState, errorState, formatTimestamp, h } from '../dom.js';

interface OccupancyRow {
  time: string;
  estimate: number;
  confidence: number;
  state: string;
  details: Record<string, unknown> | null;
}

interface LabelSessionRow {
  id: number;
  startedAt: string;
  endedAt: string | null;
  notes: string | null;
}

interface LabelRow {
  id: number;
  sessionId: number;
  time: string;
  occupancyCount: number;
  notes: string | null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const WIDTH = 1000;
const HEIGHT = 320;
const MARGIN = { top: 16, right: 16, bottom: 30, left: 40 };

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

function stateColor(state: string): string {
  return STATE_COLORS[state] ?? '#5dc8fa';
}

function svgEl(name: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, name) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export function renderOccupancy(container: HTMLElement): () => void {
  let disposed = false;
  const root = h('div', { class: 'view-scroll' });
  container.append(root);

  const rangeSelect = h('select', { 'aria-label': 'Time range' }) as HTMLSelectElement;
  for (const preset of RANGE_PRESETS) rangeSelect.append(h('option', { value: String(preset.ms) }, `last ${preset.label}`));
  rangeSelect.value = String(RANGE_PRESETS[2]!.ms);

  const sessionSelect = h('select', { 'aria-label': 'Ground-truth session overlay' }) as HTMLSelectElement;
  sessionSelect.append(h('option', { value: '' }, 'no ground-truth overlay'));

  const chartArea = h('div', { class: 'panel' });

  root.append(
    h('div', { class: 'controls' }, h('label', {}, 'Range', rangeSelect), h('label', {}, 'Ground truth', sessionSelect)),
    chartArea,
  );

  async function loadSessions(): Promise<void> {
    try {
      const res = await apiGet<{ sessions: LabelSessionRow[] }>('/api/labels/sessions?limit=100');
      if (disposed) return;
      for (const s of res.sessions) {
        sessionSelect.append(h('option', { value: String(s.id) }, `#${s.id} — ${formatTimestamp(s.startedAt)}${s.notes ? ` (${s.notes})` : ''}`));
      }
    } catch {
      // Non-fatal: the timeline still works without the ground-truth picker populated.
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

    let labels: LabelRow[] = [];
    if (sessionSelect.value) {
      try {
        const res = await apiGet<{ labels: LabelRow[] }>(`/api/labels/sessions/${sessionSelect.value}/labels?limit=5000`);
        labels = res.labels.filter((l) => new Date(l.time) >= from && new Date(l.time) <= to);
      } catch {
        // Non-fatal: render the prediction without the overlay rather than failing the whole view.
      }
    }

    if (disposed) return;
    clear(chartArea);
    chartArea.append(h('h2', {}, 'Occupancy timeline'));

    if (states.length === 0) {
      chartArea.append(
        emptyState(
          'No occupancy_states rows in this window — the occupancy pipeline (brief B4) has not produced an estimate yet, or the range is before it started. This is an honest empty state.',
        ),
      );
      return;
    }

    chartArea.append(renderChart(states, labels, from, to));
    chartArea.append(legend());
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

  function renderChart(states: OccupancyRow[], labels: LabelRow[], from: Date, to: Date): HTMLElement {
    const svg = svgEl('svg', { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, width: WIDTH, height: HEIGHT, role: 'img', 'aria-label': 'Occupancy estimate over time' });

    // Y axis gridlines/labels at 0, 1, 2+.
    for (const [value, label] of [[0, '0'], [1, '1'], [2, '2+']] as const) {
      const y = yScale(value);
      svg.append(svgEl('line', { x1: MARGIN.left, x2: WIDTH - MARGIN.right, y1: y, y2: y, stroke: '#2a3142', 'stroke-width': 1 }));
      const text = svgEl('text', { x: MARGIN.left - 8, y: y + 4, fill: '#93a0b8', 'font-size': 11, 'text-anchor': 'end' });
      text.textContent = label;
      svg.append(text);
    }

    // Confidence band + step line, coloured per internal state, with vertical dashed markers at transitions.
    let prevState: string | null = null;
    for (let i = 0; i < states.length; i++) {
      const row = states[i] as OccupancyRow;
      const x = xScale(new Date(row.time).getTime(), from, to);
      const y = yScale(row.estimate);
      const bandHalfHeight = (1 - row.confidence) * 14; // lower confidence -> taller uncertainty band

      svg.append(
        svgEl('rect', {
          x: x - 1.5,
          y: y - bandHalfHeight,
          width: 3,
          height: bandHalfHeight * 2 || 1,
          fill: stateColor(row.state),
          opacity: 0.25,
        }),
      );
      svg.append(svgEl('circle', { cx: x, cy: y, r: 2.5, fill: stateColor(row.state) }));

      if (prevState !== null && row.state !== prevState) {
        svg.append(svgEl('line', { x1: x, x2: x, y1: MARGIN.top, y2: HEIGHT - MARGIN.bottom, stroke: stateColor(row.state), 'stroke-width': 1, 'stroke-dasharray': '3,3', opacity: 0.6 }));
        const label = svgEl('text', { x: x + 3, y: MARGIN.top + 10, fill: stateColor(row.state), 'font-size': 10 });
        label.textContent = row.state;
        svg.append(label);
      }
      prevState = row.state;
    }

    // Connect the estimate as a step line.
    let path = '';
    for (let i = 0; i < states.length; i++) {
      const row = states[i] as OccupancyRow;
      const x = xScale(new Date(row.time).getTime(), from, to);
      const y = yScale(row.estimate);
      path += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
    }
    svg.append(svgEl('path', { d: path, fill: 'none', stroke: '#5dc8fa', 'stroke-width': 1.5, opacity: 0.7 }));

    // Ground-truth label overlay: diamonds at the labelled occupancy count.
    for (const label of labels) {
      const x = xScale(new Date(label.time).getTime(), from, to);
      const y = yScale(label.occupancyCount);
      const diamond = svgEl('rect', { x: x - 4, y: y - 4, width: 8, height: 8, transform: `rotate(45 ${x} ${y})`, fill: 'none', stroke: '#e6e9f0', 'stroke-width': 1.5 });
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = `ground truth: ${label.occupancyCount} at ${formatTimestamp(label.time)}${label.notes ? ` — ${label.notes}` : ''}`;
      diamond.append(title);
      svg.append(diamond);
    }

    // X axis labels (start/end).
    const startLabel = svgEl('text', { x: MARGIN.left, y: HEIGHT - 8, fill: '#93a0b8', 'font-size': 11 });
    startLabel.textContent = formatTimestamp(from.toISOString());
    const endLabel = svgEl('text', { x: WIDTH - MARGIN.right, y: HEIGHT - 8, fill: '#93a0b8', 'font-size': 11, 'text-anchor': 'end' });
    endLabel.textContent = formatTimestamp(to.toISOString());
    svg.append(startLabel, endLabel);

    const wrap = h('div', {});
    wrap.append(svg);
    return wrap;
  }

  function legend(): HTMLElement {
    return h(
      'p',
      { class: 'sub' },
      'Line: occupancy estimate (step). Shaded band around each point: uncertainty band, wider = lower confidence. Dashed vertical markers: latch state transitions, labelled with the new state. Diamonds: ground-truth labels from the selected recording session, for visual comparison against the prediction.',
    );
  }

  rangeSelect.addEventListener('change', () => void load());
  sessionSelect.addEventListener('change', () => void load());

  void loadSessions();
  void load();

  return () => {
    disposed = true;
  };
}
