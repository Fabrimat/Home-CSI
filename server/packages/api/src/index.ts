import type { Config } from '@homecsi/config';
import { createPool } from '@homecsi/db';
import { getWebAssetsDir } from '@homecsi/web';
import { PgHomeCsiDb } from './db/pgDb.js';
import { createAppLogger } from './logs/logger.js';
import { attachLiveAndStatic, buildApp } from './server.js';

export { buildApp, attachLiveAndStatic } from './server.js';
export type { BuildAppOptions } from './server.js';
export type { HomeCsiDb } from './db/types.js';
export { PgHomeCsiDb } from './db/pgDb.js';

/**
 * Starts the token-authenticated HTTP API + web UI server on
 * `config.server.http`, serving `@homecsi/web`'s built assets and the
 * occupancy/history endpoints described in docs/architecture.md. Resolves
 * when the server is shut down (e.g. on SIGINT/SIGTERM), and should
 * reject if it fails to bind.
 *
 * Contract: see packages/cli/CONTRACTS.md ("serve"). Owned by brief B5.
 */
export async function startServer(config: Config): Promise<void> {
  const { logger, ringBuffer } = createAppLogger(config.logging);
  const pool = createPool(config.database);
  const db = new PgHomeCsiDb(pool);

  const app = buildApp({
    db,
    apiToken: config.server.apiToken,
    webAssetsDir: getWebAssetsDir(),
    logger,
    ringBuffer,
  });
  await attachLiveAndStatic(app, {
    db,
    apiToken: config.server.apiToken,
    webAssetsDir: getWebAssetsDir(),
    logger,
    ringBuffer,
  });

  try {
    await app.listen({ host: config.server.http.host, port: config.server.http.port });
  } catch (err) {
    await pool.end().catch(() => undefined);
    throw err;
  }

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'shutting down');
      app
        .close()
        .catch((err: unknown) => logger.error({ err }, 'error while closing http server'))
        .finally(() => {
          pool
            .end()
            .catch((err: unknown) => logger.error({ err }, 'error while closing db pool'))
            .finally(resolve);
        });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
