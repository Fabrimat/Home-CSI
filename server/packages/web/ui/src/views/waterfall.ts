import { apiGet, ApiError } from '../api.js';
import { clear, h } from '../dom.js';
import { emptyState, errorState, loadingState } from '../components/asyncState.js';
import { viridis } from '../colormap.js';
import { liveSocket, type LiveDataMessage } from '../ws.js';
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

interface CsiPoint {
  time: string;
  rssi: number;
  noiseFloor: number;
  csiFormat: number;
  amplitudes: number[];
}

const MAX_COLUMNS = 400;
/**
 * How often the link picker is rebuilt. Only the list refreshes on this
 * timer -- the selected link's own data arrives over the WebSocket, so this
 * is purely "has a node started (or stopped) transmitting since I opened
 * this page", which moves on the scale of node reboots, not packets.
 */
const LINK_REFRESH_MS = 60_000;
const HISTORY_WINDOW_MS = 2 * 60 * 1000;
const DISPLAY_WIDTH = 900;
const DISPLAY_HEIGHT = 320;

function linkKey(l: LinkSummary): string {
  return `${l.nodeId}:${l.srcMac}:${l.dstMac}`;
}

/** 5th/95th percentile clip so a single outlier reading doesn't wash out the whole colour range. */
function robustRange(columns: CsiPoint[]): [number, number] {
  const values: number[] = [];
  for (const col of columns) {
    for (const v of col.amplitudes) values.push(v);
  }
  if (values.length === 0) return [0, 1];
  values.sort((a, b) => a - b);
  const lo = values[Math.floor(values.length * 0.05)] ?? values[0] ?? 0;
  const hi = values[Math.ceil(values.length * 0.95) - 1] ?? values[values.length - 1] ?? 1;
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

export function renderWaterfall(container: HTMLElement): () => void {
  let disposed = false;
  const root = h('div', { class: 'view-scroll' });
  container.append(root);

  const linkSelect = h('select', { 'aria-label': 'Link' }) as HTMLSelectElement;
  const liveToggle = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const status = h('span', { class: 'sub' }, '');
  const canvas = h('canvas', { width: String(DISPLAY_WIDTH), height: String(DISPLAY_HEIGHT) }) as HTMLCanvasElement;
  const legendCanvas = h('canvas', { width: '20', height: '220' }) as HTMLCanvasElement;
  const legendMax = h('div', {}, '');
  const legendMin = h('div', {}, '');
  const chartArea = h('div', { class: 'panel' });

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
  let linkTimer: ReturnType<typeof setInterval> | null = null;
  let columns: CsiPoint[] = [];
  let unsubscribeLive: (() => void) | null = null;
  let unsubscribeData: (() => void) | null = null;

  function drawLegend(lo: number, hi: number): void {
    const ctx = legendCanvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = legendCanvas;
    const img = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      const t = 1 - y / (height - 1);
      const [r, g, b] = viridis(t);
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        img.data[idx] = r;
        img.data[idx + 1] = g;
        img.data[idx + 2] = b;
        img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    legendMax.textContent = hi.toFixed(1);
    legendMin.textContent = lo.toFixed(1);
  }

  function draw(): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (columns.length === 0) return;

    // Subcarrier count is derived per-frame from the data itself, never assumed.
    const numRows = columns.reduce((max, c) => Math.max(max, c.amplitudes.length), 0);
    if (numRows === 0) return;
    const numCols = columns.length;

    const [lo, hi] = robustRange(columns);
    drawLegend(lo, hi);

    const offscreen = document.createElement('canvas');
    offscreen.width = numCols;
    offscreen.height = numRows;
    const octx = offscreen.getContext('2d');
    if (!octx) return;
    const img = octx.createImageData(numCols, numRows);

    for (let x = 0; x < numCols; x++) {
      const amplitudes = (columns[x] as CsiPoint).amplitudes;
      for (let y = 0; y < numRows; y++) {
        const idx = (y * numCols + x) * 4;
        const amp = amplitudes[y];
        if (amp === undefined) {
          // This record had fewer subcarriers than the tallest column in view
          // (e.g. a csi_format change) — render as neutral grey, not fabricated colour.
          img.data[idx] = 40;
          img.data[idx + 1] = 40;
          img.data[idx + 2] = 46;
          img.data[idx + 3] = 255;
          continue;
        }
        const t = (amp - lo) / (hi - lo);
        const [r, g, b] = viridis(t);
        img.data[idx] = r;
        img.data[idx + 1] = g;
        img.data[idx + 2] = b;
        img.data[idx + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(offscreen, 0, 0, numCols, numRows, 0, 0, canvas.width, canvas.height);
  }

  function renderChart(): void {
    clear(chartArea);
    chartArea.append(h('h2', {}, 'Amplitude waterfall'));
    if (!linkSelect.value) {
      chartArea.append(emptyState('Select a link above to view its CSI waterfall.'));
      return;
    }
    if (columns.length === 0) {
      chartArea.append(
        emptyState(
          'No CSI records for this link in the selected window. This is an honest empty state — the link may be idle, dead, or ingest has not started. It is not a placeholder chart.',
        ),
      );
      return;
    }
    const numRows = columns.reduce((max, c) => Math.max(max, c.amplitudes.length), 0);
    chartArea.append(
      h(
        'div',
        { class: 'waterfall-wrap' },
        h('div', {}, canvas, h('div', { class: 'sub' }, `x: time (${columns.length} samples, newest on the right) · y: subcarrier index (0–${numRows - 1}, derived from this link's own record length)`)),
        h('div', { class: 'legend' }, h('div', {}, legendMax), legendCanvas, h('div', {}, legendMin), h('div', {}, 'amplitude (a.u.)')),
      ),
    );
    draw();
  }

  function pushColumn(point: CsiPoint): void {
    columns.push(point);
    if (columns.length > MAX_COLUMNS) columns.shift();
    renderChart();
  }

  async function loadHistoryAndSubscribe(link: LinkSummary): Promise<void> {
    unsubscribeLive?.();
    unsubscribeLive = null;
    unsubscribeData?.();
    unsubscribeData = null;
    columns = [];
    renderChart();

    const to = new Date();
    const from = new Date(to.getTime() - HISTORY_WINDOW_MS);
    try {
      const res = await apiGet<{ points: CsiPoint[] }>(
        `/api/csi?nodeId=${link.nodeId}&srcMac=${encodeURIComponent(link.srcMac)}&dstMac=${encodeURIComponent(link.dstMac)}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&maxPoints=${MAX_COLUMNS}`,
      );
      if (disposed || linkSelect.value !== linkKey(link)) return;
      columns = res.points;
      renderChart();
    } catch (err) {
      if (disposed) return;
      status.textContent = err instanceof ApiError ? err.message : String(err);
    }

    if (!liveToggle.checked) return;
    unsubscribeData = liveSocket.onData((msg: LiveDataMessage) => {
      if (msg.channel !== 'csi' || linkSelect.value !== linkKey(link)) return;
      for (const record of msg.records as unknown as CsiPoint[]) pushColumn(record);
    });
    unsubscribeLive = liveSocket.subscribe({ channel: 'csi', nodeId: link.nodeId, srcMac: link.srcMac, dstMac: link.dstMac });
  }

  /**
   * Rebuilds the picker most-recently-heard first, preserving whatever the
   * operator had selected. Re-selecting for them would be worse than a
   * stale-looking list: the waterfall is a live stream, and silently
   * switching which link it shows mid-observation loses their place.
   */
  function renderLinkOptions(): void {
    const previous = linkSelect.value;
    clear(linkSelect);
    if (links.length === 0) {
      linkSelect.append(h('option', { value: '' }, 'no links observed recently'));
      return;
    }
    linkSelect.append(
      h('option', { value: '' }, 'select a link…'),
      ...links.map((l) => h('option', { value: linkKey(l) }, linkOptionText(directory, l))),
    );
    if (previous && links.some((l) => linkKey(l) === previous)) linkSelect.value = previous;
  }

  async function loadLinks(initial: boolean): Promise<void> {
    try {
      const res = await apiGet<{ links: LinkSummary[] }>('/api/links?sinceMs=3600000&limit=500');
      links = sortByRecency(res.links);
    } catch (err) {
      // A failed refresh leaves the existing picker alone; only the very
      // first load has nothing to fall back to and must surface the error.
      if (disposed || !initial) return;
      clear(chartArea);
      chartArea.append(errorState(err instanceof ApiError ? err.message : String(err)));
      return;
    }
    if (disposed) return;
    renderLinkOptions();
    if (initial) renderChart();
  }

  linkSelect.addEventListener('change', () => {
    const link = links.find((l) => linkKey(l) === linkSelect.value);
    if (link) void loadHistoryAndSubscribe(link);
    else renderChart();
  });

  liveToggle.addEventListener('change', () => {
    const link = links.find((l) => linkKey(l) === linkSelect.value);
    if (link) void loadHistoryAndSubscribe(link);
  });

  void (async (): Promise<void> => {
    directory = await loadNodeDirectory();
    if (disposed) return;
    await loadLinks(true);
    if (disposed) return;
    linkTimer = setInterval(() => void loadLinks(false), LINK_REFRESH_MS);
  })();

  return () => {
    disposed = true;
    if (linkTimer) clearInterval(linkTimer);
    unsubscribeLive?.();
    unsubscribeData?.();
  };
}
