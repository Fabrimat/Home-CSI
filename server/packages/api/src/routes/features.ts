import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HomeCsiDb } from '../db/types.js';
import { macAddressSchema, nodeIdSchema, timeOrderCheck, TIME_ORDER_MESSAGE, timeRangeQuerySchema } from '../schemas.js';
import { parseOrThrow } from '../validate.js';

const MAX_POINTS = 5000;
const DEFAULT_POINTS = 500;

const featuresQuerySchema = timeRangeQuerySchema
  .extend({
    nodeId: nodeIdSchema,
    linkMac: macAddressSchema.optional(),
    maxPoints: z.coerce.number().int().positive().max(MAX_POINTS).optional(),
  })
  .refine(timeOrderCheck, { message: TIME_ORDER_MESSAGE });

/**
 * Feature vectors for one node/link over a time range, downsampled
 * server-side. `feature_vector` is opaque jsonb (owned by brief B4) — the
 * API passes it through unmodified rather than assuming its shape.
 */
export function registerFeatureRoutes(app: FastifyInstance, db: HomeCsiDb): void {
  app.get('/api/features', async (request) => {
    const { nodeId, linkMac, from, to, maxPoints } = parseOrThrow(featuresQuerySchema, request.query);
    const features = await db.listFeatures({
      nodeId,
      linkMac,
      from,
      to,
      maxPoints: maxPoints ?? DEFAULT_POINTS,
    });
    return { features, maxPoints: maxPoints ?? DEFAULT_POINTS };
  });
}
