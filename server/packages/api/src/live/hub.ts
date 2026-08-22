import type { WebSocket } from 'ws';
import type { HomeCsiDb } from '../db/types.js';

export type LiveChannel = 'csi' | 'occupancy' | 'heartbeat';

export interface LiveSubscription {
  channel: LiveChannel;
  /** Required for 'csi' and 'heartbeat'; ignored for 'occupancy' (whole-house). */
  nodeId?: number;
  /** Required for 'csi'. */
  srcMac?: string;
  /** Required for 'csi'. */
  dstMac?: string;
}

const POLL_INTERVAL_MS = 750;
/** Bound on rows fetched per poll tick, per feed — a fast producer cannot force an unbounded query. */
const MAX_ROWS_PER_TICK = 500;

function feedKey(sub: LiveSubscription): string {
  switch (sub.channel) {
    case 'csi':
      return `csi:${sub.nodeId}:${sub.srcMac}:${sub.dstMac}`;
    case 'heartbeat':
      return `heartbeat:${sub.nodeId}`;
    case 'occupancy':
      return 'occupancy';
  }
}

/** Validates that a subscription request carries the parameters its channel needs. */
export function isValidSubscription(sub: LiveSubscription): boolean {
  if (sub.channel === 'csi') {
    return typeof sub.nodeId === 'number' && !!sub.srcMac && !!sub.dstMac;
  }
  if (sub.channel === 'heartbeat') {
    return typeof sub.nodeId === 'number';
  }
  return true;
}

interface Feed {
  sub: LiveSubscription;
  subscribers: Set<WebSocket>;
  since: Date;
  timer: ReturnType<typeof setInterval>;
  polling: boolean;
  /**
   * Sockets still owed the one-time initial snapshot. Occupancy only — see
   * LiveHub.tick. Per-socket rather than per-feed so a socket that joins an
   * already-running feed is also caught up.
   */
  pendingSnapshot: Set<WebSocket>;
}

/**
 * Fan-out hub for live data over WebSocket.
 *
 * The ingest/occupancy/features pipelines run as separate OS processes
 * (docs/architecture.md) so this API process has no in-process event feed
 * to subscribe to. Instead each distinct (channel, link/node) subscription
 * is backed by exactly one shared DB poller (regardless of how many
 * sockets asked for it), polling for rows newer than the last-seen cursor
 * on a fixed interval and bounded by MAX_ROWS_PER_TICK. This is both the
 * server-side rate limit (a socket can receive at most one coalesced batch
 * per POLL_INTERVAL_MS) and the coalescing (all rows produced since the
 * last tick arrive in a single message).
 *
 * One exception to "rows newer than the cursor": `occupancy` is a sparse
 * *event* log, not a dense sample stream. A subscriber's cursor starts at
 * "now", so with nothing but a poll it would see an empty panel until the
 * next transition — potentially hours. Each new occupancy subscriber
 * therefore gets a one-time `snapshot` message carrying the latest row
 * (whatever its age) before normal polling continues. Dense channels get no
 * snapshot: there, a stale row is noise, not state.
 */
export class LiveHub {
  private readonly feeds = new Map<string, Feed>();
  private readonly socketFeeds = new Map<WebSocket, Set<string>>();

  constructor(
    private readonly db: HomeCsiDb,
    private readonly logger: { warn: (obj: unknown, msg?: string) => void },
  ) {}

  subscribe(socket: WebSocket, sub: LiveSubscription): void {
    const key = feedKey(sub);
    let feed = this.feeds.get(key);
    if (!feed) {
      feed = {
        sub,
        subscribers: new Set(),
        since: new Date(),
        polling: false,
        pendingSnapshot: new Set(),
        timer: setInterval(() => {
          void this.tick(key);
        }, POLL_INTERVAL_MS),
      };
      this.feeds.set(key, feed);
    }
    feed.subscribers.add(socket);
    if (sub.channel === 'occupancy') feed.pendingSnapshot.add(socket);

    let keys = this.socketFeeds.get(socket);
    if (!keys) {
      keys = new Set();
      this.socketFeeds.set(socket, keys);
    }
    keys.add(key);
  }

  unsubscribe(socket: WebSocket, sub: LiveSubscription): void {
    this.removeFromFeed(socket, feedKey(sub));
  }

  /** Call on socket close/error to release every feed it was subscribed to. */
  removeSocket(socket: WebSocket): void {
    const keys = this.socketFeeds.get(socket);
    if (!keys) return;
    for (const key of [...keys]) {
      this.removeFromFeed(socket, key);
    }
    this.socketFeeds.delete(socket);
  }

  private removeFromFeed(socket: WebSocket, key: string): void {
    const feed = this.feeds.get(key);
    if (!feed) return;
    feed.subscribers.delete(socket);
    feed.pendingSnapshot.delete(socket);
    this.socketFeeds.get(socket)?.delete(key);
    if (feed.subscribers.size === 0) {
      clearInterval(feed.timer);
      this.feeds.delete(key);
    }
  }

  private async tick(key: string): Promise<void> {
    const feed = this.feeds.get(key);
    if (!feed || feed.polling || feed.subscribers.size === 0) return;
    feed.polling = true;
    try {
      await this.sendPendingSnapshots(feed, key);

      const since = feed.since;
      let rows: Array<{ time: string }>;
      switch (feed.sub.channel) {
        case 'csi':
          rows = await this.db.pollCsiRecords({
            nodeId: feed.sub.nodeId as number,
            srcMac: feed.sub.srcMac as string,
            dstMac: feed.sub.dstMac as string,
            since,
            limit: MAX_ROWS_PER_TICK,
          });
          break;
        case 'heartbeat':
          rows = await this.db.pollHeartbeats({
            nodeId: feed.sub.nodeId as number,
            since,
            limit: MAX_ROWS_PER_TICK,
          });
          break;
        case 'occupancy':
          rows = await this.db.pollOccupancyStates({ since, limit: MAX_ROWS_PER_TICK });
          break;
      }
      if (rows.length === 0) return;
      const last = rows[rows.length - 1];
      if (last) feed.since = new Date(last.time);

      const message = JSON.stringify({ type: 'data', channel: feed.sub.channel, key, records: rows });
      for (const socket of feed.subscribers) {
        this.sendCoalesced(socket, message);
      }
    } catch (err) {
      this.logger.warn({ err, key }, 'live feed poll failed');
    } finally {
      feed.polling = false;
    }
  }

  /**
   * Delivers the one-time initial occupancy snapshot to any socket still
   * owed one. Sockets are only marked as served once the send has actually
   * happened, so a failed DB read simply retries on the next tick instead of
   * silently leaving a subscriber with a blank panel.
   */
  private async sendPendingSnapshots(feed: Feed, key: string): Promise<void> {
    if (feed.sub.channel !== 'occupancy' || feed.pendingSnapshot.size === 0) return;
    const targets = [...feed.pendingSnapshot];
    const latest = await this.db.getLatestOccupancyState();
    if (latest) {
      const message = JSON.stringify({
        type: 'data',
        channel: feed.sub.channel,
        key,
        snapshot: true,
        records: [latest],
      });
      for (const socket of targets) this.sendCoalesced(socket, message);
    }
    for (const socket of targets) feed.pendingSnapshot.delete(socket);
  }

  /**
   * Backpressure handling: if a socket's outbound buffer is still full of a
   * previous message, we drop this tick's batch for that socket rather than
   * queueing unboundedly in-process — the next tick's `since` cursor has
   * already moved on, so the client simply receives the next coalesced
   * batch instead of an ever-growing backlog.
   */
  private sendCoalesced(socket: WebSocket, message: string): void {
    const MAX_BUFFERED_BYTES = 1_000_000;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
    socket.send(message);
  }
}
