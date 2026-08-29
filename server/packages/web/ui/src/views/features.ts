import { apiGet, ApiError } from '../api.js';
import { clear, formatTimestamp, h } from '../dom.js';
import { emptyState, errorState, loadingState } from '../components/asyncState.js';
import { describeDomain, seriesDomain, type TimeDomain } from '../featureScale.js';
import {
  EMPTY_NODE_DIRECTORY,
  linkOptionText,
  loadNodeDirectory,
  sortByRecency,
  type NodeDirectory,
} from '../nodeNames.js';

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
const MARGIN = { top: 10, right: 10, bottom: 26, left: 44 };
const RANGE_MS = 30 * 60 * 1000;

/**
 * How often the charts re-fetch while Live is on. The feature pipeline runs
 * on a 60s loop (`pipeline` service, ops/docker-compose*.yml), so anything
 * much faster than this just re-reads the same rows; anything slower makes
 * the view feel dead during bring-up, which is when it is watched most.
 * There is no `features` WebSocket channel to subscribe to (ws.ts carries
 * csi/occupancy/heartbeat only), so polling is the honest mechanism here.
 */
const REFRESH_MS = 15_000;
/** The link list changes far more slowly than the data on one link. */
const LINK_REFRESH_MS = 60_000;

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

function renderSeriesChart(series: Series, domain: TimeDomain): HTMLElement {
  const allValues = [...series.valuePoints, ...series.baselinePoints].map((p) => p.value);
  const lo = Math.min(...allValues);
  const hi = Math.max(...allValues);
  const span = hi - lo || 1;

  const x = (t: string): number => {
    const spanMs = domain.toMs - domain.fromMs || 1;
    return (
      MARGIN.left + ((new Date(t).getTime() - domain.fromMs) / spanMs) * (CHART_WIDTH - MARGIN.left - MARGIN.right)
    );
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

  // X axis endpoints. The domain is fitted to the data (see featureScale.ts),
  // so without these two labels the reader has no way to tell whether they
  // are looking at thirty seconds or thirty minutes.
  const axisY = CHART_HEIGHT - MARGIN.bottom + 12;
  const timeText = (ms: number): string =>
    new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const startLabel = svgEl('text', { x: MARGIN.left, y: axisY, fill: '#93a0b8', 'font-size': 9, 'text-anchor': 'start' });
  startLabel.textContent = timeText(domain.fromMs);
  const endLabel = svgEl('text', { x: CHART_WIDTH - MARGIN.right, y: axisY, fill: '#93a0b8', 'font-size': 9, 'text-anchor': 'end' });
  endLabel.textContent = timeText(domain.toMs);
  svg.append(startLabel, endLabel);

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
  const liveToggle = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const status = h('span', { class: 'sub' }, '');
  const chartArea = h('div', { class: 'grid' });
  root.append(
    h(
      'div',
      { class: 'controls' },
      h('label', {}, 'Link', linkSelect),
      h('label', {}, h('span', {}, 'Live'), liveToggle),
      status,
    ),
    chartArea,
  );
  chartArea.append(loadingState('Loading available links…'));

  let links: LinkSummary[] = [];
  let directory: NodeDirectory = EMPTY_NODE_DIRECTORY;
  let dataTimer: ReturnType<typeof setInterval> | null = null;
  let linkTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Signature of what is currently drawn. A poll that returns the same rows
   * must not rebuild the DOM: it would flicker every 15s and reset the
   * scroll position of a long feature list for no gain.
   */
  let renderedSignature = '';

  function linkKey(l: LinkSummary): string {
    return `${l.nodeId}:${l.srcMac}`;
  }

  async function load(): Promise<void> {
    const selected = links.find((l) => linkKey(l) === linkSelect.value);
    if (!selected) {
      renderedSignature = '';
      clear(chartArea);
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
      if (disposed) return;
      renderedSignature = '';
      clear(chartArea);
      chartArea.append(errorState(err instanceof ApiError ? err.message : String(err)));
      return;
    }

    if (disposed) return;

    const signature = `${linkSelect.value}|${rows.length}|${rows[rows.length - 1]?.time ?? ''}`;
    if (signature === renderedSignature) {
      // Same data as last time. Only the "last updated" clock moves.
      status.textContent = `checked ${new Date().toLocaleTimeString()} · no new windows`;
      return;
    }
    renderedSignature = signature;

    clear(chartArea);
    if (rows.length === 0) {
      chartArea.append(
        emptyState(
          'No features rows for this link/window — the feature pipeline has not produced output for it yet, or this link genuinely has no recent data. Honest empty state, not a placeholder chart.',
        ),
      );
      status.textContent = `checked ${new Date().toLocaleTimeString()}`;
      return;
    }

    const series = buildSeries(rows);
    if (series.length === 0) {
      chartArea.append(
        h('div', {}, h('p', { class: 'sub' }, `${rows.length} feature rows found, but none had a recognizable numeric field. Showing the latest raw vector:`), h('pre', {}, JSON.stringify(rows[rows.length - 1]?.featureVector, null, 2))),
      );
      return;
    }

    // Fitted to the rows that came back, NOT to the 30-minute window they
    // were requested over -- see featureScale.ts for why.
    const domain = seriesDomain(rows, to.getTime());
    for (const s of series) chartArea.append(renderSeriesChart(s, domain));
    chartArea.append(
      h(
        'p',
        { class: 'sub' },
        `${rows.length} feature windows on screen, x axis fitted to the data: ${describeDomain(domain)}. Requested window was the last ${Math.round(RANGE_MS / 60000)} minutes; last sample at ${formatTimestamp(rows[rows.length - 1]!.time)}.`,
      ),
    );
    status.textContent = `updated ${new Date().toLocaleTimeString()}`;
  }

  /** Rebuilds the picker, preserving the current choice, ordered most-recently-heard first. */
  function renderLinkOptions(): void {
    const previous = linkSelect.value;
    clear(linkSelect);
    if (links.length === 0) {
      linkSelect.append(h('option', { value: '' }, 'no links observed recently'));
      return;
    }
    linkSelect.append(
      h('option', { value: '' }, 'select a link…'),
      ...links.map((l) => h('option', { value: linkKey(l) }, linkOptionText(directory, l, false))),
    );
    // Only restore a selection that still exists; otherwise the picker would
    // show a value the option list no longer contains.
    if (previous && links.some((l) => linkKey(l) === previous)) linkSelect.value = previous;
  }

  async function loadLinks(initial: boolean): Promise<void> {
    try {
      const res = await apiGet<{ links: LinkSummary[] }>('/api/links?sinceMs=3600000&limit=500');
      links = sortByRecency(res.links);
    } catch (err) {
      if (disposed || !initial) return;
      clear(chartArea);
      chartArea.append(errorState(err instanceof ApiError ? err.message : String(err)));
      return;
    }
    if (disposed) return;
    renderLinkOptions();
    if (initial) void load();
  }

  function startPolling(): void {
    stopPolling();
    dataTimer = setInterval(() => void load(), REFRESH_MS);
    linkTimer = setInterval(() => void loadLinks(false), LINK_REFRESH_MS);
  }

  function stopPolling(): void {
    if (dataTimer) clearInterval(dataTimer);
    if (linkTimer) clearInterval(linkTimer);
    dataTimer = null;
    linkTimer = null;
  }

  linkSelect.addEventListener('change', () => {
    // Force a redraw even if the new link happens to produce the same row
    // count as the old one.
    renderedSignature = '';
    void load();
  });

  liveToggle.addEventListener('change', () => {
    if (liveToggle.checked) {
      startPolling();
      void load();
    } else {
      stopPolling();
      status.textContent = 'live off';
    }
  });

  void (async (): Promise<void> => {
    directory = await loadNodeDirectory();
    if (disposed) return;
    await loadLinks(true);
    if (disposed) return;
    if (liveToggle.checked) startPolling();
  })();

  return () => {
    disposed = true;
    stopPolling();
  };
}
