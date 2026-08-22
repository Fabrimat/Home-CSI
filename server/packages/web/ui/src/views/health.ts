import { apiGet, ApiError } from '../api.js';
import { clear, emptyState, errorState, formatRelative, h } from '../dom.js';

interface NodeLiveness {
  id: number;
  name: string;
  room: string;
  lastHeartbeatAt: string | null;
  lastCsiRecordAt: string | null;
}

interface HeartbeatRow {
  time: string;
  nodeId: number;
  uptimeS: number;
  freeHeapBytes: number;
  minFreeHeapBytes: number;
  framesCaptured: number;
  framesDropped: number;
  batchesSent: number;
  sendFailures: number;
  rssiToAp: number;
  channel: number;
  sntpSynced: boolean;
  fwVersion: string;
}

interface LinkSummary {
  nodeId: number;
  srcMac: string;
  dstMac: string;
  recordCount: number;
  lastSeenAt: string;
}

const DEAD_THRESHOLD_MS = 5 * 60 * 1000;
const STALE_THRESHOLD_MS = 60 * 1000;
const POLL_INTERVAL_MS = 10000;
const LINKS_SINCE_MS = 60 * 60 * 1000;

function livenessBadge(lastSeen: string | null): HTMLElement {
  if (!lastSeen) return h('span', { class: 'badge dead' }, 'never seen');
  const age = Date.now() - new Date(lastSeen).getTime();
  if (age < STALE_THRESHOLD_MS) return h('span', { class: 'badge live' }, 'live');
  if (age < DEAD_THRESHOLD_MS) return h('span', { class: 'badge stale' }, 'stale');
  return h('span', { class: 'badge dead' }, 'dead');
}

function formatUptime(seconds: number): string {
  const h_ = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h_}h ${m}m`;
}

export function renderHealth(container: HTMLElement): () => void {
  let disposed = false;
  const root = h('div', { class: 'view-scroll' });
  container.append(root);

  async function loadLatestHeartbeat(nodeId: number): Promise<HeartbeatRow | null> {
    const to = new Date();
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
    try {
      const res = await apiGet<{ heartbeats: HeartbeatRow[] }>(
        `/api/nodes/${nodeId}/heartbeats?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&limit=1`,
      );
      return res.heartbeats[0] ?? null;
    } catch {
      return null;
    }
  }

  async function load(): Promise<void> {
    let nodes: NodeLiveness[];
    let links: LinkSummary[];
    try {
      const [nodesRes, linksRes] = await Promise.all([
        apiGet<{ nodes: NodeLiveness[] }>('/api/nodes'),
        apiGet<{ links: LinkSummary[] }>(`/api/links?sinceMs=${LINKS_SINCE_MS}&limit=500`),
      ]);
      nodes = nodesRes.nodes;
      links = linksRes.links;
    } catch (err) {
      if (disposed) return;
      clear(root);
      root.append(errorState(err instanceof ApiError ? err.message : String(err)));
      return;
    }

    const heartbeats = await Promise.all(nodes.map((n) => loadLatestHeartbeat(n.id)));
    if (disposed) return;
    clear(root);

    root.append(
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Nodes'),
        nodes.length === 0
          ? emptyState('No nodes registered in the database yet.')
          : h(
              'table',
              {},
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  h('th', {}, 'Node'),
                  h('th', {}, 'Status'),
                  h('th', {}, 'RSSI to AP'),
                  h('th', {}, 'Channel'),
                  h('th', {}, 'Uptime'),
                  h('th', {}, 'Free heap'),
                  h('th', {}, 'Frames captured / dropped'),
                  h('th', {}, 'Send failures'),
                  h('th', {}, 'SNTP'),
                  h('th', {}, 'Firmware'),
                  h('th', {}, 'Last heartbeat'),
                ),
              ),
              h(
                'tbody',
                {},
                ...nodes.map((n, i) => {
                  const hb = heartbeats[i] ?? null;
                  return h(
                    'tr',
                    {},
                    h('td', {}, `${n.name} (#${n.id})`),
                    h('td', {}, livenessBadge(n.lastHeartbeatAt)),
                    h('td', {}, hb ? `${hb.rssiToAp} dBm` : '—'),
                    h('td', {}, hb ? String(hb.channel) : '—'),
                    h('td', {}, hb ? formatUptime(hb.uptimeS) : '—'),
                    h('td', {}, hb ? `${Math.round(hb.freeHeapBytes / 1024)} KiB` : '—'),
                    h('td', {}, hb ? `${hb.framesCaptured} / ${hb.framesDropped}` : '—'),
                    h('td', {}, hb ? String(hb.sendFailures) : '—'),
                    h('td', {}, hb ? (hb.sntpSynced ? 'synced' : 'unsynced') : '—'),
                    h('td', {}, hb ? hb.fwVersion : '—'),
                    h('td', {}, formatRelative(n.lastHeartbeatAt)),
                  );
                }),
              ),
            ),
      ),
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, `Links (observed in the last ${Math.round(LINKS_SINCE_MS / 60000)} minutes)`),
        h(
          'p',
          { class: 'sub' },
          'With N nodes there are N·(N−1) directional node-to-node links plus N node-to-AP links, per the broadcast-sounding mesh — health is per link, not just per node.',
        ),
        links.length === 0
          ? emptyState('No CSI records observed on any link in this window — the mesh looks dead, or ingest has not started.')
          : h(
              'table',
              {},
              h('thead', {}, h('tr', {}, h('th', {}, 'Node'), h('th', {}, 'Src MAC'), h('th', {}, 'Dst MAC'), h('th', {}, 'Records'), h('th', {}, 'Last seen'), h('th', {}, 'Status'))),
              h(
                'tbody',
                {},
                ...links.map((l) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, String(l.nodeId)),
                    h('td', {}, l.srcMac),
                    h('td', {}, l.dstMac),
                    h('td', {}, String(l.recordCount)),
                    h('td', {}, formatRelative(l.lastSeenAt)),
                    h('td', {}, livenessBadge(l.lastSeenAt)),
                  ),
                ),
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
