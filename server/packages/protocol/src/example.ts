import { CsiFormat } from './constants.js';
import { encodeCsiBatchDatagram } from './datagram.js';
import type { CsiBatch } from './csiBatch.js';

/**
 * Fixed inputs for the worked example in docs/protocol.md section 13.
 * Every value here (including the key) is fixed/non-random so the encoded
 * datagram is fully deterministic and can be embedded verbatim in the doc.
 */
export const EXAMPLE_NODE_ID = 7;
export const EXAMPLE_BOOT_EPOCH = 3;
export const EXAMPLE_SEQ = 42;
export const EXAMPLE_KEY = Buffer.from(
  Array.from({ length: 32 }, (_, i) => i), // 00 01 02 ... 1f
);

export const EXAMPLE_BATCH: CsiBatch = {
  wallClockUs: 1_700_000_000_000_000n,
  monoUs: 123_456_789n,
  sntpSynced: true,
  records: [
    {
      srcMac: 'aa:bb:cc:dd:ee:01',
      dstMac: 'aa:bb:cc:dd:ee:ff',
      rssi: -42,
      rate: 11,
      sigMode: 1,
      mcs: 7,
      bandwidth: 0,
      channel: 6,
      secondaryChannel: 0,
      noiseFloor: -95,
      rxTimestampUs: 123_456_700n,
      csiFormat: CsiFormat.Lltf,
      csiData: Buffer.from([1, 2, 3, 4]),
    },
  ],
};

export function buildExampleDatagram(): Buffer {
  return encodeCsiBatchDatagram({
    nodeId: EXAMPLE_NODE_ID,
    bootEpoch: EXAMPLE_BOOT_EPOCH,
    seq: EXAMPLE_SEQ,
    key: EXAMPLE_KEY,
    batch: EXAMPLE_BATCH,
  });
}

function hexBytes(buf: Buffer): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function hexDumpLines(buf: Buffer, bytesPerLine = 16): string[] {
  const lines: string[] = [];
  for (let offset = 0; offset < buf.length; offset += bytesPerLine) {
    const chunk = buf.subarray(offset, offset + bytesPerLine);
    lines.push(`${offset.toString(16).padStart(4, '0')}  ${hexBytes(chunk)}`);
  }
  return lines;
}

/**
 * Builds the full annotated hex dump text embedded in
 * docs/protocol.md section 13, between the GENERATED_EXAMPLE markers.
 *
 * This is a convenience generator for the doc's *prose* (offsets, decoded
 * field values) after an intentional change to the example inputs — it is
 * NOT the correctness check. It calls this package's own encoder
 * (`buildExampleDatagram` -> `encodeCsiBatchDatagram`), so comparing its
 * output to the doc would only prove neither was hand-edited since the
 * last run, not that either is correct. The actual correctness check is
 * `docs-example.test.ts`'s hardcoded, independently-derived golden vector
 * (laid out by hand and sealed via a direct `node:crypto` call, cross-
 * checked against firmware's own derivation in
 * `firmware/tests/test_docs_example.c`), which both this encoder's output
 * and the doc's raw bytes are checked against — not against each other.
 */
export function buildAnnotatedHexDump(): string {
  const datagram = buildExampleDatagram();
  const header = datagram.subarray(0, 28);
  const ciphertextAndTag = datagram.subarray(28);
  const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);

  const lines: string[] = [];
  lines.push(`Full datagram, ${datagram.length} bytes total:`);
  lines.push('');
  lines.push(...hexDumpLines(datagram));
  lines.push('');
  lines.push('Cleartext header (28 bytes, also the AEAD AAD):');
  lines.push(`  magic       (offset  0, 4B): ${hexBytes(header.subarray(0, 4))}  ("HCS1")`);
  lines.push(`  version     (offset  4, 1B): ${hexBytes(header.subarray(4, 5))}  (${header.readUInt8(4)})`);
  lines.push(`  msg_type    (offset  5, 1B): ${hexBytes(header.subarray(5, 6))}  (${header.readUInt8(5)} = CSI_BATCH)`);
  lines.push(`  node_id     (offset  6, 2B): ${hexBytes(header.subarray(6, 8))}  (${header.readUInt16LE(6)})`);
  lines.push(`  boot_epoch  (offset  8, 4B): ${hexBytes(header.subarray(8, 12))}  (${header.readUInt32LE(8)})`);
  lines.push(`  seq         (offset 12, 4B): ${hexBytes(header.subarray(12, 16))}  (${header.readUInt32LE(12)})`);
  lines.push(`  nonce       (offset 16, 12B): ${hexBytes(header.subarray(16, 28))}`);
  lines.push('');
  lines.push(`Ciphertext (${ciphertext.length} bytes, offset 28):`);
  lines.push(...hexDumpLines(ciphertext).map((l) => `  ${l}`));
  lines.push('');
  lines.push(`Auth tag (16 bytes, offset ${28 + ciphertext.length}):`);
  lines.push(`  ${hexBytes(tag)}`);
  lines.push('');
  lines.push('Decrypted plaintext (CSI_BATCH payload) for reference:');
  lines.push('  batch header (22 bytes):');
  lines.push(`    wall_clock_us (offset 0, 8B) = ${EXAMPLE_BATCH.wallClockUs}`);
  lines.push(`    mono_us       (offset 8, 8B) = ${EXAMPLE_BATCH.monoUs}`);
  lines.push('    sntp_synced   (offset 16, 1B) = 1');
  lines.push('    reserved      (offset 17, 3B) = 00 00 00');
  lines.push(`    record_count  (offset 20, 2B) = ${EXAMPLE_BATCH.records.length}`);
  lines.push('  record[0] (31-byte fixed part + 4 bytes csi_data):');
  lines.push(`    src_mac            = ${EXAMPLE_BATCH.records[0]?.srcMac}`);
  lines.push(`    dst_mac            = ${EXAMPLE_BATCH.records[0]?.dstMac}`);
  lines.push(`    rssi               = ${EXAMPLE_BATCH.records[0]?.rssi}`);
  lines.push(`    rate               = ${EXAMPLE_BATCH.records[0]?.rate}`);
  lines.push(`    sig_mode           = ${EXAMPLE_BATCH.records[0]?.sigMode}`);
  lines.push(`    mcs                = ${EXAMPLE_BATCH.records[0]?.mcs}`);
  lines.push(`    bandwidth          = ${EXAMPLE_BATCH.records[0]?.bandwidth}`);
  lines.push(`    channel            = ${EXAMPLE_BATCH.records[0]?.channel}`);
  lines.push(`    secondary_channel  = ${EXAMPLE_BATCH.records[0]?.secondaryChannel}`);
  lines.push(`    noise_floor        = ${EXAMPLE_BATCH.records[0]?.noiseFloor}`);
  lines.push(`    rx_timestamp_us    = ${EXAMPLE_BATCH.records[0]?.rxTimestampUs}`);
  lines.push(`    csi_format         = ${EXAMPLE_BATCH.records[0]?.csiFormat} (LLTF)`);
  lines.push(`    csi_len            = ${EXAMPLE_BATCH.records[0]?.csiData.length}`);
  lines.push(`    csi_data           = ${hexBytes(Buffer.from(EXAMPLE_BATCH.records[0]?.csiData ?? []))}`);

  return lines.join('\n');
}
