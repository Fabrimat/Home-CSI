/**
 * The read/write surface the API needs from the database, expressed as an
 * interface so route tests can substitute an in-memory fake and run with
 * no live database (see packages/db's own migrationRunner.test.ts for the
 * pattern this follows). `PgHomeCsiDb` (pgDb.ts) is the real
 * TimescaleDB-backed implementation used by `startServer`.
 */

export interface NodeLiveness {
  id: number;
  name: string;
  room: string;
  expectedMac: string | null;
  createdAt: string;
  /** ISO timestamp of the most recent heartbeat from this node, or null if none seen. */
  lastHeartbeatAt: string | null;
  /** ISO timestamp of the most recent CSI record attributed to this node, or null. */
  lastCsiRecordAt: string | null;
}

export interface HeartbeatRow {
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

export interface LinkSummary {
  nodeId: number;
  srcMac: string;
  dstMac: string;
  recordCount: number;
  lastSeenAt: string;
}

export interface CsiPoint {
  time: string;
  rssi: number;
  noiseFloor: number;
  csiFormat: number;
  /** Per-subcarrier amplitude, length derived from the record's own byte length. */
  amplitudes: number[];
}

export interface FeatureRow {
  time: string;
  nodeId: number;
  linkMac: string | null;
  windowMs: number;
  featureVector: Record<string, unknown>;
}

/**
 * Why an `occupancy_states` row exists (`row_kind`, migration 006). The
 * column has a CHECK constraint admitting exactly these two values.
 *  - `transition`: the estimate and/or the latch's state label changed here.
 *  - `keepalive`: nothing changed, but the pipeline was observing — proof
 *    that a quiet stretch is quiet rather than missing. Carries no details.
 */
export type OccupancyRowKind = 'transition' | 'keepalive';

/**
 * One row of the sparse occupancy event log. Rows are events, not samples:
 * consumers must carry the last value forward until the next row (step
 * semantics), never interpolate or assume a fixed cadence.
 */
export interface OccupancyRow {
  time: string;
  estimate: number;
  confidence: number;
  state: string;
  kind: OccupancyRowKind;
  details: Record<string, unknown> | null;
}

export interface LabelSessionRow {
  id: number;
  startedAt: string;
  endedAt: string | null;
  notes: string | null;
}

/**
 * Explicit label provenance (migration 008's `labels.source` CHECK
 * constraint admits exactly these four values) -- mirrors
 * `@homecsi/labeling`'s `LabelSource` (sessions.ts), duplicated here rather
 * than imported so this package's wire contract doesn't take on a runtime
 * dependency on @homecsi/labeling's internal type just for a string union.
 */
export type LabelSource = 'manual' | 'weak:phone-presence' | 'confirmed' | 'training';

export interface LabelRow {
  id: number;
  sessionId: number;
  /** ISO-8601. Interval START, or the instant for a point label. */
  time: string;
  /** ISO-8601, EXCLUSIVE end. `null` means a point label (migration 008). */
  endTime: string | null;
  occupancyCount: number;
  source: LabelSource;
  notes: string | null;
}

export interface StatusSummary {
  dbReachable: boolean;
  windowMs: number;
  nodeCount: number;
  liveNodeCount: number;
  latestOccupancy: OccupancyRow | null;
  recentCsiRecordCount: number;
  recentHeartbeatCount: number;
}

export interface TimeRange {
  from: Date;
  to: Date;
}

/**
 * Result of `HomeCsiDb.updateLabelEndTime`. A discriminated union rather
 * than `null`/throw so the route can distinguish "no such label" (404)
 * from "the requested endTime is not after the label's own time" (400)
 * without a second query to re-fetch the label just to check.
 */
export type UpdateLabelEndTimeResult =
  | { status: 'updated'; label: LabelRow }
  | { status: 'not-found' }
  | { status: 'invalid-end-time' };

export interface HomeCsiDb {
  /** Round-trips a trivial query; used for the unauthenticated liveness route too. */
  healthCheck(): Promise<boolean>;

  listNodes(): Promise<NodeLiveness[]>;

  listHeartbeats(params: TimeRange & { nodeId: number; limit: number }): Promise<HeartbeatRow[]>;

  /** New heartbeats for one node since `since`, bounded by `limit`. */
  pollHeartbeats(params: { nodeId: number; since: Date; limit: number }): Promise<HeartbeatRow[]>;

  /** Links observed within the last `sinceMs` milliseconds, most recent first. */
  listLinks(params: { sinceMs: number; limit: number }): Promise<LinkSummary[]>;

  /**
   * Server-downsampled CSI records for one link: at most `maxPoints`
   * representative records spread evenly across [from, to).
   */
  listCsiRecords(
    params: TimeRange & { nodeId: number; srcMac: string; dstMac: string; maxPoints: number },
  ): Promise<CsiPoint[]>;

  /** New CSI records for one link since `since`, bounded by `limit`. */
  pollCsiRecords(
    params: { nodeId: number; srcMac: string; dstMac: string; since: Date; limit: number },
  ): Promise<CsiPoint[]>;

  listFeatures(
    params: TimeRange & { nodeId: number; linkMac?: string; maxPoints: number },
  ): Promise<FeatureRow[]>;

  /**
   * Occupancy events in [from, to), ascending, **plus a carry-in row**: the
   * last event at or before `from`, returned with its real (pre-window)
   * timestamp. Without it a window containing no transitions would come back
   * empty and the UI would render "no data" for a house that has been
   * occupied for three hours.
   *
   * `limit` now bounds *events*, not samples. When rows were written every
   * 500 ms, trimming dropped redundant samples; now every row is a semantic
   * event, so trimming silently drops transitions. Implementations keep the
   * newest events and the carry-in.
   */
  listOccupancyStates(params: TimeRange & { limit: number }): Promise<OccupancyRow[]>;

  pollOccupancyStates(params: { since: Date; limit: number }): Promise<OccupancyRow[]>;

  /**
   * The most recent occupancy event, however old — the current state under
   * step semantics. Used for the WebSocket initial snapshot: with a sparse
   * log, a fresh subscriber would otherwise see nothing until the next
   * transition (up to a keepalive interval away, or longer).
   */
  getLatestOccupancyState(): Promise<OccupancyRow | null>;

  getStatusSummary(windowMs: number): Promise<StatusSummary>;

  listLabelSessions(params: { limit: number }): Promise<LabelSessionRow[]>;

  createLabelSession(params: { startedAt: Date; notes?: string }): Promise<LabelSessionRow>;

  stopLabelSession(params: { id: number; endedAt: Date }): Promise<LabelSessionRow | null>;

  listLabels(
    params: { sessionId: number; limit: number },
  ): Promise<LabelRow[]>;

  /**
   * Labels across ALL sessions whose interval *overlaps* [from, to) --
   * `time < to AND COALESCE(end_time, time) >= from` -- so the dashboard
   * can show existing corrections on the timeline without first picking a
   * session. Ordered `time` ascending. Unlike `listLabels`, this is not
   * scoped to one session.
   */
  listLabelsInRange(params: TimeRange & { limit: number }): Promise<LabelRow[]>;

  createLabel(
    params: {
      sessionId: number;
      time: Date;
      /** EXCLUSIVE end of the labelled interval; omitted (or undefined) means a point label. */
      endTime?: Date;
      occupancyCount: number;
      /** Defaults to `'manual'` when omitted, matching migration 008's column default. */
      source?: LabelSource;
      notes?: string;
    },
  ): Promise<LabelRow>;

  /**
   * Updates only a label's `end_time` -- used by brief B14's training mode
   * to close a previously-open declaration when the operator declares the
   * next state. Returns a discriminated result rather than `null`/throw so
   * the route can tell "no such label" (404) apart from "the requested
   * endTime is not after the label's own time" (400) without a second
   * round-trip to re-fetch the label.
   */
  updateLabelEndTime(params: { id: number; endTime: Date }): Promise<UpdateLabelEndTimeResult>;
}
