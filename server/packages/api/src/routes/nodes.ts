import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HomeCsiDb } from '../db/types.js';
import { boundedLimit, nodeIdSchema, timeOrderCheck, TIME_ORDER_MESSAGE, timeRangeQuerySchema } from '../schemas.js';
import { parseOrThrow } from '../validate.js';

const MAX_HEARTBEAT_LIMIT = 2000;
const DEFAULT_HEARTBEAT_LIMIT = 200;

const heartbeatQuerySchema = timeRangeQuerySchema
  .extend({
    limit: boundedLimit(DEFAULT_HEARTBEAT_LIMIT, MAX_HEARTBEAT_LIMIT),
  })
  .refine(timeOrderCheck, { message: TIME_ORDER_MESSAGE });

const nodeParamsSchema = z.object({ nodeId: nodeIdSchema });

/** Node registry + liveness, and per-node heartbeat history. */
export function registerNodeRoutes(app: FastifyInstance, db: HomeCsiDb): void {
  app.get('/api/nodes', async () => {
    const nodes = await db.listNodes();
    return { nodes };
  });

  app.get('/api/nodes/:nodeId/heartbeats', async (request) => {
    const { nodeId } = parseOrThrow(nodeParamsSchema, request.params);
    const { from, to, limit } = parseOrThrow(heartbeatQuerySchema, request.query);
    const heartbeats = await db.listHeartbeats({ nodeId, from, to, limit });
    return { heartbeats, limit };
  });
}
