import { existsSync } from 'node:fs';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { DEFAULT_RETENTION_SAFETY_MARGIN_MS } from '@homecsi/labeling';
import { extractBearerToken, tokensMatch } from './auth.js';
import type { HomeCsiDb } from './db/types.js';
import { LiveHub } from './live/hub.js';
import { registerCsiRoutes } from './routes/csi.js';
import { DEFAULT_RETENTION_MAX_AGE_MS, registerConfigRoutes, type ClientConfig } from './routes/config.js';
import { registerFeatureRoutes } from './routes/features.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerLabelRoutes, type LabelPreservationDeps } from './routes/labels.js';
import { registerLinkRoutes } from './routes/links.js';
import { registerLogRoutes } from './routes/logs.js';
import { registerNodeRoutes } from './routes/nodes.js';
import { registerOccupancyRoutes } from './routes/occupancy.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerWsRoutes } from './routes/ws.js';
import { ValidationError } from './validate.js';
import { RingLogBuffer } from './logs/ringBuffer.js';

export interface BuildAppOptions {
  db: HomeCsiDb;
  apiToken: string;
  webAssetsDir: string;
  logger?: FastifyBaseLogger | boolean;
  /** Backs `/api/logs`. Defaults to an empty, unused buffer for tests that don't care about log tailing. */
  ringBuffer?: RingLogBuffer;
  /**
   * Training-set preservation deps for the labels session-stop route (see
   * routes/labels.ts). Omitted by tests that don't need it and by any
   * caller without a live database; `startServer` always supplies it in
   * production so the web UI's stop button preserves features the same way
   * the CLI's `label session stop` does (docs/architecture.md "Data lifecycle").
   */
  labelPreservation?: LabelPreservationDeps;
  /**
   * Client-relevant slice of config backing `GET /api/config` (see
   * routes/config.ts) -- lets the dashboard shade timeline selections that
   * are already past the point of no return for training-set preservation.
   * Optional and defaulted (DEFAULT_RETENTION_MAX_AGE_MS/
   * DEFAULT_RETENTION_SAFETY_MARGIN_MS) so tests that don't care about this
   * route don't need to learn about it; `startServer` always supplies the
   * real values from `config.storage.retention`.
   */
  clientConfig?: ClientConfig;
}

/**
 * Builds (but does not bind) the Fastify app. Split out from `startServer`
 * so route-level tests can `inject()` against it with an in-memory
 * `HomeCsiDb` fake and no live database or open socket.
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  // --- auth: every /api/* route except the WebSocket upgrade itself, which
  // authenticates via its own first-message protocol because browsers
  // cannot set a custom header on a WS handshake (see routes/ws.ts). ---
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/') || request.url.startsWith('/api/ws')) return;
    const token = extractBearerToken(request.headers.authorization);
    if (!token || !tokensMatch(token, options.apiToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return undefined;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ValidationError) {
      reply.code(400).send({ error: 'invalid request', issues: error.issues });
      return;
    }
    request.log.error({ err: error }, 'unhandled route error');
    reply.code(500).send({ error: 'internal server error' });
  });

  registerHealthRoutes(app, options.db);
  registerStatusRoutes(app, options.db);
  registerNodeRoutes(app, options.db);
  registerLinkRoutes(app, options.db);
  registerCsiRoutes(app, options.db);
  registerFeatureRoutes(app, options.db);
  registerOccupancyRoutes(app, options.db);
  registerLabelRoutes(app, options.db, options.labelPreservation);
  registerConfigRoutes(
    app,
    options.clientConfig ?? {
      retentionMaxAgeMs: DEFAULT_RETENTION_MAX_AGE_MS,
      retentionSafetyMarginMs: DEFAULT_RETENTION_SAFETY_MARGIN_MS,
    },
  );
  registerLogRoutes(app, options.ringBuffer ?? new RingLogBuffer(1));

  return app;
}

/**
 * Registers the WebSocket plugin/route and static UI serving. Kept separate
 * from `buildApp` because `@fastify/websocket`'s route registration needs
 * `app.register` (async) to complete before `inject()`-based tests run, and
 * because static asset serving depends on a directory that may not exist in
 * a pure route-level test (no build has been run for `@homecsi/web`).
 */
export async function attachLiveAndStatic(
  app: FastifyInstance,
  options: BuildAppOptions,
): Promise<void> {
  await app.register(fastifyWebsocket);
  const hub = new LiveHub(options.db, app.log);
  registerWsRoutes(app, hub, options.apiToken);

  if (existsSync(options.webAssetsDir)) {
    await app.register(fastifyStatic, {
      root: options.webAssetsDir,
      index: ['index.html'],
    });
  } else {
    app.log.warn(
      { webAssetsDir: options.webAssetsDir },
      'web assets directory does not exist — UI will not be served (run the @homecsi/web build)',
    );
  }
}
