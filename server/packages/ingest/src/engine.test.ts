import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CsiFormat,
  MsgType,
  encodeCsiBatchDatagram,
  encodeHeader,
  encodeHeartbeatDatagram,
  seal,
  type CsiBatch,
  type Heartbeat,
} from '@homecsi/protocol';
import type { CaptureRecordEnvelope, DbWriteQueueMetrics } from '@homecsi/storage';
import { createIngestEngine, type CaptureWriterLike, type DbWriteQueueLike } from './engine.js';
import type { Logger } from './logger.js';
import { makeTestConfig, testPsk } from './testHelpers.js';

/**
 * `handleDatagram` deliberately does not await its internal capture-write
 * -> DB-enqueue continuation (see engine.ts's `finalizeAccepted`), so
 * tests that assert on capture/DB-queue side effects must let pending
 * microtasks/macrotasks drain first. `setImmediate` schedules after the
 * current microtask queue is fully drained, which is enough for any
 * chain of already-resolved promises (as our fakes use).
 */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// --- Test fakes -------------------------------------------------------

function makeFakeLogger(): Logger {
  const noop = (): void => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  } as unknown as Logger;
}

class FakeCaptureWriter {
  public records: CaptureRecordEnvelope[] = [];
  appendRecord(rec: CaptureRecordEnvelope): Promise<void> {
    this.records.push(rec);
    return Promise.resolve();
  }
}

class FakeDbWriteQueue implements DbWriteQueueLike {
  public csiCalls: Array<{ nodeId: number; bootEpoch: number; seq: number; receivedAt: Date; batch: CsiBatch }> = [];
  public heartbeatCalls: Array<{
    nodeId: number;
    bootEpoch: number;
    seq: number;
    receivedAt: Date;
    heartbeat: Heartbeat;
  }> = [];
  enqueueCsiBatch(nodeId: number, bootEpoch: number, seq: number, receivedAt: Date, batch: CsiBatch): void {
    this.csiCalls.push({ nodeId, bootEpoch, seq, receivedAt, batch });
  }
  enqueueHeartbeat(nodeId: number, bootEpoch: number, seq: number, receivedAt: Date, heartbeat: Heartbeat): void {
    this.heartbeatCalls.push({ nodeId, bootEpoch, seq, receivedAt, heartbeat });
  }
  upsertNode(): Promise<void> {
    return Promise.resolve();
  }
  getMetrics(): DbWriteQueueMetrics {
    return {
      queueDepth: 0,
      queueDrops: 0,
      recordsWritten: this.csiCalls.length + this.heartbeatCalls.length,
      batchInsertFailures: 0,
    };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function makeHarness(nodes: Array<{ id: number; psk: string; expectedMac?: string }>) {
  const config = makeTestConfig(nodes);
  const captureWriter = new FakeCaptureWriter();
  const dbWriteQueue = new FakeDbWriteQueue();
  const logger = makeFakeLogger();
  const engine = createIngestEngine(config, { captureWriter, dbWriteQueue, logger });
  return { config, captureWriter, dbWriteQueue, engine };
}

function makeCsiBatch(overrides: Partial<CsiBatch> = {}): CsiBatch {
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
    ],
    ...overrides,
  };
}

// --- Round trip ---------------------------------------------------------

describe('createIngestEngine: round trip', () => {
  it('accepts a valid CSI_BATCH datagram and dispatches it to capture + DB queue', async () => {
    const psk = testPsk(1);
    const { engine, captureWriter, dbWriteQueue } = makeHarness([{ id: 7, psk }]);

    const batch = makeCsiBatch();
    const datagram = encodeCsiBatchDatagram({
      nodeId: 7,
      bootEpoch: 3,
      seq: 42,
      key: Buffer.from(psk, 'base64'),
      batch,
    });

    engine.handleDatagram(datagram);
    await flushAsync();

    const metrics = engine.getMetrics();
    expect(metrics.datagramsReceived).toBe(1);
    expect(metrics.accepted).toBe(1);
    expect(Object.values(metrics.rejected).reduce((a, b) => a + b, 0)).toBe(0);
    expect(metrics.perNode[7]).toMatchObject({ lastSeq: 42, lastBootEpoch: 3 });

    expect(captureWriter.records).toHaveLength(1);
    expect(captureWriter.records[0]?.nodeId).toBe(7);
    expect(captureWriter.records[0]?.msgType).toBe(MsgType.CsiBatch);

    expect(dbWriteQueue.csiCalls).toHaveLength(1);
    expect(dbWriteQueue.csiCalls[0]?.batch.records[0]?.csiData).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('accepts a valid HEARTBEAT datagram', async () => {
    const psk = testPsk(2);
    const { engine, dbWriteQueue } = makeHarness([{ id: 3, psk }]);

    const heartbeat: Heartbeat = {
      uptimeS: 100,
      freeHeapBytes: 50000,
      minFreeHeapBytes: 40000,
      framesCaptured: 10,
      framesDropped: 0,
      batchesSent: 2,
      sendFailures: 0,
      rssiToAp: -50,
      channel: 6,
      sntpSynced: true,
      fwVersionMajor: 1,
      fwVersionMinor: 0,
      fwVersionPatch: 0,
    };
    const datagram = encodeHeartbeatDatagram({
      nodeId: 3,
      bootEpoch: 1,
      seq: 0,
      key: Buffer.from(psk, 'base64'),
      heartbeat,
    });

    engine.handleDatagram(datagram);
    await flushAsync();

    const metrics = engine.getMetrics();
    expect(metrics.accepted).toBe(1);
    expect(dbWriteQueue.heartbeatCalls).toHaveLength(1);
    expect(dbWriteQueue.heartbeatCalls[0]?.heartbeat.uptimeS).toBe(100);
  });

  it('preserves variable-length CSI records across at least two csi_format values', async () => {
    const psk = testPsk(3);
    const { engine, dbWriteQueue } = makeHarness([{ id: 1, psk }]);

    const lltfData = Buffer.alloc(128, 0x11);
    const combinedData = Buffer.alloc(384, 0x22);
    const batch = makeCsiBatch({
      records: [
        {
          srcMac: 'aa:bb:cc:dd:ee:01',
          dstMac: 'aa:bb:cc:dd:ee:ff',
          rssi: -40,
          rate: 11,
          sigMode: 0,
          mcs: 0xff,
          bandwidth: 0,
          channel: 6,
          secondaryChannel: 0,
          noiseFloor: -90,
          rxTimestampUs: 1n,
          csiFormat: CsiFormat.Lltf,
          csiData: lltfData,
        },
        {
          srcMac: 'aa:bb:cc:dd:ee:02',
          dstMac: 'aa:bb:cc:dd:ee:ff',
          rssi: -41,
          rate: 11,
          sigMode: 1,
          mcs: 7,
          bandwidth: 0,
          channel: 6,
          secondaryChannel: 0,
          noiseFloor: -90,
          rxTimestampUs: 2n,
          csiFormat: CsiFormat.LltfHtLtf,
          csiData: combinedData,
        },
      ],
    });
    const datagram = encodeCsiBatchDatagram({
      nodeId: 1,
      bootEpoch: 1,
      seq: 0,
      key: Buffer.from(psk, 'base64'),
      batch,
    });

    engine.handleDatagram(datagram);
    await flushAsync();

    const received = dbWriteQueue.csiCalls[0]?.batch.records;
    expect(received).toHaveLength(2);
    expect(received?.[0]?.csiFormat).toBe(CsiFormat.Lltf);
    expect(received?.[0]?.csiData).toHaveLength(128);
    expect(received?.[1]?.csiFormat).toBe(CsiFormat.LltfHtLtf);
    expect(received?.[1]?.csiData).toHaveLength(384);
    expect(received?.[1]?.csiData).toEqual(combinedData);
  });
});

// --- Hostile inputs -------------------------------------------------------

describe('createIngestEngine: hostile inputs never throw and are counted', () => {
  it('rejects completely random bytes without throwing', () => {
    const { engine } = makeHarness([{ id: 1, psk: testPsk(1) }]);
    expect(() => engine.handleDatagram(randomBytes(64))).not.toThrow();
    const metrics = engine.getMetrics();
    expect(metrics.datagramsReceived).toBe(1);
    expect(metrics.accepted).toBe(0);
    expect(Object.values(metrics.rejected).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('rejects an oversized datagram', () => {
    const { engine } = makeHarness([{ id: 1, psk: testPsk(1) }]);
    engine.handleDatagram(randomBytes(1300));
    expect(engine.getMetrics().rejected.oversized).toBe(1);
  });

  it('rejects a truncated datagram (shorter than header+tag)', () => {
    const { engine } = makeHarness([{ id: 1, psk: testPsk(1) }]);
    engine.handleDatagram(randomBytes(10));
    expect(engine.getMetrics().rejected.truncated).toBe(1);
  });

  it('rejects a datagram with bad magic', () => {
    const { engine } = makeHarness([{ id: 1, psk: testPsk(1) }]);
    const buf = randomBytes(100);
    buf.write('XXXX', 0, 'ascii'); // definitely not "HCS1"
    engine.handleDatagram(buf);
    expect(engine.getMetrics().rejected.bad_magic).toBe(1);
  });

  it('rejects an unsupported protocol version', () => {
    const { engine } = makeHarness([{ id: 1, psk: testPsk(1) }]);
    const key = Buffer.from(testPsk(1), 'base64');
    const header = encodeHeader({ version: 2, msgType: MsgType.CsiBatch, nodeId: 1, bootEpoch: 0, seq: 0 });
    const nonce = header.subarray(16, 28);
    const sealed = seal(key, Buffer.from(nonce), header, Buffer.from('garbage'));
    engine.handleDatagram(Buffer.concat([header, sealed]));
    expect(engine.getMetrics().rejected.unsupported_version).toBe(1);
  });

  it('rejects an unknown node id', () => {
    const { engine } = makeHarness([{ id: 1, psk: testPsk(1) }]);
    const datagram = encodeCsiBatchDatagram({
      nodeId: 999,
      bootEpoch: 0,
      seq: 0,
      key: Buffer.from(testPsk(1), 'base64'),
      batch: makeCsiBatch(),
    });
    engine.handleDatagram(datagram);
    expect(engine.getMetrics().rejected.unknown_node).toBe(1);
  });

  it('rejects a datagram sealed with the wrong key', () => {
    const { engine } = makeHarness([{ id: 1, psk: testPsk(1) }]);
    const wrongKey = Buffer.from(testPsk(9), 'base64');
    const datagram = encodeCsiBatchDatagram({
      nodeId: 1,
      bootEpoch: 0,
      seq: 0,
      key: wrongKey,
      batch: makeCsiBatch(),
    });
    engine.handleDatagram(datagram);
    expect(engine.getMetrics().rejected.auth_failed).toBe(1);
  });

  it('rejects a datagram with a valid header but tampered ciphertext', () => {
    const { engine } = makeHarness([{ id: 1, psk: testPsk(1) }]);
    const datagram = encodeCsiBatchDatagram({
      nodeId: 1,
      bootEpoch: 0,
      seq: 0,
      key: Buffer.from(testPsk(1), 'base64'),
      batch: makeCsiBatch(),
    });
    // Flip a byte inside the ciphertext (after the 28-byte header).
    datagram[30] = (datagram[30] ?? 0) ^ 0xff;
    engine.handleDatagram(datagram);
    expect(engine.getMetrics().rejected.auth_failed).toBe(1);
  });

  it('rejects an unknown/unimplemented message type', () => {
    const { engine } = makeHarness([{ id: 1, psk: testPsk(1) }]);
    const key = Buffer.from(testPsk(1), 'base64');
    const header = encodeHeader({ version: 1, msgType: 3, nodeId: 1, bootEpoch: 0, seq: 0 }); // 3 = LOG, reserved
    const nonce = header.subarray(16, 28);
    const sealed = seal(key, Buffer.from(nonce), header, Buffer.from('irrelevant'));
    engine.handleDatagram(Buffer.concat([header, sealed]));
    expect(engine.getMetrics().rejected.unknown_msg_type).toBe(1);
  });

  it('rejects a datagram whose AEAD-authentic plaintext is structurally malformed', () => {
    const { engine } = makeHarness([{ id: 1, psk: testPsk(1) }]);
    const key = Buffer.from(testPsk(1), 'base64');
    const header = encodeHeader({ version: 1, msgType: MsgType.CsiBatch, nodeId: 1, bootEpoch: 0, seq: 0 });
    const nonce = header.subarray(16, 28);
    // Valid AEAD auth, but not a well-formed CSI_BATCH payload (too short
    // to even contain the 22-byte batch header).
    const garbagePlaintext = Buffer.from([1, 2, 3]);
    const sealed = seal(key, Buffer.from(nonce), header, garbagePlaintext);
    engine.handleDatagram(Buffer.concat([header, sealed]));
    expect(engine.getMetrics().rejected.malformed_payload).toBe(1);
  });

  it('detects a replayed (exact duplicate) datagram', () => {
    const { engine } = makeHarness([{ id: 1, psk: testPsk(1) }]);
    const datagram = encodeCsiBatchDatagram({
      nodeId: 1,
      bootEpoch: 5,
      seq: 10,
      key: Buffer.from(testPsk(1), 'base64'),
      batch: makeCsiBatch(),
    });
    engine.handleDatagram(datagram);
    engine.handleDatagram(datagram);
    const metrics = engine.getMetrics();
    expect(metrics.accepted).toBe(1);
    expect(metrics.rejected.duplicate).toBe(1);
  });

  it('detects a boot-epoch rollback', () => {
    const { engine } = makeHarness([{ id: 1, psk: testPsk(1) }]);
    const key = Buffer.from(testPsk(1), 'base64');
    engine.handleDatagram(
      encodeCsiBatchDatagram({ nodeId: 1, bootEpoch: 5, seq: 1, key, batch: makeCsiBatch() }),
    );
    engine.handleDatagram(
      encodeCsiBatchDatagram({ nodeId: 1, bootEpoch: 4, seq: 1, key, batch: makeCsiBatch() }),
    );
    const metrics = engine.getMetrics();
    expect(metrics.accepted).toBe(1);
    expect(metrics.rejected.stale_epoch).toBe(1);
  });

  it('accepts an out-of-order-but-within-window datagram, then rejects it as a duplicate on resend', () => {
    const { engine } = makeHarness([{ id: 1, psk: testPsk(1) }]);
    const key = Buffer.from(testPsk(1), 'base64');
    engine.handleDatagram(
      encodeCsiBatchDatagram({ nodeId: 1, bootEpoch: 1, seq: 5, key, batch: makeCsiBatch() }),
    );
    engine.handleDatagram(
      encodeCsiBatchDatagram({ nodeId: 1, bootEpoch: 1, seq: 3, key, batch: makeCsiBatch() }),
    );
    let metrics = engine.getMetrics();
    expect(metrics.accepted).toBe(2);

    engine.handleDatagram(
      encodeCsiBatchDatagram({ nodeId: 1, bootEpoch: 1, seq: 3, key, batch: makeCsiBatch() }),
    );
    metrics = engine.getMetrics();
    expect(metrics.accepted).toBe(2);
    expect(metrics.rejected.duplicate).toBe(1);
  });

  it('rejects a too-old datagram outside the replay window', () => {
    const { engine } = makeHarness([{ id: 1, psk: testPsk(1) }]);
    const key = Buffer.from(testPsk(1), 'base64');
    engine.handleDatagram(
      encodeCsiBatchDatagram({ nodeId: 1, bootEpoch: 1, seq: 2000, key, batch: makeCsiBatch() }),
    );
    engine.handleDatagram(
      encodeCsiBatchDatagram({ nodeId: 1, bootEpoch: 1, seq: 1, key, batch: makeCsiBatch() }),
    );
    expect(engine.getMetrics().rejected.too_old).toBe(1);
  });
});

describe('createIngestEngine: expectedMac soft-attribution', () => {
  it('does not drop a CSI_BATCH whose records reference other MACs, but counts a mismatch', async () => {
    const { engine, dbWriteQueue } = makeHarness([
      { id: 1, psk: testPsk(1), expectedMac: 'ff:ff:ff:ff:ff:ff' },
    ]);
    const datagram = encodeCsiBatchDatagram({
      nodeId: 1,
      bootEpoch: 0,
      seq: 0,
      key: Buffer.from(testPsk(1), 'base64'),
      batch: makeCsiBatch(),
    });
    engine.handleDatagram(datagram);
    await flushAsync();
    const metrics = engine.getMetrics();
    expect(metrics.accepted).toBe(1);
    expect(dbWriteQueue.csiCalls).toHaveLength(1);
    expect(metrics.perNode[1]?.macMismatches).toBe(1);
  });
});

// --- Capture-write / DB-enqueue ordering (regression test for the ---
// --- "drop-oldest recoverability" defect: an item must never become ---
// --- eligible for the DB queue before its capture write has actually ---
// --- completed, not merely been initiated). -------------------------

describe('createIngestEngine: capture write happens-before DB enqueue', () => {
  it('never enqueues to the DB queue until that same datagram’s capture write has completed, even under a concurrent burst with out-of-order completions', async () => {
    type Event = { type: 'capture-start' | 'capture-done' | 'enqueue'; id: number };
    const events: Event[] = [];

    class SlowCaptureWriter implements CaptureWriterLike {
      async appendRecord(rec: CaptureRecordEnvelope): Promise<void> {
        const id = rec.receivedAtMs;
        events.push({ type: 'capture-start', id });
        // Vary the delay (including some writes finishing "out of order"
        // relative to when they started) so this isn't just testing FIFO
        // timing — it must hold per-item regardless of completion order.
        const delayMs = (id * 7) % 5;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        events.push({ type: 'capture-done', id });
      }
    }

    class TrackingDbWriteQueue implements DbWriteQueueLike {
      enqueueCsiBatch(_nodeId: number, _bootEpoch: number, _seq: number, receivedAt: Date): void {
        events.push({ type: 'enqueue', id: receivedAt.getTime() });
      }
      enqueueHeartbeat(_nodeId: number, _bootEpoch: number, _seq: number, receivedAt: Date): void {
        events.push({ type: 'enqueue', id: receivedAt.getTime() });
      }
      upsertNode(): Promise<void> {
        return Promise.resolve();
      }
      getMetrics(): DbWriteQueueMetrics {
        return { queueDepth: 0, queueDrops: 0, recordsWritten: 0, batchInsertFailures: 0 };
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    }

    const nodeCount = 20;
    const nodes = Array.from({ length: nodeCount }, (_, i) => ({ id: i + 1, psk: testPsk(i + 1) }));
    const config = makeTestConfig(nodes);
    const captureWriter = new SlowCaptureWriter();
    const dbWriteQueue = new TrackingDbWriteQueue();
    const logger = makeFakeLogger();
    let clock = 0;
    const engine = createIngestEngine(config, {
      captureWriter,
      dbWriteQueue,
      logger,
      now: () => clock++, // unique, monotonic correlation id per datagram
    });

    // Fire every datagram back-to-back, synchronously, with no awaits in
    // between — a burst, not the quiet one-at-a-time path.
    for (const node of nodes) {
      const datagram = encodeCsiBatchDatagram({
        nodeId: node.id,
        bootEpoch: 0,
        seq: 0,
        key: Buffer.from(node.psk, 'base64'),
        batch: makeCsiBatch(),
      });
      engine.handleDatagram(datagram);
    }

    // Let every pending capture write (up to ~5ms of simulated delay each)
    // and its continuation finish.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const enqueueIds = events.filter((e): e is Event & { type: 'enqueue' } => e.type === 'enqueue').map((e) => e.id);
    expect(enqueueIds).toHaveLength(nodeCount);

    for (const id of enqueueIds) {
      const doneIndex = events.findIndex((e) => e.type === 'capture-done' && e.id === id);
      const enqueueIndex = events.findIndex((e) => e.type === 'enqueue' && e.id === id);
      expect(doneIndex).toBeGreaterThanOrEqual(0);
      expect(doneIndex).toBeLessThan(enqueueIndex);
    }
  });
});

// --- finalizeAccepted must never produce an unhandled promise rejection ---
// --- (regression test: it is invoked as `void finalizeAccepted(...)` --
// --- from a synchronous socket handler, so a throw anywhere in its body
// --- that isn't caught inside the function itself becomes an unhandled
// --- rejection, which Node >= 20 turns into a process-crashing exit by
// --- default. A fake queue that throws plus asserting `handleDatagram`
// --- itself doesn't throw is NOT sufficient — the escape route is the
// --- discarded promise, not a synchronous throw, so this must actually
// --- install a `process.on('unhandledRejection', ...)` listener.

describe('createIngestEngine: finalizeAccepted never produces an unhandled promise rejection', () => {
  let unhandled: unknown[] = [];
  let listener: ((reason: unknown) => void) | undefined;

  afterEach(() => {
    if (listener) {
      process.removeListener('unhandledRejection', listener);
      listener = undefined;
    }
    unhandled = [];
  });

  function installUnhandledRejectionGuard(): void {
    listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
  }

  function makeThrowingDbWriteQueue(overrides: Partial<DbWriteQueueLike>): DbWriteQueueLike {
    return {
      enqueueCsiBatch: () => undefined,
      enqueueHeartbeat: () => undefined,
      upsertNode: () => Promise.resolve(),
      getMetrics: () => ({ queueDepth: 0, queueDrops: 0, recordsWritten: 0, batchInsertFailures: 0 }),
      close: () => Promise.resolve(),
      ...overrides,
    };
  }

  it('does not crash the process when enqueueCsiBatch throws synchronously', async () => {
    installUnhandledRejectionGuard();
    const dbWriteQueue = makeThrowingDbWriteQueue({
      enqueueCsiBatch: () => {
        throw new Error('BOOM from enqueueCsiBatch');
      },
    });
    const config = makeTestConfig([{ id: 1, psk: testPsk(1) }]);
    const captureWriter = new FakeCaptureWriter();
    const logger = makeFakeLogger();
    const engine = createIngestEngine(config, { captureWriter, dbWriteQueue, logger });

    const datagram = encodeCsiBatchDatagram({
      nodeId: 1,
      bootEpoch: 0,
      seq: 0,
      key: Buffer.from(testPsk(1), 'base64'),
      batch: makeCsiBatch(),
    });

    expect(() => engine.handleDatagram(datagram)).not.toThrow();
    // An unhandledRejection is reported asynchronously by Node, after the
    // microtask queue fully drains — give it several turns to surface.
    await flushAsync();
    await flushAsync();
    await flushAsync();

    expect(unhandled).toHaveLength(0);
  });

  it('does not crash the process when enqueueHeartbeat throws synchronously', async () => {
    installUnhandledRejectionGuard();
    const dbWriteQueue = makeThrowingDbWriteQueue({
      enqueueHeartbeat: () => {
        throw new Error('BOOM from enqueueHeartbeat');
      },
    });
    const config = makeTestConfig([{ id: 1, psk: testPsk(1) }]);
    const captureWriter = new FakeCaptureWriter();
    const logger = makeFakeLogger();
    const engine = createIngestEngine(config, { captureWriter, dbWriteQueue, logger });

    const heartbeat: Heartbeat = {
      uptimeS: 1,
      freeHeapBytes: 1,
      minFreeHeapBytes: 1,
      framesCaptured: 1,
      framesDropped: 0,
      batchesSent: 1,
      sendFailures: 0,
      rssiToAp: -50,
      channel: 6,
      sntpSynced: true,
      fwVersionMajor: 1,
      fwVersionMinor: 0,
      fwVersionPatch: 0,
    };
    const datagram = encodeHeartbeatDatagram({
      nodeId: 1,
      bootEpoch: 0,
      seq: 0,
      key: Buffer.from(testPsk(1), 'base64'),
      heartbeat,
    });

    expect(() => engine.handleDatagram(datagram)).not.toThrow();
    await flushAsync();
    await flushAsync();
    await flushAsync();

    expect(unhandled).toHaveLength(0);
  });

  it('does not crash the process when getMetrics (called from syncDbMetrics) throws synchronously', async () => {
    installUnhandledRejectionGuard();
    const dbWriteQueue = makeThrowingDbWriteQueue({
      getMetrics: () => {
        throw new Error('BOOM from getMetrics');
      },
    });
    const config = makeTestConfig([{ id: 1, psk: testPsk(1) }]);
    const captureWriter = new FakeCaptureWriter();
    const logger = makeFakeLogger();
    const engine = createIngestEngine(config, { captureWriter, dbWriteQueue, logger });

    const datagram = encodeCsiBatchDatagram({
      nodeId: 1,
      bootEpoch: 0,
      seq: 0,
      key: Buffer.from(testPsk(1), 'base64'),
      batch: makeCsiBatch(),
    });

    expect(() => engine.handleDatagram(datagram)).not.toThrow();
    await flushAsync();
    await flushAsync();
    await flushAsync();

    expect(unhandled).toHaveLength(0);
  });
});
