import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HomeCsiDb } from '../db/types.js';
import { parseOrThrow } from '../validate.js';

const statusQuerySchema = z.object({
  windowMs: z.coerce.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
});

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

/** Landing-view summary: DB reachability, node liveness, latest occupancy, recent volumes. */
export function registerStatusRoutes(app: FastifyInstance, db: HomeCsiDb): void {
  app.get('/api/status', async (request) => {
    const { windowMs } = parseOrThrow(statusQuerySchema, request.query);
    return db.getStatusSummary(windowMs ?? DEFAULT_WINDOW_MS);
  });
}
