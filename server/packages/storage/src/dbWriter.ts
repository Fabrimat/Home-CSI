import type { CsiBatch, Heartbeat } from '@homecsi/protocol';
import { createRateLimitedLogger, noopLogger, type BasicLogger } from './logger.js';

/**
 * Minimal query surface this class needs — satisfied by `pg.Pool`
 * (`@homecsi/db`'s `DbPool`) and trivially by test fakes, mirroring the
 * same narrow-interface pattern `@homecsi/db`'s `migrationRunner.ts` uses
 * for `DbExecutor`.
 */
export interface DbQueryable {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

export interface PendingCsiRow {
  time: Date;
  nodeId: number;
  /** Wire datagram identity (docs/protocol.md section 3/6) — see migration 004. */
  bootEpoch: number;
  seq: number;
  /** 0-based position of this record within its CSI_BATCH — see migration 004. */
  recordIndex: number;
  srcMac: string;
  dstMac: string;
  rssi: number;
  rate: number;
  sigMode: number;
  mcs: number;
  bandwidth: number;
  channel: number;
  secondaryChannel: number;
  noiseFloor: number;
  csiFormat: number;
  csiData: Buffer;
}

export interface PendingHeartbeatRow {
  time: Date;
  nodeId: number;
  /** Wire datagram identity (docs/protocol.md section 3/6) — see migration 004. */
  bootEpoch: number;
  seq: number;
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

export interface DbWriteQueueMetrics {
  /** Current number of pending (not yet flushed) rows. */
  queueDepth: number;
  /** Rows dropped because the queue was full when a new one arrived (see overflow policy below). */
  queueDrops: number;
  /** Rows successfully committed to the database so far. */
  recordsWritten: number;
  /** Batch INSERTs that failed (network/DB error); their rows are dropped, see rationale below. */
  batchInsertFailures: number;
}

export interface DbWriteQueueOptions {
  /**
   * Maximum number of pending rows (csi + heartbeat combined) held in
   * memory at once. There is no config knob for this yet (packages/config
   * has none for ingest's internal queueing) — chosen conservatively so a
   * fully stalled database degrades gracefully rather than growing memory
   * unboundedly. Flagged in the B3 report as a candidate future config key.
   */
  maxQueueSize?: number;
  /** Rows per batch INSERT. */
  batchSize?: number;
  /** How often the background flush loop runs. */
  flushIntervalMs?: number;
  logger?: BasicLogger;
}

const DEFAULT_MAX_QUEUE_SIZE = 5000;
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_FLUSH_INTERVAL_MS = 500;

type QueueItem = { kind: 'csi'; row: PendingCsiRow } | { kind: 'heartbeat'; row: PendingHeartbeatRow };

/**
 * Bounded, batched writer for `csi_records` / `heartbeats`, shared by live
 * ingest (`@homecsi/ingest`) and `replayCaptures` so both go through the
 * exact same database-write path (docs/architecture.md "Data lifecycle").
 *
 * Design: `enqueue*` is a synchronous, O(1)-ish array push — the socket
 * handler in ingest never awaits a database round-trip. A background
 * timer periodically drains the queue in batches via multi-row INSERTs.
 *
 * Overflow policy: when the queue is full, the OLDEST pending row is
 * dropped to make room for the newest one. Rationale: this is a
 * near-real-time monitoring pipeline (occupancy features/estimate, brief
 * B4, operate on *recent* windows); if Postgres is degraded for a while,
 * the freshest data is more operationally useful than a stale backlog.
 * Critically, this is safe rather than merely convenient: the caller that
 * owns this queue (`@homecsi/ingest`'s `createIngestEngine`) awaits the
 * raw-capture write to *fully complete* — not merely be initiated —
 * before ever calling `enqueue*`. An item therefore only becomes eligible
 * to sit in (and thus only eligible to be dropped from) this in-memory
 * queue once its bytes are already durably on disk, so any row dropped
 * from here can always be recovered later via `homecsi replay` against
 * the capture directory. (The one narrow exception: if the capture write
 * itself failed — e.g. a full disk — the item is still enqueued
 * best-effort and counted separately as `captureWriteFailures` by the
 * caller; there is nothing on disk to recover in that specific case, but
 * that is a capture-write failure, not a consequence of this queue's
 * overflow policy.)
 *
 * Failure policy: a batch INSERT that fails (e.g. connection error) is
 * *not* retried — its rows are dropped and counted in
 * `batchInsertFailures`. Retrying indefinitely against a persistently
 * down database would either block the queue or grow it unboundedly,
 * exactly what the bounded queue exists to prevent; the same
 * raw-capture-replay recovery path applies here too.
 */
export class DbWriteQueue {
  private readonly pool: DbQueryable;
  private readonly maxQueueSize: number;
  private readonly batchSize: number;
  private readonly logger: BasicLogger;
  /** Rate-limited: a sustained DB outage can fail dozens of batches/second (see flush()). */
  private readonly failureLogger: BasicLogger;
  private queue: QueueItem[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing = false;
  private metrics: DbWriteQueueMetrics = {
    queueDepth: 0,
    queueDrops: 0,
    recordsWritten: 0,
    batchInsertFailures: 0,
  };

  constructor(pool: DbQueryable, options: DbWriteQueueOptions = {}) {
    this.pool = pool;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.logger = options.logger ?? noopLogger;
    this.failureLogger = createRateLimitedLogger(this.logger);
    const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.flush();
    }, flushIntervalMs).unref();
  }

  private enqueue(item: QueueItem): void {
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      this.metrics.queueDrops++;
    }
    this.queue.push(item);
    this.metrics.queueDepth = this.queue.length;
  }

  /**
   * Enqueues every CSI record in `batch` as its own `csi_records` row.
   * `bootEpoch`/`seq` identify the wire datagram this batch came from
   * (docs/protocol.md section 3/6); combined with each record's 0-based
   * position in `batch.records` (`record_index`), this gives every row a
   * natural per-record key so `insertCsiRows` can `ON CONFLICT DO
   * NOTHING` — see migration 004.
   *
   * Per-record `time`: when the node's clock is SNTP-synced
   * (`batch.sntpSynced`), each record gets its own wall-clock estimate —
   * `batch.wallClockUs` anchored at `batch.monoUs`, offset by
   * `(record.rxTimestampUs - batch.monoUs)` — giving per-record precision
   * within the batch rather than one timestamp for the whole batch.
   * `docs/protocol.md` section 7 explicitly says node wall-clock time
   * MUST be treated as untrustworthy when `sntp_synced == 0` (it could be
   * anything, including near the Unix epoch), so in that case we fall
   * back to `receivedAt` (this server's own, always-NTP-correct wall
   * clock) for every record in the batch instead. Note this also means
   * `time` (part of the dedup key, see migration 004) is still computed
   * deterministically from each record's own fields, so replaying the
   * same wire bytes twice reproduces the same key and is correctly
   * deduplicated.
   */
  enqueueCsiBatch(nodeId: number, bootEpoch: number, seq: number, receivedAt: Date, batch: CsiBatch): void {
    batch.records.forEach((rec, recordIndex) => {
      const time = batch.sntpSynced
        ? new Date(Number((batch.wallClockUs + (rec.rxTimestampUs - batch.monoUs)) / 1000n))
        : receivedAt;
      this.enqueue({
        kind: 'csi',
        row: {
          time,
          nodeId,
          bootEpoch,
          seq,
          recordIndex,
          srcMac: rec.srcMac,
          dstMac: rec.dstMac,
          rssi: rec.rssi,
          rate: rec.rate,
          sigMode: rec.sigMode,
          mcs: rec.mcs,
          bandwidth: rec.bandwidth,
          channel: rec.channel,
          secondaryChannel: rec.secondaryChannel,
          noiseFloor: rec.noiseFloor,
          csiFormat: rec.csiFormat,
          csiData: rec.csiData,
        },
      });
    });
  }

  enqueueHeartbeat(nodeId: number, bootEpoch: number, seq: number, receivedAt: Date, hb: Heartbeat): void {
    this.enqueue({
      kind: 'heartbeat',
      row: {
        time: receivedAt,
        nodeId,
        bootEpoch,
        seq,
        uptimeS: hb.uptimeS,
        freeHeapBytes: hb.freeHeapBytes,
        minFreeHeapBytes: hb.minFreeHeapBytes,
        framesCaptured: hb.framesCaptured,
        framesDropped: hb.framesDropped,
        batchesSent: hb.batchesSent,
        sendFailures: hb.sendFailures,
        rssiToAp: hb.rssiToAp,
        channel: hb.channel,
        sntpSynced: hb.sntpSynced,
        fwVersion: `${hb.fwVersionMajor}.${hb.fwVersionMinor}.${hb.fwVersionPatch}`,
      },
    });
  }

  /**
   * Upserts a node's identity + placement row (id/name/room/expected_mac/
   * floor/pos_x/pos_y) so it exists for the `csi_records`/`heartbeats`
   * foreign keys and stays in sync with `config.nodes`. This is the
   * "upsert node liveness" step from the ingest contract: liveness
   * *timing* (last-seen, last-seq) is tracked as an in-process metric by
   * `@homecsi/ingest`, not persisted here — see that package's
   * `IngestMetrics.perNode`.
   *
   * DELIBERATE DESIGN DECISION -- there is NO write-back path from the
   * dashboard (or any other API caller) to `floor`/`pos_x`/`pos_y`.
   * `config.yaml` (gitignored, holds per-node PSKs) is the sole source of
   * truth for placement, and this method is called with every configured
   * node at every ingest/replay start (see @homecsi/ingest's `index.ts`
   * and @homecsi/storage's `replay.ts`), overwriting whatever is in the
   * database. A hypothetical "save placement" dashboard button would
   * create split-brain state that the next ingest restart would silently
   * revert — worse than not offering the button at all. If a future brief
   * wants operator-editable placement, the right shape is generating a
   * YAML snippet the operator pastes into `config.yaml`, not writing to
   * this table directly (see migration 010's header comment).
   */
  async upsertNode(node: {
    id: number;
    name: string;
    room: string;
    expectedMac?: string;
    floor?: number;
    position?: { x: number; y: number };
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO nodes (id, name, room, expected_mac, floor, pos_x, pos_y)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         room = EXCLUDED.room,
         expected_mac = EXCLUDED.expected_mac,
         floor = EXCLUDED.floor,
         pos_x = EXCLUDED.pos_x,
         pos_y = EXCLUDED.pos_y`,
      [
        node.id,
        node.name,
        node.room,
        node.expectedMac ?? null,
        node.floor ?? 0,
        node.position?.x ?? null,
        node.position?.y ?? null,
      ],
    );
  }

  getMetrics(): DbWriteQueueMetrics {
    return { ...this.metrics };
  }

  /** Drains and inserts pending rows in batches. Safe to call re-entrantly (no-ops while already flushing). */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.batchSize);
        this.metrics.queueDepth = this.queue.length;
        const csiRows = batch.filter((i): i is { kind: 'csi'; row: PendingCsiRow } => i.kind === 'csi').map((i) => i.row);
        const hbRows = batch
          .filter((i): i is { kind: 'heartbeat'; row: PendingHeartbeatRow } => i.kind === 'heartbeat')
          .map((i) => i.row);
        try {
          let written = 0;
          if (csiRows.length > 0) written += await this.insertCsiRows(csiRows);
          if (hbRows.length > 0) written += await this.insertHeartbeatRows(hbRows);
          // Not necessarily === batch.length: ON CONFLICT DO NOTHING (see
          // migration 004) means a row already present from a previous
          // live-ingest run or replay is silently skipped, not "written".
          this.metrics.recordsWritten += written;
        } catch (err) {
          this.metrics.batchInsertFailures++;
          // Rate-limited: a sustained DB outage can otherwise log dozens of
          // lines per second (one flush() call can iterate many batches).
          this.failureLogger.error(
            { err: err instanceof Error ? err.message : String(err), batchSize: batch.length },
            'batch insert failed; rows dropped (recoverable via `homecsi replay`)',
          );
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async insertCsiRows(rows: PendingCsiRow[]): Promise<number> {
    const cols = [
      'time',
      'node_id',
      'boot_epoch',
      'seq',
      'record_index',
      'src_mac',
      'dst_mac',
      'rssi',
      'rate',
      'sig_mode',
      'mcs',
      'bandwidth',
      'channel',
      'secondary_channel',
      'noise_floor',
      'csi_format',
      'csi_data',
    ];
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      const base = i * cols.length;
      values.push(
        r.time,
        r.nodeId,
        r.bootEpoch,
        r.seq,
        r.recordIndex,
        r.srcMac,
        r.dstMac,
        r.rssi,
        r.rate,
        r.sigMode,
        r.mcs,
        r.bandwidth,
        r.channel,
        r.secondaryChannel,
        r.noiseFloor,
        r.csiFormat,
        r.csiData,
      );
      return `(${cols.map((_, j) => `$${base + j + 1}`).join(', ')})`;
    });
    // ON CONFLICT DO NOTHING against migration 004's unique index on
    // (node_id, boot_epoch, seq, record_index, time): makes replaying a
    // capture range that was already ingested (live or via a previous
    // replay) idempotent instead of silently duplicating rows.
    const result = await this.pool.query(
      `INSERT INTO csi_records (${cols.join(', ')}) VALUES ${tuples.join(', ')}
       ON CONFLICT (node_id, boot_epoch, seq, record_index, time) DO NOTHING`,
      values,
    );
    // Fall back to the attempted count if a fake/older executor doesn't
    // report rowCount (real pg.Pool always does).
    return result.rowCount ?? rows.length;
  }

  private async insertHeartbeatRows(rows: PendingHeartbeatRow[]): Promise<number> {
    const cols = [
      'time',
      'node_id',
      'boot_epoch',
      'seq',
      'uptime_s',
      'free_heap_bytes',
      'min_free_heap_bytes',
      'frames_captured',
      'frames_dropped',
      'batches_sent',
      'send_failures',
      'rssi_to_ap',
      'channel',
      'sntp_synced',
      'fw_version',
    ];
    const values: unknown[] = [];
    const tuples = rows.map((r, i) => {
      const base = i * cols.length;
      values.push(
        r.time,
        r.nodeId,
        r.bootEpoch,
        r.seq,
        r.uptimeS,
        r.freeHeapBytes,
        r.minFreeHeapBytes,
        r.framesCaptured,
        r.framesDropped,
        r.batchesSent,
        r.sendFailures,
        r.rssiToAp,
        r.channel,
        r.sntpSynced,
        r.fwVersion,
      );
      return `(${cols.map((_, j) => `$${base + j + 1}`).join(', ')})`;
    });
    // ON CONFLICT DO NOTHING against migration 004's unique index on
    // (node_id, boot_epoch, seq, time) — see insertCsiRows for the same
    // reasoning.
    const result = await this.pool.query(
      `INSERT INTO heartbeats (${cols.join(', ')}) VALUES ${tuples.join(', ')}
       ON CONFLICT (node_id, boot_epoch, seq, time) DO NOTHING`,
      values,
    );
    return result.rowCount ?? rows.length;
  }

  /** Stops the background timer and makes a bounded effort to drain the queue before returning. */
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const maxAttempts = 5;
    for (let i = 0; i < maxAttempts && this.queue.length > 0; i++) {
      await this.flush();
    }
  }
}
