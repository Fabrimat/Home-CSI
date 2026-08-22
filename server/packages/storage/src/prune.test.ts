import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compressAgedShards } from './compression.js';
import { readShardRecords } from './captureReader.js';
import { pruneStorage } from './prune.js';
import { CaptureWriter } from './captureWriter.js';
import { makeTestConfig } from './testHelpers.js';

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'homecsi-prune-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

/** Writes one finalized (non-.writing) shard with `sizeBytes` of raw content, then sets its mtime. */
async function writeFinalizedShard(
  dir: string,
  name: string,
  sizeBytes: number,
  mtime: Date,
): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, Buffer.alloc(sizeBytes, 0x41));
  await fs.utimes(filePath, mtime, mtime);
  return filePath;
}

describe('compressAgedShards', () => {
  it('gzips a shard older than afterMs and leaves a replayable .gz behind', async () => {
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
      msgType: 1,
      payload: Buffer.from('compress-me'),
    });
    await writer.close();

    const [shardName] = (await fs.readdir(dir)).filter((f) => f.endsWith('.hcscap'));
    const shardPath = path.join(dir, shardName as string);
    // Backdate the shard so it looks old enough to compress.
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(shardPath, old, old);

    const result = await compressAgedShards(dir, 5_000, { now: Date.now() });
    expect(result.compressed).toEqual([shardPath]);

    const files = await fs.readdir(dir);
    expect(files).toContain(`${shardName}.gz`);
    expect(files).not.toContain(shardName);

    const records = [];
    for await (const rec of readShardRecords(path.join(dir, `${shardName}.gz`))) {
      records.push(rec);
    }
    expect(records).toHaveLength(1);
    expect(records[0]?.payload.toString()).toBe('compress-me');
  });

  it('does not touch a shard younger than afterMs', async () => {
    const dir = await makeTmpDir();
    const shardPath = await writeFinalizedShard(dir, 'capture-1-000000.hcscap', 32, new Date());
    await compressAgedShards(dir, 3_600_000);
    expect(await fs.readdir(dir)).toEqual(['capture-1-000000.hcscap']);
    void shardPath;
  });
});

describe('pruneStorage', () => {
  it('deletes shards older than retention.maxAgeMs', async () => {
    const dir = await makeTmpDir();
    const oldShard = await writeFinalizedShard(
      dir,
      'capture-1-000000.hcscap',
      100,
      new Date(Date.now() - 100_000),
    );
    const freshShard = await writeFinalizedShard(dir, 'capture-2-000000.hcscap', 100, new Date());

    const config = makeTestConfig([]);
    config.storage.captureDir = dir;
    config.storage.compression.enabled = false;
    config.storage.retention.maxAgeMs = 50_000;
    config.storage.retention.maxTotalBytes = 1_000_000_000;

    await pruneStorage(config);

    await expect(fs.access(oldShard)).rejects.toThrow();
    await expect(fs.access(freshShard)).resolves.toBeUndefined();
  });

  it('deletes oldest-first once the total budget is exceeded', async () => {
    const dir = await makeTmpDir();
    const now = new Date();
    const shard1 = await writeFinalizedShard(dir, 'capture-1-000000.hcscap', 100, now);
    const shard2 = await writeFinalizedShard(dir, 'capture-2-000000.hcscap', 100, now);
    const shard3 = await writeFinalizedShard(dir, 'capture-3-000000.hcscap', 100, now);

    const config = makeTestConfig([]);
    config.storage.captureDir = dir;
    config.storage.compression.enabled = false;
    config.storage.retention.maxAgeMs = 1_000_000_000;
    // Budget only fits one shard (100 bytes); the two oldest must go.
    config.storage.retention.maxTotalBytes = 150;

    await pruneStorage(config);

    await expect(fs.access(shard1)).rejects.toThrow();
    await expect(fs.access(shard2)).rejects.toThrow();
    await expect(fs.access(shard3)).resolves.toBeUndefined();
  });

  it('never deletes the shard currently being written (.hcscap.writing), regardless of age/budget', async () => {
    const dir = await makeTmpDir();
    const activePath = await writeFinalizedShard(
      dir,
      'capture-1-000000.hcscap.writing',
      100,
      new Date(Date.now() - 1_000_000_000),
    );

    const config = makeTestConfig([]);
    config.storage.captureDir = dir;
    config.storage.compression.enabled = true;
    config.storage.compression.afterMs = 1;
    config.storage.retention.maxAgeMs = 1;
    config.storage.retention.maxTotalBytes = 1;

    await pruneStorage(config);

    await expect(fs.access(activePath)).resolves.toBeUndefined();
  });

  it('is safe to run concurrently with an active CaptureWriter (never touches its open shard)', async () => {
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
      msgType: 1,
      payload: Buffer.from('still-being-written'),
    });

    const config = makeTestConfig([]);
    config.storage.captureDir = dir;
    config.storage.compression.enabled = false;
    config.storage.retention.maxAgeMs = 1; // as aggressive as possible
    config.storage.retention.maxTotalBytes = 1;

    await pruneStorage(config);

    // The active shard must still exist and still be writable.
    expect(writer.getActivePath()).toBeDefined();
    await fs.access(writer.getActivePath() as string);

    await writer.appendRecord({
      receivedAtMs: Date.now(),
      nodeId: 1,
      bootEpoch: 1,
      seq: 1,
      msgType: 1,
      payload: Buffer.from('more-data'),
    });
    await writer.close();
  });
});
