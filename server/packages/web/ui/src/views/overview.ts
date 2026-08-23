import { apiGet, ApiError } from '../api.js';
import { clear, formatRelative, h } from '../dom.js';
import { emptyState, errorState, loadingState } from '../components/asyncState.js';
import {
  currentRunStartMs,
  formatDuration,
  KEEPALIVE_INTERVAL_MS,
  type OccupancyRow,
} from '../occupancySeries.js';

interface NodeLiveness {
  id: number;
  name: string;
  room: string;
  lastHeartbeatAt: string | null;
  lastCsiRecordAt: string | null;
}

interface StatusSummary {
  dbReachable: boolean;
  windowMs: number;
  nodeCount: number;
  liveNodeCount: number;
  latestOccupancy: OccupancyRow | null;
  recentCsiRecordCount: number;
  recentHeartbeatCount: number;
}

const LIVE_THRESHOLD_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const TIME_IN_STATE_LOOKBACK_MS = 6 * 60 * 60 * 1000;

function isLive(lastSeen: string | null): boolean {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < LIVE_THRESHOLD_MS;
}

/**
 * How long the *current* state has held.
 *
 * This is exact rather than clipped to the lookback window, because
 * /api/occupancy returns a carry-in event from before the window: for a house
 * that has been occupied since yesterday, the oldest row in `history` is the
 * transition that started the run, at its real timestamp.
 */
function timeInCurrentState(history: OccupancyRow[]): string | null {
  const startMs = currentRunStartMs(history);
  return startMs === null ? null : formatDuration(Date.now() - startMs);
}

/**
 * True when the latest event is older than the pipeline would leave it while
 * running (transitions are sparse, but a keepalive lands every
 * KEEPALIVE_INTERVAL_MS of tick time). Two intervals of slack, so an ordinary
 * late batch is not called an outage.
 */
function occupancyIsStale(latest: OccupancyRow): boolean {
  return Date.now() - Date.parse(latest.time) > 2 * KEEPALIVE_INTERVAL_MS;
}

export function renderOverview(container: HTMLElement): () => void {
  let disposed = false;
  const root = h('div', { class: 'view-scroll' });
  container.append(root);
  root.append(loadingState('Loading status…'));

  // Tracks the message currently shown by errorState() below. This view
  // polls every POLL_INTERVAL_MS: without this, an outage that persists
  // across many ticks would clear() + re-append a brand new role="alert"
  // node every single tick, re-announcing the SAME failure to a screen
  // reader every few seconds for as long as the outage lasts. A genuinely
  // different failure message (e.g. a network error giving way to a 401)
  // still replaces the node and announces fresh -- the guard compares text,
  // not "is an error currently showing". Reset to null on every successful
  // fetch, so recovery always re-renders real content, and a later
  // recurrence of the same message (a new, distinct outage) announces again.
  let lastErrorMessage: string | null = null;

  async function load(): Promise<void> {
    let status: StatusSummary;
    try {
      status = await apiGet<StatusSummary>('/api/status');
    } catch (err) {
      if (disposed) return;
      const message = err instanceof ApiError ? err.message : String(err);
      if (message === lastErrorMessage) return;
      lastErrorMessage = message;
      clear(root);
      root.append(errorState(message));
      return;
    }
    lastErrorMessage = null;

    let nodes: NodeLiveness[] = [];
    let history: OccupancyRow[] = [];
    try {
      const [nodesRes, historyRes] = await Promise.all([
        apiGet<{ nodes: NodeLiveness[] }>('/api/nodes'),
        apiGet<{ states: OccupancyRow[] }>(
          `/api/occupancy?from=${encodeURIComponent(
            new Date(Date.now() - TIME_IN_STATE_LOOKBACK_MS).toISOString(),
          )}&to=${encodeURIComponent(new Date().toISOString())}&limit=2000`,
        ),
      ]);
      nodes = nodesRes.nodes;
      history = historyRes.states;
    } catch {
      // Non-fatal for the overview — status summary already rendered above; leave nodes/history sections empty-honest.
    }

    if (disposed) return;
    clear(root);

    const occ = status.latestOccupancy;
    const timeInState = timeInCurrentState(history);

    root.append(
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Occupancy — latch state machine'),
        occ
          ? h(
              'div',
              { class: 'grid' },
              // Step semantics: the latest event IS the current state, however
              // old it is. occupancy_states is a sparse event log, so "as of"
              // is a normal, expected lag, not a fault — but if it exceeds a
              // couple of keepalive intervals the pipeline has stopped
              // observing, and that is said out loud rather than implied.
              stat(
                'Estimate',
                occ.estimate === 0 ? '0 (empty)' : occ.estimate === 1 ? '1' : '2+',
                h('span', { class: 'sub' }, `recorded ${formatRelative(occ.time)}${occupancyIsStale(occ) ? ' — no fresh observations since' : ''}`),
              ),
              // Confidence is the value stored with that event, not a live
              // ramp: the DECAYING ramp is recomputed by the pipeline on every
              // transition and keepalive, so this figure is at most one
              // keepalive interval stale, and it is labelled as such rather
              // than re-derived in the browser.
              stat('Confidence', `${Math.round(occ.confidence * 100)}%`, h('span', { class: 'sub' }, `as recorded ${formatRelative(occ.time)}`)),
              stat('Internal state', occ.state),
              stat('Time in state', timeInState ?? '—', h('span', { class: 'sub' }, 'since the transition that started it')),
            )
          : emptyState(
              'No occupancy_states rows yet — the occupancy pipeline (brief B4) has not produced an estimate. This is an honest empty state, not a placeholder.',
            ),
        occ?.details
          ? h('div', { class: 'sub', style: 'margin-top:0.5rem' }, `details: ${JSON.stringify(occ.details)}`)
          : null,
      ),
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Ingest & database'),
        h(
          'div',
          { class: 'grid' },
          stat('DB reachable', status.dbReachable ? 'yes' : 'no'),
          stat('CSI records', String(status.recentCsiRecordCount), h('span', { class: 'sub' }, `last ${Math.round(status.windowMs / 1000)}s`)),
          stat('Heartbeats', String(status.recentHeartbeatCount), h('span', { class: 'sub' }, `last ${Math.round(status.windowMs / 1000)}s`)),
          stat('Nodes live / total', `${status.liveNodeCount} / ${status.nodeCount}`),
        ),
        h(
          'p',
          { class: 'sub' },
          'Rejection counters and disk/retention status are not shown here: they are produced in-process by the ingest/storage pipelines (briefs B3), which are separate OS processes with no durable, queryable record of that data today. See the API brief report for what should be persisted so this panel can show them honestly instead of omitting them.',
        ),
      ),
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Node liveness'),
        nodes.length === 0
          ? emptyState('No nodes registered.')
          : h(
              'table',
              {},
              h('thead', {}, h('tr', {}, h('th', {}, 'Node'), h('th', {}, 'Room'), h('th', {}, 'Last heartbeat'), h('th', {}, 'Last CSI'), h('th', {}, 'Status'))),
              h(
                'tbody',
                {},
                ...nodes.map((n) => {
                  const live = isLive(n.lastHeartbeatAt);
                  return h(
                    'tr',
                    {},
                    h('td', {}, `${n.name} (#${n.id})`),
                    h('td', {}, n.room),
                    h('td', {}, formatRelative(n.lastHeartbeatAt)),
                    h('td', {}, formatRelative(n.lastCsiRecordAt)),
                    h('td', {}, h('span', { class: `badge ${live ? 'live' : 'dead'}` }, live ? 'live' : 'silent')),
                  );
                }),
              ),
            ),
      ),
    );
  }

  void load();
  const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
  return () => {
    disposed = true;
    clearInterval(timer);
  };
}

function stat(label: string, value: string, sub?: HTMLElement | null): HTMLElement {
  return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ?? null);
}
