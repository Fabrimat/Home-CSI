import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HomeCsiDb } from '../db/types.js';
import { boundedLimit } from '../schemas.js';
import { parseOrThrow } from '../validate.js';

const MAX_LINKS_LIMIT = 500;
const DEFAULT_LINKS_LIMIT = 200;
const MAX_SINCE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SINCE_MS = 60 * 60 * 1000;

const linksQuerySchema = z.object({
  sinceMs: z.coerce.number().int().positive().max(MAX_SINCE_MS).optional(),
  limit: boundedLimit(DEFAULT_LINKS_LIMIT, MAX_LINKS_LIMIT),
});

/**
 * Per-link (not per-node) discovery: with N nodes there are N*(N-1)
 * directional node-to-node links plus N node-to-AP links
 * (docs/architecture.md "broadcast-sounding mesh"). This lists links
 * actually observed recently so the UI can populate a link picker without
 * the caller needing to already know every (node, src_mac, dst_mac) triple.
 */
export function registerLinkRoutes(app: FastifyInstance, db: HomeCsiDb): void {
  app.get('/api/links', async (request) => {
    const { sinceMs, limit } = parseOrThrow(linksQuerySchema, request.query);
    const links = await db.listLinks({ sinceMs: sinceMs ?? DEFAULT_SINCE_MS, limit });
    return { links, limit };
  });
}
