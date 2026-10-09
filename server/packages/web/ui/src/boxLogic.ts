/**
 * DOM-free logic behind the Box experiment view (`views/box.ts`): realtime
 * mode display rules, per-node pickup status, per-lane liveness, dataset
 * readiness, and the CSI feed-key format the live strip routes incoming
 * WebSocket frames by.
 *
 * Split out from the view for the same reason as `featureScale.ts` /
 * `groundTruthLogic.ts`: these are rules a reviewer needs to trust without
 * reading a canvas-drawing view, and they are only testable if they don't
 * need one.
 */

// ==== Realtime mode ========================================================

export type RealtimeMode = 'normal' | 'realtime' | 'unknown';

/**
 * What mode to actually SHOW, given what the server reported.
 *
 * `knownSinceRestart: false` means the hub itself does not yet know what
 * every node currently has applied (it just restarted and lost the picture
 * of who was mid-burst) -- rendering the server's `mode` value verbatim in
 * that state would show "normal" as a confirmed fact when a node may still be
 * bursting under a deadline set before the restart. This is the one place
 * that distinction is enforced, so the view cannot accidentally skip it.
 */
export function displayMode(mode: RealtimeMode, knownSinceRestart: boolean): RealtimeMode {
  if (!knownSinceRestart) return 'unknown';
  return mode;
}

/** A node picks up a new mode on its own next poll of the hub -- this is that cadence, for the "give it about a minute" copy in the view. */
export const NODE_CONFIG_POLL_INTERVAL_MS = 60_000;

/**
 * Whether a `role="status"` node's text should actually be reassigned (and
 * therefore actually re-announced by a screen reader) given its previous
 * announced value. Reassigning the SAME text on every tick of a poll/redraw
 * loop still triggers many screen readers to re-announce it -- this is the
 * exact bug `views/houseMap.ts`'s `updateStatusSummary` guards against with
 * its own `lastStatusText` check (`text === lastStatusText` -> skip the
 * write), pulled out here as a small pure rule so the view's realtime-mode
 * and recording-state announcements can use the same guard, tested, rather
 * than each view re-deriving "only on change" ad hoc.
 */
export function shouldAnnounce(previousText: string, nextText: string): boolean {
  return previousText !== nextText;
}

/** The subset of `GET /api/realtime`'s per-node row the pickup rule needs. */
export interface RealtimeNodeState {
  nodeId: number;
  lastPolledAt: string | null;
  appliedRevision: number | null;
}

export type PickupStatus = 'applied' | 'pending' | 'unseen';

/**
 * Whether a specific node has actually applied the CURRENT revision, is
 * known to exist but hasn't caught up yet, or has never been observed
 * polling at all. `'unseen'` is distinct from `'pending'` on purpose: a node
 * that has never polled might be powered off, not just running one poll
 * cycle behind -- collapsing the two would tell the operator "it's coming"
 * about a node that may not be coming at all.
 */
export function nodePickupStatus(node: RealtimeNodeState, targetRevision: number): PickupStatus {
  if (node.lastPolledAt === null) return 'unseen';
  return node.appliedRevision === targetRevision ? 'applied' : 'pending';
}

// ==== Live strip lanes ======================================================

/** How long since a lane's last CSI record before it is shown as silent rather than live. */
export const LANE_SILENT_AFTER_MS = 4_000;

export type LaneStatus = 'no-link' | 'live' | 'silent';

/**
 * Whether a lane is drawing genuinely fresh data. `null` means no link has
 * ever been found for this node -- distinct from a link that WAS live and
 * has since gone quiet, because the operator's next move differs (check
 * wiring/power vs. "it just stopped moving").
 */
export function laneStatus(lastRecordAtMs: number | null, nowMs: number, silentAfterMs = LANE_SILENT_AFTER_MS): LaneStatus {
  if (lastRecordAtMs === null) return 'no-link';
  return nowMs - lastRecordAtMs > silentAfterMs ? 'silent' : 'live';
}

/**
 * The feed key the API's live hub assigns to a `csi` subscription
 * (`packages/api/src/live/hub.ts`'s `feedKey`, verified against that source
 * rather than guessed): `csi:<nodeId>:<srcMac>:<dstMac>`. The box view holds
 * several concurrent subscriptions (one per box node), so an incoming
 * `data` message has to be routed to the right lane by this key -- unlike
 * the waterfall view, which only ever has one subscription open and can
 * assume any `csi` message is for it.
 */
export function csiFeedKey(nodeId: number, srcMac: string, dstMac: string): string {
  return `csi:${nodeId}:${srcMac}:${dstMac}`;
}

/**
 * 5th/95th percentile clip across every amplitude sample currently on
 * screen, so one outlier reading doesn't wash out a lane's whole colour
 * range. Same technique as `views/waterfall.ts`'s `robustRange`, generalised
 * to a flat list of amplitude arrays and pulled out here (rather than
 * imported from that view, which does not export it) so it is unit-tested
 * once and reused by every lane in the strip.
 */
export function robustAmplitudeRange(columns: readonly number[][]): [number, number] {
  const values: number[] = [];
  for (const col of columns) {
    for (const v of col) values.push(v);
  }
  if (values.length === 0) return [0, 1];
  values.sort((a, b) => a - b);
  const lo = values[Math.floor(values.length * 0.05)] ?? values[0] ?? 0;
  const hi = values[Math.ceil(values.length * 0.95) - 1] ?? values[values.length - 1] ?? 1;
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

// ==== Dataset readiness =====================================================

/** One row of `GET /api/box/summary`'s `classes`. */
export interface ClassSummary {
  gestureClass: string;
  takeCount: number;
  totalRecords: number;
}

export interface ClassReadiness extends ClassSummary {
  ready: boolean;
  /** How many more takes this class needs, 0 once it is ready. */
  remaining: number;
}

/** Whether a gesture class has enough takes to train on, and how many more it needs if not. */
export function classReadiness(cls: ClassSummary, minTakesPerClass: number): ClassReadiness {
  const remaining = Math.max(0, minTakesPerClass - cls.takeCount);
  return { ...cls, ready: remaining === 0, remaining };
}

/** The three numbers `lastTraining` carries, minus its `confusion` matrix (rendered separately -- its shape is not fixed). */
export interface TrainingAccuracy {
  accuracy: number;
  majorityBaseline: number;
  randomBaseline: number;
}

/**
 * "62% accuracy (vs 41% majority-class baseline, 20% random baseline)" --
 * the one line every caller must use to show accuracy, so a bare accuracy
 * number can never be rendered without the two baselines next to it. All
 * three are assumed to be fractions in [0, 1], matching every other
 * confidence/fraction field in this dashboard (`occ.confidence`,
 * `coverage.reviewedFraction`).
 */
export function formatAccuracyComparison(t: TrainingAccuracy): string {
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  return `${pct(t.accuracy)} accuracy (vs ${pct(t.majorityBaseline)} majority-class baseline, ${pct(t.randomBaseline)} random baseline)`;
}
