/**
 * Wire-protocol constants. These mirror docs/protocol.md exactly — if you
 * change a value here, update the doc (and vice versa). See
 * docs-example.test.ts for the mechanism that keeps the worked example in
 * docs/protocol.md byte-for-byte in sync with this implementation.
 */

/** ASCII "HCS1". Never changes across protocol versions. */
export const MAGIC = Uint8Array.from([0x48, 0x43, 0x53, 0x31]);

/** Current protocol version (docs/protocol.md section 3, 13). */
export const PROTOCOL_VERSION = 1;

/** Cleartext header size in bytes (docs/protocol.md section 3). */
export const HEADER_LEN = 28;

/** AEAD tag size in bytes (Poly1305). */
export const TAG_LEN = 16;

/** AEAD nonce size in bytes (ChaCha20-Poly1305 IETF variant). */
export const NONCE_LEN = 12;

/** Pre-shared key size in bytes. */
export const KEY_LEN = 32;

/** Max full datagram size (header + ciphertext + tag), docs/protocol.md section 11. */
export const MAX_DATAGRAM_BYTES = 1200;

/** Max plaintext payload size implied by MAX_DATAGRAM_BYTES. */
export const MAX_PLAINTEXT_BYTES = MAX_DATAGRAM_BYTES - HEADER_LEN - TAG_LEN;

/** Batch header fixed size, docs/protocol.md section 9.1. */
export const BATCH_HEADER_LEN = 22;

/** CSI record fixed part size, docs/protocol.md section 9.2. */
export const CSI_RECORD_FIXED_LEN = 31;

/** HEARTBEAT payload fixed size, docs/protocol.md section 10. */
export const HEARTBEAT_LEN = 36;

/** Message type enum, docs/protocol.md section 8. */
export const MsgType = {
  Invalid: 0,
  CsiBatch: 1,
  Heartbeat: 2,
  Log: 3,
  OtaStatus: 4,
} as const;
export type MsgType = (typeof MsgType)[keyof typeof MsgType];

/** csi_format enum, docs/protocol.md section 9.3. */
export const CsiFormat = {
  Lltf: 0,
  HtLtf: 1,
  LltfHtLtf: 2,
  StbcHtLtf: 3,
} as const;
export type CsiFormat = (typeof CsiFormat)[keyof typeof CsiFormat];

/** bandwidth enum, docs/protocol.md section 9.2. */
export const Bandwidth = {
  Ht20: 0,
  Ht40: 1,
} as const;
export type Bandwidth = (typeof Bandwidth)[keyof typeof Bandwidth];

/** secondary_channel enum, docs/protocol.md section 9.2 (mirrors wifi_second_chan_t). */
export const SecondaryChannel = {
  None: 0,
  Above: 1,
  Below: 2,
} as const;
export type SecondaryChannel = (typeof SecondaryChannel)[keyof typeof SecondaryChannel];

/** sig_mode enum, docs/protocol.md section 9.2. */
export const SigMode = {
  NonHt: 0,
  Ht: 1,
} as const;
export type SigMode = (typeof SigMode)[keyof typeof SigMode];
