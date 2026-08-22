import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  CsiFormat,
  MAX_DATAGRAM_BYTES,
  ProtocolError,
  buildNonce,
  decodeDatagram,
  encodeCsiBatchDatagram,
  encodeHeartbeatDatagram,
  type CsiBatch,
  type Heartbeat,
} from './index.js';

const KEY = randomBytes(32);
const keyForNode = (nodeId: number): Buffer | undefined => (nodeId === 7 ? KEY : undefined);

function makeBatch(): CsiBatch {
  return {
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
      {
        srcMac: '11:22:33:44:55:66',
        dstMac: '66:55:44:33:22:11',
        rssi: -60,
        rate: 12,
        sigMode: 1,
        mcs: 15,
        bandwidth: 0,
        channel: 6,
        secondaryChannel: 0,
        noiseFloor: -90,
        rxTimestampUs: 123_460_000n,
        csiFormat: CsiFormat.LltfHtLtf,
        // deliberately a different, longer length than the first record
        csiData: Buffer.from(Array.from({ length: 40 }, (_, i) => i)),
      },
    ],
  };
}

function makeHeartbeat(): Heartbeat {
  return {
    uptimeS: 3600,
    freeHeapBytes: 120_000,
    minFreeHeapBytes: 90_000,
    framesCaptured: 5000,
    framesDropped: 3,
    batchesSent: 250,
    sendFailures: 1,
    rssiToAp: -55,
    channel: 6,
    sntpSynced: true,
    fwVersionMajor: 0,
    fwVersionMinor: 1,
    fwVersionPatch: 0,
  };
}

describe('CSI_BATCH round trip', () => {
  it('round-trips a batch with two distinct csi_format tags and differing lengths', () => {
    const batch = makeBatch();
    const datagram = encodeCsiBatchDatagram({ nodeId: 7, bootEpoch: 3, seq: 42, key: KEY, batch });

    expect(datagram.length).toBeLessThanOrEqual(MAX_DATAGRAM_BYTES);

    const decoded = decodeDatagram(datagram, keyForNode);
    expect(decoded.type).toBe('CSI_BATCH');
    if (decoded.type !== 'CSI_BATCH') throw new Error('unreachable');

    expect(decoded.nodeId).toBe(7);
    expect(decoded.bootEpoch).toBe(3);
    expect(decoded.seq).toBe(42);
    expect(decoded.batch.wallClockUs).toBe(batch.wallClockUs);
    expect(decoded.batch.monoUs).toBe(batch.monoUs);
    expect(decoded.batch.sntpSynced).toBe(true);
    expect(decoded.batch.records).toHaveLength(2);

    expect(decoded.batch.records[0]?.csiFormat).toBe(CsiFormat.Lltf);
    expect(decoded.batch.records[0]?.csiData).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(decoded.batch.records[1]?.csiFormat).toBe(CsiFormat.LltfHtLtf);
    expect(decoded.batch.records[1]?.csiData).toHaveLength(40);
    expect(decoded.batch.records[0]?.srcMac).toBe('aa:bb:cc:dd:ee:01');
    expect(decoded.batch.records[1]?.rssi).toBe(-60);
  });

  it('round-trips a batch with zero records', () => {
    const batch: CsiBatch = {
      wallClockUs: 1n,
      monoUs: 2n,
      sntpSynced: false,
      records: [],
    };
    const datagram = encodeCsiBatchDatagram({ nodeId: 7, bootEpoch: 0, seq: 0, key: KEY, batch });
    const decoded = decodeDatagram(datagram, keyForNode);
    expect(decoded.type).toBe('CSI_BATCH');
    if (decoded.type !== 'CSI_BATCH') throw new Error('unreachable');
    expect(decoded.batch.records).toHaveLength(0);
    expect(decoded.batch.sntpSynced).toBe(false);
  });
});

describe('HEARTBEAT round trip', () => {
  it('round-trips a heartbeat', () => {
    const heartbeat = makeHeartbeat();
    const datagram = encodeHeartbeatDatagram({
      nodeId: 7,
      bootEpoch: 3,
      seq: 43,
      key: KEY,
      heartbeat,
    });
    const decoded = decodeDatagram(datagram, keyForNode);
    expect(decoded.type).toBe('HEARTBEAT');
    if (decoded.type !== 'HEARTBEAT') throw new Error('unreachable');
    expect(decoded.heartbeat).toEqual(heartbeat);
  });
});

describe('tamper detection', () => {
  it('rejects a flipped byte in the cleartext header (AAD)', () => {
    const datagram = encodeCsiBatchDatagram({
      nodeId: 7,
      bootEpoch: 3,
      seq: 1,
      key: KEY,
      batch: makeBatch(),
    });
    const tampered = Buffer.from(datagram);
    // flip a bit inside the header (node_id byte), which is part of the AAD
    tampered[6] = (tampered[6] ?? 0) ^ 0xff;
    expect(() => decodeDatagram(tampered, keyForNode)).toThrow();
  });

  it('rejects a flipped byte in the ciphertext', () => {
    const datagram = encodeCsiBatchDatagram({
      nodeId: 7,
      bootEpoch: 3,
      seq: 1,
      key: KEY,
      batch: makeBatch(),
    });
    const tampered = Buffer.from(datagram);
    // flip a byte well inside the ciphertext region (after the 28-byte header)
    const idx = 40;
    tampered[idx] = (tampered[idx] ?? 0) ^ 0xff;
    expect(() => decodeDatagram(tampered, keyForNode)).toThrow(ProtocolError);
  });

  it('rejects when decrypted with the wrong key', () => {
    const datagram = encodeCsiBatchDatagram({
      nodeId: 7,
      bootEpoch: 3,
      seq: 1,
      key: KEY,
      batch: makeBatch(),
    });
    const wrongKeyForNode = () => randomBytes(32);
    expect(() => decodeDatagram(datagram, wrongKeyForNode)).toThrow(ProtocolError);
  });
});

describe('nonce uniqueness', () => {
  it('produces distinct nonces for every distinct (nodeId, bootEpoch, seq)', () => {
    const seen = new Set<string>();
    for (let nodeId = 1; nodeId <= 3; nodeId++) {
      for (let bootEpoch = 0; bootEpoch <= 2; bootEpoch++) {
        for (let seq = 0; seq <= 5; seq++) {
          const nonce = buildNonce(nodeId, bootEpoch, seq).toString('hex');
          expect(seen.has(nonce)).toBe(false);
          seen.add(nonce);
        }
      }
    }
  });

  it('embeds a zeroed reserved tail', () => {
    const nonce = buildNonce(1, 2, 3);
    expect(nonce.subarray(10, 12)).toEqual(Buffer.from([0, 0]));
  });
});

describe('framing validation', () => {
  it('rejects a truncated datagram', () => {
    const datagram = encodeCsiBatchDatagram({
      nodeId: 7,
      bootEpoch: 0,
      seq: 0,
      key: KEY,
      batch: makeBatch(),
    });
    const truncated = datagram.subarray(0, 10);
    expect(() => decodeDatagram(Buffer.from(truncated), keyForNode)).toThrow(ProtocolError);
  });

  it('rejects an oversized datagram', () => {
    const oversized = Buffer.alloc(MAX_DATAGRAM_BYTES + 1);
    expect(() => decodeDatagram(oversized, keyForNode)).toThrow(ProtocolError);
  });

  it('rejects an unknown node id (no key configured)', () => {
    const datagram = encodeCsiBatchDatagram({
      nodeId: 99,
      bootEpoch: 0,
      seq: 0,
      key: KEY,
      batch: makeBatch(),
    });
    expect(() => decodeDatagram(datagram, keyForNode)).toThrow(ProtocolError);
  });

  it('rejects an unsupported protocol version', () => {
    const datagram = encodeCsiBatchDatagram({
      nodeId: 7,
      bootEpoch: 0,
      seq: 0,
      key: KEY,
      batch: makeBatch(),
      version: 99,
    });
    expect(() => decodeDatagram(datagram, keyForNode)).toThrow(ProtocolError);
  });

  it('rejects a datagram whose nonce field was tampered independently of node/epoch/seq', () => {
    const datagram = encodeCsiBatchDatagram({
      nodeId: 7,
      bootEpoch: 0,
      seq: 0,
      key: KEY,
      batch: makeBatch(),
    });
    const tampered = Buffer.from(datagram);
    // nonce field lives at header offset 16..28
    tampered[16] = (tampered[16] ?? 0) ^ 0xff;
    expect(() => decodeDatagram(tampered, keyForNode)).toThrow(ProtocolError);
  });
});

describe('seq/boot_epoch exhaustion boundary (docs/protocol.md section 4.1)', () => {
  it('encodes and round-trips seq = 0xFFFFFFFF, the last valid seq in an epoch', () => {
    const datagram = encodeCsiBatchDatagram({
      nodeId: 7,
      bootEpoch: 0,
      seq: 0xffffffff,
      key: KEY,
      batch: makeBatch(),
    });
    const decoded = decodeDatagram(datagram, keyForNode);
    expect(decoded.seq).toBe(0xffffffff);
  });

  it('encodes and round-trips boot_epoch = 0xFFFFFFFF, the last valid epoch', () => {
    const datagram = encodeCsiBatchDatagram({
      nodeId: 7,
      bootEpoch: 0xffffffff,
      seq: 0,
      key: KEY,
      batch: makeBatch(),
    });
    const decoded = decodeDatagram(datagram, keyForNode);
    expect(decoded.bootEpoch).toBe(0xffffffff);
  });

  it('rejects a seq beyond the u32 range rather than silently wrapping it', () => {
    expect(() =>
      encodeCsiBatchDatagram({
        nodeId: 7,
        bootEpoch: 0,
        seq: 0x100000000,
        key: KEY,
        batch: makeBatch(),
      }),
    ).toThrow(ProtocolError);
  });

  it('rejects a boot_epoch beyond the u32 range rather than silently wrapping it', () => {
    expect(() =>
      encodeCsiBatchDatagram({
        nodeId: 7,
        bootEpoch: 0x100000000,
        seq: 0,
        key: KEY,
        batch: makeBatch(),
      }),
    ).toThrow(ProtocolError);
  });

  it('produces a distinct nonce for seq = 0xFFFFFFFF vs. a wrapped seq = 0 in the same epoch', () => {
    const atCeiling = buildNonce(7, 3, 0xffffffff);
    const wrapped = buildNonce(7, 3, 0);
    expect(atCeiling.equals(wrapped)).toBe(false);
  });
});
