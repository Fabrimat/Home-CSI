import dgram from 'node:dgram';
import type { Config } from '@homecsi/config';
import { createPool, type DbPool } from '@homecsi/db';
import { CaptureWriter, DbWriteQueue, resolveCaptureDir } from '@homecsi/storage';
import { createIngestEngine, type IngestDeps, type IngestEngine } from './engine.js';
import { createLogger, type Logger } from './logger.js';
import { createEmptyMetrics, type IngestMetrics } from './metrics.js';
import { startMetricsSnapshotLoop } from './metricsSnapshotLoop.js';

export { createIngestEngine } from './engine.js';
export type { IngestEngine, IngestDeps, CaptureWriterLike, DbWriteQueueLike } from './engine.js';
export type { IngestMetrics, PerNodeMetrics, RejectReason } from './metrics.js';
export { flattenMetrics } from './metricsSnapshotLoop.js';

let currentEngine: IngestEngine | undefined;

/**
 * Snapshot of ingest's in-process counters (see `IngestMetrics`). Returns
 * a zeroed snapshot if no `runIngest` call is currently active in this
 * process.
 *
 * SAME-PROCESS CAVEAT for brief B5 (`@homecsi/api`): this reads a
 * module-level reference to the engine created by the most recent
 * `runIngest` call *in this process*. If `ingest` and `serve` are run as
 * two separate OS processes (the expected production deployment — see
 * `packages/cli/CONTRACTS.md`, each is its own long-running CLI
 * subcommand), `@homecsi/api` importing this function will only ever see
 * zeros, because it never called `runIngest` itself. Bridging that gap
 * (e.g. an HTTP metrics endpoint on the ingest process, or writing
 * metrics to a shared store) is cross-cutting and out of this brief's
 * scope; flagged back to the coordinating brief so B5 knows to either run
 * ingest in-process or use a different transport for metrics.
 */
export function getIngestMetrics(): IngestMetrics {
  return currentEngine ? currentEngine.getMetrics() : createEmptyMetrics();
}

async function buildDeps(config: Config, logger: Logger): Promise<{ deps: IngestDeps; pool: DbPool; captureWriter: CaptureWriter }> {
  const pool = createPool(config.database);
  const captureDir = resolveCaptureDir(config);
  const captureWriter = new CaptureWriter({ captureDir, rotation: config.storage.rotation, logger });
  await captureWriter.init();

  const dbWriteQueue = new DbWriteQueue(pool, { logger });
  for (const node of config.nodes) {
    await dbWriteQueue.upsertNode(node).catch((err: unknown) => {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), nodeId: node.id },
        'failed to upsert node registry row at startup',
      );
    });
  }

  return { deps: { captureWriter, dbWriteQueue, logger }, pool, captureWriter };
}

/**
 * Runs the UDP ingest server: binds `config.server.udp`, decodes
 * datagrams with `@homecsi/protocol`, applies per-node replay windows,
 * writes raw captures and batched database rows via `@homecsi/storage`.
 * Resolves on SIGINT/SIGTERM (graceful shutdown); rejects if the UDP
 * socket cannot bind.
 *
 * Contract: see packages/cli/CONTRACTS.md ("ingest"). Owned by brief B3.
 */
export async function runIngest(config: Config): Promise<void> {
  const logger = createLogger(config);
  const { deps, pool, captureWriter } = await buildDeps(config, logger);
  const engine = createIngestEngine(config, deps);
  currentEngine = engine;

  const stopMetricsSnapshotLoop = startMetricsSnapshotLoop(
    pool,
    config,
    () => engine.getMetrics(),
    logger,
  );

  const socket = dgram.createSocket('udp4');
  socket.on('message', (msg) => {
    engine.handleDatagram(msg);
  });
  socket.on('error', (err) => {
    logger.error({ err: err.message }, 'UDP socket error');
  });

  await new Promise<void>((resolve, reject) => {
    const onBindError = (err: Error): void => reject(err);
    socket.once('error', onBindError);
    socket.bind(config.server.udp.port, config.server.udp.host, () => {
      socket.removeListener('error', onBindError);
      logger.info(
        { host: config.server.udp.host, port: config.server.udp.port },
        'ingest UDP listener bound',
      );
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    const shutdown = (signal: string): void => {
      void (async () => {
        logger.info({ signal }, 'ingest shutting down');
        socket.close();
        stopMetricsSnapshotLoop();
        await engine.close();
        await captureWriter.close();
        await pool.end().catch(() => undefined);
        currentEngine = undefined;
        resolve();
      })();
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  });
}
