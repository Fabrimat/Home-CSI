import { HEADER_LEN, MAX_DATAGRAM_BYTES, MsgType, PROTOCOL_VERSION, TAG_LEN } from './constants.js';
import { open, seal } from './crypto.js';
import { decodeHeader, encodeHeader, ProtocolError } from './header.js';
import { decodeCsiBatch, encodeCsiBatch, type CsiBatch } from './csiBatch.js';
import { decodeHeartbeat, encodeHeartbeat, type Heartbeat } from './heartbeat.js';

export interface EncodeCsiBatchDatagramParams {
  nodeId: number;
  bootEpoch: number;
  seq: number;
  key: Buffer;
  batch: CsiBatch;
  version?: number;
}

export interface EncodeHeartbeatDatagramParams {
  nodeId: number;
  bootEpoch: number;
  seq: number;
  key: Buffer;
  heartbeat: Heartbeat;
  version?: number;
}

function assembleDatagram(
  version: number,
  msgType: MsgType,
  nodeId: number,
  bootEpoch: number,
  seq: number,
  key: Buffer,
  plaintext: Buffer,
): Buffer {
  const header = encodeHeader({ version, msgType, nodeId, bootEpoch, seq });
  const nonce = header.subarray(16, 28);
  const sealed = seal(key, Buffer.from(nonce), header, plaintext);
  const datagram = Buffer.concat([header, sealed]);
  if (datagram.length > MAX_DATAGRAM_BYTES) {
    throw new ProtocolError(
      `encoded datagram (${datagram.length} bytes) exceeds MAX_DATAGRAM_BYTES (${MAX_DATAGRAM_BYTES})`,
    );
  }
  return datagram;
}

/** Encodes a full CSI_BATCH datagram: cleartext header + AEAD-sealed payload. */
export function encodeCsiBatchDatagram(params: EncodeCsiBatchDatagramParams): Buffer {
  const plaintext = encodeCsiBatch(params.batch);
  return assembleDatagram(
    params.version ?? PROTOCOL_VERSION,
    MsgType.CsiBatch,
    params.nodeId,
    params.bootEpoch,
    params.seq,
    params.key,
    plaintext,
  );
}

/** Encodes a full HEARTBEAT datagram: cleartext header + AEAD-sealed payload. */
export function encodeHeartbeatDatagram(params: EncodeHeartbeatDatagramParams): Buffer {
  const plaintext = encodeHeartbeat(params.heartbeat);
  return assembleDatagram(
    params.version ?? PROTOCOL_VERSION,
    MsgType.Heartbeat,
    params.nodeId,
    params.bootEpoch,
    params.seq,
    params.key,
    plaintext,
  );
}

export type DecodedDatagram =
  | {
      type: 'CSI_BATCH';
      version: number;
      nodeId: number;
      bootEpoch: number;
      seq: number;
      batch: CsiBatch;
    }
  | {
      type: 'HEARTBEAT';
      version: number;
      nodeId: number;
      bootEpoch: number;
      seq: number;
      heartbeat: Heartbeat;
    };

export interface DecodeDatagramOptions {
  /** Protocol versions this decoder accepts. Defaults to [PROTOCOL_VERSION]. */
  supportedVersions?: readonly number[];
}

/**
 * Decodes a raw UDP datagram end-to-end: framing/size checks, cleartext
 * header + nonce validation, version check, AEAD open (using
 * `keyForNode(nodeId)` to look up the per-node PSK), then dispatch to the
 * message-type-specific payload decoder. Throws ProtocolError on any
 * failure — callers are expected to catch, drop, and count metrics rather
 * than propagate (docs/protocol.md sections 2, 5, 8, 13).
 */
export function decodeDatagram(
  buf: Buffer,
  keyForNode: (nodeId: number) => Buffer | undefined,
  options: DecodeDatagramOptions = {},
): DecodedDatagram {
  const supportedVersions = options.supportedVersions ?? [PROTOCOL_VERSION];

  if (buf.length > MAX_DATAGRAM_BYTES) {
    throw new ProtocolError(`oversized datagram: ${buf.length} bytes`);
  }
  if (buf.length < HEADER_LEN + TAG_LEN) {
    throw new ProtocolError(`truncated datagram: ${buf.length} bytes`);
  }

  const headerBuf = Buffer.from(buf.subarray(0, HEADER_LEN));
  const header = decodeHeader(headerBuf);

  if (!supportedVersions.includes(header.version)) {
    throw new ProtocolError(
      `unsupported protocol version ${header.version} from node ${header.nodeId}`,
    );
  }

  const key = keyForNode(header.nodeId);
  if (!key) {
    throw new ProtocolError(`no key configured for node_id ${header.nodeId}`);
  }

  const ciphertextAndTag = Buffer.from(buf.subarray(HEADER_LEN));
  const plaintext = open(key, header.nonce, headerBuf, ciphertextAndTag);

  switch (header.msgType) {
    case MsgType.CsiBatch:
      return {
        type: 'CSI_BATCH',
        version: header.version,
        nodeId: header.nodeId,
        bootEpoch: header.bootEpoch,
        seq: header.seq,
        batch: decodeCsiBatch(plaintext),
      };
    case MsgType.Heartbeat:
      return {
        type: 'HEARTBEAT',
        version: header.version,
        nodeId: header.nodeId,
        bootEpoch: header.bootEpoch,
        seq: header.seq,
        heartbeat: decodeHeartbeat(plaintext),
      };
    default:
      throw new ProtocolError(`unsupported msg_type ${header.msgType}`);
  }
}
