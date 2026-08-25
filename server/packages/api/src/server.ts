import { existsSync } from 'node:fs';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { DEFAULT_RETENTION_SAFETY_MARGIN_MS } from '@homecsi/labeling';
import { extractBearerToken, tokensMatch } from './auth.js';
import { DeviceTokenRegistry } from './deviceAuth.js';
import type { HomeCsiDb } from './db/types.js';
import { LiveHub } from './live/hub.js';
import { registerAnnotationRoutes } from './routes/annotations.js';
import {
  DEFAULT_RETENTION_MAX_AGE_MS,
  registerConfigRoutes,
  type ClientConfig,
} from './routes/config.js';
import { registerCoverageRoutes } from './routes/coverage.js';
import { registerCsiRoutes } from './routes/csi.js';
import {
  DEFAULT_OTA_FIRMWARE_DIR,
  DeviceHelloStore,
  registerDeviceRoutes,
} from './routes/device.js';
import { registerFeatureRoutes } from './routes/features.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerLabelRoutes, type LabelPreservationDeps } from './routes/labels.js';
import { registerLinkRoutes } from './routes/links.js';
import { registerLogRoutes } from './routes/logs.js';
import { registerNodeRoutes } from './routes/nodes.js';
import { registerOccupancyRoutes } from './routes/occupancy.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerTopologyRoutes } from './routes/topology.js';
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
  /**
   * Resolves a `/device/*` bearer token (see deviceAuth.ts) to a node id.
   * Defaults to an empty registry -- with no nodes configured, nothing can
   * ever authenticate, so an omitted registry leaves `/device/*` closed
   * rather than silently open. `startServer` always supplies the real one,
   * built from `config.nodes`.
   */
  deviceTokenRegistry?: DeviceTokenRegistry;
  /**
   * OTA artifact directory backing `/device/ota/*` (routes/device.ts).
   * Defaults to `DEFAULT_OTA_FIRMWARE_DIR`, matching `config.ota`'s own
   * default (packages/config/src/schema.ts) for when that optional section
   * is omitted.
   */
  otaFirmwareDir?: string;
  /**
   * In-memory `POST /device/hello` state backing `/api/devices`. Defaults
   * to a fresh, empty store for tests that don't care about it.
   */
  deviceHelloStore?: DeviceHelloStore;
}

/**
 * Builds (but does not bind) the Fastify app. Split out from `startServer`
 * so route-level tests can `inject()` against it with an in-memory
 * `HomeCsiDb` fake and no live database or open socket.
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  // Fastify 5 split what Fastify 4 accepted under a single `logger` option: a
  // configuration OBJECT still goes to `logger`, but a ready-made logger
  // instance must be handed over as `loggerInstance`. Passing an instance as
  // `logger` throws FST_ERR_LOG_INVALID_LOGGER_CONFIG ("logger options only
  // accepts a configuration object") at construction time.
  //
  // This mattered only in production, which is why it shipped: startServer
  // (index.ts) is the one caller that passes a real pino instance
  // (logs/logger.ts), while every test here passes `false` or omits the
  // option entirely and takes the boolean branch. It cost five failed Coolify
  // deployments, because a container that dies at startup is indistinguishable
  // from every other reason a deployment can roll back.
  const app: FastifyInstance =
    options.logger && typeof options.logger === 'object'
      ? Fastify({ loggerInstance: options.logger })
      : Fastify({ logger: options.logger ?? false });

  // --- auth: every /api/* route except the WebSocket upgrade itself, which
  // authenticates via its own first-message protocol because browsers
  // cannot set a custom header on a WS handshake (see routes/ws.ts).
  //
  // Gated on the *matched route pattern* (request.routeOptions.url), never
  // on the raw request.url. onRequest hooks run after routing in Fastify 5,
  // so the router has already decoded any percent-encoding and matched the
  // real route by the time this runs -- but request.url is still the raw,
  // undecoded string. Gating on it let a client skip this hook entirely by
  // percent-encoding one character of the path (e.g. `/%61pi/nodes`): the
  // router still decoded and matched `/api/nodes`'s handler and ran it
  // unauthenticated, while this hook's `startsWith('/api/')` check saw
  // `/%61pi/nodes` and didn't match -- a real, remotely-exploitable auth
  // bypass (reverse proxies forward encoded octets through untouched), not
  // a theoretical one.
  //
  // Side effect, chosen deliberately: request.routeOptions.url is undefined
  // for a request that matches no route at all, so an unmatched /api/*
  // path now falls through this hook and gets Fastify's normal 404
  // (instead of the 401 it got before, when this hook pattern-matched the
  // raw URL regardless of whether a route existed). No handler ever runs
  // for a 404, so nothing sensitive is exposed -- it only reveals that a
  // given path isn't a route, and the dashboard's own bundled JS already
  // tells any caller the full route list anyway. Pinned by a test in
  // server.test.ts ("responds 404, not 401, for a nonexistent /api/* path").
  app.addHook('onRequest', async (request, reply) => {
    const routeUrl = request.routeOptions.url;
    if (!routeUrl || !routeUrl.startsWith('/api/') || routeUrl.startsWith('/api/ws')) return;
    const token = extractBearerToken(request.headers.authorization);
    if (!token || !tokensMatch(token, options.apiToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return undefined;
  });

  // --- a second, entirely separate auth realm for /device/*, isolated from
  // /api/*'s apiToken hook above in both directions: this hook never fires
  // for /api/* (so a device token can never be checked against it), and
  // the /api/* hook above already returns early for anything not starting
  // with /api/ (so it never validates a device-realm request either). A
  // device bearer token is per-node (see deviceAuth.ts), never the shared
  // dashboard apiToken -- resolving it also tells each /device/* route
  // which node is calling (request.deviceNodeId).
  //
  // Also gated on request.routeOptions.url, not request.url, for the same
  // percent-encoding-bypass reason as the /api/* hook above -- and so the
  // two realms can't drift onto different (and differently exploitable)
  // gating strategies. This realm doesn't strictly need it: every
  // /device/* handler independently 401s when request.deviceNodeId is
  // still null (defense in depth, see routes/device.ts), so a raw-URL
  // bypass of *this* hook would still hit a handler-level 401, not leak
  // data -- but there's no reason to leave the weaker check in place once
  // the shared reason to avoid it is known. ---
  const deviceTokenRegistry = options.deviceTokenRegistry ?? new DeviceTokenRegistry([]);
  app.decorateRequest('deviceNodeId', null);
  app.addHook('onRequest', async (request, reply) => {
    const routeUrl = request.routeOptions.url;
    if (!routeUrl || !routeUrl.startsWith('/device/')) return;
    const token = extractBearerToken(request.headers.authorization);
    const nodeId = token === null ? null : deviceTokenRegistry.resolve(token);
    if (nodeId === null) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    request.deviceNodeId = nodeId;
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
  registerTopologyRoutes(app, options.db);
  registerOccupancyRoutes(app, options.db);
  registerLabelRoutes(app, options.db, options.labelPreservation);
  registerAnnotationRoutes(app, options.db);
  // Same retentionMaxAgeMs/safetyMarginMs source of truth as GET /api/config
  // (routes/config.ts) -- reuses the already-optional clientConfig option
  // and its defaults rather than inventing a third way to thread these two
  // numbers through buildApp.
  registerCoverageRoutes(app, options.db, {
    retentionMaxAgeMs: options.clientConfig?.retentionMaxAgeMs ?? DEFAULT_RETENTION_MAX_AGE_MS,
    safetyMarginMs: options.clientConfig?.retentionSafetyMarginMs ?? DEFAULT_RETENTION_SAFETY_MARGIN_MS,
  });
  registerDeviceRoutes(app, {
    firmwareDir: options.otaFirmwareDir ?? DEFAULT_OTA_FIRMWARE_DIR,
    helloStore: options.deviceHelloStore ?? new DeviceHelloStore(),
  });
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
