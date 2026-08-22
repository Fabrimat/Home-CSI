import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { decodeCaptureRecordAt, SHARD_MAGIC, type CaptureRecordEnvelope } from './captureFormat.js';

/** Matches finalized (closed) shard filenames: `capture-<startMs>-<counter>.hcscap[.gz]`. */
const SHARD_FILENAME_RE = /^capture-(\d+)-(\d+)\.hcscap(\.gz)?$/;

export interface ShardFileInfo {
  path: string;
  startMs: number;
  counter: number;
  compressed: boolean;
}

/**
 * Lists finalized shard files (`.hcscap` and `.hcscap.gz`) in a capture
 * directory, in timestamp order (by the start-time + rotation-counter
 * embedded in the filename, ascending). Deliberately excludes any
 * `*.hcscap.writing` file — the shard currently being appended to by a
 * live ingest process, or an orphan left by a crashed one — since neither
 * replay nor prune/compression should ever act on it (see FORMAT.md).
 */
export async function listClosedShardFiles(dir: string): Promise<ShardFileInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files: ShardFileInfo[] = [];
  for (const name of entries) {
    const match = SHARD_FILENAME_RE.exec(name);
    if (!match) continue;
    files.push({
      path: path.join(dir, name),
      startMs: Number(match[1]),
      counter: Number(match[2]),
      compressed: Boolean(match[3]),
    });
  }
  files.sort((a, b) => a.startMs - b.startMs || a.counter - b.counter);
  return files;
}

/**
 * Streams every complete record out of one shard file, in order,
 * transparently decompressing `.gz` shards. Stops cleanly (without
 * throwing) at the first incomplete/truncated record it finds — this is
 * what makes an abrupt-kill-truncated final record non-fatal for the rest
 * of the shard (see FORMAT.md).
 */
export async function* readShardRecords(filePath: string): AsyncGenerator<CaptureRecordEnvelope> {
  const isGz = filePath.endsWith('.gz');
  const raw = createReadStream(filePath);
  const stream = isGz ? raw.pipe(createGunzip()) : raw;

  let buf = Buffer.alloc(0);
  let magicChecked = false;

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);

    if (!magicChecked) {
      if (buf.length < SHARD_MAGIC.length) continue;
      if (!buf.subarray(0, SHARD_MAGIC.length).equals(SHARD_MAGIC)) {
        throw new Error(`${filePath}: not a Home CSI capture shard (bad magic)`);
      }
      buf = buf.subarray(SHARD_MAGIC.length);
      magicChecked = true;
    }

    let offset = 0;
    for (;;) {
      const decoded = decodeCaptureRecordAt(buf, offset);
      if (!decoded) break;
      yield decoded.record;
      offset += decoded.length;
    }
    buf = buf.subarray(offset);
  }
  // Any bytes still in `buf` here are a truncated final record (or, if
  // magic was never fully seen, a shard so short it never even got past
  // its header) — silently ignored per FORMAT.md: every complete record
  // before it has already been yielded.
}
