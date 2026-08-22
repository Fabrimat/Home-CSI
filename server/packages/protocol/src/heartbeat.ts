import { HEARTBEAT_LEN } from './constants.js';
import { ProtocolError } from './header.js';

export interface Heartbeat {
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
  fwVersionMajor: number;
  fwVersionMinor: number;
  fwVersionPatch: number;
}

/** Encodes a HEARTBEAT plaintext payload per docs/protocol.md section 10. */
export function encodeHeartbeat(hb: Heartbeat): Buffer {
  const buf = Buffer.alloc(HEARTBEAT_LEN);
  buf.writeUInt32LE(hb.uptimeS, 0);
  buf.writeUInt32LE(hb.freeHeapBytes, 4);
  buf.writeUInt32LE(hb.minFreeHeapBytes, 8);
  buf.writeUInt32LE(hb.framesCaptured, 12);
  buf.writeUInt32LE(hb.framesDropped, 16);
  buf.writeUInt32LE(hb.batchesSent, 20);
  buf.writeUInt32LE(hb.sendFailures, 24);
  buf.writeInt8(hb.rssiToAp, 28);
  buf.writeUInt8(hb.channel, 29);
  buf.writeUInt8(hb.sntpSynced ? 1 : 0, 30);
  buf.writeUInt8(hb.fwVersionMajor, 31);
  buf.writeUInt8(hb.fwVersionMinor, 32);
  buf.writeUInt8(hb.fwVersionPatch, 33);
  // bytes 34..36 reserved, stay zero.
  return buf;
}

/** Decodes a HEARTBEAT plaintext payload per docs/protocol.md section 10. */
export function decodeHeartbeat(buf: Buffer): Heartbeat {
  if (buf.length !== HEARTBEAT_LEN) {
    throw new ProtocolError(`HEARTBEAT payload must be ${HEARTBEAT_LEN} bytes, got ${buf.length}`);
  }
  return {
    uptimeS: buf.readUInt32LE(0),
    freeHeapBytes: buf.readUInt32LE(4),
    minFreeHeapBytes: buf.readUInt32LE(8),
    framesCaptured: buf.readUInt32LE(12),
    framesDropped: buf.readUInt32LE(16),
    batchesSent: buf.readUInt32LE(20),
    sendFailures: buf.readUInt32LE(24),
    rssiToAp: buf.readInt8(28),
    channel: buf.readUInt8(29),
    sntpSynced: buf.readUInt8(30) !== 0,
    fwVersionMajor: buf.readUInt8(31),
    fwVersionMinor: buf.readUInt8(32),
    fwVersionPatch: buf.readUInt8(33),
  };
}
