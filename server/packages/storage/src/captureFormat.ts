import type { MsgType } from '@homecsi/protocol';

/**
 * Magic bytes at the very start of every shard file (after decompression,
 * if the shard is gzipped). Identifies the file as a Home CSI raw-capture
 * shard and pins the record framing format version described in
 * `packages/storage/FORMAT.md`. Bump this (e.g. `HCSCAP02`) if the record
 * framing below ever changes in a non-backward-compatible way.
 */
export const SHARD_MAGIC = Buffer.from('HCSCAP01', 'ascii');

/** Fixed-size portion of one capture record, in bytes (see FORMAT.md). */
const ENVELOPE_FIXED_LEN =
  8 /* receivedAtMs */ + 2 /* nodeId */ + 4 /* bootEpoch */ + 4 /* seq */ + 1 /* msgType */;

/**
 * One accepted, decrypted datagram as stored in a capture shard. `payload`
 * is exactly the plaintext bytes produced by `@homecsi/protocol`'s
 * `encodeCsiBatch`/`encodeHeartbeat` — capture never re-implements wire
 * codec logic, it just wraps the already-decoded payload with enough
 * envelope metadata to replay faithfully.
 */
export interface CaptureRecordEnvelope {
  /** Server wall-clock (`Date.now()`, milliseconds) when this datagram was accepted. */
  receivedAtMs: number;
  nodeId: number;
  bootEpoch: number;
  seq: number;
  msgType: typeof MsgType.CsiBatch | typeof MsgType.Heartbeat;
  payload: Buffer;
}

/**
 * Encodes one capture record as `[u32 LE bodyLen][body]`, where `body` is
 * the fixed envelope fields followed by `payload`. The length prefix is
 * what lets a reader detect a truncated final record cleanly (see
 * `captureReader.ts` and FORMAT.md) instead of needing a checksum.
 */
export function encodeCaptureRecord(rec: CaptureRecordEnvelope): Buffer {
  const body = Buffer.alloc(ENVELOPE_FIXED_LEN + rec.payload.length);
  body.writeBigUInt64LE(BigInt(rec.receivedAtMs), 0);
  body.writeUInt16LE(rec.nodeId, 8);
  body.writeUInt32LE(rec.bootEpoch, 10);
  body.writeUInt32LE(rec.seq, 14);
  body.writeUInt8(rec.msgType, 18);
  rec.payload.copy(body, ENVELOPE_FIXED_LEN);

  const lenPrefix = Buffer.alloc(4);
  lenPrefix.writeUInt32LE(body.length, 0);
  return Buffer.concat([lenPrefix, body]);
}

export interface DecodedCaptureRecord {
  record: CaptureRecordEnvelope;
  /** Total bytes consumed from the buffer, including the 4-byte length prefix. */
  length: number;
}

/**
 * Attempts to decode exactly one record starting at `offset` in `buf`.
 * Returns `null` (rather than throwing) whenever there are not yet enough
 * bytes to know it is complete: a missing/partial length prefix, or a
 * declared body length that runs past the end of the available bytes, is
 * treated identically as "not a complete record yet". This is what makes
 * a truncated *final* record (abrupt process kill mid-write, or reading a
 * shard while it is still being appended to) a clean "stop here" rather
 * than a hard parse error.
 *
 * This alone only catches *end-of-stream* truncation — it cannot detect a
 * torn record buried in the *middle* of an otherwise-longer file (bytes
 * missing partway through, followed by more data). That class of
 * corruption is prevented on the write side instead: `CaptureWriter`
 * checks every `write()`'s `bytesWritten` and treats a short write as
 * fatal for the current shard (closing/finalizing it immediately rather
 * than writing anything further to it), so a shard this function is ever
 * asked to parse is either fully well-formed or has at most one truncated
 * tail at the very end. See FORMAT.md's "What this does and does not
 * protect against".
 */
export function decodeCaptureRecordAt(buf: Buffer, offset: number): DecodedCaptureRecord | null {
  if (offset + 4 > buf.length) {
    return null;
  }
  const bodyLen = buf.readUInt32LE(offset);
  if (bodyLen < ENVELOPE_FIXED_LEN) {
    // A well-formed writer never emits a body shorter than the fixed
    // envelope; treat this the same as "incomplete" so we stop instead of
    // misinterpreting corrupted bytes as a giant/negative record.
    return null;
  }
  const totalLen = 4 + bodyLen;
  if (offset + totalLen > buf.length) {
    return null;
  }

  const bodyStart = offset + 4;
  const receivedAtMs = Number(buf.readBigUInt64LE(bodyStart));
  const nodeId = buf.readUInt16LE(bodyStart + 8);
  const bootEpoch = buf.readUInt32LE(bodyStart + 10);
  const seq = buf.readUInt32LE(bodyStart + 14);
  const msgType = buf.readUInt8(bodyStart + 18) as CaptureRecordEnvelope['msgType'];
  const payload = Buffer.from(buf.subarray(bodyStart + ENVELOPE_FIXED_LEN, bodyStart + bodyLen));

  return {
    record: { receivedAtMs, nodeId, bootEpoch, seq, msgType, payload },
    length: totalLen,
  };
}
