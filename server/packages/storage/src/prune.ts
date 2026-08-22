import { promises as fs } from 'node:fs';
import type { Config } from '@homecsi/config';
import { compressAgedShards } from './compression.js';
import { listClosedShardFiles, type ShardFileInfo } from './captureReader.js';
import { resolveCaptureDir } from './paths.js';

/**
 * Enforces the raw-capture lifecycle from `config.storage`
 * (docs/architecture.md "Data lifecycle"):
 *
 *   1. Compression: gzips closed shards older than
 *      `compression.afterMs`, if `compression.enabled`.
 *   2. Retention (age): deletes shards older than `retention.maxAgeMs`.
 *   3. Retention (budget): if the capture tree still exceeds
 *      `retention.maxTotalBytes`, deletes the oldest remaining shards
 *      until it doesn't.
 *
 * Only ever considers finalized shards (`.hcscap`/`.hcscap.gz`); the
 * shard currently being written (`*.hcscap.writing`) is never listed by
 * `listClosedShardFiles` and so can never be touched here — this is what
 * makes `pruneStorage` safe to run concurrently with a live `runIngest`
 * process (no shared mutable state, just filesystem naming convention;
 * see FORMAT.md).
 */
export async function pruneStorage(config: Config): Promise<void> {
  const dir = resolveCaptureDir(config);
  await fs.mkdir(dir, { recursive: true });

  if (config.storage.compression.enabled) {
    await compressAgedShards(dir, config.storage.compression.afterMs);
  }

  const shards = await listClosedShardFiles(dir);
  const now = Date.now();

  const survivors: Array<ShardFileInfo & { size: number }> = [];
  for (const shard of shards) {
    const stat = await fs.stat(shard.path).catch(() => undefined);
    if (!stat) continue;
    const ageMs = now - stat.mtimeMs;
    if (ageMs > config.storage.retention.maxAgeMs) {
      await fs.unlink(shard.path).catch(() => undefined);
      continue;
    }
    survivors.push({ ...shard, size: stat.size });
  }

  // Oldest-first (already sorted by listClosedShardFiles by startMs/counter,
  // but re-sort defensively since we've mutated the list).
  survivors.sort((a, b) => a.startMs - b.startMs || a.counter - b.counter);

  let totalBytes = survivors.reduce((sum, s) => sum + s.size, 0);
  const budget = config.storage.retention.maxTotalBytes;
  for (const shard of survivors) {
    if (totalBytes <= budget) break;
    await fs.unlink(shard.path).catch(() => undefined);
    totalBytes -= shard.size;
  }
}
