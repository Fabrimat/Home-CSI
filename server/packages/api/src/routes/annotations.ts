import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HomeCsiDb } from '../db/types.js';
import { boundedLimit, timeOrderCheck, TIME_ORDER_MESSAGE, timeRangeQuerySchema, timestampSchema } from '../schemas.js';
import { parseOrThrow } from '../validate.js';

const MAX_ANNOTATIONS_LIMIT = 5000;
const DEFAULT_ANNOTATIONS_LIMIT = 500;

/** `event_annotations.category` CHECK constraint's exact admitted values (migration 009). No `activity` -- see that migration's comment header. */
const annotationCategorySchema = z.enum(['appliance', 'door', 'hvac', 'pet', 'interference', 'other']);

/** `event_annotations.source` CHECK constraint (migration 009) -- 'manual' is the only value any code path writes today. */
const annotationSourceSchema = z.enum(['manual']);

/** `GET /api/annotations?from&to` overlap-range query -- same shape/bounds convention as `/api/labels`'s. */
const annotationsRangeQuerySchema = timeRangeQuerySchema
  .extend({ limit: boundedLimit(DEFAULT_ANNOTATIONS_LIMIT, MAX_ANNOTATIONS_LIMIT) })
  .refine(timeOrderCheck, { message: TIME_ORDER_MESSAGE });

const createAnnotationBodySchema = z
  .object({
    time: timestampSchema.optional(),
    /** EXCLUSIVE end of the annotated interval; omitted means a point annotation. */
    endTime: timestampSchema.optional(),
    category: annotationCategorySchema,
    label: z.string().max(120).optional(),
    notes: z.string().max(2000).optional(),
    source: annotationSourceSchema.optional(),
  })
  // Only comparable here when `time` was actually supplied. When it is
  // omitted, the instant it defaults to is resolved ONCE in the handler
  // below and checked there instead -- reading the clock in this refine as
  // well would mean two `new Date()` calls a few ms apart, and an `endTime`
  // landing between them would pass validation against the earlier read and
  // then violate the `end_time > time` CHECK against the later one (a 500
  // from a constraint violation rather than the 400 it should have been).
  .refine((v) => v.endTime === undefined || v.time === undefined || v.endTime.getTime() > v.time.getTime(), {
    message: 'endTime must be after time',
    path: ['endTime'],
  });

const annotationIdParamsSchema = z.object({ id: z.coerce.number().int().positive() });

/**
 * Event annotations: categorised, point-or-interval markers ("that spike at
 * 19:42 is the microwave") that carry NO occupancy count -- see migration
 * 009's comment header for why these live in their own table rather than as
 * a `labels` variant. Read/write/delete, no `maxAgeMs` span guard and no
 * `preservationWarning` -- unlike `POST /api/labels/corrections`, nothing
 * here ever attempts training-set preservation (deliberately; see the
 * migration comment), so there is no retention-window edge to reject
 * against and no warning to surface.
 */
export function registerAnnotationRoutes(app: FastifyInstance, db: HomeCsiDb): void {
  app.get('/api/annotations', async (request) => {
    const { from, to, limit } = parseOrThrow(annotationsRangeQuerySchema, request.query);
    const annotations = await db.listAnnotationsInRange({ from, to, limit });
    return { annotations, limit };
  });

  app.post('/api/annotations', async (request, reply) => {
    const body = parseOrThrow(createAnnotationBodySchema, request.body ?? {});
    // One clock read, used for both the ordering check and the stored row --
    // see the schema's `refine` above for why this is not done there.
    const time = body.time ?? new Date();
    if (body.endTime !== undefined && body.endTime.getTime() <= time.getTime()) {
      reply.code(400);
      return { error: 'invalid request', issues: [{ path: ['endTime'], message: 'endTime must be after time' }] };
    }
    const annotation = await db.createAnnotation({
      time,
      endTime: body.endTime,
      category: body.category,
      label: body.label,
      notes: body.notes,
      source: body.source,
    });
    reply.code(201);
    return { annotation };
  });

  // DELETE is deliberately supported here even though `labels` is
  // append-only (docs/architecture.md, POST /api/labels/corrections):
  // annotations are not part of the dataset export, so the "an operator
  // could quietly change the training corpus" risk that rules out delete
  // for `labels` does not apply. A fast one-tap annotation UI guarantees
  // mis-taps, and an un-deletable mis-tap is worse than the write.
  app.delete('/api/annotations/:id', async (request, reply) => {
    const { id } = parseOrThrow(annotationIdParamsSchema, request.params);
    const deleted = await db.deleteAnnotation({ id });
    if (!deleted) {
      return reply.code(404).send({ error: 'annotation not found' });
    }
    return reply.code(204).send();
  });
}
