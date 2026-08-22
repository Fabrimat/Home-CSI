/**
 * Distinct rejection reasons counted by the ingest datagram handler. Each
 * one corresponds to a specific step in the decode/verify pipeline
 * described in docs/protocol.md and packages/cli/CONTRACTS.md — see
 * `engine.ts` for exactly where each is raised.
 */
export type RejectReason =
  | 'oversized'
  | 'truncated'
  | 'bad_magic'
  | 'unsupported_version'
  | 'bad_header'
  | 'unknown_node'
  | 'auth_failed'
  | 'unknown_msg_type'
  | 'stale_epoch'
  | 'too_old'
  | 'duplicate'
  | 'malformed_payload';

export const REJECT_REASONS: readonly RejectReason[] = [
  'oversized',
  'truncated',
  'bad_magic',
  'unsupported_version',
  'bad_header',
  'unknown_node',
  'auth_failed',
  'unknown_msg_type',
  'stale_epoch',
  'too_old',
  'duplicate',
  'malformed_payload',
];

export interface PerNodeMetrics {
  /** Server wall-clock (ms) when the last accepted datagram from this node arrived. */
  lastSeenAtMs: number;
  lastSeq: number;
  lastBootEpoch: number;
  /**
   * Count of accepted CSI_BATCH datagrams from this node in which no CSI
   * record referenced `config.nodes[].expectedMac` (see engine.ts for why
   * this is a soft attribution counter, not a drop reason).
   */
  macMismatches: number;
}

/**
 * Plain, JSON-serializable snapshot of ingest's in-process counters.
 * Exported via `getIngestMetrics()` (see index.ts) so `@homecsi/api`
 * (brief B5) can read it — see that function's doc comment for the
 * same-process caveat.
 */
export interface IngestMetrics {
  datagramsReceived: number;
  bytesReceived: number;
  accepted: number;
  /** Every reason in `REJECT_REASONS` is always present, zero-initialized. */
  rejected: Record<RejectReason, number>;
  /** Rows successfully committed to the database (mirrors DbWriteQueueMetrics.recordsWritten). */
  recordsWritten: number;
  batchInsertFailures: number;
  queueDepth: number;
  queueDrops: number;
  /** Async capture-file writes that failed (fire-and-forget from the socket handler; see engine.ts). */
  captureWriteFailures: number;
  perNode: Record<number, PerNodeMetrics>;
}

export function createEmptyMetrics(): IngestMetrics {
  const rejected = Object.fromEntries(REJECT_REASONS.map((r) => [r, 0])) as Record<RejectReason, number>;
  return {
    datagramsReceived: 0,
    bytesReceived: 0,
    accepted: 0,
    rejected,
    recordsWritten: 0,
    batchInsertFailures: 0,
    queueDepth: 0,
    queueDrops: 0,
    captureWriteFailures: 0,
    perNode: {},
  };
}
