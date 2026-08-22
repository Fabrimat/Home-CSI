export {
  MAGIC,
  PROTOCOL_VERSION,
  HEADER_LEN,
  TAG_LEN,
  NONCE_LEN,
  KEY_LEN,
  MAX_DATAGRAM_BYTES,
  MAX_PLAINTEXT_BYTES,
  BATCH_HEADER_LEN,
  CSI_RECORD_FIXED_LEN,
  HEARTBEAT_LEN,
  MsgType,
  CsiFormat,
  Bandwidth,
  SecondaryChannel,
  SigMode,
} from './constants.js';

export { buildNonce, encodeHeader, decodeHeader, ProtocolError } from './header.js';
export type { HeaderFields, DecodedHeader } from './header.js';

export { seal, open } from './crypto.js';

export { macToBuffer, macToString } from './mac.js';

export { encodeCsiBatch, decodeCsiBatch } from './csiBatch.js';
export type { CsiRecord, CsiBatch } from './csiBatch.js';

export { encodeHeartbeat, decodeHeartbeat } from './heartbeat.js';
export type { Heartbeat } from './heartbeat.js';

export {
  encodeCsiBatchDatagram,
  encodeHeartbeatDatagram,
  decodeDatagram,
} from './datagram.js';
export type {
  DecodedDatagram,
  DecodeDatagramOptions,
  EncodeCsiBatchDatagramParams,
  EncodeHeartbeatDatagramParams,
} from './datagram.js';

export { ReplayWindow, DEFAULT_WINDOW_BITS } from './replayWindow.js';
export type { ReplayReason, ReplayResult } from './replayWindow.js';

export {
  csiRecordSchema,
  csiBatchSchema,
  heartbeatSchema,
  decodedDatagramSchema,
} from './schemas.js';
export type {
  CsiRecordShape,
  CsiBatchShape,
  HeartbeatShape,
  DecodedDatagramShape,
} from './schemas.js';
