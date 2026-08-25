import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { preserveSessionFeatures, type PreservationConfig, type TrainingFeaturesStore } from '@homecsi/labeling';
import type { HomeCsiDb, LabelSessionRow } from '../db/types.js';
import { boundedLimit, timeOrderCheck, TIME_ORDER_MESSAGE, timeRangeQuerySchema, timestampSchema } from '../schemas.js';
import { parseOrThrow } from '../validate.js';

const MAX_SESSIONS_LIMIT = 500;
const DEFAULT_SESSIONS_LIMIT = 100;
const MAX_LABELS_LIMIT = 5000;
const DEFAULT_LABELS_LIMIT = 500;

const sessionsQuerySchema = z.object({
  limit: boundedLimit(DEFAULT_SESSIONS_LIMIT, MAX_SESSIONS_LIMIT),
  /**
   * `open=true` -> only sessions still running (`ended_at IS NULL`);
   * `open=false` -> only stopped ones. Absent means no filter at all
   * (unchanged behaviour for existing callers).
   *
   * Deliberately an explicit `'true'|'false'` enum rather than
   * `z.coerce.boolean()`, which coerces the *string* `'false'` to `true`.
   */
  open: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /**
   * Server-side prefix match on `notes`. Exists so the ground-truth view can
   * ask "is there an open `[training]` session?" in one query instead of
   * paging `limit=500` newest-first and scanning client-side: every
   * dashboard correction creates its own `label_sessions` row
   * (`POST /api/labels/corrections`), so enough corrections would push an
   * open training session off the end of even the maximum page and silently
   * orphan a walk in progress.
   */
  notesPrefix: z.string().min(1).max(200).optional(),
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

/** `labels.source` CHECK constraint's exact admitted values (migration 008). */
const labelSourceSchema = z.enum(['manual', 'weak:phone-presence', 'confirmed', 'training']);

const createLabelBodySchema = z
  .object({
    sessionId: z.coerce.number().int().positive(),
    time: timestampSchema.optional(),
    /** EXCLUSIVE end of the labelled interval; omitted means a point label (unchanged pre-migration-008 behaviour). */
    endTime: timestampSchema.optional(),
    occupancyCount: z.coerce.number().int().min(0).max(255),
    source: labelSourceSchema.optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => v.endTime === undefined || v.endTime.getTime() > (v.time ?? new Date()).getTime(), {
    message: 'endTime must be after time',
    path: ['endTime'],
  });

const labelIdParamsSchema = z.object({ labelId: z.coerce.number().int().positive() });

/** PATCH /api/labels/:labelId only ever updates end_time -- see that route's own comment for why nothing else is updatable here. */
const patchLabelBodySchema = z.object({
  endTime: timestampSchema,
});

/** `GET /api/labels?from&to` overlap-range query -- same shape/bounds as `/api/labels/sessions/:sessionId/labels`'s limit, reused rather than inventing new ones. */
const labelsRangeQuerySchema = timeRangeQuerySchema
  .extend({ limit: boundedLimit(DEFAULT_LABELS_LIMIT, MAX_LABELS_LIMIT) })
  .refine(timeOrderCheck, { message: TIME_ORDER_MESSAGE });

/** `POST /api/labels/corrections` only ever writes `manual` or operator-`confirmed` labels -- never `weak:phone-presence` or `training`, which have their own dedicated code paths. */
const correctionSourceSchema = z.enum(['manual', 'confirmed']);

const createCorrectionBodySchema = z
  .object({
    from: timestampSchema,
    to: timestampSchema,
    occupancyCount: z.coerce.number().int().min(0).max(255),
    source: correctionSourceSchema.optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine(timeOrderCheck, { message: TIME_ORDER_MESSAGE });

/**
 * Training-set preservation deps for the session-stop route and
 * `POST /api/labels/corrections` below (`packages/labeling`'s
 * `preserveSessionFeatures`, docs/architecture.md "Data lifecycle").
 * Optional: when omitted (e.g. route-level tests using an in-memory
 * `HomeCsiDb` with no live Postgres), the stop route simply stops the
 * session without attempting preservation, and the corrections route skips
 * both the retention-span guard and the preservation attempt -- callers
 * that care about these paths (production `startServer`) always provide it.
 */
export interface LabelPreservationDeps {
  trainingStore: TrainingFeaturesStore;
  config: PreservationConfig;
  /**
   * config.storage.retention.maxAgeMs -- the debug window a correction's
   * raw per-link features must fit inside to ever be preservable at all.
   * `POST /api/labels/corrections` rejects a correction whose span alone
   * already exceeds this, before creating any rows for it.
   */
  maxAgeMs: number;
}

/**
 * Attempts training-set preservation for a just-closed session and reduces
 * the result to an optional warning string, with the exact failure
 * semantics both the session-stop route and the dashboard-corrections
 * route need: a preservation failure must never fail the request or roll
 * back what was already written, only surface as `preservationWarning`
 * (and a server-side log line) alongside an otherwise-successful response.
 * Shared here so that guarantee is enforced in one place, not re-typed at
 * each call site.
 */
async function attemptPreservation(
  session: Pick<LabelSessionRow, 'id' | 'startedAt' | 'endedAt' | 'notes'>,
  preservation: LabelPreservationDeps,
  log: FastifyBaseLogger,
  actionNoun: string,
): Promise<string | undefined> {
  try {
    const result = await preserveSessionFeatures(
      {
        id: session.id,
        startedAtMs: new Date(session.startedAt).getTime(),
        endedAtMs: session.endedAt === null ? null : new Date(session.endedAt).getTime(),
        notes: session.notes,
      },
      preservation.trainingStore,
      preservation.config,
    );
    if (result.status === 'preserved' && result.densityCheckSkipped) {
      return "no live feature-row baseline was available to sanity-check this window's density -- preserved as-is, unchecked.";
    }
    return undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, sessionId: session.id }, 'training-set preservation failed');
    return (
      `training-set preservation failed for this ${actionNoun}: ${message} -- the ${actionNoun} was still recorded; ` +
      `re-run \`homecsi label preserve --session ${session.id}\` once the underlying issue is resolved.`
    );
  }
}

/**
 * Ground-truth label sessions/labels: read endpoints plus start/stop/annotate
 * writes, so the recording-controls view can drive labelled recordings that
 * the occupancy timeline later overlays against the predicted estimate.
 */
export function registerLabelRoutes(
  app: FastifyInstance,
  db: HomeCsiDb,
  preservation?: LabelPreservationDeps,
): void {
  app.get('/api/labels/sessions', async (request) => {
    const { limit, open, notesPrefix } = parseOrThrow(sessionsQuerySchema, request.query);
    const sessions = await db.listLabelSessions({ limit, open, notesPrefix });
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

    if (!preservation) {
      return { session };
    }

    // Web-UI session-close hook (docs/architecture.md "Data lifecycle"):
    // mirrors the CLI's `label session stop` (packages/labeling/src/index.ts)
    // so stopping a session from the debug UI also preserves its raw
    // per-link features into `training_features`, not just the CLI path.
    //
    // Failure semantics (see `attemptPreservation`): the session row is
    // already updated above by the time this runs, so a preservation
    // failure (e.g. this window is already partially or fully past the
    // 7-day `features` retention window -- see trainingPreservation.ts)
    // must NOT undo the stop or surface as an opaque 500. This still
    // returns 200 with the stopped session, plus a `preservationWarning`
    // string describing what went wrong when there was one. `homecsi label
    // preserve` is the documented backstop for exactly this situation (see
    // docs/deployment.md "Scheduling the training-set preservation sweep").
    const preservationWarning = await attemptPreservation(session, preservation, request.log, 'session');
    return preservationWarning === undefined ? { session } : { session, preservationWarning };
  });

  app.get('/api/labels/sessions/:sessionId/labels', async (request) => {
    const { sessionId } = parseOrThrow(sessionIdParamsSchema, request.params);
    const { limit } = parseOrThrow(labelsQuerySchema, request.query);
    const labels = await db.listLabels({ sessionId, limit });
    return { labels, limit };
  });

  // Labels across ALL sessions overlapping [from, to) -- lets the dashboard
  // show existing corrections on the timeline without first picking a
  // session. See HomeCsiDb.listLabelsInRange for the overlap predicate.
  app.get('/api/labels', async (request) => {
    const { from, to, limit } = parseOrThrow(labelsRangeQuerySchema, request.query);
    const labels = await db.listLabelsInRange({ from, to, limit });
    return { labels, limit };
  });

  app.post('/api/labels', async (request, reply) => {
    const body = parseOrThrow(createLabelBodySchema, request.body ?? {});
    const label = await db.createLabel({
      sessionId: body.sessionId,
      time: body.time ?? new Date(),
      endTime: body.endTime,
      occupancyCount: body.occupancyCount,
      source: body.source,
      notes: body.notes,
    });
    reply.code(201);
    return { label };
  });

  // Closes a previously-open interval declaration when the operator
  // declares the next state (brief B14's training mode) -- the only field
  // this route ever touches is `end_time`; everything else about a label
  // (time, occupancyCount, source, notes) is immutable once created.
  app.patch('/api/labels/:labelId', async (request, reply) => {
    const { labelId } = parseOrThrow(labelIdParamsSchema, request.params);
    const { endTime } = parseOrThrow(patchLabelBodySchema, request.body ?? {});
    const result = await db.updateLabelEndTime({ id: labelId, endTime });
    if (result.status === 'not-found') {
      reply.code(404);
      return { error: 'label not found' };
    }
    if (result.status === 'invalid-end-time') {
      reply.code(400);
      return { error: 'endTime must be after the label\'s own time' };
    }
    return { label: result.label };
  });

  // The single most important endpoint for the dashboard's feedback loop
  // (docs/roadmap.md "Web dashboard", brief B13): one composite action --
  // create a session, add the interval label, stop the session, attempt
  // preservation. This does NOT run inside a single DB transaction, so a
  // failure between createLabelSession and stopLabelSession can still
  // leave a dangling open "dashboard correction" session behind -- what
  // this collapse into one server call actually buys is eliminating the
  // *client-abandonment* failure mode (a browser tab closing mid-flow used
  // to leave an open session with three separate round-trips; now there is
  // only one). Any session stranded by a genuine mid-request DB failure is
  // still caught: it is just an open session like any other, and the
  // `label preserve` sweep's open-session retention warning
  // (retentionWarning.ts, openSessionRetentionWarnings) surfaces it the
  // same way it surfaces any other session an operator forgot to stop.
  app.post('/api/labels/corrections', async (request, reply) => {
    const body = parseOrThrow(createCorrectionBodySchema, request.body ?? {});

    // A correction whose span alone already exceeds the debug window
    // (config.storage.retention.maxAgeMs) can never have its raw per-link
    // features fully preserved -- part of the window is guaranteed to
    // already be outside `features`' retention by the time this even runs
    // (migration 007). Reject up front, before creating anything, rather
    // than silently accepting a correction preservation can never satisfy.
    if (preservation) {
      const spanMs = body.to.getTime() - body.from.getTime();
      if (spanMs > preservation.maxAgeMs) {
        reply.code(400);
        return {
          error:
            `correction span (${spanMs}ms) exceeds the ${preservation.maxAgeMs}ms debug window ` +
            '(config.storage.retention.maxAgeMs) -- its raw per-link features could never be fully preserved for retraining',
        };
      }
    }

    // One label_session PER CORRECTION, deliberately -- not one
    // long-running "dashboard corrections" session shared by every
    // correction an operator ever makes. This is subtle enough to be worth
    // spelling out rather than trusting a future reader not to "simplify"
    // it away:
    //
    // `preserveSessionFeatures` (trainingPreservation.ts) is keyed on a
    // session's *window* (started_at..ended_at) -- it copies exactly that
    // span's raw per-link features into `training_features`. A
    // per-correction session makes that window exactly the corrected
    // interval, at the moment it was corrected. A single long-running
    // session reused by every correction would instead have a window that
    // grows every time an operator corrects anything, anywhere in history
    // -- eventually spanning the entire 7-day `features` clock -- so every
    // preservation attempt against it would try to (and eventually
    // succeed at) copying ALL of `features` into `training_features`.
    // That is exactly the unbounded "labelled covers practically all of
    // features" ballooning docs/architecture.md and docs/roadmap.md warn
    // about for the always-on weak-label cron -- a per-correction session
    // keeps each preserved window scoped to what was actually corrected.
    //
    // Session notes must never start with WEAK_LABEL_PREFIX
    // (@homecsi/labeling/sessions.js): a weak-flagged session is skipped
    // by `preserveSessionFeatures`, which would silently evaporate this
    // correction's features at the 7-day mark. The fixed literal below
    // obviously doesn't.
    const session = await db.createLabelSession({ startedAt: body.from, notes: 'dashboard correction' });

    const label = await db.createLabel({
      sessionId: session.id,
      time: body.from,
      endTime: body.to,
      occupancyCount: body.occupancyCount,
      source: body.source ?? 'manual',
      notes: body.notes,
    });

    const stoppedSession = await db.stopLabelSession({ id: session.id, endedAt: body.to });
    // Cannot be null here: the session was created a few lines above and
    // nothing else in this handler can have deleted it in between.
    const finalSession = stoppedSession ?? session;

    reply.code(201);

    if (!preservation) {
      return { session: finalSession, label };
    }

    // Same failure semantics as the session-stop route above: a
    // preservation failure must not fail this request or roll back the
    // session/label that were just written.
    const preservationWarning = await attemptPreservation(finalSession, preservation, request.log, 'correction');
    return preservationWarning === undefined
      ? { session: finalSession, label }
      : { session: finalSession, label, preservationWarning };
  });
}
