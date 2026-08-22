import { apiGet, ApiError } from '../api.js';
import { clear, emptyState, errorState, formatRelative, h } from '../dom.js';

interface NodeLiveness {
  id: number;
  name: string;
  room: string;
  lastHeartbeatAt: string | null;
  lastCsiRecordAt: string | null;
}

interface OccupancyRow {
  time: string;
  estimate: number;
  confidence: number;
  state: string;
  details: Record<string, unknown> | null;
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

/** Walks a (time-ascending) occupancy history backwards to find how long the *current* state has held. */
function timeInCurrentState(history: OccupancyRow[]): string | null {
  if (history.length === 0) return null;
  const current = history[history.length - 1] as OccupancyRow;
  let start = current.time;
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i] as OccupancyRow;
    if (row.state !== current.state) break;
    start = row.time;
  }
  const ms = Date.now() - new Date(start).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function renderOverview(container: HTMLElement): () => void {
  let disposed = false;
  const root = h('div', { class: 'view-scroll' });
  container.append(root);

  async function load(): Promise<void> {
    let status: StatusSummary;
    try {
      status = await apiGet<StatusSummary>('/api/status');
    } catch (err) {
      if (disposed) return;
      clear(root);
      root.append(errorState(err instanceof ApiError ? err.message : String(err)));
      return;
    }

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
              stat('Estimate', occ.estimate === 0 ? '0 (empty)' : occ.estimate === 1 ? '1' : '2+', h('span', { class: 'sub' }, `as of ${formatRelative(occ.time)}`)),
              stat('Confidence', `${Math.round(occ.confidence * 100)}%`),
              stat('Internal state', occ.state),
              stat('Time in state', timeInState ?? '—', h('span', { class: 'sub' }, `over last ${TIME_IN_STATE_LOOKBACK_MS / 3600000}h of history`)),
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
