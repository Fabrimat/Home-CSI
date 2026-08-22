import type { FastifyInstance } from 'fastify';
import type { HomeCsiDb } from '../db/types.js';

/**
 * Unauthenticated liveness route. Deliberately does not require the bearer
 * token (docs/architecture.md "Token-authenticated UI/API" carves out
 * health/liveness) and deliberately does not leak database credentials or
 * internal error detail — just whether the process is up and whether it can
 * currently reach the database.
 */
export function registerHealthRoutes(app: FastifyInstance, db: HomeCsiDb): void {
  app.get('/healthz', async (_request, reply) => {
    const dbReachable = await db.healthCheck();
    reply.code(dbReachable ? 200 : 503);
    return { status: dbReachable ? 'ok' : 'degraded', dbReachable };
  });
}
