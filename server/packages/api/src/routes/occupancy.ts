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
 *
 * **This is a sparse event log, read with step semantics.** Since migration
 * 006 the occupancy pipeline writes one row per *transition* plus a
 * keepalive every 15 minutes of tick time, not one row per 500 ms tick.
 * Consequences for callers:
 *
 *  - The response includes a **carry-in** row: the last event at or before
 *    `from`, returned with its real (pre-window) timestamp, so
 *    `states[0].time` may be earlier than `from`. Carry it forward to the
 *    start of the window rather than treating the window as empty — that is
 *    what lets a UI say "occupied since 3h ago" instead of "no data".
 *  - A row's value holds until the *next* row. Never interpolate between
 *    rows and never assume a fixed cadence.
 *  - `limit` bounds **events, not samples**. When rows were dense, trimming
 *    dropped redundant samples; now every row is a semantic event, so
 *    trimming silently drops transitions. The carry-in is always kept and
 *    the oldest in-window events are dropped first. Narrow the range rather
 *    than relying on the limit.
 *  - `kind` is `"transition"` or `"keepalive"`; a keepalive means "nothing
 *    changed and the pipeline was watching", and carries no `details`. A
 *    *gap* with no keepalive means there were no whole-house observations
 *    at all — that is a real signal, not missing data.
 */
export function registerOccupancyRoutes(app: FastifyInstance, db: HomeCsiDb): void {
  app.get('/api/occupancy', async (request) => {
    const { from, to, limit } = parseOrThrow(occupancyQuerySchema, request.query);
    const states = await db.listOccupancyStates({ from, to, limit });
    return { states, limit };
  });
}
