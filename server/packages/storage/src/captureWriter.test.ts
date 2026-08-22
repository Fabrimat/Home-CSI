import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MsgType } from '@homecsi/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { CaptureWriter } from './captureWriter.js';
import { readShardRecords } from './captureReader.js';
import type { CaptureRecordEnvelope } from './captureFormat.js';

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'homecsi-capture-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

function makeRecord(overrides: Partial<CaptureRecordEnvelope> = {}): CaptureRecordEnvelope {
  return {
    receivedAtMs: Date.now(),
    nodeId: 1,
    bootEpoch: 1,
    seq: 0,
    msgType: MsgType.CsiBatch,
    payload: Buffer.from('hello-payload'),
    ...overrides,
  };
}

describe('CaptureWriter', () => {
  it('round-trips records through a finalized shard', async () => {
    const dir = await makeTmpDir();
    const writer = new CaptureWriter({
      captureDir: dir,
      rotation: { maxBytes: 10_000_000, maxIntervalMs: 3_600_000 },
    });
    await writer.init();

    await writer.appendRecord(makeRecord({ seq: 0, payload: Buffer.from('one') }));
    await writer.appendRecord(makeRecord({ seq: 1, payload: Buffer.from('two') }));
    await writer.close();

    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.hcscap$/);

    const records: CaptureRecordEnvelope[] = [];
    for await (const rec of readShardRecords(path.join(dir, files[0] as string))) {
      records.push(rec);
    }
    expect(records).toHaveLength(2);
    expect(records[0]?.payload.toString()).toBe('one');
    expect(records[1]?.payload.toString()).toBe('two');
  });

  it('rotates to a new shard when maxBytes is exceeded', async () => {
    const dir = await makeTmpDir();
    // Small enough that a single record forces rotation on the next append.
    const writer = new CaptureWriter({
      captureDir: dir,
      rotation: { maxBytes: 40, maxIntervalMs: 3_600_000 },
    });
    await writer.init();

    await writer.appendRecord(makeRecord({ seq: 0, payload: Buffer.from('x'.repeat(20)) }));
    await writer.appendRecord(makeRecord({ seq: 1, payload: Buffer.from('y'.repeat(20)) }));
    await writer.close();

    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.hcscap'));
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it('rotates to a new shard when maxIntervalMs elapses', async () => {
    const dir = await makeTmpDir();
    const writer = new CaptureWriter({
      captureDir: dir,
      rotation: { maxBytes: 10_000_000, maxIntervalMs: 20 },
    });
    await writer.init();

    await writer.appendRecord(makeRecord({ seq: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    await writer.appendRecord(makeRecord({ seq: 1 }));
    await writer.close();

    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.hcscap'));
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it('recovers earlier records when the final record is truncated (abrupt kill simulation)', async () => {
    const dir = await makeTmpDir();
    const writer = new CaptureWriter({
      captureDir: dir,
      rotation: { maxBytes: 10_000_000, maxIntervalMs: 3_600_000 },
    });
    await writer.init();
    await writer.appendRecord(makeRecord({ seq: 0, payload: Buffer.from('complete-one') }));
    await writer.appendRecord(makeRecord({ seq: 1, payload: Buffer.from('complete-two') }));
    await writer.appendRecord(makeRecord({ seq: 2, payload: Buffer.from('this-one-will-be-cut-short') }));
    await writer.close();

    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.hcscap'));
    expect(files).toHaveLength(1);
    const shardPath = path.join(dir, files[0] as string);

    const stat = await fs.stat(shardPath);
    // Chop off the last 10 bytes, guaranteed to land inside the third record's payload.
    const fh = await fs.open(shardPath, 'r+');
    await fh.truncate(stat.size - 10);
    await fh.close();

    const records: CaptureRecordEnvelope[] = [];
    await expect(
      (async () => {
        for await (const rec of readShardRecords(shardPath)) {
          records.push(rec);
        }
      })(),
    ).resolves.toBeUndefined();

    expect(records).toHaveLength(2);
    expect(records[0]?.payload.toString()).toBe('complete-one');
    expect(records[1]?.payload.toString()).toBe('complete-two');
  });

  it('finalizes an orphaned .writing shard left by a previous crashed process on init()', async () => {
    const dir = await makeTmpDir();
    const orphanName = 'capture-1000-000000.hcscap.writing';
    await fs.writeFile(path.join(dir, orphanName), Buffer.from('HCSCAP01'));

    const writer = new CaptureWriter({
      captureDir: dir,
      rotation: { maxBytes: 10_000_000, maxIntervalMs: 3_600_000 },
    });
    await writer.init();
    await writer.close();

    const files = await fs.readdir(dir);
    expect(files).toContain('capture-1000-000000.hcscap');
    expect(files).not.toContain(orphanName);
  });

  it('never exposes the active shard under a finalized name while still writing', async () => {
    const dir = await makeTmpDir();
    const writer = new CaptureWriter({
      captureDir: dir,
      rotation: { maxBytes: 10_000_000, maxIntervalMs: 3_600_000 },
    });
    await writer.init();
    await writer.appendRecord(makeRecord());

    const files = await fs.readdir(dir);
    expect(files.some((f) => f.endsWith('.hcscap.writing'))).toBe(true);
    expect(files.some((f) => f.endsWith('.hcscap'))).toBe(false);

    await writer.close();
  });

  it('recovers the write chain after a transient append failure, abandons the failed shard, and starts a fresh one (no untracked partial write left behind)', async () => {
    const dir = await makeTmpDir();
    const writer = new CaptureWriter({
      captureDir: dir,
      rotation: { maxBytes: 10_000_000, maxIntervalMs: 3_600_000 },
    });
    await writer.init();

    await writer.appendRecord(makeRecord({ seq: 0, payload: Buffer.from('first-ok') }));

    // Simulate a transient disk error (e.g. ENOSPC/EIO) on exactly one
    // underlying write, by monkeypatching the writer's private file
    // handle (white-box test of the recovery behaviour). The write()
    // call REJECTS outright here (as opposed to the short-write test
    // below, where it resolves with fewer bytes than requested) — both
    // failure modes must be treated identically: abandon the handle,
    // finalize it, and force the next append onto a fresh shard.
    const internal = writer as unknown as { fh?: { write: (buf: Buffer) => Promise<{ bytesWritten: number; buffer: Buffer }> } };
    const failedHandle = internal.fh;
    expect(failedHandle).toBeDefined();
    const realWrite = failedHandle!.write.bind(failedHandle);
    let failedOnce = false;
    failedHandle!.write = (buf: Buffer) => {
      if (!failedOnce) {
        failedOnce = true;
        return Promise.reject(new Error('ENOSPC (simulated)'));
      }
      return realWrite(buf);
    };

    await expect(
      writer.appendRecord(makeRecord({ seq: 1, payload: Buffer.from('this-one-fails') })),
    ).rejects.toThrow('ENOSPC');

    // The failed handle must have been abandoned immediately (cleared
    // from the writer's state), not left as the active handle with an
    // untracked, possibly-partial write already on disk.
    expect(internal.fh).not.toBe(failedHandle);

    // The chain must not be permanently poisoned: a later append succeeds.
    await writer.appendRecord(makeRecord({ seq: 2, payload: Buffer.from('recovered-ok') }));
    await writer.close();

    const shardFiles = (await fs.readdir(dir)).filter((f) => f.endsWith('.hcscap'));
    // Abandoning the failed shard and opening a fresh one means the
    // recovered append must land in a SEPARATE file from the first —
    // never appended after an untracked partial write in the same file.
    expect(shardFiles.length).toBeGreaterThanOrEqual(2);

    const records: CaptureRecordEnvelope[] = [];
    for (const f of shardFiles) {
      for await (const rec of readShardRecords(path.join(dir, f))) records.push(rec);
    }
    const payloads = records.map((r) => r.payload.toString());
    expect(payloads).toContain('first-ok');
    expect(payloads).toContain('recovered-ok');
    expect(payloads).not.toContain('this-one-fails');
  });

  it('treats a short write as fatal, finalizes the shard with its valid prefix, and starts a fresh shard for later appends (no cross-record corruption)', async () => {
    const dir = await makeTmpDir();
    const writer = new CaptureWriter({
      captureDir: dir,
      rotation: { maxBytes: 10_000_000, maxIntervalMs: 3_600_000 },
    });
    await writer.init();

    await writer.appendRecord(makeRecord({ seq: 0, payload: Buffer.from('good-prefix-record') }));

    const internal = writer as unknown as { fh?: { write: (buf: Buffer) => Promise<{ bytesWritten: number; buffer: Buffer }> } };
    expect(internal.fh).toBeDefined();
    const realWrite = internal.fh!.write.bind(internal.fh);
    let shortWriteDone = false;
    internal.fh!.write = async (buf: Buffer) => {
      if (!shortWriteDone) {
        shortWriteDone = true;
        // Simulate a short write: only half the intended bytes actually
        // land on disk (this is the scenario that, without a bytesWritten
        // check, would let a later record's bytes get appended right
        // after this torn one and be misparsed as part of it).
        const half = Math.floor(buf.length / 2);
        await realWrite(buf.subarray(0, half));
        return { bytesWritten: half, buffer: buf };
      }
      return realWrite(buf);
    };

    await expect(
      writer.appendRecord(makeRecord({ seq: 1, payload: Buffer.from('this-record-is-torn-by-a-short-write') })),
    ).rejects.toThrow(/short write/);

    // A later append must land in a brand new shard, never appended after
    // the torn bytes in the same file.
    await writer.appendRecord(makeRecord({ seq: 2, payload: Buffer.from('good-record-in-a-fresh-shard') }));
    await writer.close();

    const shardFiles = (await fs.readdir(dir)).filter((f) => f.endsWith('.hcscap')).sort();
    expect(shardFiles.length).toBeGreaterThanOrEqual(2);

    const allRecords: CaptureRecordEnvelope[] = [];
    for (const f of shardFiles) {
      for await (const rec of readShardRecords(path.join(dir, f))) {
        allRecords.push(rec);
      }
    }
    const payloads = allRecords.map((r) => r.payload.toString());
    expect(payloads).toContain('good-prefix-record');
    expect(payloads).toContain('good-record-in-a-fresh-shard');
    // The torn record must never be misparsed into existence, whole or
    // corrupted — it should simply not appear at all.
    expect(payloads.some((p) => p.includes('this-record-is-torn'))).toBe(false);
    expect(allRecords).toHaveLength(2);
  });
});
