import type { DbPool } from '@homecsi/db';
import { healthCheck as pgHealthCheck } from '@homecsi/db';
import { decodeAmplitudes } from './amplitude.js';
import type {
  CsiPoint,
  FeatureRow,
  HeartbeatRow,
  HomeCsiDb,
  LabelRow,
  LabelSessionRow,
  LinkSummary,
  NodeLiveness,
  OccupancyRow,
  StatusSummary,
  TimeRange,
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
    }>(
      `SELECT n.id, n.name, n.room, n.expected_mac, n.created_at,
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

  async listOccupancyStates(params: TimeRange & { limit: number }): Promise<OccupancyRow[]> {
    const result = await this.pool.query<{
      time: Date;
      estimate: number;
      confidence: number;
      state: string;
      details: Record<string, unknown> | null;
    }>(
      `SELECT time, estimate, confidence, state, details
       FROM occupancy_states
       WHERE time >= $1 AND time < $2
       ORDER BY time DESC
       LIMIT $3`,
      [params.from, params.to, params.limit],
    );
    return result.rows
      .map((row) => ({
        time: row.time.toISOString(),
        estimate: row.estimate,
        confidence: row.confidence,
        state: row.state,
        details: row.details,
      }))
      .sort((a, b) => a.time.localeCompare(b.time));
  }

  async pollOccupancyStates(params: { since: Date; limit: number }): Promise<OccupancyRow[]> {
    const result = await this.pool.query<{
      time: Date;
      estimate: number;
      confidence: number;
      state: string;
      details: Record<string, unknown> | null;
    }>(
      `SELECT time, estimate, confidence, state, details
       FROM occupancy_states
       WHERE time > $1
       ORDER BY time ASC
       LIMIT $2`,
      [params.since, params.limit],
    );
    return result.rows.map((row) => ({
      time: row.time.toISOString(),
      estimate: row.estimate,
      confidence: row.confidence,
      state: row.state,
      details: row.details,
    }));
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
        this.pool.query<{
          time: Date;
          estimate: number;
          confidence: number;
          state: string;
          details: Record<string, unknown> | null;
        }>('SELECT time, estimate, confidence, state, details FROM occupancy_states ORDER BY time DESC LIMIT 1'),
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
      latestOccupancy: occupancyRow
        ? {
            time: occupancyRow.time.toISOString(),
            estimate: occupancyRow.estimate,
            confidence: occupancyRow.confidence,
            state: occupancyRow.state,
            details: occupancyRow.details,
          }
        : null,
      recentCsiRecordCount: Number(csiCountResult.rows[0]?.count ?? 0),
      recentHeartbeatCount: Number(heartbeatCountResult.rows[0]?.count ?? 0),
    };
  }

  async listLabelSessions(params: { limit: number }): Promise<LabelSessionRow[]> {
    const result = await this.pool.query<{
      id: string;
      started_at: Date;
      ended_at: Date | null;
      notes: string | null;
    }>(
      `SELECT id, started_at, ended_at, notes FROM label_sessions
       ORDER BY started_at DESC
       LIMIT $1`,
      [params.limit],
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
    const result = await this.pool.query<{
      id: string;
      session_id: string;
      time: Date;
      occupancy_count: number;
      notes: string | null;
    }>(
      `SELECT id, session_id, time, occupancy_count, notes
       FROM labels
       WHERE session_id = $1
       ORDER BY time ASC
       LIMIT $2`,
      [params.sessionId, params.limit],
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      sessionId: Number(row.session_id),
      time: row.time.toISOString(),
      occupancyCount: row.occupancy_count,
      notes: row.notes,
    }));
  }

  async createLabel(params: {
    sessionId: number;
    time: Date;
    occupancyCount: number;
    notes?: string;
  }): Promise<LabelRow> {
    const result = await this.pool.query<{
      id: string;
      session_id: string;
      time: Date;
      occupancy_count: number;
      notes: string | null;
    }>(
      `INSERT INTO labels (session_id, time, occupancy_count, notes) VALUES ($1, $2, $3, $4)
       RETURNING id, session_id, time, occupancy_count, notes`,
      [params.sessionId, params.time, params.occupancyCount, params.notes ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error('insert into labels returned no row');
    return {
      id: Number(row.id),
      sessionId: Number(row.session_id),
      time: row.time.toISOString(),
      occupancyCount: row.occupancy_count,
      notes: row.notes,
    };
  }
}
