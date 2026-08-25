/**
 * The read/write surface the API needs from the database, expressed as an
 * interface so route tests can substitute an in-memory fake and run with
 * no live database (see packages/db's own migrationRunner.test.ts for the
 * pattern this follows). `PgHomeCsiDb` (pgDb.ts) is the real
 * TimescaleDB-backed implementation used by `startServer`.
 */

/** {x, y} in METRES on one floor's own operator-chosen origin -- see packages/config's `nodeSchema` for the full contract. Never used for localisation, only geometry/drawing. */
export interface NodePosition {
  x: number;
  y: number;
}

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
  /** Signed floor index (basement negative); defaults to 0 (migration 010). */
  floor: number;
  /** Relative position on this node's floor, or `null` if not yet placed (migration 010: `pos_x`/`pos_y` are both nullable). */
  position: NodePosition | null;
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

/**
 * `event_annotations.category` CHECK constraint's exact admitted values
 * (migration 009). Deliberately has NO `activity` value -- a person doing
 * something at home is occupancy signal, not a confounder, and belongs in
 * `labels` via `POST /api/labels/corrections` instead (see migration 009's
 * comment header).
 */
export type AnnotationCategory = 'appliance' | 'door' | 'hvac' | 'pet' | 'interference' | 'other';

/** `event_annotations.source` CHECK constraint (migration 009) -- 'manual' is the only value any code path writes today. */
export type AnnotationSource = 'manual';

/**
 * A categorised, point-or-interval marker that something non-occupant
 * happened -- a microwave, a door, the HVAC -- WITHOUT asserting an
 * occupancy count (migration 009). Deliberately NOT a `LabelRow`: see that
 * migration's comment header for why annotations live in their own table
 * rather than as a `labels` variant.
 */
export interface AnnotationRow {
  id: number;
  /** ISO-8601. Interval START, or the instant for a point annotation. */
  time: string;
  /** ISO-8601, EXCLUSIVE end. `null` means a point annotation. */
  endTime: string | null;
  category: AnnotationCategory;
  label: string | null;
  notes: string | null;
  source: AnnotationSource;
  createdAt: string;
}

/**
 * Everything `GET /api/coverage` (routes/coverage.ts) needs from one window,
 * read in a small, fixed number of aggregate queries rather than the route
 * re-deriving an aggregate from a row-capped listing (`listLabelsInRange`'s
 * `limit` is sized for a per-row dashboard payload, not for an exact
 * coverage total over a multi-day retention window).
 */
export interface CoverageInputs {
  /**
   * One entry per `labels` row whose `source` counts as a genuine human
   * review (`manual`/`confirmed`/`training` -- excludes `weak:phone-
   * presence`, an automated guess, not a review) that overlaps the query
   * window, already clamped to it (`fromMs`/`toMs` are both within
   * [window.from, window.to]). A point label clamps to a zero-width
   * `fromMs === toMs` pair, contributing nothing to covered duration on its
   * own but still real -- callers merge these into a coverage total, this
   * type just carries the raw, clamped intervals.
   */
  reviewedIntervals: { fromMs: number; toMs: number }[];
  /** Count of `labels` rows overlapping the window, grouped by `source` -- every source seen, not just the ones the route currently surfaces. */
  labelSourceCounts: Partial<Record<LabelSource, number>>;
  /** Count of `event_annotations` rows overlapping the window. */
  annotationCount: number;
  /** Distinct `event_annotations.category` values seen overlapping the window. */
  annotationCategories: AnnotationCategory[];
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

  /**
   * Label sessions, newest `started_at` first. Both filters are optional and
   * additive: `open` narrows to running (`true`) or stopped (`false`)
   * sessions, `notesPrefix` to sessions whose `notes` start with that exact
   * literal (no LIKE metacharacter semantics). Omitting both is the original
   * "newest N sessions" behaviour.
   *
   * The filters exist so a caller can ask "is there an open `[training]`
   * session?" directly rather than paging the newest N and scanning -- see
   * `GET /api/labels/sessions`' query schema for why scanning is unsafe.
   */
  listLabelSessions(params: { limit: number; open?: boolean; notesPrefix?: string }): Promise<LabelSessionRow[]>;

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

  /**
   * Annotations across ALL categories overlapping [from, to) -- same
   * overlap predicate as `listLabelsInRange` (migration 009's index mirrors
   * `idx_labels_time_range` for the same reason). Ordered `time` ascending.
   */
  listAnnotationsInRange(params: TimeRange & { limit: number }): Promise<AnnotationRow[]>;

  createAnnotation(params: {
    time: Date;
    /** EXCLUSIVE end of the annotated interval; omitted (or undefined) means a point annotation. */
    endTime?: Date;
    category: AnnotationCategory;
    label?: string;
    notes?: string;
    /** Defaults to `'manual'` when omitted, matching migration 009's column default. */
    source?: AnnotationSource;
  }): Promise<AnnotationRow>;

  /**
   * Deletes one annotation by id. Returns whether a row actually existed to
   * delete -- unlike `labels` (append-only by design), annotations are not
   * part of the dataset export, so deleting one carries none of the
   * "quietly changed the training corpus" risk that rules out delete for
   * `labels`; a fast one-tap annotation UI needs an undo for mis-taps more
   * than it needs an audit trail.
   */
  deleteAnnotation(params: { id: number }): Promise<boolean>;

  /** Aggregate inputs for `GET /api/coverage` -- see `CoverageInputs`. */
  getCoverageInputs(params: TimeRange): Promise<CoverageInputs>;

  /**
   * Per-(node, link_mac) motion summary for GET /api/topology
   * (routes/topology.ts), aggregated in SQL over [from, to) -- `features`
   * is a high-volume hypertable (docs/architecture.md "Data lifecycle"),
   * so this must never degrade into pulling raw feature rows into Node to
   * reduce there. Bounded by `limit` distinct links, same rationale as
   * `listLinks`. See `LinkMotionSummary` for field semantics.
   */
  listLinkMotion(params: TimeRange & { limit: number }): Promise<LinkMotionSummary[]>;
}

/**
 * One link's motion signal, summarised over a requested window from the
 * REAL `feature_vector` field names `@homecsi/features` writes
 * (packages/features/src/featureVector.ts's `LinkFeatureVector`) -- NOT
 * renamed or reinterpreted here. `baselineDeviation` is the primary,
 * baseline-relative motion signal (comparable across links regardless of
 * each link's own noise floor); `baselineFrozen` is that link's own local
 * Schmitt-triggered "is this window motion" classification (true also means
 * the adaptive baseline was NOT updated from this window -- see
 * baseline.ts). This is link-path motion attribution, never a person count
 * or position (docs/architecture.md "Motion, not people", "Amplitude-first").
 */
export interface LinkMotionSummary {
  /** The observing node (this link's (node_id, link_mac) key -- see @homecsi/features's CsiRecordRow doc). */
  nodeId: number;
  /** The transmitting peer's MAC, as captured -- may or may not resolve to a configured node (see routes/topology.ts's `peerNodeId` resolution). */
  linkMac: string;
  /** Mean of |feature_vector.baselineDeviation| across every window observed for this link in [from, to). */
  meanAbsDeviation: number;
  /** feature_vector.baselineFrozen of the most recent window in range -- this link's own local motion classification as of "now" within the window. */
  motionActive: boolean;
  /** Number of feature-vector windows this summary was aggregated from. */
  sampleCount: number;
  /** ISO timestamp of the most recent window aggregated. */
  lastSeenAt: string;
}
