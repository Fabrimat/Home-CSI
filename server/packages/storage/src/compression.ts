import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { listClosedShardFiles } from './captureReader.js';
import { noopLogger, type BasicLogger } from './logger.js';

export interface CompressAgedShardsResult {
  /** Absolute paths of shards that were compressed during this pass. */
  compressed: string[];
}

/**
 * Gzips every closed, not-yet-compressed shard (`.hcscap`) in `dir` whose
 * age — measured from the shard's last-modified time, i.e. when it was
 * finalized/closed, per `docs/architecture.md`'s "compressed after a
 * short hot window" lifecycle description — exceeds `afterMs`. Never
 * touches an active `.hcscap.writing` shard (it is not matched by
 * `listClosedShardFiles`) or an already-compressed `.hcscap.gz` shard.
 *
 * Compression is crash-safe: the gzip output is written to a `.gz.tmp`
 * file first and only `rename`d into place (then the original unlinked)
 * after the stream completes successfully, so a kill mid-compression
 * leaves the original shard untouched and simply gets retried next pass.
 */
export async function compressAgedShards(
  dir: string,
  afterMs: number,
  options: { now?: number; logger?: BasicLogger } = {},
): Promise<CompressAgedShardsResult> {
  const now = options.now ?? Date.now();
  const logger = options.logger ?? noopLogger;
  const shards = await listClosedShardFiles(dir);
  const compressed: string[] = [];

  for (const shard of shards) {
    if (shard.compressed) continue;
    const stat = await fs.stat(shard.path).catch(() => undefined);
    if (!stat) continue;
    if (now - stat.mtimeMs < afterMs) continue;

    try {
      await gzipFile(shard.path);
      compressed.push(shard.path);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), path: shard.path },
        'failed to compress capture shard; will retry on the next pass',
      );
    }
  }

  return { compressed };
}

async function gzipFile(filePath: string): Promise<void> {
  const gzPath = `${filePath}.gz`;
  const tmpPath = `${gzPath}.tmp`;
  await pipeline(createReadStream(filePath), createGzip(), createWriteStream(tmpPath));
  await fs.rename(tmpPath, gzPath);
  await fs.unlink(filePath);
}
