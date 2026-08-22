import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CsiFormat, encodeCsiBatch, encodeHeartbeat, MsgType, type CsiBatch, type Heartbeat } from '@homecsi/protocol';
import { CaptureWriter } from './captureWriter.js';
import { replayCaptures } from './replay.js';
import { makeTestConfig } from './testHelpers.js';

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'homecsi-replay-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

function makeBatch(): CsiBatch {
  return {
    wallClockUs: 1_700_000_000_000_000n,
    monoUs: 1000n,
    sntpSynced: true,
    records: [
      {
        srcMac: 'aa:bb:cc:dd:ee:01',
        dstMac: 'aa:bb:cc:dd:ee:ff',
        rssi: -40,
        rate: 11,
        sigMode: 1,
        mcs: 7,
        bandwidth: 0,
        channel: 6,
        secondaryChannel: 0,
        noiseFloor: -95,
        rxTimestampUs: 1000n,
        csiFormat: CsiFormat.Lltf,
        csiData: Buffer.from([9, 9, 9, 9]),
      },
    ],
  };
}

const makeHeartbeat = (): Heartbeat => ({
  uptimeS: 5,
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
});

describe('replayCaptures', () => {
  // No live Postgres is required or used: config.database points at a
  // local port nothing is listening on, so every DbWriteQueue insert
  // fails fast (ECONNREFUSED) and is counted/dropped internally rather
  // than thrown — replayCaptures is still expected to resolve cleanly.
  // This exercises the real file/directory resolution, shard iteration
  // ordering, and decode dispatch without needing a database.
  function unreachableDbConfig(nodes: Array<{ id: number }>) {
    const config = makeTestConfig(nodes);
    config.database.host = '127.0.0.1';
    config.database.port = 18291; // presumed closed
    return config;
  }

  it('resolves without throwing for an empty capture directory', async () => {
    const dir = await makeTmpDir();
    const config = unreachableDbConfig([]);
    await expect(replayCaptures(dir, config)).resolves.toBeUndefined();
  });

  it('reads every finalized shard in a directory and dispatches CSI + heartbeat records without throwing', async () => {
    const dir = await makeTmpDir();
    const writer = new CaptureWriter({
      captureDir: dir,
      rotation: { maxBytes: 10_000_000, maxIntervalMs: 3_600_000 },
    });
    await writer.init();
    await writer.appendRecord({
      receivedAtMs: Date.now(),
      nodeId: 1,
      bootEpoch: 1,
      seq: 0,
      msgType: MsgType.CsiBatch,
      payload: encodeCsiBatch(makeBatch()),
    });
    await writer.appendRecord({
      receivedAtMs: Date.now(),
      nodeId: 1,
      bootEpoch: 1,
      seq: 1,
      msgType: MsgType.Heartbeat,
      payload: encodeHeartbeat(makeHeartbeat()),
    });
    await writer.close();

    const config = unreachableDbConfig([{ id: 1 }]);
    await expect(replayCaptures(dir, config)).resolves.toBeUndefined();
  });

  it('accepts a single shard file path directly (not just a directory)', async () => {
    const dir = await makeTmpDir();
    const writer = new CaptureWriter({
      captureDir: dir,
      rotation: { maxBytes: 10_000_000, maxIntervalMs: 3_600_000 },
    });
    await writer.init();
    await writer.appendRecord({
      receivedAtMs: Date.now(),
      nodeId: 1,
      bootEpoch: 1,
      seq: 0,
      msgType: MsgType.CsiBatch,
      payload: encodeCsiBatch(makeBatch()),
    });
    await writer.close();

    const [shardName] = (await fs.readdir(dir)).filter((f) => f.endsWith('.hcscap'));
    const config = unreachableDbConfig([{ id: 1 }]);
    await expect(replayCaptures(path.join(dir, shardName as string), config)).resolves.toBeUndefined();
  });

  it('rejects for a nonexistent input path (a genuine operator error, not a stub gap)', async () => {
    const config = unreachableDbConfig([]);
    await expect(replayCaptures(path.join(process.cwd(), 'this-does-not-exist-anywhere'), config)).rejects.toThrow();
  });
});
