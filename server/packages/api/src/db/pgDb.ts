import type { DbPool } from '@homecsi/db';
import { healthCheck as pgHealthCheck } from '@homecsi/db';
import { decodeAmplitudes } from './amplitude.js';
import type {
  AnnotationCategory,
  AnnotationRow,
  AnnotationSource,
  CoverageInputs,
  CsiPoint,
  FeatureRow,
  HeartbeatRow,
  HomeCsiDb,
  LabelRow,
  LabelSessionRow,
  LabelSource,
  LinkMotionSummary,
  LinkSummary,
  NodeLiveness,
  OccupancyRow,
  OccupancyRowKind,
  StatusSummary,
  TimeRange,
  UpdateLabelEndTimeResult,
} from './types.js';

interface CsiRecordDbRow {
  time: Date;
  rssi: number;
  noise_floor: number;
  csi_format: number;
  csi_data: Buffer;
}

function toCsiPoint(row: CsiRecordDbRow): CsiPoint {
  return {
    time: row.time.toISOString(),
    rssi: row.rssi,
    noiseFloor: row.noise_floor,
    csiFormat: row.csi_format,
    amplitudes: decodeAmplitudes(row.csi_data),
  };
}

interface OccupancyDbRow {
  time: Date;
  estimate: number;
  confidence: number;
  state: string;
  row_kind: string;
  details: Record<string, unknown> | null;
}

/** `row_kind` is CHECK-constrained to the OccupancyRowKind union by migration 006. */
function toOccupancyRow(row: OccupancyDbRow): OccupancyRow {
  return {
    time: row.time.toISOString(),
    estimate: row.estimate,
    confidence: row.confidence,
    state: row.state,
    kind: row.row_kind as OccupancyRowKind,
    details: row.details,
  };
}

interface LabelDbRow {
  id: string;
  session_id: string;
  time: Date;
  end_time: Date | null;
  occupancy_count: number;
  source: string;
  notes: string | null;
}

/** `source` is CHECK-constrained to the LabelSource union by migration 008. */
function toLabelRow(row: LabelDbRow): LabelRow {
  return {
    id: Number(row.id),
    sessionId: Number(row.session_id),
    time: row.time.toISOString(),
    endTime: row.end_time ? row.end_time.toISOString() : null,
    occupancyCount: row.occupancy_count,
    source: row.source as LabelSource,
    notes: row.notes,
  };
}

interface AnnotationDbRow {
  id: string;
  time: Date;
  end_time: Date | null;
  category: string;
  label: string | null;
  notes: string | null;
  source: string;
  created_at: Date;
}

/** `category`/`source` are CHECK-constrained to their respective unions by migration 009. */
function toAnnotationRow(row: AnnotationDbRow): AnnotationRow {
  return {
    id: Number(row.id),
    time: row.time.toISOString(),
    endTime: row.end_time ? row.end_time.toISOString() : null,
    category: row.category as AnnotationCategory,
    label: row.label,
    notes: row.notes,
    source: row.source as AnnotationSource,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Shared overlap predicate for a "does [time, COALESCE(end_time, time)) touch
 * [$1, $2)" query, identical in shape to `labels`' own (see
 * `PgHomeCsiDb.listLabelsInRange`'s comment for the asymmetric point-vs-
 * interval boundary reasoning) -- reused across `labels` and
 * `event_annotations` queries in this file rather than re-derived per call
 * site, so the two tables' range semantics cannot silently drift apart.
 */
const OVERLAP_PREDICATE = `time < $2
    AND (
      (end_time IS NULL AND time >= $1)
      OR (end_time IS NOT NULL AND end_time > $1)
    )`;

/** Postgres `INTERVAL` literal for a millisecond count, safe to bind as a string parameter. */
function msInterval(ms: number): string {
  return `${Math.max(1, Math.round(ms))} milliseconds`;
}

/**
 * Real TimescaleDB-backed implementation of `HomeCsiDb`. Every query here is
 * either bounded by an explicit LIMIT, restricted to an explicit time
 * range, or both — csi_records/features/heartbeats/occupancy_states are
 * hypertables expected to grow to millions of rows (docs/architecture.md
 * "Data lifecycle").
 */
export class PgHomeCsiDb implements HomeCsiDb {
  constructor(private readonly pool: DbPool) {}

  async healthCheck(): Promise<boolean> {
    return pgHealthCheck(this.pool);
  }

  async listNodes(): Promise<NodeLiveness[]> {
    const result = await this.pool.query<{
      id: number;
      name: string;
      room: string;
      expected_mac: string | null;
      created_at: Date;
      last_heartbeat_at: Date | null;
      last_csi_record_at: Date | null;
      floor: number;
      pos_x: number | null;
      pos_y: number | null;
    }>(
      `SELECT n.id, n.name, n.room, n.expected_mac, n.created_at, n.floor, n.pos_x, n.pos_y,
              hb.time AS last_heartbeat_at,
              csi.time AS last_csi_record_at
       FROM nodes n
       LEFT JOIN LATERAL (
         SELECT time FROM heartbeats WHERE node_id = n.id ORDER BY time DESC LIMIT 1
       ) hb ON true
       LEFT JOIN LATERAL (
         SELECT time FROM csi_records WHERE node_id = n.id ORDER BY time DESC LIMIT 1
       ) csi ON true
       ORDER BY n.id
       LIMIT 500`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      room: row.room,
      expectedMac: row.expected_mac,
      createdAt: row.created_at.toISOString(),
      lastHeartbeatAt: row.last_heartbeat_at ? row.last_heartbeat_at.toISOString() : null,
      lastCsiRecordAt: row.last_csi_record_at ? row.last_csi_record_at.toISOString() : null,
      floor: row.floor,
      // NULL means "not placed" (migration 010) -- never fabricate (0, 0).
      position: row.pos_x !== null && row.pos_y !== null ? { x: row.pos_x, y: row.pos_y } : null,
    }));
  }

  async listHeartbeats(
    params: TimeRange & { nodeId: number; limit: number },
  ): Promise<HeartbeatRow[]> {
    const result = await this.pool.query<{
      time: Date;
      node_id: number;
      uptime_s: number;
      free_heap_bytes: number;
      min_free_heap_bytes: number;
      frames_captured: number;
      frames_dropped: number;
      batches_sent: number;
      send_failures: number;
      rssi_to_ap: number;
      channel: number;
      sntp_synced: boolean;
      fw_version: string;
    }>(
      `SELECT time, node_id, uptime_s, free_heap_bytes, min_free_heap_bytes,
              frames_captured, frames_dropped, batches_sent, send_failures,
              rssi_to_ap, channel, sntp_synced, fw_version
       FROM heartbeats
       WHERE node_id = $1 AND time >= $2 AND time < $3
       ORDER BY time DESC
       LIMIT $4`,
      [params.nodeId, params.from, params.to, params.limit],
    );
    return result.rows.map((row) => ({
      time: row.time.toISOString(),
      nodeId: row.node_id,
      uptimeS: row.uptime_s,
      freeHeapBytes: row.free_heap_bytes,
      minFreeHeapBytes: row.min_free_heap_bytes,
      framesCaptured: row.frames_captured,
      framesDropped: row.frames_dropped,
      batchesSent: row.batches_sent,
      sendFailures: row.send_failures,
      rssiToAp: row.rssi_to_ap,
      channel: row.channel,
      sntpSynced: row.sntp_synced,
      fwVersion: row.fw_version,
    }));
  }

  async pollHeartbeats(params: {
    nodeId: number;
    since: Date;
    limit: number;
  }): Promise<HeartbeatRow[]> {
    const result = await this.pool.query<{
      time: Date;
      node_id: number;
      uptime_s: number;
      free_heap_bytes: number;
      min_free_heap_bytes: number;
      frames_captured: number;
      frames_dropped: number;
      batches_sent: number;
      send_failures: number;
      rssi_to_ap: number;
      channel: number;
      sntp_synced: boolean;
      fw_version: string;
    }>(
      `SELECT time, node_id, uptime_s, free_heap_bytes, min_free_heap_bytes,
              frames_captured, frames_dropped, batches_sent, send_failures,
              rssi_to_ap, channel, sntp_synced, fw_version
       FROM heartbeats
       WHERE node_id = $1 AND time > $2
       ORDER BY time ASC
       LIMIT $3`,
      [params.nodeId, params.since, params.limit],
    );
    return result.rows.map((row) => ({
      time: row.time.toISOString(),
      nodeId: row.node_id,
      uptimeS: row.uptime_s,
      freeHeapBytes: row.free_heap_bytes,
      minFreeHeapBytes: row.min_free_heap_bytes,
      framesCaptured: row.frames_captured,
      framesDropped: row.frames_dropped,
      batchesSent: row.batches_sent,
      sendFailures: row.send_failures,
      rssiToAp: row.rssi_to_ap,
      channel: row.channel,
      sntpSynced: row.sntp_synced,
      fwVersion: row.fw_version,
    }));
  }

  async listLinks(params: { sinceMs: number; limit: number }): Promise<LinkSummary[]> {
    const result = await this.pool.query<{
      node_id: number;
      src_mac: string;
      dst_mac: string;
      record_count: string;
      last_seen_at: Date;
    }>(
      `SELECT node_id, src_mac, dst_mac, count(*)::bigint AS record_count, max(time) AS last_seen_at
       FROM csi_records
       WHERE time > now() - ($1 || ' milliseconds')::interval
       GROUP BY node_id, src_mac, dst_mac
       ORDER BY last_seen_at DESC
       LIMIT $2`,
      [params.sinceMs, params.limit],
    );
    return result.rows.map((row) => ({
      nodeId: row.node_id,
      srcMac: row.src_mac,
      dstMac: row.dst_mac,
      recordCount: Number(row.record_count),
      lastSeenAt: row.last_seen_at.toISOString(),
    }));
  }

  async listCsiRecords(
    params: TimeRange & { nodeId: number; srcMac: string; dstMac: string; maxPoints: number },
  ): Promise<CsiPoint[]> {
    const spanMs = Math.max(1, params.to.getTime() - params.from.getTime());
    const bucketMs = spanMs / Math.max(1, params.maxPoints);
    const result = await this.pool.query<CsiRecordDbRow>(
      `SELECT DISTINCT ON (bucket) bucket, time, rssi, noise_floor, csi_format, csi_data
       FROM (
         SELECT time_bucket(($1 || ' milliseconds')::interval, time) AS bucket,
                time, rssi, noise_floor, csi_format, csi_data
         FROM csi_records
         WHERE node_id = $2 AND src_mac = $3 AND dst_mac = $4
           AND time >= $5 AND time < $6
       ) bucketed
       ORDER BY bucket, time DESC
       LIMIT $7`,
      [bucketMs, params.nodeId, params.srcMac, params.dstMac, params.from, params.to, params.maxPoints],
    );
    return result.rows.map(toCsiPoint).sort((a, b) => a.time.localeCompare(b.time));
  }

  async pollCsiRecords(params: {
    nodeId: number;
    srcMac: string;
    dstMac: string;
    since: Date;
    limit: number;
  }): Promise<CsiPoint[]> {
    const result = await this.pool.query<CsiRecordDbRow>(
      `SELECT time, rssi, noise_floor, csi_format, csi_data
       FROM csi_records
       WHERE node_id = $1 AND src_mac = $2 AND dst_mac = $3 AND time > $4
       ORDER BY time ASC
       LIMIT $5`,
      [params.nodeId, params.srcMac, params.dstMac, params.since, params.limit],
    );
    return result.rows.map(toCsiPoint);
  }

  async listFeatures(
    params: TimeRange & { nodeId: number; linkMac?: string; maxPoints: number },
  ): Promise<FeatureRow[]> {
    const spanMs = Math.max(1, params.to.getTime() - params.from.getTime());
    const bucketMs = spanMs / Math.max(1, params.maxPoints);
    const linkFilter = params.linkMac ? 'AND link_mac = $6' : '';
    const values: unknown[] = [bucketMs, params.nodeId, params.from, params.to, params.maxPoints];
    if (params.linkMac) values.push(params.linkMac);
    const result = await this.pool.query<{
      time: Date;
      node_id: number;
      link_mac: string | null;
      window_ms: number;
      feature_vector: Record<string, unknown>;
    }>(
      `SELECT DISTINCT ON (bucket) bucket, time, node_id, link_mac, window_ms, feature_vector
       FROM (
         SELECT time_bucket(($1 || ' milliseconds')::interval, time) AS bucket,
                time, node_id, link_mac, window_ms, feature_vector
         FROM features
         WHERE node_id = $2 AND time >= $3 AND time < $4 ${linkFilter}
       ) bucketed
       ORDER BY bucket, time DESC
       LIMIT $5`,
      values,
    );
    return result.rows
      .map((row) => ({
        time: row.time.toISOString(),
        nodeId: row.node_id,
        linkMac: row.link_mac,
        windowMs: row.window_ms,
        featureVector: row.feature_vector,
      }))
      .sort((a, b) => a.time.localeCompare(b.time));
  }

  /**
   * Sparse-log read: the events inside [from, to), plus a carry-in event
   * from before it.
   *
   * The carry-in is fetched as its own `time <= from ... LIMIT 1` query
   * rather than by widening the range, deliberately. This query orders DESC
   * and *then* limits, so on a busy range the rows `LIMIT` throws away are
   * the oldest ones — which is exactly the carry-in we are trying to keep.
   *
   * `limit` bounds events, not samples: see HomeCsiDb.listOccupancyStates.
   */
  async listOccupancyStates(params: TimeRange & { limit: number }): Promise<OccupancyRow[]> {
    const [inWindow, carryIn] = await Promise.all([
      this.pool.query<OccupancyDbRow>(
        `SELECT time, estimate, confidence, state, row_kind, details
         FROM occupancy_states
         WHERE time >= $1 AND time < $2
         ORDER BY time DESC
         LIMIT $3`,
        [params.from, params.to, params.limit],
      ),
      this.pool.query<OccupancyDbRow>(
        `SELECT time, estimate, confidence, state, row_kind, details
         FROM occupancy_states
         WHERE time <= $1
         ORDER BY time DESC
         LIMIT 1`,
        [params.from],
      ),
    ]);

    const rows = [...inWindow.rows, ...carryIn.rows]
      .map(toOccupancyRow)
      .sort((a, b) => a.time.localeCompare(b.time));

    // `time <= from` can return a row that is also the first in-window row
    // (an event landing exactly on `from`); occupancy_states has one row per
    // instant (unique index, migration 006), so dedup by timestamp.
    const deduped = rows.filter((row, i) => i === 0 || row.time !== (rows[i - 1] as OccupancyRow).time);

    // The carry-in is context, not a result, but the response still honours
    // `limit` overall: when both together overflow it, the carry-in is kept
    // and the *oldest* in-window events are dropped. Losing them loses
    // transitions outright — see HomeCsiDb.listOccupancyStates.
    if (deduped.length <= params.limit) return deduped;
    return [deduped[0] as OccupancyRow, ...deduped.slice(deduped.length - (params.limit - 1))];
  }

  async pollOccupancyStates(params: { since: Date; limit: number }): Promise<OccupancyRow[]> {
    const result = await this.pool.query<OccupancyDbRow>(
      `SELECT time, estimate, confidence, state, row_kind, details
       FROM occupancy_states
       WHERE time > $1
       ORDER BY time ASC
       LIMIT $2`,
      [params.since, params.limit],
    );
    return result.rows.map(toOccupancyRow);
  }

  async getLatestOccupancyState(): Promise<OccupancyRow | null> {
    const result = await this.pool.query<OccupancyDbRow>(
      `SELECT time, estimate, confidence, state, row_kind, details
       FROM occupancy_states
       ORDER BY time DESC
       LIMIT 1`,
    );
    const row = result.rows[0];
    return row ? toOccupancyRow(row) : null;
  }

  async getStatusSummary(windowMs: number): Promise<StatusSummary> {
    const dbReachable = await this.healthCheck();
    if (!dbReachable) {
      return {
        dbReachable: false,
        windowMs,
        nodeCount: 0,
        liveNodeCount: 0,
        latestOccupancy: null,
        recentCsiRecordCount: 0,
        recentHeartbeatCount: 0,
      };
    }

    const interval = msInterval(windowMs);
    const [nodeCountResult, liveNodeResult, occupancyResult, csiCountResult, heartbeatCountResult] =
      await Promise.all([
        this.pool.query<{ count: string }>('SELECT count(*)::bigint AS count FROM nodes'),
        this.pool.query<{ count: string }>(
          `SELECT count(DISTINCT node_id)::bigint AS count FROM heartbeats
           WHERE time > now() - $1::interval`,
          [interval],
        ),
        // Deliberately unfiltered by recency: under the sparse event log the
        // latest row is the current state no matter how long ago it was
        // written, so a "last N minutes" filter would blank the summary out
        // during exactly the quiet periods it is meant to describe.
        this.pool.query<OccupancyDbRow>(
          'SELECT time, estimate, confidence, state, row_kind, details FROM occupancy_states ORDER BY time DESC LIMIT 1',
        ),
        this.pool.query<{ count: string }>(
          `SELECT count(*)::bigint AS count FROM csi_records WHERE time > now() - $1::interval`,
          [interval],
        ),
        this.pool.query<{ count: string }>(
          `SELECT count(*)::bigint AS count FROM heartbeats WHERE time > now() - $1::interval`,
          [interval],
        ),
      ]);

    const occupancyRow = occupancyResult.rows[0];

    return {
      dbReachable: true,
      windowMs,
      nodeCount: Number(nodeCountResult.rows[0]?.count ?? 0),
      liveNodeCount: Number(liveNodeResult.rows[0]?.count ?? 0),
      latestOccupancy: occupancyRow ? toOccupancyRow(occupancyRow) : null,
      recentCsiRecordCount: Number(csiCountResult.rows[0]?.count ?? 0),
      recentHeartbeatCount: Number(heartbeatCountResult.rows[0]?.count ?? 0),
    };
  }

  async listLabelSessions(params: { limit: number; open?: boolean; notesPrefix?: string }): Promise<LabelSessionRow[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (params.open !== undefined) {
      conditions.push(params.open ? 'ended_at IS NULL' : 'ended_at IS NOT NULL');
    }
    if (params.notesPrefix !== undefined) {
      values.push(params.notesPrefix);
      // `starts_with`, not `LIKE $n || '%'`: the prefix is caller-supplied,
      // and LIKE would treat any `%`/`_` in it as a wildcard. NULL notes
      // yield NULL here and are correctly excluded.
      conditions.push(`starts_with(notes, $${values.length})`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(params.limit);
    const result = await this.pool.query<{
      id: string;
      started_at: Date;
      ended_at: Date | null;
      notes: string | null;
    }>(
      `SELECT id, started_at, ended_at, notes FROM label_sessions
       ${where}
       ORDER BY started_at DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      startedAt: row.started_at.toISOString(),
      endedAt: row.ended_at ? row.ended_at.toISOString() : null,
      notes: row.notes,
    }));
  }

  async createLabelSession(params: { startedAt: Date; notes?: string }): Promise<LabelSessionRow> {
    const result = await this.pool.query<{
      id: string;
      started_at: Date;
      ended_at: Date | null;
      notes: string | null;
    }>(
      `INSERT INTO label_sessions (started_at, notes) VALUES ($1, $2)
       RETURNING id, started_at, ended_at, notes`,
      [params.startedAt, params.notes ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error('insert into label_sessions returned no row');
    return {
      id: Number(row.id),
      startedAt: row.started_at.toISOString(),
      endedAt: row.ended_at ? row.ended_at.toISOString() : null,
      notes: row.notes,
    };
  }

  async stopLabelSession(params: { id: number; endedAt: Date }): Promise<LabelSessionRow | null> {
    const result = await this.pool.query<{
      id: string;
      started_at: Date;
      ended_at: Date | null;
      notes: string | null;
    }>(
      `UPDATE label_sessions SET ended_at = $2 WHERE id = $1
       RETURNING id, started_at, ended_at, notes`,
      [params.id, params.endedAt],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      startedAt: row.started_at.toISOString(),
      endedAt: row.ended_at ? row.ended_at.toISOString() : null,
      notes: row.notes,
    };
  }

  async listLabels(params: { sessionId: number; limit: number }): Promise<LabelRow[]> {
    const result = await this.pool.query<LabelDbRow>(
      `SELECT id, session_id, time, end_time, occupancy_count, source, notes
       FROM labels
       WHERE session_id = $1
       ORDER BY time ASC
       LIMIT $2`,
      [params.sessionId, params.limit],
    );
    return result.rows.map(toLabelRow);
  }

  /**
   * Overlap predicate, not containment: a label whose interval merely
   * *touches* [from, to) -- e.g. it started before `from` and ends inside
   * the window -- must still show up, or a dashboard paging through history
   * would visually "lose" the tail of a long correction at every window
   * boundary.
   *
   * `end_time` is EXCLUSIVE everywhere else in the system (the CHECK
   * constraint, dataset export's expansion filter, the UI's clamping) --
   * this must agree, or abutting training-mode intervals would double-count
   * the tick at their shared boundary. That makes the boundary check
   * different for a point label than for a real interval: a point label
   * (`end_time IS NULL`) is a single instant, included whenever it falls
   * anywhere in [from, to) -- i.e. `time >= from` -- while a real interval
   * [time, end_time) only touches the window if `end_time > from` (an
   * interval that ends exactly at `from` does not reach into it, since
   * `end_time` itself is excluded from the interval it closes). A single
   * `COALESCE(end_time, time) >= from` cannot express both rules at once --
   * it would wrongly include a real interval that ends exactly at `from`.
   */
  async listLabelsInRange(params: TimeRange & { limit: number }): Promise<LabelRow[]> {
    const result = await this.pool.query<LabelDbRow>(
      `SELECT id, session_id, time, end_time, occupancy_count, source, notes
       FROM labels
       WHERE time < $2
         AND (
           (end_time IS NULL AND time >= $1)
           OR (end_time IS NOT NULL AND end_time > $1)
         )
       ORDER BY time ASC
       LIMIT $3`,
      [params.from, params.to, params.limit],
    );
    return result.rows.map(toLabelRow);
  }

  async createLabel(params: {
    sessionId: number;
    time: Date;
    endTime?: Date;
    occupancyCount: number;
    source?: LabelSource;
    notes?: string;
  }): Promise<LabelRow> {
    const result = await this.pool.query<LabelDbRow>(
      `INSERT INTO labels (session_id, time, end_time, occupancy_count, source, notes) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, session_id, time, end_time, occupancy_count, source, notes`,
      [
        params.sessionId,
        params.time,
        params.endTime ?? null,
        params.occupancyCount,
        params.source ?? 'manual',
        params.notes ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('insert into labels returned no row');
    return toLabelRow(row);
  }

  /**
   * Fetches the label's current `time` first, rather than relying solely on
   * the `end_time > time` CHECK constraint (migration 008) to reject a bad
   * request: a raw constraint-violation error from the UPDATE would be
   * indistinguishable from any other Postgres error at this layer, and the
   * route needs to tell "no such label" (404) apart from "endTime not after
   * time" (400) to answer correctly. The CHECK constraint itself is
   * defense-in-depth against any other write path, not removed.
   */
  async updateLabelEndTime(params: { id: number; endTime: Date }): Promise<UpdateLabelEndTimeResult> {
    const existing = await this.pool.query<{ time: Date }>('SELECT time FROM labels WHERE id = $1', [params.id]);
    const existingRow = existing.rows[0];
    if (!existingRow) return { status: 'not-found' };
    if (params.endTime.getTime() <= existingRow.time.getTime()) return { status: 'invalid-end-time' };

    const result = await this.pool.query<LabelDbRow>(
      `UPDATE labels SET end_time = $2 WHERE id = $1
       RETURNING id, session_id, time, end_time, occupancy_count, source, notes`,
      [params.id, params.endTime],
    );
    const row = result.rows[0];
    // Defensive only: the label existed a moment ago (the SELECT above) and
    // nothing in this codebase deletes labels, so this should be
    // unreachable in practice.
    if (!row) return { status: 'not-found' };
    return { status: 'updated', label: toLabelRow(row) };
  }

  /** Overlap predicate identical to `listLabelsInRange`'s -- see `OVERLAP_PREDICATE` above and migration 009's matching index. */
  async listAnnotationsInRange(params: TimeRange & { limit: number }): Promise<AnnotationRow[]> {
    const result = await this.pool.query<AnnotationDbRow>(
      `SELECT id, time, end_time, category, label, notes, source, created_at
       FROM event_annotations
       WHERE ${OVERLAP_PREDICATE}
       ORDER BY time ASC
       LIMIT $3`,
      [params.from, params.to, params.limit],
    );
    return result.rows.map(toAnnotationRow);
  }

  async createAnnotation(params: {
    time: Date;
    endTime?: Date;
    category: AnnotationCategory;
    label?: string;
    notes?: string;
    source?: AnnotationSource;
  }): Promise<AnnotationRow> {
    const result = await this.pool.query<AnnotationDbRow>(
      `INSERT INTO event_annotations (time, end_time, category, label, notes, source)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, time, end_time, category, label, notes, source, created_at`,
      [
        params.time,
        params.endTime ?? null,
        params.category,
        params.label ?? null,
        params.notes ?? null,
        params.source ?? 'manual',
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('insert into event_annotations returned no row');
    return toAnnotationRow(row);
  }

  async deleteAnnotation(params: { id: number }): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM event_annotations WHERE id = $1', [params.id]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Three small aggregate queries for `GET /api/coverage`, run in parallel --
   * see `CoverageInputs` for what each field means and why this is a
   * purpose-built aggregate read rather than the route deriving one from a
   * row-capped listing.
   */
  async getCoverageInputs(params: TimeRange): Promise<CoverageInputs> {
    const [reviewedResult, sourceCountResult, annotationResult] = await Promise.all([
      this.pool.query<{ from_ms: Date; to_ms: Date }>(
        `SELECT GREATEST(time, $1::timestamptz) AS from_ms,
                LEAST(COALESCE(end_time, time), $2::timestamptz) AS to_ms
         FROM labels
         WHERE source IN ('manual', 'confirmed', 'training')
           AND ${OVERLAP_PREDICATE}`,
        [params.from, params.to],
      ),
      this.pool.query<{ source: string; count: string }>(
        `SELECT source, count(*)::bigint AS count
         FROM labels
         WHERE ${OVERLAP_PREDICATE}
         GROUP BY source`,
        [params.from, params.to],
      ),
      this.pool.query<{ count: string; categories: string[] | null }>(
        `SELECT count(*)::bigint AS count, array_agg(DISTINCT category) AS categories
         FROM event_annotations
         WHERE ${OVERLAP_PREDICATE}`,
        [params.from, params.to],
      ),
    ]);

    const labelSourceCounts: Partial<Record<LabelSource, number>> = {};
    for (const row of sourceCountResult.rows) {
      labelSourceCounts[row.source as LabelSource] = Number(row.count);
    }

    const annotationRow = annotationResult.rows[0];

    return {
      reviewedIntervals: reviewedResult.rows.map((row) => ({
        fromMs: row.from_ms.getTime(),
        toMs: row.to_ms.getTime(),
      })),
      labelSourceCounts,
      annotationCount: Number(annotationRow?.count ?? 0),
      annotationCategories: (annotationRow?.categories ?? []) as AnnotationCategory[],
    };
  }

  /**
   * Aggregates `features` (a high-volume hypertable) down to one row per
   * (node_id, link_mac) entirely in SQL -- GET /api/topology (routes/
   * topology.ts) then only ever handles this small, bounded result plus
   * `listNodes()`'s handful of rows, never raw feature rows.
   *
   * `mean_abs_deviation` is computed from `feature_vector->>'baselineDeviation'`
   * (the real field @homecsi/features writes -- see LinkFeatureVector) over
   * every window in range; `motion_active` is `baselineFrozen` from
   * specifically the MOST RECENT window in range (`latest`, via `DISTINCT
   * ON`), i.e. "is this link showing motion right now", not "did it ever
   * during the window".
   */
  async listLinkMotion(params: TimeRange & { limit: number }): Promise<LinkMotionSummary[]> {
    const result = await this.pool.query<{
      node_id: number;
      link_mac: string;
      mean_abs_deviation: number;
      sample_count: string;
      last_seen_at: Date;
      motion_active: boolean;
    }>(
      `WITH win AS (
         SELECT node_id, link_mac, time, feature_vector
         FROM features
         WHERE link_mac IS NOT NULL AND time >= $1 AND time < $2
       ),
       agg AS (
         SELECT node_id, link_mac,
                avg(abs((feature_vector->>'baselineDeviation')::double precision)) AS mean_abs_deviation,
                count(*)::bigint AS sample_count,
                max(time) AS last_seen_at
         FROM win
         GROUP BY node_id, link_mac
       ),
       latest AS (
         SELECT DISTINCT ON (node_id, link_mac) node_id, link_mac,
                (feature_vector->>'baselineFrozen')::boolean AS motion_active
         FROM win
         ORDER BY node_id, link_mac, time DESC
       )
       SELECT agg.node_id, agg.link_mac, agg.mean_abs_deviation, agg.sample_count,
              agg.last_seen_at, latest.motion_active
       FROM agg JOIN latest USING (node_id, link_mac)
       ORDER BY agg.last_seen_at DESC
       LIMIT $3`,
      [params.from, params.to, params.limit],
    );
    return result.rows.map((row) => ({
      nodeId: row.node_id,
      linkMac: row.link_mac,
      meanAbsDeviation: Number(row.mean_abs_deviation),
      motionActive: row.motion_active,
      sampleCount: Number(row.sample_count),
      lastSeenAt: row.last_seen_at.toISOString(),
    }));
  }
}
