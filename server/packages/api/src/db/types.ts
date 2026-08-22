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

export interface OccupancyRow {
  time: string;
  estimate: number;
  confidence: number;
  state: string;
  details: Record<string, unknown> | null;
}

export interface LabelSessionRow {
  id: number;
  startedAt: string;
  endedAt: string | null;
  notes: string | null;
}

export interface LabelRow {
  id: number;
  sessionId: number;
  time: string;
  occupancyCount: number;
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

  listOccupancyStates(params: TimeRange & { limit: number }): Promise<OccupancyRow[]>;

  pollOccupancyStates(params: { since: Date; limit: number }): Promise<OccupancyRow[]>;

  getStatusSummary(windowMs: number): Promise<StatusSummary>;

  listLabelSessions(params: { limit: number }): Promise<LabelSessionRow[]>;

  createLabelSession(params: { startedAt: Date; notes?: string }): Promise<LabelSessionRow>;

  stopLabelSession(params: { id: number; endedAt: Date }): Promise<LabelSessionRow | null>;

  listLabels(
    params: { sessionId: number; limit: number },
  ): Promise<LabelRow[]>;

  createLabel(
    params: { sessionId: number; time: Date; occupancyCount: number; notes?: string },
  ): Promise<LabelRow>;
}
