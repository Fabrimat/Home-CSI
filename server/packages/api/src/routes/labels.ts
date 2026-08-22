import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HomeCsiDb } from '../db/types.js';
import { boundedLimit, timestampSchema } from '../schemas.js';
import { parseOrThrow } from '../validate.js';

const MAX_SESSIONS_LIMIT = 500;
const DEFAULT_SESSIONS_LIMIT = 100;
const MAX_LABELS_LIMIT = 5000;
const DEFAULT_LABELS_LIMIT = 500;

const sessionsQuerySchema = z.object({
  limit: boundedLimit(DEFAULT_SESSIONS_LIMIT, MAX_SESSIONS_LIMIT),
});

const startSessionBodySchema = z.object({
  startedAt: timestampSchema.optional(),
  notes: z.string().max(2000).optional(),
});

const sessionIdParamsSchema = z.object({ sessionId: z.coerce.number().int().positive() });

const stopSessionBodySchema = z.object({
  endedAt: timestampSchema.optional(),
});

const labelsQuerySchema = z.object({
  limit: boundedLimit(DEFAULT_LABELS_LIMIT, MAX_LABELS_LIMIT),
});

const createLabelBodySchema = z.object({
  sessionId: z.coerce.number().int().positive(),
  time: timestampSchema.optional(),
  occupancyCount: z.coerce.number().int().min(0).max(255),
  notes: z.string().max(2000).optional(),
});

/**
 * Ground-truth label sessions/labels: read endpoints plus start/stop/annotate
 * writes, so the recording-controls view can drive labelled recordings that
 * the occupancy timeline later overlays against the predicted estimate.
 */
export function registerLabelRoutes(app: FastifyInstance, db: HomeCsiDb): void {
  app.get('/api/labels/sessions', async (request) => {
    const { limit } = parseOrThrow(sessionsQuerySchema, request.query);
    const sessions = await db.listLabelSessions({ limit });
    return { sessions, limit };
  });

  app.post('/api/labels/sessions', async (request, reply) => {
    const body = parseOrThrow(startSessionBodySchema, request.body ?? {});
    const session = await db.createLabelSession({
      startedAt: body.startedAt ?? new Date(),
      notes: body.notes,
    });
    reply.code(201);
    return { session };
  });

  app.post('/api/labels/sessions/:sessionId/stop', async (request, reply) => {
    const { sessionId } = parseOrThrow(sessionIdParamsSchema, request.params);
    const body = parseOrThrow(stopSessionBodySchema, request.body ?? {});
    const session = await db.stopLabelSession({ id: sessionId, endedAt: body.endedAt ?? new Date() });
    if (!session) {
      reply.code(404);
      return { error: 'label session not found' };
    }
    return { session };
  });

  app.get('/api/labels/sessions/:sessionId/labels', async (request) => {
    const { sessionId } = parseOrThrow(sessionIdParamsSchema, request.params);
    const { limit } = parseOrThrow(labelsQuerySchema, request.query);
    const labels = await db.listLabels({ sessionId, limit });
    return { labels, limit };
  });

  app.post('/api/labels', async (request, reply) => {
    const body = parseOrThrow(createLabelBodySchema, request.body ?? {});
    const label = await db.createLabel({
      sessionId: body.sessionId,
      time: body.time ?? new Date(),
      occupancyCount: body.occupancyCount,
      notes: body.notes,
    });
    reply.code(201);
    return { label };
  });
}
