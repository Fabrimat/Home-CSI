import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { encodeCaptureRecord, SHARD_MAGIC, type CaptureRecordEnvelope } from './captureFormat.js';
import { noopLogger, type BasicLogger } from './logger.js';

/** Suffix marking a shard as currently open/being appended to. See FORMAT.md. */
const WRITING_SUFFIX = '.hcscap.writing';
/** Suffix a shard is renamed to once it is finalized (closed/rotated). */
const FINAL_SUFFIX = '.hcscap';

export interface CaptureWriterOptions {
  /** Absolute path to the capture directory (already resolved by the caller). */
  captureDir: string;
  rotation: {
    maxBytes: number;
    maxIntervalMs: number;
  };
  logger?: BasicLogger;
}

/**
 * Appends accepted, decrypted datagrams to append-only shard files under
 * `captureDir`, rotating by size or time (whichever comes first) and
 * surviving an abrupt process kill without corrupting the whole shard —
 * see `packages/storage/FORMAT.md` for the on-disk format and the
 * `.hcscap.writing` / `.hcscap` naming convention that makes this class
 * safe to run concurrently with `pruneStorage` (which only ever considers
 * finalized `.hcscap`/`.hcscap.gz` files, never the active `.writing`
 * one).
 */
export class CaptureWriter {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly maxIntervalMs: number;
  private readonly logger: BasicLogger;

  private fh: FileHandle | undefined;
  private activePath: string | undefined;
  private finalPath: string | undefined;
  private currentSize = 0;
  private shardStartMs = 0;
  private counter = 0;
  private rotateTimer: NodeJS.Timeout | undefined;
  /** Serializes appends/rotations so concurrent callers never interleave writes. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: CaptureWriterOptions) {
    this.dir = options.captureDir;
    this.maxBytes = options.rotation.maxBytes;
    this.maxIntervalMs = options.rotation.maxIntervalMs;
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Creates the capture directory if needed and finalizes any `.writing`
   * shard left behind by a previous crashed process (renaming it to its
   * final name so it becomes visible to replay/prune/compression — our
   * reader already tolerates a truncated tail, so this is always safe).
   * Must be called once before `appendRecord`.
   */
  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await this.finalizeOrphans();
    this.rotateTimer = setInterval(() => {
      void this.rotateIfIntervalElapsed().catch((err: unknown) => {
        this.logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'scheduled capture shard rotation failed',
        );
      });
      // Unref so this timer never keeps the process alive on its own.
    }, Math.min(this.maxIntervalMs, 60_000)).unref();
  }

  private async finalizeOrphans(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.endsWith(WRITING_SUFFIX)) continue;
      const finalName = name.slice(0, -'.writing'.length);
      await fs
        .rename(path.join(this.dir, name), path.join(this.dir, finalName))
        .catch((err: unknown) => {
          this.logger.error(
            { err: err instanceof Error ? err.message : String(err), name },
            'failed to finalize orphaned capture shard from a previous run',
          );
        });
    }
  }

  private async rotateIfIntervalElapsed(): Promise<void> {
    if (this.fh && Date.now() - this.shardStartMs >= this.maxIntervalMs) {
      await this.rotate();
    }
  }

  /**
   * Appends one accepted datagram to the currently active shard, rotating
   * first if needed. Calls are serialized via `writeChain` so they never
   * interleave, but a single call's failure (e.g. a transient ENOSPC/EIO)
   * must not permanently stop every future append: `writeChain` itself is
   * always re-armed to a *fulfilled* continuation regardless of this
   * call's outcome, while the promise returned to *this* caller still
   * carries the real rejection.
   */
  appendRecord(rec: CaptureRecordEnvelope): Promise<void> {
    const attempt = this.writeChain.then(() => this.doAppend(rec));
    this.writeChain = attempt.then(
      () => undefined,
      () => undefined,
    );
    return attempt;
  }

  private async doAppend(rec: CaptureRecordEnvelope): Promise<void> {
    const encoded = encodeCaptureRecord(rec);
    const needsRotation =
      !this.fh ||
      this.currentSize + encoded.length > this.maxBytes ||
      Date.now() - this.shardStartMs >= this.maxIntervalMs;
    if (needsRotation) {
      await this.rotate();
    }
    const fh = this.fh;
    if (!fh) {
      throw new Error('capture writer has no open shard to append to');
    }

    // Any failure from here on — the write() call rejecting outright
    // (e.g. ENOSPC/EIO after some unknown number of bytes may already
    // have reached the OS), or it resolving with fewer bytes written
    // than requested — leaves this file's tail in an untracked, possibly
    // partial state. Both are handled identically: abandon this file
    // handle immediately so NOTHING is ever written to it again
    // (finalizing it now so its valid prefix is still replayable right
    // away), and force the next append to open a fresh shard. Without
    // this, a later record's bytes could land right after an untracked
    // partial write in the same file — the cross-record misparse risk
    // this whole abandon-and-rotate strategy exists to prevent (see
    // FORMAT.md).
    let bytesWritten: number;
    try {
      ({ bytesWritten } = await fh.write(encoded));
    } catch (err) {
      await this.abandonShard(fh);
      throw err;
    }

    if (bytesWritten !== encoded.length) {
      await this.abandonShard(fh);
      throw new Error(
        `short write to capture shard (${bytesWritten}/${encoded.length} bytes) — shard finalized early with its valid prefix intact; a new shard will be opened on the next append`,
      );
    }
    this.currentSize += bytesWritten;
  }

  /**
   * Abandons `fh` as the active shard: clears it from this writer's state
   * (so the next `doAppend` is forced to rotate to a fresh shard) and
   * finalizes the file on disk (closed and renamed away from its
   * `.writing` suffix) so whatever valid prefix it contains is
   * immediately visible to replay/prune/compression. Safe to call even
   * if `fh` is no longer the active handle (no-ops in that case).
   */
  private async abandonShard(fh: FileHandle): Promise<void> {
    if (this.fh !== fh) return;
    const abandonedActive = this.activePath;
    const abandonedFinal = this.finalPath;
    this.fh = undefined;
    this.activePath = undefined;
    this.finalPath = undefined;
    await fh.close().catch(() => undefined);
    if (abandonedActive && abandonedFinal) {
      await fs.rename(abandonedActive, abandonedFinal).catch(() => undefined);
    }
  }

  private async rotate(): Promise<void> {
    await this.closeCurrent();
    await this.openNew();
  }

  private async closeCurrent(): Promise<void> {
    if (!this.fh) return;
    const fh = this.fh;
    const activePath = this.activePath;
    const finalPath = this.finalPath;
    this.fh = undefined;
    this.activePath = undefined;
    this.finalPath = undefined;
    await fh.close();
    if (activePath && finalPath) {
      await fs.rename(activePath, finalPath);
    }
  }

  private async openNew(): Promise<void> {
    this.shardStartMs = Date.now();
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const base = `capture-${this.shardStartMs}-${String(this.counter).padStart(6, '0')}`;
      const activePath = path.join(this.dir, `${base}${WRITING_SUFFIX}`);
      const finalPath = path.join(this.dir, `${base}${FINAL_SUFFIX}`);
      try {
        const fh = await fs.open(activePath, 'wx');
        await fh.write(SHARD_MAGIC);
        this.fh = fh;
        this.activePath = activePath;
        this.finalPath = finalPath;
        this.currentSize = SHARD_MAGIC.length;
        this.counter++;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          this.counter++;
          continue;
        }
        throw err;
      }
    }
    throw new Error(
      `failed to create a new capture shard file under ${this.dir} after ${maxAttempts} attempts`,
    );
  }

  /** Path to the shard currently being written, if any (used by tests/diagnostics). */
  getActivePath(): string | undefined {
    return this.activePath;
  }

  /** Flushes any pending write, finalizes the current shard, and stops the rotation timer. */
  async close(): Promise<void> {
    if (this.rotateTimer) {
      clearInterval(this.rotateTimer);
      this.rotateTimer = undefined;
    }
    await this.writeChain.catch(() => undefined);
    await this.closeCurrent();
  }
}
