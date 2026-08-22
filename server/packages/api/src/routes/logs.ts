import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RingLogBuffer } from '../logs/ringBuffer.js';
import { boundedLimit } from '../schemas.js';
import { parseOrThrow } from '../validate.js';

const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 200;

const logsQuerySchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
  limit: boundedLimit(DEFAULT_LIMIT, MAX_LIMIT),
});

/** Recent server log lines (this process's own real output), filterable by level. */
export function registerLogRoutes(app: FastifyInstance, ringBuffer: RingLogBuffer): void {
  app.get('/api/logs', async (request) => {
    const { level, limit } = parseOrThrow(logsQuerySchema, request.query);
    const lines = ringBuffer.list({ level, limit });
    return { lines, limit };
  });
}
