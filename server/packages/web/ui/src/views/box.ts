import './box.css';
import { apiDelete, apiGet, apiPost, ApiError } from '../api.js';
import { clear, formatRelative, formatTimestamp, h } from '../dom.js';
import { emptyState, errorState, loadingState } from '../components/asyncState.js';
import { statusMessage, type StatusKind } from '../components/statusMessage.js';
import { viridis } from '../colormap.js';
import { formatSpan } from '../featureScale.js';
import { sortByRecency } from '../nodeNames.js';
import { liveSocket, type LiveDataMessage } from '../ws.js';
import {
  classReadiness,
  csiFeedKey,
  displayMode,
  formatAccuracyComparison,
  laneStatus,
  nodePickupStatus,
  NODE_CONFIG_POLL_INTERVAL_MS,
  robustAmplitudeRange,
  shouldAnnounce,
  type ClassSummary,
  type RealtimeMode,
  type RealtimeNodeState,
} from '../boxLogic.js';

/**
 * The box experiment: 5 ESP32-C6 nodes around a closed cardboard box,
 * watched live while an operator moves a hand inside it, plus the tooling to
 * record short labelled takes of gestures for a dataset.
 *
 * The live strip is the centrepiece (per the brief this view was built from
 * -- it is "the most instructive and satisfying part of the whole
 * experiment"), so it is laid out first and given the most space, not bolted
 * on beside the forms below it.
 *
 * Deliberately never says anything about house occupancy: this is a
 * gesture/presence experiment on a fenced-off set of `role: 'box'` nodes
 * (see eslint.config.js's import-direction guard for the structural side of
 * that fence), not a per-window occupancy claim.
 */

// ==== Wire shapes (sibling briefs B1/B3 -- not built here) ==================

interface BoxNode {
  id: number;
  name: string;
  room: string;
  role: 'house' | 'box';
}

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

interface RealtimeSnapshot {
  mode: RealtimeMode;
  revision: number;
  expiresAt: string | null;
  knownSinceRestart: boolean;
  nodes: RealtimeNodeState[];
}

/** `POST /api/box/sessions`' 201 response -- narrower than a listed take: no `endedAt`/`recordCount` yet. */
interface CreatedSession {
  id: number;
  startedAt: string;
  gestureClass: string;
  geometryNote: string | null;
  notes: string | null;
}

/** One row of `GET /api/box/sessions`. */
interface BoxSessionRow {
  id: number;
  startedAt: string;
  endedAt: string | null;
  gestureClass: string;
  geometryNote: string | null;
  notes: string | null;
  recordCount: number;
}

interface StopSessionResponse {
  id: number;
  startedAt: string;
  endedAt: string;
  gestureClass: string;
  recordCount: number;
  preservationWarning?: string;
}

interface LastTraining {
  at: string;
  accuracy: number;
  majorityBaseline: number;
  randomBaseline: number;
  confusion: unknown;
}

interface BoxSummary {
  classes: ClassSummary[];
  minTakesPerClass: number;
  lastTraining: LastTraining | null;
}

// ==== Constants ==============================================================

/** Intrinsic pixel size of one lane's canvas; scaled to its card by `.box-lane-canvas` (see box.css). */
const LANE_WIDTH = 360;
const LANE_HEIGHT = 90;
/** Rolling history kept per lane -- enough to read as a moving waterfall, not so much it never scrolls. */
const LANE_MAX_COLUMNS = 200;
/** How often a node's link is re-discovered (it may start transmitting on a fresh link after this view is opened). */
const LINK_REFRESH_MS = 60_000;
/** How often `GET /api/realtime` is re-polled so pickup progress updates without a manual refresh. */
const REALTIME_POLL_MS = 5_000;
/** Drives lane-silence detection, the recording elapsed readout, and the realtime countdown. */
const TICK_MS = 1000;
const TAKES_LIMIT = 20;

function errText(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

function linkKey(l: { nodeId: number; srcMac: string; dstMac: string }): string {
  return `${l.nodeId}:${l.srcMac}:${l.dstMac}`;
}

export function renderBox(container: HTMLElement): () => void {
  let disposed = false;
  const root = h('div', { class: 'view-scroll' });
  container.append(root);

  root.append(h('h2', { class: 'box-title' }, 'Box experiment'));

  // ==== Section 1: live strip (the centrepiece) ==============================

  interface Lane {
    node: BoxNode;
    link: LinkSummary | null;
    columns: CsiPoint[];
    lastRecordAtMs: number | null;
    unsubscribeLive: (() => void) | null;
    canvas: HTMLCanvasElement;
    statusBadge: HTMLElement;
    caption: HTMLElement;
    card: HTMLElement;
  }

  let boxNodes: BoxNode[] = [];
  /** Distinguishes "still loading" from "loaded, and there are genuinely zero box nodes" -- `enableRealtime` must not fire with an accidentally-empty `nodeIds` just because the initial fetch hasn't resolved yet. */
  let boxNodesLoaded = false;
  let lanes: Lane[] = [];
  let linkRefreshTimer: ReturnType<typeof setInterval> | null = null;

  const liveStripGrid = h('div', { class: 'chart-grid' });
  const liveStripSection = h(
    'section',
    { class: 'box-live-strip', 'aria-label': 'Live CSI per box node' },
    h('div', { class: 'panel' }, h('h2', {}, 'Live CSI — box nodes'), h('p', { class: 'sub' }, 'Move a hand inside the box and watch each node\'s amplitude change in real time.')),
    liveStripGrid,
  );
  liveStripGrid.append(loadingState('Loading box nodes…'));

  function buildLane(node: BoxNode): Lane {
    const canvas = h('canvas', {
      width: String(LANE_WIDTH),
      height: String(LANE_HEIGHT),
      class: 'box-lane-canvas box-lane-quiet',
    }) as HTMLCanvasElement;
    const statusBadge = h('span', { class: 'badge dead' }, 'no link yet');
    const caption = h('div', { class: 'sub' }, '');
    const card = h('div', { class: 'panel box-lane' }, h('h2', {}, node.name, statusBadge), canvas, caption);
    return { node, link: null, columns: [], lastRecordAtMs: null, unsubscribeLive: null, canvas, statusBadge, caption, card };
  }

  function drawLane(lane: Lane): void {
    const ctx = lane.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, lane.canvas.width, lane.canvas.height);
    if (lane.columns.length === 0) return;

    // Subcarrier count derived per-frame from the data itself, never assumed
    // (docs/protocol.md 9.3 -- csi_len varies with csi_format).
    const numRows = lane.columns.reduce((max, c) => Math.max(max, c.amplitudes.length), 0);
    if (numRows === 0) return;
    const numCols = lane.columns.length;

    const [lo, hi] = robustAmplitudeRange(lane.columns.map((c) => c.amplitudes));

    const offscreen = document.createElement('canvas');
    offscreen.width = numCols;
    offscreen.height = numRows;
    const octx = offscreen.getContext('2d');
    if (!octx) return;
    const img = octx.createImageData(numCols, numRows);

    for (let x = 0; x < numCols; x++) {
      const amplitudes = (lane.columns[x] as CsiPoint).amplitudes;
      for (let y = 0; y < numRows; y++) {
        const idx = (y * numCols + x) * 4;
        const amp = amplitudes[y];
        if (amp === undefined) {
          // Fewer subcarriers than the tallest column currently in view -- neutral grey, never fabricated colour.
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
    ctx.drawImage(offscreen, 0, 0, numCols, numRows, 0, 0, lane.canvas.width, lane.canvas.height);
    lane.caption.textContent = `${lo.toFixed(1)}–${hi.toFixed(1)} amplitude (a.u.) · y: subcarrier 0–${numRows - 1} · ${lane.columns.length} samples`;
  }

  /** Text + badge, never colour alone (a11y bar this app already holds itself to) -- a silent or link-less lane says so in words. */
  function syncLaneStatus(lane: Lane): void {
    if (lane.link === null) {
      lane.statusBadge.className = 'badge dead';
      lane.statusBadge.textContent = 'no link yet';
      lane.canvas.classList.add('box-lane-quiet');
      return;
    }
    const status = laneStatus(lane.lastRecordAtMs, Date.now());
    if (status === 'live') {
      lane.statusBadge.className = 'badge live';
      lane.statusBadge.textContent = 'live';
      lane.canvas.classList.remove('box-lane-quiet');
    } else {
      // 'silent': a link was found and has produced data before, but not
      // recently -- distinct from 'no-link' above, and never drawn as if it
      // were still live.
      const sinceMs = lane.lastRecordAtMs === null ? 0 : Date.now() - lane.lastRecordAtMs;
      lane.statusBadge.className = 'badge stale';
      lane.statusBadge.textContent = `silent — ${formatSpan(sinceMs)} since last frame`;
      lane.canvas.classList.add('box-lane-quiet');
    }
  }

  function pushRecord(lane: Lane, point: CsiPoint): void {
    lane.columns.push(point);
    if (lane.columns.length > LANE_MAX_COLUMNS) lane.columns.shift();
    lane.lastRecordAtMs = Date.now();
    drawLane(lane);
    syncLaneStatus(lane);
  }

  /**
   * Rebinds each lane to that node's most-recently-heard link, mirroring
   * `views/waterfall.ts`'s own link discovery. Re-run periodically (not just
   * once) because a box node may start transmitting on a fresh link after
   * this view is already open, and a lane must recover from that on its own
   * rather than staying stuck on "no link yet" for the rest of the session.
   */
  async function refreshLaneLinks(): Promise<void> {
    let links: LinkSummary[];
    try {
      const res = await apiGet<{ links: LinkSummary[] }>(
        `/api/links?sinceMs=3600000&limit=500`,
      );
      links = sortByRecency(res.links);
    } catch {
      return; // best-effort refresh; leave lanes on whatever link they already have
    }
    if (disposed) return;

    for (const lane of lanes) {
      const best = links.find((l) => l.nodeId === lane.node.id) ?? null;
      const currentKey = lane.link ? linkKey(lane.link) : null;
      const bestKey = best ? linkKey(best) : null;
      if (bestKey === currentKey) continue;

      lane.unsubscribeLive?.();
      lane.unsubscribeLive = null;
      lane.link = best;
      lane.columns = [];
      lane.lastRecordAtMs = null;
      syncLaneStatus(lane);
      drawLane(lane);
      if (best) {
        lane.unsubscribeLive = liveSocket.subscribe({
          channel: 'csi',
          nodeId: best.nodeId,
          srcMac: best.srcMac,
          dstMac: best.dstMac,
        });
      }
    }
  }

  // A single shared handler routes every incoming `csi` message to whichever
  // lane's current link it matches, by the API hub's own feed-key format
  // (`csiFeedKey`) -- unlike `views/waterfall.ts`, which only ever has one
  // subscription open and can assume any `csi` message is for it, this view
  // holds up to 5 concurrent subscriptions at once.
  const unsubscribeLiveData = liveSocket.onData((msg: LiveDataMessage) => {
    if (disposed || msg.channel !== 'csi') return;
    for (const lane of lanes) {
      if (!lane.link) continue;
      if (csiFeedKey(lane.link.nodeId, lane.link.srcMac, lane.link.dstMac) !== msg.key) continue;
      for (const record of msg.records as unknown as CsiPoint[]) pushRecord(lane, record);
    }
  });

  async function loadBoxNodes(): Promise<void> {
    let allNodes: BoxNode[];
    try {
      const res = await apiGet<{ nodes: BoxNode[] }>('/api/nodes');
      allNodes = res.nodes;
    } catch (err) {
      if (disposed) return;
      boxNodesLoaded = true;
      syncRealtimeControls();
      clear(liveStripGrid);
      liveStripGrid.append(errorState(`Could not load nodes: ${errText(err)}`));
      return;
    }
    if (disposed) return;
    boxNodes = allNodes.filter((n) => n.role === 'box');
    boxNodesLoaded = true;
    syncRealtimeControls();
    clear(liveStripGrid);
    if (boxNodes.length === 0) {
      liveStripGrid.append(
        emptyState(
          'No nodes are registered with role "box" yet — configure the box experiment nodes (config.yaml) before this strip can show anything.',
        ),
      );
      return;
    }
    lanes = boxNodes.map(buildLane);
    for (const lane of lanes) liveStripGrid.append(lane.card);
    await refreshLaneLinks();
    if (disposed) return;
    linkRefreshTimer = setInterval(() => void refreshLaneLinks(), LINK_REFRESH_MS);
  }

  // ==== Section 2: realtime toggle ============================================

  let realtime: RealtimeSnapshot | null = null;
  let realtimeError: string | null = null;
  let realtimeBusy = false;
  /** Guards `modeAnnounce`'s role="status" text -- reassigned (and therefore only actually announced) when the shown mode genuinely changes, never on every tick/poll. Same pattern as views/houseMap.ts's `lastStatusText`, factored into boxLogic.ts's `shouldAnnounce` so it is tested once. */
  let lastModeAnnounceText = '';

  // The one genuinely live-updating, role="status" readout in this section:
  // just the mode word itself, reassigned only on a real transition (see
  // syncModeAnnounce below). Deliberately NOT on realtimeBody below, which is
  // rebuilt wholesale on every tick/poll (countdown, pickup table) -- an
  // aria-live region that large, reassigned every second, would re-announce
  // its entire contents indefinitely (the exact bug views/houseMap.ts's
  // `statusSummary` comment and views/groundTruth.ts's ticking
  // `readoutDuration` -- which carries no aria-live at all -- both exist to
  // avoid).
  const modeAnnounce = h('div', { class: 'box-realtime-mode', role: 'status' }, '');
  const realtimeBody = h('div', {});
  const realtimeFeedback = h('div', {});
  const durationSelect = h(
    'select',
    { 'aria-label': 'Realtime capture duration' },
    h('option', { value: '60' }, '1 minute'),
    h('option', { value: '120' }, '2 minutes'),
    h('option', { value: '300' }, '5 minutes'),
    h('option', { value: '600' }, '10 minutes'),
  ) as HTMLSelectElement;
  durationSelect.value = '300';
  const enableButton = h('button', { onclick: () => void enableRealtime() }, 'Start realtime capture');
  const disableButton = h('button', { onclick: () => void disableRealtime() }, 'Return to normal');

  const realtimeSection = h(
    'div',
    { class: 'panel' },
    h('h2', {}, 'Realtime capture mode'),
    h(
      'p',
      { class: 'sub' },
      'Temporarily makes box nodes poll and burst-capture faster, for a short window, then revert on their own once it expires — a manual return to normal works too.',
    ),
    modeAnnounce,
    realtimeBody,
    h('div', { class: 'controls' }, h('label', {}, 'Duration', durationSelect), enableButton, disableButton),
    realtimeFeedback,
  );

  function setFeedback(el: HTMLElement, kind: StatusKind, text: string): void {
    clear(el);
    el.append(statusMessage(kind, text));
  }

  function syncRealtimeControls(): void {
    // Gated on `boxNodesLoaded`, not just `boxNodes.length`, so a click that
    // races the initial node fetch cannot send an accidentally-empty
    // `nodeIds` — that would silently restrict "enable" to no nodes at all
    // rather than the box nodes the operator meant.
    enableButton.disabled = realtimeBusy || !boxNodesLoaded || boxNodes.length === 0;
    disableButton.disabled = realtimeBusy;
  }

  async function enableRealtime(): Promise<void> {
    if (realtimeBusy || !boxNodesLoaded || boxNodes.length === 0) return;
    realtimeBusy = true;
    syncRealtimeControls();
    try {
      const durationS = Number(durationSelect.value);
      const nodeIds = boxNodes.map((n) => n.id);
      realtime = await apiPost<RealtimeSnapshot>('/api/realtime', { enabled: true, durationS, nodeIds });
      setFeedback(
        realtimeFeedback,
        'ok',
        `Realtime capture requested for ${nodeIds.length} box node(s). It takes about ${Math.round(NODE_CONFIG_POLL_INTERVAL_MS / 1000)}s for each node to pick this up on its own next poll.`,
      );
    } catch (err) {
      setFeedback(realtimeFeedback, 'error', `Could not enable realtime mode: ${errText(err)}`);
    } finally {
      realtimeBusy = false;
      syncRealtimeControls();
      renderRealtime();
    }
  }

  async function disableRealtime(): Promise<void> {
    if (realtimeBusy) return;
    realtimeBusy = true;
    syncRealtimeControls();
    try {
      realtime = await apiPost<RealtimeSnapshot>('/api/realtime', { enabled: false });
      setFeedback(realtimeFeedback, 'ok', 'Requested a return to normal mode.');
    } catch (err) {
      setFeedback(realtimeFeedback, 'error', `Could not disable realtime mode: ${errText(err)}`);
    } finally {
      realtimeBusy = false;
      syncRealtimeControls();
      renderRealtime();
    }
  }

  async function loadRealtime(): Promise<void> {
    try {
      realtime = await apiGet<RealtimeSnapshot>('/api/realtime');
      realtimeError = null;
    } catch (err) {
      realtimeError = errText(err);
    }
    if (!disposed) renderRealtime();
  }

  /**
   * Reassigns `modeAnnounce`'s text (and therefore actually announces it)
   * only when the shown mode genuinely changed since the last call --
   * `shouldAnnounce` mirrors views/houseMap.ts's `lastStatusText` guard.
   * The colour class is updated unconditionally regardless: a className
   * change alone is not read aloud by a screen reader, so it carries no
   * re-announcement risk and may as well always stay in sync.
   */
  function syncModeAnnounce(shown: RealtimeMode): void {
    const label = shown === 'unknown' ? 'Unknown' : shown === 'realtime' ? 'Realtime (burst)' : 'Normal';
    modeAnnounce.className = `box-realtime-mode mode-${shown}`;
    if (shouldAnnounce(lastModeAnnounceText, label)) {
      lastModeAnnounceText = label;
      modeAnnounce.textContent = label;
    }
  }

  function renderRealtime(): void {
    if (realtime === null) {
      clear(realtimeBody);
      realtimeBody.append(realtimeError !== null ? errorState(realtimeError) : loadingState('Loading realtime mode…'));
      return;
    }

    const shown = displayMode(realtime.mode, realtime.knownSinceRestart);
    syncModeAnnounce(shown);

    clear(realtimeBody);
    if (shown === 'unknown') {
      realtimeBody.append(
        h(
          'p',
          { class: 'sub' },
          'The API restarted and does not yet know what every node currently has applied — nodes may still be bursting under a mode set before the restart, until their own deadlines expire. This is unconfirmed, not "normal".',
        ),
      );
    }

    if (realtime.expiresAt !== null) {
      const remainMs = Date.parse(realtime.expiresAt) - Date.now();
      realtimeBody.append(
        h(
          'p',
          { class: 'sub' },
          remainMs > 0
            ? `Expires in ${formatSpan(remainMs)} (revision ${realtime.revision}).`
            : `Expired ${formatSpan(-remainMs)} ago — nodes should be reverting to normal on their own (revision ${realtime.revision}).`,
        ),
      );
    } else {
      realtimeBody.append(h('p', { class: 'sub' }, `Revision ${realtime.revision}.`));
    }
    realtimeBody.append(
      h(
        'p',
        { class: 'sub' },
        `A node applies a mode change within about ${Math.round(NODE_CONFIG_POLL_INTERVAL_MS / 1000)}s of its own next poll — a node not yet reflecting a change you just made a moment ago is not a failure.`,
      ),
    );

    if (boxNodes.length === 0) return;
    const rows = boxNodes.map((n) => {
      const nodeState = realtime!.nodes.find((r) => r.nodeId === n.id) ?? null;
      const status = nodeState === null ? 'unseen' : nodePickupStatus(nodeState, realtime!.revision);
      const badgeClass = status === 'applied' ? 'live' : status === 'pending' ? 'stale' : 'dead';
      return h(
        'tr',
        {},
        h('td', {}, n.name),
        h('td', {}, h('span', { class: `badge ${badgeClass}` }, status)),
        h('td', {}, formatRelative(nodeState?.lastPolledAt ?? null)),
        h('td', {}, nodeState?.appliedRevision != null ? String(nodeState.appliedRevision) : '—'),
      );
    });
    realtimeBody.append(
      h(
        'table',
        { class: 'box-pickup-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Node'), h('th', {}, 'Pickup'), h('th', {}, 'Last polled'), h('th', {}, 'Applied revision'))),
        h('tbody', {}, ...rows),
      ),
    );
  }

  // ==== Section 3: recording panel =============================================

  let activeTake: CreatedSession | null = null;
  let recordingBusy = false;

  const gestureClassDatalist = h('datalist', { id: 'box-gesture-classes' });
  const gestureClassInput = h('input', {
    type: 'text',
    list: 'box-gesture-classes',
    placeholder: 'e.g. "wave", "push", "reach-in"',
  }) as HTMLInputElement;
  const geometryNoteInput = h('input', {
    type: 'text',
    placeholder: 'e.g. "5 nodes at box corners, lid open"',
  }) as HTMLInputElement;
  const notesInput = h('input', { type: 'text', placeholder: 'optional' }) as HTMLInputElement;
  const recordFeedback = h('div', {});
  // Plain, non-live ticking readout -- same reasoning as
  // views/groundTruth.ts's `readoutDuration` (no aria-live at all) and
  // views/houseMap.ts's `lastPolled` (a caption, not a status region): its
  // elapsed-time text changes every second by design, and an aria-live
  // region reassigned every second would re-announce the whole "RECORDING —
  // ..." line for the entire duration of every take. The actual
  // state-change announcements ("Recording started for ...", "Take stopped
  // ...") already go through `recordFeedback` (statusMessage), fired once
  // per genuine start/stop, not per tick.
  const recordingBannerText = h('span', {});
  const recordingBanner = h(
    'div',
    { class: 'box-recording-banner', style: 'display:none' },
    h('span', { class: 'box-recording-dot', 'aria-hidden': 'true' }),
    recordingBannerText,
  );
  const recordToggleButton = h(
    'button',
    { class: 'box-record-toggle', onclick: () => void toggleRecording() },
    'Start recording',
  );

  const recordingSection = h(
    'div',
    { class: 'panel' },
    h('h2', {}, 'Record a take'),
    h(
      'p',
      { class: 'sub' },
      'Different physical arrangements of the 5 nodes is an explicit goal of this experiment — write down which one a take used, or it is worthless afterwards.',
    ),
    recordingBanner,
    h(
      'div',
      { class: 'controls' },
      h('label', {}, 'Gesture class', gestureClassInput),
      gestureClassDatalist,
      h('label', {}, 'Geometry note', geometryNoteInput),
      h('label', {}, 'Notes (optional)', notesInput),
    ),
    h('div', { class: 'controls' }, recordToggleButton),
    recordFeedback,
  );

  function syncRecordingControls(): void {
    const recording = activeTake !== null;
    recordToggleButton.disabled = recordingBusy;
    recordToggleButton.textContent = recordingBusy
      ? recording
        ? 'Stopping…'
        : 'Starting…'
      : recording
        ? 'Stop recording'
        : 'Start recording';
    recordToggleButton.classList.toggle('recording', recording);
    gestureClassInput.disabled = recording || recordingBusy;
    geometryNoteInput.disabled = recording || recordingBusy;
    notesInput.disabled = recording || recordingBusy;
    recordingBanner.style.display = recording ? '' : 'none';
    if (recording) tickRecordingBanner();
  }

  function tickRecordingBanner(): void {
    if (activeTake === null) return;
    const heldMs = Date.now() - Date.parse(activeTake.startedAt);
    recordingBannerText.textContent = `RECORDING — "${activeTake.gestureClass}"${
      activeTake.geometryNote ? ` · ${activeTake.geometryNote}` : ''
    } — ${formatSpan(heldMs)}`;
  }

  async function toggleRecording(): Promise<void> {
    if (recordingBusy) return;
    if (activeTake === null) await startRecording();
    else await stopRecording();
  }

  async function startRecording(): Promise<void> {
    const gestureClass = gestureClassInput.value.trim();
    if (!gestureClass) {
      setFeedback(recordFeedback, 'error', 'Enter or pick a gesture class before recording.');
      return;
    }
    recordingBusy = true;
    syncRecordingControls();
    try {
      const geometryNote = geometryNoteInput.value.trim();
      const notes = notesInput.value.trim();
      activeTake = await apiPost<CreatedSession>('/api/box/sessions', {
        gestureClass,
        geometryNote: geometryNote || undefined,
        notes: notes || undefined,
      });
      setFeedback(recordFeedback, 'ok', `Recording started for "${gestureClass}".`);
    } catch (err) {
      setFeedback(recordFeedback, 'error', `Could not start a take: ${errText(err)}`);
    } finally {
      recordingBusy = false;
      syncRecordingControls();
    }
  }

  async function stopRecording(): Promise<void> {
    if (activeTake === null) return;
    recordingBusy = true;
    syncRecordingControls();
    try {
      const res = await apiPost<StopSessionResponse>(`/api/box/sessions/${activeTake.id}/stop`);
      // A preservationWarning means the take was recorded but its raw
      // features could not be archived -- shown as a distinct warning, and
      // the take still counts as recorded (same semantics as the ground
      // truth view's session stop).
      setFeedback(
        recordFeedback,
        res.preservationWarning !== undefined ? 'warn' : 'ok',
        res.preservationWarning ?? `Take stopped — ${res.recordCount} record(s) captured for "${res.gestureClass}".`,
      );
      activeTake = null;
      await Promise.all([loadSummary(), loadSessions()]);
    } catch (err) {
      setFeedback(recordFeedback, 'error', `Could not stop the take — it is still open server-side. Try Stop again. ${errText(err)}`);
    } finally {
      recordingBusy = false;
      syncRecordingControls();
    }
  }

  // ==== Section 4: takes + dataset readiness ===================================

  let summary: BoxSummary | null = null;
  let summaryError: string | null = null;
  let sessions: BoxSessionRow[] = [];
  let sessionsError: string | null = null;

  const summaryBody = h('div', {});
  const summarySection = h('div', { class: 'panel' }, h('h2', {}, 'Dataset readiness'), summaryBody);

  const sessionsBody = h('div', {});
  const sessionsSection = h('div', { class: 'panel' }, h('h2', {}, 'Takes'), sessionsBody);

  function syncGestureDatalist(): void {
    clear(gestureClassDatalist);
    if (summary === null) return;
    for (const cls of summary.classes) gestureClassDatalist.append(h('option', { value: cls.gestureClass }));
  }

  function renderSummary(): void {
    clear(summaryBody);
    if (summary === null) {
      summaryBody.append(summaryError !== null ? errorState(summaryError) : loadingState('Loading dataset summary…'));
      return;
    }

    if (summary.classes.length === 0) {
      summaryBody.append(emptyState('No takes recorded yet for any gesture class.'));
    } else {
      const rows = summary.classes.map((cls) => {
        const r = classReadiness(cls, summary!.minTakesPerClass);
        return h(
          'tr',
          {},
          h('td', {}, r.gestureClass),
          h('td', {}, String(r.takeCount)),
          h('td', {}, String(r.totalRecords)),
          h('td', {}, h('span', { class: `badge ${r.ready ? 'ready' : 'not-ready'}` }, r.ready ? 'ready' : `needs ${r.remaining} more`)),
        );
      });
      summaryBody.append(
        h('p', { class: 'sub' }, `Minimum ${summary.minTakesPerClass} takes per class to train.`),
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Gesture class'), h('th', {}, 'Takes'), h('th', {}, 'Records'), h('th', {}, 'Ready?'))),
          h('tbody', {}, ...rows),
        ),
      );
    }

    summaryBody.append(h('h2', {}, 'Last training run'));
    if (summary.lastTraining === null) {
      summaryBody.append(
        emptyState('No training run yet. Training is run from the CLI (homecsi box train) — there is no train button here.'),
      );
    } else {
      const t = summary.lastTraining;
      // Accuracy is never rendered without its two baselines next to it.
      summaryBody.append(
        h('p', {}, formatAccuracyComparison(t)),
        h('p', { class: 'sub' }, `Trained ${formatTimestamp(t.at)}.`),
        h('div', { class: 'box-confusion' }, JSON.stringify(t.confusion, null, 2)),
      );
    }
  }

  async function loadSummary(): Promise<void> {
    try {
      summary = await apiGet<BoxSummary>('/api/box/summary');
      summaryError = null;
      syncGestureDatalist();
    } catch (err) {
      summaryError = errText(err);
    }
    if (!disposed) renderSummary();
  }

  function renderSessions(): void {
    clear(sessionsBody);
    if (sessions.length === 0) {
      sessionsBody.append(sessionsError !== null ? errorState(sessionsError) : emptyState('No takes recorded yet.'));
      return;
    }
    const rows = sessions.map((s) => {
      const open = s.endedAt === null;
      const deleteButton = h(
        'button',
        {
          'aria-label': `Delete take #${s.id} (${s.gestureClass})`,
          disabled: activeTake !== null && activeTake.id === s.id,
          onclick: () => void onDeleteTake(s.id, s.gestureClass),
        },
        'Delete',
      );
      return h(
        'tr',
        {},
        h('td', {}, String(s.id)),
        h('td', {}, s.gestureClass),
        h('td', {}, s.geometryNote ?? '—'),
        h('td', {}, formatTimestamp(s.startedAt)),
        h('td', {}, h('span', { class: `badge${open ? ' live' : ''}` }, open ? 'open' : 'stopped')),
        h('td', {}, String(s.recordCount)),
        h('td', {}, deleteButton),
      );
    });
    sessionsBody.append(
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', {}, '#'),
            h('th', {}, 'Gesture'),
            h('th', {}, 'Geometry'),
            h('th', {}, 'Started'),
            h('th', {}, 'Status'),
            h('th', {}, 'Records'),
            h('th', {}, ''),
          ),
        ),
        h('tbody', {}, ...rows),
      ),
    );
  }

  async function loadSessions(): Promise<void> {
    try {
      const res = await apiGet<{ sessions: BoxSessionRow[] }>(`/api/box/sessions?limit=${TAKES_LIMIT}`);
      sessions = res.sessions;
      sessionsError = null;
    } catch (err) {
      sessionsError = errText(err);
    }
    if (!disposed) renderSessions();
  }

  async function onDeleteTake(id: number, gestureClass: string): Promise<void> {
    if (!window.confirm(`Delete take #${id} (${gestureClass})? This cannot be undone.`)) return;
    try {
      await apiDelete<void>(`/api/box/sessions/${id}`);
      await Promise.all([loadSessions(), loadSummary()]);
    } catch (err) {
      setFeedback(recordFeedback, 'error', `Could not delete take #${id}: ${errText(err)}`);
    }
  }

  // ==== Mount ===================================================================

  root.append(liveStripSection, realtimeSection, recordingSection, summarySection, sessionsSection);

  syncRecordingControls();
  syncRealtimeControls();
  void loadBoxNodes();
  void loadRealtime();
  void loadSummary();
  void loadSessions();

  const tickTimer = setInterval(() => {
    if (disposed) return;
    for (const lane of lanes) syncLaneStatus(lane);
    if (activeTake !== null) tickRecordingBanner();
    if (realtime !== null) renderRealtime();
  }, TICK_MS);
  const realtimePollTimer = setInterval(() => void loadRealtime(), REALTIME_POLL_MS);

  return () => {
    disposed = true;
    clearInterval(tickTimer);
    clearInterval(realtimePollTimer);
    if (linkRefreshTimer) clearInterval(linkRefreshTimer);
    unsubscribeLiveData();
    for (const lane of lanes) lane.unsubscribeLive?.();
  };
}
