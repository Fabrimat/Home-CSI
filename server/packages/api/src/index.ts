import type { Config } from '@homecsi/config';
import { createPool } from '@homecsi/db';
import {
  DEFAULT_BASELINE_WINDOW_MS,
  DEFAULT_MIN_DENSITY_FRACTION,
  DEFAULT_RETENTION_SAFETY_MARGIN_MS,
  createPgTrainingFeaturesStore,
  type PreservationConfig,
} from '@homecsi/labeling';
import { getWebAssetsDir } from '@homecsi/web';
import type { ClientConfig } from './routes/config.js';
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

  // Same preservation config the CLI's `label session stop`/`label preserve`
  // use (packages/labeling/src/index.ts) -- so a session stopped from the
  // web UI gets its raw per-link features preserved into training_features
  // the same way a session stopped via the CLI does (docs/architecture.md
  // "Data lifecycle").
  const preservationConfig: PreservationConfig = {
    toleranceMs: config.features.windowMs,
    baselineWindowMs: config.training?.preservation.baselineWindowMs ?? DEFAULT_BASELINE_WINDOW_MS,
    minDensityFraction: config.training?.preservation.minDensityFraction ?? DEFAULT_MIN_DENSITY_FRACTION,
  };
  const labelPreservation = {
    trainingStore: createPgTrainingFeaturesStore(pool),
    config: preservationConfig,
    maxAgeMs: config.storage.retention.maxAgeMs,
  };

  // Client-relevant slice of config for GET /api/config (routes/config.ts)
  // -- the dashboard's only way to learn this deployment's actual debug
  // window and retention-warning margin, since it has no config of its own.
  const clientConfig: ClientConfig = {
    retentionMaxAgeMs: config.storage.retention.maxAgeMs,
    retentionSafetyMarginMs: DEFAULT_RETENTION_SAFETY_MARGIN_MS,
  };

  const app = buildApp({
    db,
    apiToken: config.server.apiToken,
    webAssetsDir: getWebAssetsDir(),
    logger,
    ringBuffer,
    labelPreservation,
    clientConfig,
  });
  await attachLiveAndStatic(app, {
    db,
    apiToken: config.server.apiToken,
    webAssetsDir: getWebAssetsDir(),
    logger,
    ringBuffer,
    labelPreservation,
    clientConfig,
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
