import { HEADER_LEN, MAGIC, NONCE_LEN, type MsgType } from './constants.js';

export interface HeaderFields {
  version: number;
  msgType: MsgType;
  nodeId: number;
  bootEpoch: number;
  seq: number;
}

export class ProtocolError extends Error {}

/**
 * Builds the 12-byte nonce deterministically from (nodeId, bootEpoch, seq),
 * per docs/protocol.md section 4:
 *   nonce[0..2)   = nodeId     (u16 LE)
 *   nonce[2..6)   = bootEpoch  (u32 LE)
 *   nonce[6..10)  = seq        (u32 LE)
 *   nonce[10..12) = 0x00 0x00
 */
export function buildNonce(nodeId: number, bootEpoch: number, seq: number): Buffer {
  const nonce = Buffer.alloc(NONCE_LEN);
  nonce.writeUInt16LE(nodeId, 0);
  nonce.writeUInt32LE(bootEpoch, 2);
  nonce.writeUInt32LE(seq, 6);
  // bytes 10..12 stay zero (reserved).
  return nonce;
}

/**
 * Encodes the 28-byte cleartext header (also used verbatim as AEAD AAD).
 *
 * `seq`'s full u32 range up to and including `0xffffffff` is a valid,
 * encodable value — it is the *last* usable seq in a boot_epoch, not an
 * invalid one (docs/protocol.md section 4.1). This function is stateless
 * and does not itself enforce the "never wrap" rule (it has no persisted
 * counter to wrap); callers that own a per-boot sequence counter are
 * responsible for treating `0xffffffff` as exhaustion and refusing to
 * produce a `seq` of `0` again under the same `boot_epoch`.
 */
export function encodeHeader(fields: HeaderFields): Buffer {
  const { version, msgType, nodeId, bootEpoch, seq } = fields;
  if (!Number.isInteger(nodeId) || nodeId < 0 || nodeId > 0xffff) {
    throw new ProtocolError(`nodeId out of range: ${nodeId}`);
  }
  if (!Number.isInteger(bootEpoch) || bootEpoch < 0 || bootEpoch > 0xffffffff) {
    throw new ProtocolError(`bootEpoch out of range: ${bootEpoch}`);
  }
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) {
    throw new ProtocolError(`seq out of range: ${seq}`);
  }

  const header = Buffer.alloc(HEADER_LEN);
  Buffer.from(MAGIC).copy(header, 0);
  header.writeUInt8(version, 4);
  header.writeUInt8(msgType, 5);
  header.writeUInt16LE(nodeId, 6);
  header.writeUInt32LE(bootEpoch, 8);
  header.writeUInt32LE(seq, 12);
  buildNonce(nodeId, bootEpoch, seq).copy(header, 16);
  return header;
}

export interface DecodedHeader extends HeaderFields {
  nonce: Buffer;
}

/**
 * Decodes and validates the 28-byte cleartext header. Verifies the magic,
 * and that the embedded nonce matches the deterministic construction from
 * (nodeId, bootEpoch, seq) — see docs/protocol.md section 4. Does NOT check
 * `version` support; callers decide what versions they accept (section 13).
 */
export function decodeHeader(buf: Buffer): DecodedHeader {
  if (buf.length < HEADER_LEN) {
    throw new ProtocolError(`truncated header: got ${buf.length} bytes, need ${HEADER_LEN}`);
  }
  const magic = buf.subarray(0, 4);
  if (!magic.equals(Buffer.from(MAGIC))) {
    throw new ProtocolError('bad magic');
  }
  const version = buf.readUInt8(4);
  const msgType = buf.readUInt8(5) as MsgType;
  const nodeId = buf.readUInt16LE(6);
  const bootEpoch = buf.readUInt32LE(8);
  const seq = buf.readUInt32LE(12);
  const nonce = Buffer.from(buf.subarray(16, 28));

  const expectedNonce = buildNonce(nodeId, bootEpoch, seq);
  if (!nonce.equals(expectedNonce)) {
    throw new ProtocolError('nonce does not match (nodeId, bootEpoch, seq) construction');
  }

  return { version, msgType, nodeId, bootEpoch, seq, nonce };
}
