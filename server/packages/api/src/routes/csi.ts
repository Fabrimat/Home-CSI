import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HomeCsiDb } from '../db/types.js';
import { macAddressSchema, nodeIdSchema, timeOrderCheck, TIME_ORDER_MESSAGE, timeRangeQuerySchema } from '../schemas.js';
import { parseOrThrow } from '../validate.js';

const MAX_POINTS = 2000;
const DEFAULT_POINTS = 300;

const csiQuerySchema = timeRangeQuerySchema
  .extend({
    nodeId: nodeIdSchema,
    srcMac: macAddressSchema,
    dstMac: macAddressSchema,
    maxPoints: z.coerce.number().int().positive().max(MAX_POINTS).optional(),
  })
  .refine(timeOrderCheck, { message: TIME_ORDER_MESSAGE });

/**
 * CSI records for one link over a time range, downsampled server-side to at
 * most `maxPoints` representative records (docs/architecture.md — never
 * ship a million raw rows to a browser). Subcarrier count is not assumed;
 * each returned point carries its own amplitude array, whose length comes
 * from that record's own `csi_data` length.
 */
export function registerCsiRoutes(app: FastifyInstance, db: HomeCsiDb): void {
  app.get('/api/csi', async (request) => {
    const { nodeId, srcMac, dstMac, from, to, maxPoints } = parseOrThrow(csiQuerySchema, request.query);
    const points = await db.listCsiRecords({
      nodeId,
      srcMac,
      dstMac,
      from,
      to,
      maxPoints: maxPoints ?? DEFAULT_POINTS,
    });
    return { points, maxPoints: maxPoints ?? DEFAULT_POINTS };
  });
}
