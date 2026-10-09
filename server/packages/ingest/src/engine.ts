import type { Config } from '@homecsi/config';
import {
  HEADER_LEN,
  MAGIC,
  MAX_DATAGRAM_BYTES,
  MsgType,
  PROTOCOL_VERSION,
  TAG_LEN,
  ReplayWindow,
  decodeCsiBatch,
  decodeHeader,
  decodeHeartbeat,
  encodeCsiBatch,
  encodeHeartbeat,
  open,
  type CsiBatch,
  type Heartbeat,
} from '@homecsi/protocol';
import type { CaptureRecordEnvelope, DbWriteQueueMetrics } from '@homecsi/storage';
import { createRateLimiter, type Logger } from './logger.js';
import { createEmptyMetrics, type IngestMetrics, type RejectReason } from './metrics.js';
import {
  CLOSED_BOX_SESSION_GATE,
  DEFAULT_PERSISTED_RATE_CEILING,
  PersistedRateLimiter,
  type BoxSessionGateLike,
  type PersistedRateLimiterLike,
} from './persistedRateLimiter.js';

const MAGIC_BUF = Buffer.from(MAGIC);

/** Narrow surface of `CaptureWriter` this engine needs — real or fake in tests. */
export interface CaptureWriterLike {
  appendRecord(rec: CaptureRecordEnvelope): Promise<void>;
}

/** Narrow surface of `DbWriteQueue` this engine needs — real or fake in tests. */
export interface DbWriteQueueLike {
  enqueueCsiBatch(nodeId: number, bootEpoch: number, seq: number, receivedAt: Date, batch: CsiBatch): void;
  enqueueHeartbeat(nodeId: number, bootEpoch: number, seq: number, receivedAt: Date, hb: Heartbeat): void;
  upsertNode(node: {
    id: number;
    name: string;
    room: string;
    expectedMac?: string;
    /** Signed floor index (basement negative); defaults to 0 when omitted -- see packages/config's `nodeSchema` and migration 010. */
    floor?: number;
    /** Optional {x, y} metres on that floor's own operator-chosen origin -- omitted means "not yet placed" (see nodeSchema's no-trilateration contract). */
    position?: { x: number; y: number };
    /** DATA-FLOW FENCE, not a label -- defaults to 'house' when omitted. See packages/config's `nodeRoleSchema` and migration 011. */
    role?: 'house' | 'box';
  }): Promise<void>;
  getMetrics(): DbWriteQueueMetrics;
  close(): Promise<void>;
}

export interface IngestDeps {
  captureWriter: CaptureWriterLike;
  dbWriteQueue: DbWriteQueueLike;
  logger: Logger;
  /** Injectable clock, for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Injectable persisted-rate ceiling gating the DbWriteQueue path (never
   * CaptureWriter -- see persistedRateLimiter.ts). Defaults to a real
   * `PersistedRateLimiter` built from `config.realtime?.persistedRateCeiling`
   * (or `DEFAULT_PERSISTED_RATE_CEILING` when that whole section is
   * omitted) -- tests only need to inject their own when they want to
   * observe/control the ceiling's exact behaviour directly.
   */
  rateLimiter?: PersistedRateLimiterLike;
  /**
   * Injectable "is at least one box_sessions row currently open" gate.
   * Defaults to `CLOSED_BOX_SESSION_GATE` (never bypass) -- `runIngest`
   * (index.ts) always supplies a real, pool-backed poller in production.
   */
  boxSessionGate?: BoxSessionGateLike;
}

export interface IngestEngine {
  /**
   * Processes one raw UDP payload end-to-end: size checks, header decode,
   * node lookup, AEAD open, per-node replay-window check, payload decode,
   * capture-write, and DB-queue enqueue. Never throws — every failure
   * path counts a distinct rejection reason and returns.
   */
  handleDatagram(buf: Buffer): void;
  getMetrics(): IngestMetrics;
  close(): Promise<void>;
}

/**
 * Builds the stateful pieces of ingest (per-node replay windows, node/key
 * registry, counters) around injected `deps`, decoupled from the real UDP
 * socket / real Postgres / real disk so it can be exercised directly by
 * tests with hostile inputs and no live database or network hardware.
 * `runIngest` (index.ts) is a thin wrapper that wires this to a real
 * `dgram` socket and real `@homecsi/storage` collaborators.
 */
export function createIngestEngine(config: Config, deps: IngestDeps): IngestEngine {
  const metrics = createEmptyMetrics();
  const now = deps.now ?? Date.now;
  const rateLimiter = createRateLimiter(deps.logger);

  const nodesById = new Map(config.nodes.map((n) => [n.id, n]));
  const keysById = new Map(config.nodes.map((n) => [n.id, Buffer.from(n.psk, 'base64')]));
  const replayWindows = new Map<number, ReplayWindow>();

  const persistedRateLimiter: PersistedRateLimiterLike =
    deps.rateLimiter ??
    new PersistedRateLimiter(config.realtime?.persistedRateCeiling ?? DEFAULT_PERSISTED_RATE_CEILING);
  const boxSessionGate: BoxSessionGateLike = deps.boxSessionGate ?? CLOSED_BOX_SESSION_GATE;

  /**
   * Whether one more CSI record for this (nodeId, linkMac) key may reach
   * DbWriteQueue right now -- the persisted-rate ceiling's admission check.
   * `linkMac` is the record's own `srcMac` (the transmitting peer), the
   * same (nodeId, linkMac) granularity @homecsi/features keys `features`
   * rows by. A role='box' node bypasses the ceiling entirely, but ONLY
   * while a box_sessions row is open -- so a recording take can capture a
   * dense burst -- and a role='house' node is NEVER bypassed, regardless
   * of box_sessions state.
   */
  function admitForPersistence(nodeId: number, linkMac: string, nowMs: number): boolean {
    const node = nodesById.get(nodeId);
    if (node?.role === 'box' && boxSessionGate.isOpen()) return true;
    return persistedRateLimiter.admit(nodeId, linkMac, nowMs);
  }

  function reject(reason: RejectReason, extra: Record<string, unknown> = {}): void {
    metrics.rejected[reason]++;
    rateLimiter.warn(reason, { reason, ...extra }, `datagram rejected: ${reason}`);
  }

  function syncDbMetrics(): void {
    const dbMetrics = deps.dbWriteQueue.getMetrics();
    metrics.recordsWritten = dbMetrics.recordsWritten;
    metrics.batchInsertFailures = dbMetrics.batchInsertFailures;
    metrics.queueDepth = dbMetrics.queueDepth;
    metrics.queueDrops = dbMetrics.queueDrops;
  }

  function processDatagram(buf: Buffer): void {
    // --- Size sanity checks, before any parsing/crypto (docs/protocol.md section 2). ---
    if (buf.length > MAX_DATAGRAM_BYTES) return reject('oversized', { size: buf.length });
    if (buf.length < HEADER_LEN + TAG_LEN) return reject('truncated', { size: buf.length });

    // Cheap pre-checks so we never attempt to interpret a header we don't
    // recognize the shape of (docs/protocol.md sections 2, 12): magic,
    // then version, both before the fuller decodeHeader (which also
    // verifies the nonce construction).
    if (!buf.subarray(0, 4).equals(MAGIC_BUF)) return reject('bad_magic');
    const version = buf.readUInt8(4);
    if (version !== PROTOCOL_VERSION) return reject('unsupported_version', { version });

    let header;
    try {
      header = decodeHeader(Buffer.from(buf.subarray(0, HEADER_LEN)));
    } catch {
      return reject('bad_header');
    }

    // --- Look up the node in the config registry. ---
    const node = nodesById.get(header.nodeId);
    const key = keysById.get(header.nodeId);
    if (!node || !key) return reject('unknown_node', { nodeId: header.nodeId });

    // --- AEAD open with that node's PSK. ---
    let plaintext: Buffer;
    try {
      plaintext = open(
        key,
        header.nonce,
        Buffer.from(buf.subarray(0, HEADER_LEN)),
        Buffer.from(buf.subarray(HEADER_LEN)),
      );
    } catch {
      return reject('auth_failed', { nodeId: header.nodeId });
    }

    // --- Replay check, per docs/protocol.md section 6, after AEAD success. ---
    let window = replayWindows.get(header.nodeId);
    if (!window) {
      window = new ReplayWindow();
      replayWindows.set(header.nodeId, window);
    }
    const replayResult = window.check(header.bootEpoch, header.seq);
    if (!replayResult.accepted) {
      return reject(replayResult.reason as RejectReason, {
        nodeId: header.nodeId,
        bootEpoch: header.bootEpoch,
        seq: header.seq,
      });
    }

    // --- Dispatch by message type. ---
    let decoded: { type: 'CSI_BATCH'; batch: CsiBatch } | { type: 'HEARTBEAT'; heartbeat: Heartbeat };
    try {
      switch (header.msgType) {
        case MsgType.CsiBatch:
          decoded = { type: 'CSI_BATCH', batch: decodeCsiBatch(plaintext) };
          break;
        case MsgType.Heartbeat:
          decoded = { type: 'HEARTBEAT', heartbeat: decodeHeartbeat(plaintext) };
          break;
        default:
          return reject('unknown_msg_type', { nodeId: header.nodeId, msgType: header.msgType });
      }
    } catch {
      return reject('malformed_payload', { nodeId: header.nodeId });
    }

    metrics.accepted++;
    const receivedAtMs = now();
    const perNode = metrics.perNode[header.nodeId] ?? {
      lastSeenAtMs: 0,
      lastSeq: 0,
      lastBootEpoch: 0,
      macMismatches: 0,
    };
    perNode.lastSeenAtMs = receivedAtMs;
    perNode.lastSeq = header.seq;
    perNode.lastBootEpoch = header.bootEpoch;
    metrics.perNode[header.nodeId] = perNode;

    // Soft attribution check, CSI_BATCH only (heartbeats carry no MAC).
    // Deliberately NOT a drop reason: this deployment's whole point is
    // promiscuous capture of other devices'/nodes' traffic (the
    // broadcast-sounding mesh, docs/architecture.md), so most records in
    // a batch will legitimately reference MACs other than the capturing
    // node's own. Authenticity/integrity are already fully guaranteed by
    // the per-node AEAD PSK; expectedMac is only a soft, best-effort
    // provisioning sanity signal for operators.
    if (decoded.type === 'CSI_BATCH' && node.expectedMac && decoded.batch.records.length > 0) {
      const expected = node.expectedMac.toLowerCase();
      const anyMatch = decoded.batch.records.some(
        (r) => r.srcMac.toLowerCase() === expected || r.dstMac.toLowerCase() === expected,
      );
      if (!anyMatch) {
        perNode.macMismatches++;
        rateLimiter.warn(
          `mac_mismatch:${header.nodeId}`,
          { nodeId: header.nodeId, expectedMac: node.expectedMac },
          'no CSI record in this batch referenced the node registry expectedMac (soft check; not dropped)',
        );
      }
    }

    const msgType = decoded.type === 'CSI_BATCH' ? MsgType.CsiBatch : MsgType.Heartbeat;
    const payload = decoded.type === 'CSI_BATCH' ? encodeCsiBatch(decoded.batch) : encodeHeartbeat(decoded.heartbeat);
    const captureRecord: CaptureRecordEnvelope = {
      receivedAtMs,
      nodeId: header.nodeId,
      bootEpoch: header.bootEpoch,
      seq: header.seq,
      msgType,
      payload,
    };

    // Deliberately not awaited here — the socket handler itself must stay
    // synchronous/non-blocking (dgram's 'message' event, and the backpressure
    // requirement that the DB writer never be driven synchronously from it).
    // Internally, though, `finalizeAccepted` awaits the capture write to
    // fully COMPLETE before enqueueing to the bounded DB queue. That
    // ordering is load-bearing: DbWriteQueue's drop-oldest overflow policy
    // is justified by "every enqueued item is already durably on disk" (see
    // its doc comment) — that claim is only true if an item can never be
    // sitting in (and therefore never be dropped from) the DB queue before
    // its capture write has actually finished, not merely been initiated.
    void finalizeAccepted(header.nodeId, receivedAtMs, captureRecord, decoded);
  }

  async function finalizeAccepted(
    nodeId: number,
    receivedAtMs: number,
    captureRecord: CaptureRecordEnvelope,
    decoded: { type: 'CSI_BATCH'; batch: CsiBatch } | { type: 'HEARTBEAT'; heartbeat: Heartbeat },
  ): Promise<void> {
    // The ENTIRE body (including the enqueue calls and syncDbMetrics, not
    // just the capture-write await) is wrapped in one try/catch, mirroring
    // metricsSnapshotLoop.ts's snapshotOnce. This function is invoked as
    // `void finalizeAccepted(...)` (fire-and-forget from a synchronous
    // socket handler) — `dbWriteQueue` and `captureWriter` are injected
    // interfaces, and a real or future implementation throwing
    // synchronously from enqueueCsiBatch/enqueueHeartbeat would otherwise
    // become an unhandled promise rejection. Node >= 20 (this repo's
    // minimum) defaults to `--unhandled-rejections=throw`, which
    // terminates the process — a strictly worse outcome than the
    // synchronous-throw case `handleDatagram`'s own try/catch already
    // guards against. A single bad datagram, or a transient DB-adapter
    // bug, must never be able to take down a world-facing UDP listener.
    try {
      try {
        await deps.captureWriter.appendRecord(captureRecord);
      } catch (err) {
        metrics.captureWriteFailures++;
        // Rate-limited: an ordinary, sustained failure mode (e.g. disk
        // full) must not itself flood the log at full traffic rate.
        rateLimiter.warn(
          'capture_write_failed',
          { err: err instanceof Error ? err.message : String(err), nodeId },
          'capture write failed; this datagram will not be recoverable via replay if its DB-queue entry is later dropped',
        );
        // Fall through and still enqueue to the DB best-effort below: a DB
        // row that survives is strictly better than none, even without a
        // capture backup for this one item. The recoverability guarantee
        // documented on DbWriteQueue only covers the (overwhelmingly
        // common) case where the capture write actually succeeded.
      }

      if (decoded.type === 'CSI_BATCH') {
        // Persisted-rate ceiling: gates ONLY this DbWriteQueue enqueue,
        // never the capture write above (already completed with the full,
        // unfiltered batch by the time this runs). See admitForPersistence
        // and persistedRateLimiter.ts's module doc comment.
        const admittedRecords = decoded.batch.records.filter((rec) =>
          admitForPersistence(nodeId, rec.srcMac, receivedAtMs),
        );
        const droppedCount = decoded.batch.records.length - admittedRecords.length;
        if (droppedCount > 0) metrics.rejected.persisted_rate_limited += droppedCount;
        if (admittedRecords.length > 0) {
          deps.dbWriteQueue.enqueueCsiBatch(
            nodeId,
            captureRecord.bootEpoch,
            captureRecord.seq,
            new Date(receivedAtMs),
            { ...decoded.batch, records: admittedRecords },
          );
        }
      } else {
        deps.dbWriteQueue.enqueueHeartbeat(
          nodeId,
          captureRecord.bootEpoch,
          captureRecord.seq,
          new Date(receivedAtMs),
          decoded.heartbeat,
        );
      }

      syncDbMetrics();
    } catch (err) {
      rateLimiter.warn(
        'finalize_accepted_failed',
        { err: err instanceof Error ? err.message : String(err), nodeId },
        'unexpected error finalizing an accepted datagram (DB enqueue/metrics sync)',
      );
    }
  }

  function handleDatagram(buf: Buffer): void {
    metrics.datagramsReceived++;
    metrics.bytesReceived += buf.length;
    try {
      processDatagram(buf);
    } catch (err) {
      // Absolute last-resort guard: no input, however hostile, may throw
      // out of the socket handler (docs/architecture.md "public UDP
      // port" posture).
      metrics.rejected.malformed_payload++;
      deps.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'unexpected error handling datagram',
      );
    }
  }

  return {
    handleDatagram,
    getMetrics(): IngestMetrics {
      syncDbMetrics();
      return structuredClone(metrics);
    },
    async close(): Promise<void> {
      await deps.dbWriteQueue.close();
    },
  };
}
