import type { WebSocket } from 'ws';
import type { HomeCsiDb } from '../db/types.js';
import { DEFAULT_DEVICE_MODE_CONFIG } from '../realtime/deviceModeStore.js';

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
/**
 * How fast the `csi` channel polls while at least one `box_sessions` row is
 * open (brief B1's box-experiment realtime view) — fast enough to watch a
 * hand move, which `POLL_INTERVAL_MS` (750ms) is not. Built-in default when
 * `config.realtime.liveView.burstPollIntervalMs` is omitted (see
 * packages/config/src/schema.ts's `realtimeSchema`). Only `csi` speeds up;
 * `occupancy`/`heartbeat` keep polling at `POLL_INTERVAL_MS` regardless —
 * a box take is a CSI-only concern.
 */
const DEFAULT_BURST_POLL_INTERVAL_MS = 150;
/** How often LiveHub itself checks whether a box_sessions row is open, independent of any one feed's own poll cadence. */
const BOX_SESSION_CHECK_INTERVAL_MS = 1000;
/**
 * Built-in fallback for how old an open `box_sessions` row may be before
 * it's treated as abandoned (see `hasOpenBoxSession`'s doc comment,
 * db/types.ts) -- reuses `DEFAULT_DEVICE_MODE_CONFIG.maxDurationS` (the
 * realtime control plane's own hard cap, converted to ms) rather than a
 * second constant, so "how long can a realtime/box-take window possibly
 * last" has one answer regardless of which config key is actually set.
 */
const DEFAULT_MAX_BOX_SESSION_AGE_MS = DEFAULT_DEVICE_MODE_CONFIG.maxDurationS * 1000;

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
  /**
   * Optional (rather than always-present) because a brand-new Feed is
   * constructed and registered in `this.feeds` *before* its first timer is
   * armed (see `subscribe`/`scheduleNextTick`) — there is a brief window
   * with no timer at all, not a stale one.
   */
  timer?: ReturnType<typeof setTimeout>;
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
  private readonly normalPollIntervalMs: number;
  private readonly burstPollIntervalMs: number;
  /**
   * An open box_sessions row older than this reads as CLOSED -- an
   * abandoned session (operator closed the tab mid-take, a crash) must
   * self-heal instead of holding the `csi` channel at the fast interval
   * forever. See `DEFAULT_MAX_BOX_SESSION_AGE_MS`'s own comment for why
   * the default reuses the realtime control plane's own duration cap.
   */
  private readonly maxBoxSessionAgeMs: number;
  /** Cached answer to "is a box_sessions row open", refreshed on its own timer below — a synchronous read from the hot per-feed scheduling path never itself awaits a DB round-trip. */
  private boxSessionOpen = false;
  private readonly boxSessionCheckTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly db: HomeCsiDb,
    private readonly logger: { warn: (obj: unknown, msg?: string) => void },
    options: {
      normalPollIntervalMs?: number;
      burstPollIntervalMs?: number;
      boxSessionCheckIntervalMs?: number;
      maxBoxSessionAgeMs?: number;
    } = {},
  ) {
    this.normalPollIntervalMs = options.normalPollIntervalMs ?? POLL_INTERVAL_MS;
    this.burstPollIntervalMs = options.burstPollIntervalMs ?? DEFAULT_BURST_POLL_INTERVAL_MS;
    this.maxBoxSessionAgeMs = options.maxBoxSessionAgeMs ?? DEFAULT_MAX_BOX_SESSION_AGE_MS;
    this.boxSessionCheckTimer = setInterval(
      () => void this.refreshBoxSessionState(),
      options.boxSessionCheckIntervalMs ?? BOX_SESSION_CHECK_INTERVAL_MS,
    ).unref();
  }

  private async refreshBoxSessionState(): Promise<void> {
    try {
      // Optional chaining, not a hard dependency: a `HomeCsiDb` fake built
      // before this method existed (older tests) simply never bypasses
      // POLL_INTERVAL_MS -- the safe default, same posture as
      // CLOSED_BOX_SESSION_GATE on the ingest side.
      this.boxSessionOpen = (await this.db.hasOpenBoxSession?.(this.maxBoxSessionAgeMs)) ?? false;
    } catch (err) {
      this.logger.warn({ err }, 'box_sessions open-row check failed; keeping last known answer');
    }
  }

  /** The delay used for this feed's NEXT tick — re-evaluated every time, so a channel already ticking picks up a mode change on its very next cycle rather than needing its timer torn down and rebuilt. */
  private pollIntervalFor(sub: LiveSubscription): number {
    return sub.channel === 'csi' && this.boxSessionOpen ? this.burstPollIntervalMs : this.normalPollIntervalMs;
  }

  /**
   * Arms the NEXT timer for this exact `feed` instance, tied to the
   * instance itself rather than a fresh `this.feeds.get(key)` lookup.
   *
   * Why identity, not a key re-lookup: `removeFromFeed` clears a feed's
   * timer and deletes it from `this.feeds` only once its last subscriber
   * leaves — but a tick already in flight (awaiting a DB round trip) at
   * that moment can't be cancelled, only let run to completion. If a new
   * subscriber immediately resubscribes to the SAME feed key before that
   * in-flight tick's `.finally` runs, `subscribe` (below) creates a fresh
   * `Feed` object and arms its own independent timer chain. The old tick's
   * `.finally` would then, if it re-looked-up `this.feeds.get(key)`, find
   * that brand-new feed and arm a SECOND timer for it — two permanent
   * polling chains racing on one feed key, each firing on its own
   * schedule, roughly doubling the effective poll rate forever (not a
   * transient glitch: every future tick of the orphaned chain repeats this
   * same re-lookup-and-rearm mistake). Comparing `this.feeds.get(key)` to
   * the specific `feed` object this call was scheduled for detects exactly
   * that supersession (or an outright removal) and lets the stale chain
   * die here instead of re-arming — the new feed's own chain, armed
   * directly by `subscribe`, is unaffected either way.
   */
  private scheduleNextTick(feed: Feed, key: string): void {
    if (this.feeds.get(key) !== feed) return;
    feed.timer = setTimeout(() => {
      void this.tick(feed, key).finally(() => this.scheduleNextTick(feed, key));
    }, this.pollIntervalFor(feed.sub));
  }

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
      };
      this.feeds.set(key, feed);
      // Registered before arming its first timer so scheduleNextTick's own
      // identity check (`this.feeds.get(key) !== feed`) passes here too —
      // one code path arms every timer for a feed, first tick included.
      this.scheduleNextTick(feed, key);
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
      if (feed.timer) clearTimeout(feed.timer);
      this.feeds.delete(key);
    }
  }

  /**
   * Runs one poll for the specific `feed` instance this was scheduled for.
   * Takes `feed` directly (not a fresh `this.feeds.get(key)`) for the same
   * reason `scheduleNextTick` does — see that method's doc comment — and
   * re-checks identity itself rather than trusting the caller, since a
   * timer callback can fire after its feed was superseded/removed with no
   * way to have been cancelled in the meantime (see the comment on
   * `scheduleNextTick`).
   */
  private async tick(feed: Feed, key: string): Promise<void> {
    if (this.feeds.get(key) !== feed || feed.polling || feed.subscribers.size === 0) return;
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
