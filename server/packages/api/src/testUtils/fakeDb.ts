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
  UpdateLabelEndTimeResult,
} from '../db/types.js';

/**
 * In-memory stand-in for `HomeCsiDb`, used by route-level tests so they run
 * with no live database (mirrors packages/db's FakeExecutor pattern). Data
 * is seeded explicitly per test rather than generated, so nothing here can
 * be mistaken for real signal by a test asserting on shape alone.
 */
export class FakeHomeCsiDb implements HomeCsiDb {
  healthy = true;
  nodes: NodeLiveness[] = [];
  heartbeats: HeartbeatRow[] = [];
  csiRecords: (CsiPoint & { nodeId: number; srcMac: string; dstMac: string })[] = [];
  features: FeatureRow[] = [];
  occupancyStates: OccupancyRow[] = [];
  labelSessions: LabelSessionRow[] = [];
  labels: LabelRow[] = [];
  private nextSessionId = 1;
  private nextLabelId = 1;

  async healthCheck(): Promise<boolean> {
    return this.healthy;
  }

  async listNodes(): Promise<NodeLiveness[]> {
    return this.nodes;
  }

  async listHeartbeats(params: TimeRange & { nodeId: number; limit: number }): Promise<HeartbeatRow[]> {
    return this.heartbeats
      .filter(
        (h) =>
          h.nodeId === params.nodeId &&
          new Date(h.time) >= params.from &&
          new Date(h.time) < params.to,
      )
      .slice(0, params.limit);
  }

  async pollHeartbeats(params: { nodeId: number; since: Date; limit: number }): Promise<HeartbeatRow[]> {
    return this.heartbeats
      .filter((h) => h.nodeId === params.nodeId && new Date(h.time) > params.since)
      .slice(0, params.limit);
  }

  async listLinks(params: { sinceMs: number; limit: number }): Promise<LinkSummary[]> {
    const cutoff = Date.now() - params.sinceMs;
    const byKey = new Map<string, LinkSummary>();
    for (const r of this.csiRecords) {
      if (new Date(r.time).getTime() < cutoff) continue;
      const key = `${r.nodeId}:${r.srcMac}:${r.dstMac}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.recordCount += 1;
        if (r.time > existing.lastSeenAt) existing.lastSeenAt = r.time;
      } else {
        byKey.set(key, { nodeId: r.nodeId, srcMac: r.srcMac, dstMac: r.dstMac, recordCount: 1, lastSeenAt: r.time });
      }
    }
    return [...byKey.values()].slice(0, params.limit);
  }

  async listCsiRecords(
    params: TimeRange & { nodeId: number; srcMac: string; dstMac: string; maxPoints: number },
  ): Promise<CsiPoint[]> {
    return this.csiRecords
      .filter(
        (r) =>
          r.nodeId === params.nodeId &&
          r.srcMac === params.srcMac &&
          r.dstMac === params.dstMac &&
          new Date(r.time) >= params.from &&
          new Date(r.time) < params.to,
      )
      .slice(0, params.maxPoints)
      .map(({ time, rssi, noiseFloor, csiFormat, amplitudes }) => ({ time, rssi, noiseFloor, csiFormat, amplitudes }));
  }

  async pollCsiRecords(params: {
    nodeId: number;
    srcMac: string;
    dstMac: string;
    since: Date;
    limit: number;
  }): Promise<CsiPoint[]> {
    return this.csiRecords
      .filter(
        (r) =>
          r.nodeId === params.nodeId &&
          r.srcMac === params.srcMac &&
          r.dstMac === params.dstMac &&
          new Date(r.time) > params.since,
      )
      .slice(0, params.limit)
      .map(({ time, rssi, noiseFloor, csiFormat, amplitudes }) => ({ time, rssi, noiseFloor, csiFormat, amplitudes }));
  }

  async listFeatures(
    params: TimeRange & { nodeId: number; linkMac?: string; maxPoints: number },
  ): Promise<FeatureRow[]> {
    return this.features
      .filter(
        (f) =>
          f.nodeId === params.nodeId &&
          (params.linkMac === undefined || f.linkMac === params.linkMac) &&
          new Date(f.time) >= params.from &&
          new Date(f.time) < params.to,
      )
      .slice(0, params.maxPoints);
  }

  /**
   * Mirrors PgHomeCsiDb: in-window events (newest kept when trimmed by
   * `limit`) plus the carry-in event at or before `from`, at its real
   * timestamp. Route tests depend on this matching the real implementation's
   * step semantics, not on it being the simplest possible filter.
   */
  async listOccupancyStates(params: TimeRange & { limit: number }): Promise<OccupancyRow[]> {
    const sorted = [...this.occupancyStates].sort((a, b) => a.time.localeCompare(b.time));
    const inWindow = sorted
      .filter((o) => new Date(o.time) >= params.from && new Date(o.time) < params.to)
      .slice(-params.limit);
    const carryIn = sorted.filter((o) => new Date(o.time) <= params.from).at(-1);
    const rows = carryIn && !inWindow.includes(carryIn) ? [carryIn, ...inWindow] : inWindow;
    if (rows.length <= params.limit) return rows;
    return [rows[0] as OccupancyRow, ...rows.slice(rows.length - (params.limit - 1))];
  }

  async pollOccupancyStates(params: { since: Date; limit: number }): Promise<OccupancyRow[]> {
    return this.occupancyStates.filter((o) => new Date(o.time) > params.since).slice(0, params.limit);
  }

  async getLatestOccupancyState(): Promise<OccupancyRow | null> {
    return [...this.occupancyStates].sort((a, b) => a.time.localeCompare(b.time)).at(-1) ?? null;
  }

  async getStatusSummary(windowMs: number): Promise<StatusSummary> {
    return {
      dbReachable: this.healthy,
      windowMs,
      nodeCount: this.nodes.length,
      liveNodeCount: this.nodes.filter((n) => n.lastHeartbeatAt !== null).length,
      latestOccupancy: this.occupancyStates.at(-1) ?? null,
      recentCsiRecordCount: this.csiRecords.length,
      recentHeartbeatCount: this.heartbeats.length,
    };
  }

  async listLabelSessions(params: { limit: number }): Promise<LabelSessionRow[]> {
    return this.labelSessions.slice(0, params.limit);
  }

  async createLabelSession(params: { startedAt: Date; notes?: string }): Promise<LabelSessionRow> {
    const session: LabelSessionRow = {
      id: this.nextSessionId++,
      startedAt: params.startedAt.toISOString(),
      endedAt: null,
      notes: params.notes ?? null,
    };
    this.labelSessions.push(session);
    return session;
  }

  async stopLabelSession(params: { id: number; endedAt: Date }): Promise<LabelSessionRow | null> {
    const session = this.labelSessions.find((s) => s.id === params.id);
    if (!session) return null;
    session.endedAt = params.endedAt.toISOString();
    return session;
  }

  async listLabels(params: { sessionId: number; limit: number }): Promise<LabelRow[]> {
    return this.labels.filter((l) => l.sessionId === params.sessionId).slice(0, params.limit);
  }

  /**
   * Mirrors PgHomeCsiDb.listLabelsInRange's overlap predicate exactly --
   * including the asymmetric boundary rule for `end_time`'s exclusivity
   * (see that method's own comment): a point label is included when its
   * `time` falls anywhere in [from, to) (`>= from`), but a real interval
   * only overlaps if its `end_time` is strictly after `from` (`> from`) --
   * an interval that ends exactly at `from` has already excluded that
   * instant. Route tests depend on this matching exactly, not on it being
   * the simplest possible filter.
   */
  async listLabelsInRange(params: TimeRange & { limit: number }): Promise<LabelRow[]> {
    return [...this.labels]
      .filter((l) => {
        const start = new Date(l.time).getTime();
        const startsOverlap =
          l.endTime === null ? start >= params.from.getTime() : new Date(l.endTime).getTime() > params.from.getTime();
        return start < params.to.getTime() && startsOverlap;
      })
      .sort((a, b) => a.time.localeCompare(b.time))
      .slice(0, params.limit);
  }

  async createLabel(params: {
    sessionId: number;
    time: Date;
    endTime?: Date;
    occupancyCount: number;
    source?: LabelRow['source'];
    notes?: string;
  }): Promise<LabelRow> {
    const label: LabelRow = {
      id: this.nextLabelId++,
      sessionId: params.sessionId,
      time: params.time.toISOString(),
      endTime: params.endTime ? params.endTime.toISOString() : null,
      occupancyCount: params.occupancyCount,
      source: params.source ?? 'manual',
      notes: params.notes ?? null,
    };
    this.labels.push(label);
    return label;
  }

  /** Mirrors PgHomeCsiDb.updateLabelEndTime's not-found/invalid-end-time/updated result shape exactly -- route tests depend on it. */
  async updateLabelEndTime(params: { id: number; endTime: Date }): Promise<UpdateLabelEndTimeResult> {
    const label = this.labels.find((l) => l.id === params.id);
    if (!label) return { status: 'not-found' };
    if (params.endTime.getTime() <= new Date(label.time).getTime()) return { status: 'invalid-end-time' };
    label.endTime = params.endTime.toISOString();
    return { status: 'updated', label };
  }
}
