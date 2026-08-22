import type { FastifyInstance } from 'fastify';
import type { HomeCsiDb } from '../db/types.js';
import { boundedLimit, timeOrderCheck, TIME_ORDER_MESSAGE, timeRangeQuerySchema } from '../schemas.js';
import { parseOrThrow } from '../validate.js';

const MAX_LIMIT = 10000;
const DEFAULT_LIMIT = 1000;

const occupancyQuerySchema = timeRangeQuerySchema
  .extend({
    limit: boundedLimit(DEFAULT_LIMIT, MAX_LIMIT),
  })
  .refine(timeOrderCheck, { message: TIME_ORDER_MESSAGE });

/**
 * Whole-house occupancy states over a time range, including the latch state
 * machine's internal `state` label and `confidence` — never just the bare
 * 0/1/2+ `estimate` (docs/architecture.md "Motion, not people": a number
 * with no "why" is not debuggable).
 */
export function registerOccupancyRoutes(app: FastifyInstance, db: HomeCsiDb): void {
  app.get('/api/occupancy', async (request) => {
    const { from, to, limit } = parseOrThrow(occupancyQuerySchema, request.query);
    const states = await db.listOccupancyStates({ from, to, limit });
    return { states, limit };
  });
}
