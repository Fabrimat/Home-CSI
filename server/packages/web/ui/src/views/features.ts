import { apiGet, ApiError } from '../api.js';
import { clear, formatTimestamp, h } from '../dom.js';
import { emptyState, errorState, loadingState } from '../components/asyncState.js';

interface LinkSummary {
  nodeId: number;
  srcMac: string;
  dstMac: string;
  recordCount: number;
  lastSeenAt: string;
}

interface FeatureRow {
  time: string;
  nodeId: number;
  linkMac: string | null;
  windowMs: number;
  featureVector: Record<string, unknown>;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_WIDTH = 460;
const CHART_HEIGHT = 140;
const MARGIN = { top: 10, right: 10, bottom: 20, left: 44 };
const RANGE_MS = 30 * 60 * 1000;

const BASELINE_SUFFIX_RE = /[_-]?baseline$/i;

function svgEl(name: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, name) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Flattens one level of nested objects into dot-notation keys, keeping only numeric leaves. */
function flattenNumeric(vector: Record<string, unknown>, prefix = ''): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(vector)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[path] = value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenNumeric(value as Record<string, unknown>, path));
    }
  }
  return out;
}

interface Series {
  baseKey: string;
  valuePoints: Array<{ time: string; value: number }>;
  baselinePoints: Array<{ time: string; value: number }>;
}

function buildSeries(rows: FeatureRow[]): Series[] {
  const byKey = new Map<string, Array<{ time: string; value: number }>>();
  for (const row of rows) {
    const flat = flattenNumeric(row.featureVector);
    for (const [key, value] of Object.entries(flat)) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push({ time: row.time, value });
    }
  }

  const series = new Map<string, Series>();
  for (const [key, points] of byKey) {
    const isBaseline = BASELINE_SUFFIX_RE.test(key);
    const baseKey = isBaseline ? key.replace(BASELINE_SUFFIX_RE, '') : key;
    if (!series.has(baseKey)) series.set(baseKey, { baseKey, valuePoints: [], baselinePoints: [] });
    const s = series.get(baseKey)!;
    if (isBaseline) s.baselinePoints = points;
    else s.valuePoints = points;
  }
  return [...series.values()].filter((s) => s.valuePoints.length > 0 || s.baselinePoints.length > 0);
}

function renderSeriesChart(series: Series, from: Date, to: Date): HTMLElement {
  const allValues = [...series.valuePoints, ...series.baselinePoints].map((p) => p.value);
  const lo = Math.min(...allValues);
  const hi = Math.max(...allValues);
  const span = hi - lo || 1;

  const x = (t: string): number => {
    const spanMs = to.getTime() - from.getTime() || 1;
    return MARGIN.left + ((new Date(t).getTime() - from.getTime()) / spanMs) * (CHART_WIDTH - MARGIN.left - MARGIN.right);
  };
  const y = (v: number): number => {
    const usable = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
    return MARGIN.top + usable - ((v - lo) / span) * usable;
  };

  const svg = svgEl('svg', { viewBox: `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`, width: CHART_WIDTH, height: CHART_HEIGHT, role: 'img', 'aria-label': `${series.baseKey} over time` });

  for (const [frac, label] of [[0, hi], [1, lo]] as const) {
    const yy = MARGIN.top + frac * (CHART_HEIGHT - MARGIN.top - MARGIN.bottom);
    const text = svgEl('text', { x: MARGIN.left - 6, y: yy + 3, fill: '#93a0b8', 'font-size': 9, 'text-anchor': 'end' });
    text.textContent = (label as number).toFixed(2);
    svg.append(text);
  }

  function path(points: Array<{ time: string; value: number }>): string {
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.time)} ${y(p.value)}`).join(' ');
  }

  if (series.baselinePoints.length > 0) {
    svg.append(svgEl('path', { d: path(series.baselinePoints), fill: 'none', stroke: '#f5c451', 'stroke-width': 1.5, 'stroke-dasharray': '4,3' }));
  }
  if (series.valuePoints.length > 0) {
    svg.append(svgEl('path', { d: path(series.valuePoints), fill: 'none', stroke: '#5dc8fa', 'stroke-width': 1.5 }));
  }

  const wrap = h('div', { class: 'panel' });
  wrap.append(
    h('h2', {}, series.baseKey),
    svg,
    series.baselinePoints.length > 0
      ? h('div', { class: 'sub' }, 'solid: live value · dashed (amber): adaptive baseline — divergence between the two is what "the baseline drifted" looks like')
      : h('div', { class: 'sub' }, 'no matching baseline field for this feature'),
  );
  return wrap;
}

export function renderFeatures(container: HTMLElement): () => void {
  let disposed = false;
  const root = h('div', { class: 'view-scroll' });
  container.append(root);

  const linkSelect = h('select', { 'aria-label': 'Link' }) as HTMLSelectElement;
  const chartArea = h('div', { class: 'grid' });
  root.append(h('div', { class: 'controls' }, h('label', {}, 'Link', linkSelect)), chartArea);
  chartArea.append(loadingState('Loading available links…'));

  let links: LinkSummary[] = [];

  function linkKey(l: LinkSummary): string {
    return `${l.nodeId}:${l.srcMac}`;
  }

  async function load(): Promise<void> {
    const selected = links.find((l) => linkKey(l) === linkSelect.value);
    clear(chartArea);
    if (!selected) {
      chartArea.append(emptyState('Select a link above to inspect its feature vector.'));
      return;
    }

    const to = new Date();
    const from = new Date(to.getTime() - RANGE_MS);
    let rows: FeatureRow[];
    try {
      const res = await apiGet<{ features: FeatureRow[] }>(
        `/api/features?nodeId=${selected.nodeId}&linkMac=${encodeURIComponent(selected.srcMac)}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&maxPoints=500`,
      );
      rows = res.features;
    } catch (err) {
      chartArea.append(errorState(err instanceof ApiError ? err.message : String(err)));
      return;
    }

    if (disposed) return;
    if (rows.length === 0) {
      chartArea.append(
        emptyState(
          'No features rows for this link/window — the feature pipeline (brief B4) has not produced output yet, or this link genuinely has no recent data. Honest empty state, not a placeholder chart.',
        ),
      );
      return;
    }

    const series = buildSeries(rows);
    if (series.length === 0) {
      chartArea.append(
        h('div', {}, h('p', { class: 'sub' }, `${rows.length} feature rows found, but none had a recognizable numeric field. Showing the latest raw vector:`), h('pre', {}, JSON.stringify(rows[rows.length - 1]?.featureVector, null, 2))),
      );
      return;
    }
    for (const s of series) chartArea.append(renderSeriesChart(s, from, to));
    chartArea.append(h('p', { class: 'sub' }, `${rows.length} feature windows over the last ${Math.round(RANGE_MS / 60000)} minutes, last sample at ${formatTimestamp(rows[rows.length - 1]!.time)}.`));
  }

  async function loadLinks(): Promise<void> {
    try {
      const res = await apiGet<{ links: LinkSummary[] }>('/api/links?sinceMs=3600000&limit=500');
      links = res.links;
    } catch (err) {
      if (disposed) return;
      clear(chartArea);
      chartArea.append(errorState(err instanceof ApiError ? err.message : String(err)));
      return;
    }
    if (disposed) return;
    clear(linkSelect);
    if (links.length === 0) {
      linkSelect.append(h('option', { value: '' }, 'no links observed recently'));
    } else {
      linkSelect.append(h('option', { value: '' }, 'select a link…'), ...links.map((l) => h('option', { value: linkKey(l) }, `node ${l.nodeId}: ${l.srcMac}`)));
    }
    // Either branch leaves chartArea showing the "Loading available links…"
    // placeholder from mount time until this runs -- replace it with the
    // real prompt (or the empty-links message) rather than leaving a stale
    // loading state up once links.length > 0 and no link is selected yet.
    void load();
  }

  linkSelect.addEventListener('change', () => void load());
  void loadLinks();

  return () => {
    disposed = true;
  };
}
