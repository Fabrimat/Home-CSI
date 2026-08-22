import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from '@homecsi/config';
import { createPool } from '@homecsi/db';
import { MsgType, decodeCsiBatch, decodeHeartbeat } from '@homecsi/protocol';
import { listClosedShardFiles } from './captureReader.js';
import { readShardRecords } from './captureReader.js';
import { DbWriteQueue } from './dbWriter.js';
import type { BasicLogger } from './logger.js';

/** Simple stderr-backed logger so a CLI operator actually sees replay/DB failures. */
const consoleLogger: BasicLogger = {
  info: (obj, msg) => console.error(msg ?? '', obj),
  warn: (obj, msg) => console.error(msg ?? '', obj),
  error: (obj, msg) => console.error(msg ?? '', obj),
};

/**
 * Replays a raw capture file or directory back through the *same*
 * database-write path live ingest uses (`DbWriteQueue`, see
 * `dbWriter.ts`) — the disaster-recovery / reprocessing path from
 * `docs/architecture.md` ("Data lifecycle").
 *
 * Documented behaviour:
 *   - `inputPath` is resolved relative to `process.cwd()` (per
 *     `packages/cli/CONTRACTS.md`).
 *   - A directory is read as every finalized shard
 *     (`.hcscap`/`.hcscap.gz`) inside it, in timestamp order; a single
 *     file is read directly regardless of its name/extension.
 *   - Replay **writes decoded rows to the configured database** — it
 *     does not merely print/stream. It reuses `DbWriteQueue` exactly as
 *     live ingest does, so the two are not divergent code paths.
 *   - Replay does **not** re-run AEAD or the per-node `ReplayWindow`
 *     anti-replay check: capture records are already-decrypted,
 *     already-accepted plaintext by construction (only
 *     `@homecsi/ingest`'s engine ever writes them), and the wire
 *     protocol's replay-window state is inherently about *live* traffic
 *     ordering, not historical reprocessing.
 *   - Replay does **not** re-append to the capture files (it reads from
 *     them; re-capturing would duplicate them).
 *   - Replay **is idempotent against rows already written** by a
 *     previous live-ingest run or a previous replay of the same range
 *     (migration 004): `csi_records` has a unique index on `(node_id,
 *     boot_epoch, seq, record_index, time)` and `heartbeats` on
 *     `(node_id, boot_epoch, seq, time)`, and `DbWriteQueue`'s inserts
 *     use `ON CONFLICT (...) DO NOTHING` against exactly those columns
 *     (see `dbWriter.ts`). `record_index` is a record's 0-based position
 *     within its CSI_BATCH (one datagram can carry multiple CSI
 *     records); `time` is included only because TimescaleDB requires the
 *     hypertable's partitioning column in any unique index — it does not
 *     weaken the guarantee, since `time` is *derived deterministically*
 *     from each record's own fields (`wall_clock_us`/`mono_us`/
 *     `rx_timestamp_us` when SNTP-synced, or this server's own
 *     `receivedAt` otherwise — see `DbWriteQueue.enqueueCsiBatch`), so
 *     re-decoding the same wire bytes always reproduces the same key.
 *     Replaying a range that overlaps already-ingested data is therefore
 *     safe and produces no duplicate rows.
 */
export async function replayCaptures(inputPath: string, config: Config): Promise<void> {
  const resolvedInput = path.resolve(process.cwd(), inputPath);
  const stat = await fs.stat(resolvedInput);

  const shardPaths: string[] = stat.isDirectory()
    ? (await listClosedShardFiles(resolvedInput)).map((s) => s.path)
    : [resolvedInput];

  const pool = createPool(config.database);
  const queue = new DbWriteQueue(pool, { logger: consoleLogger });
  try {
    for (const node of config.nodes) {
      await queue.upsertNode(node).catch((err: unknown) => {
        consoleLogger.error(
          { err: err instanceof Error ? err.message : String(err), nodeId: node.id },
          'failed to upsert node registry row during replay',
        );
      });
    }

    for (const shardPath of shardPaths) {
      for await (const rec of readShardRecords(shardPath)) {
        const receivedAt = new Date(rec.receivedAtMs);
        if (rec.msgType === MsgType.CsiBatch) {
          queue.enqueueCsiBatch(rec.nodeId, rec.bootEpoch, rec.seq, receivedAt, decodeCsiBatch(rec.payload));
        } else if (rec.msgType === MsgType.Heartbeat) {
          queue.enqueueHeartbeat(rec.nodeId, rec.bootEpoch, rec.seq, receivedAt, decodeHeartbeat(rec.payload));
        }
      }
    }

    await queue.close();
  } finally {
    await pool.end().catch(() => undefined);
  }
}
