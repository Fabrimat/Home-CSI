import { BATCH_HEADER_LEN, CSI_RECORD_FIXED_LEN, type CsiFormat } from './constants.js';
import { ProtocolError } from './header.js';
import { macToBuffer, macToString } from './mac.js';

export interface CsiRecord {
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
  /** esp_timer microseconds at capture, node-local monotonic. */
  rxTimestampUs: bigint;
  csiFormat: CsiFormat;
  csiData: Buffer;
}

export interface CsiBatch {
  /** UTC microseconds, wall-clock (SNTP-disciplined). */
  wallClockUs: bigint;
  /** esp_timer microseconds since boot, monotonic. */
  monoUs: bigint;
  sntpSynced: boolean;
  records: CsiRecord[];
}

function encodeCsiRecord(record: CsiRecord): Buffer {
  const csiData = record.csiData;
  if (csiData.length > 0xffff) {
    throw new ProtocolError(`csiData too long: ${csiData.length} bytes`);
  }
  const buf = Buffer.alloc(CSI_RECORD_FIXED_LEN + csiData.length);
  macToBuffer(record.srcMac).copy(buf, 0);
  macToBuffer(record.dstMac).copy(buf, 6);
  buf.writeInt8(record.rssi, 12);
  buf.writeUInt8(record.rate, 13);
  buf.writeUInt8(record.sigMode, 14);
  buf.writeUInt8(record.mcs, 15);
  buf.writeUInt8(record.bandwidth, 16);
  buf.writeUInt8(record.channel, 17);
  buf.writeUInt8(record.secondaryChannel, 18);
  buf.writeInt8(record.noiseFloor, 19);
  buf.writeBigUInt64LE(record.rxTimestampUs, 20);
  buf.writeUInt8(record.csiFormat, 28);
  buf.writeUInt16LE(csiData.length, 29);
  csiData.copy(buf, CSI_RECORD_FIXED_LEN);
  return buf;
}

/** Returns the decoded record and the number of bytes it consumed. */
function decodeCsiRecord(buf: Buffer, offset: number): { record: CsiRecord; length: number } {
  if (offset + CSI_RECORD_FIXED_LEN > buf.length) {
    throw new ProtocolError('truncated CSI record (fixed part)');
  }
  const srcMac = macToString(Buffer.from(buf.subarray(offset, offset + 6)));
  const dstMac = macToString(Buffer.from(buf.subarray(offset + 6, offset + 12)));
  const rssi = buf.readInt8(offset + 12);
  const rate = buf.readUInt8(offset + 13);
  const sigMode = buf.readUInt8(offset + 14);
  const mcs = buf.readUInt8(offset + 15);
  const bandwidth = buf.readUInt8(offset + 16);
  const channel = buf.readUInt8(offset + 17);
  const secondaryChannel = buf.readUInt8(offset + 18);
  const noiseFloor = buf.readInt8(offset + 19);
  const rxTimestampUs = buf.readBigUInt64LE(offset + 20);
  const csiFormat = buf.readUInt8(offset + 28) as CsiFormat;
  const csiLen = buf.readUInt16LE(offset + 29);

  const dataStart = offset + CSI_RECORD_FIXED_LEN;
  if (dataStart + csiLen > buf.length) {
    throw new ProtocolError('truncated CSI record (csi_data)');
  }
  const csiData = Buffer.from(buf.subarray(dataStart, dataStart + csiLen));

  return {
    record: {
      srcMac,
      dstMac,
      rssi,
      rate,
      sigMode,
      mcs,
      bandwidth,
      channel,
      secondaryChannel,
      noiseFloor,
      rxTimestampUs,
      csiFormat,
      csiData,
    },
    length: CSI_RECORD_FIXED_LEN + csiLen,
  };
}

/** Encodes a CSI_BATCH plaintext payload per docs/protocol.md section 9. */
export function encodeCsiBatch(batch: CsiBatch): Buffer {
  if (batch.records.length > 0xffff) {
    throw new ProtocolError(`too many records: ${batch.records.length}`);
  }
  const recordBufs = batch.records.map(encodeCsiRecord);
  const header = Buffer.alloc(BATCH_HEADER_LEN);
  header.writeBigUInt64LE(batch.wallClockUs, 0);
  header.writeBigUInt64LE(batch.monoUs, 8);
  header.writeUInt8(batch.sntpSynced ? 1 : 0, 16);
  // bytes 17..20 reserved, stay zero.
  header.writeUInt16LE(batch.records.length, 20);
  return Buffer.concat([header, ...recordBufs]);
}

/** Decodes a CSI_BATCH plaintext payload per docs/protocol.md section 9. */
export function decodeCsiBatch(buf: Buffer): CsiBatch {
  if (buf.length < BATCH_HEADER_LEN) {
    throw new ProtocolError('truncated CSI_BATCH (batch header)');
  }
  const wallClockUs = buf.readBigUInt64LE(0);
  const monoUs = buf.readBigUInt64LE(8);
  const sntpSynced = buf.readUInt8(16) !== 0;
  const recordCount = buf.readUInt16LE(20);

  const records: CsiRecord[] = [];
  let offset = BATCH_HEADER_LEN;
  for (let i = 0; i < recordCount; i++) {
    const { record, length } = decodeCsiRecord(buf, offset);
    records.push(record);
    offset += length;
  }
  if (offset !== buf.length) {
    throw new ProtocolError(
      `CSI_BATCH payload has ${buf.length - offset} trailing bytes after ${recordCount} records`,
    );
  }

  return { wallClockUs, monoUs, sntpSynced, records };
}
