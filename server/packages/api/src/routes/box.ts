import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_K,
  DEFAULT_MIN_TAKES_PER_CLASS,
  DEFAULT_MIN_TAKE_RECORDS,
  computeTakeFeatureVector,
  computeTakeWindow,
  isTakeUsable,
  knnLeaveOneOut,
  preserveSessionTake,
  type BoxPreservationConfig,
  type BoxSessionStore,
  type BoxTakeStore,
  type TakeExample,
} from '@homecsi/box';
import { boundedLimit } from '../schemas.js';
import { parseOrThrow } from '../validate.js';

const MAX_BOX_SESSIONS_LIMIT = 5000;
const DEFAULT_BOX_SESSIONS_LIMIT = 100;

/** Bounded by how many takes an operator records by hand (box_sessions/box_take_records carry no retention policy, migration 012) -- not a client-facing page size, just this route's own "scan everything" cap for aggregate endpoints (GET /api/box/summary). */
const SUMMARY_SESSION_SCAN_LIMIT = 100_000;

const createSessionBodySchema = z.object({
  gestureClass: z.string().min(1).max(120),
  geometryNote: z.string().max(2000).optional(),
  notes: z.string().max(2000).optional(),
});

const sessionIdParamsSchema = z.object({ id: z.coerce.number().int().positive() });

const sessionsQuerySchema = z.object({
  limit: boundedLimit(DEFAULT_BOX_SESSIONS_LIMIT, MAX_BOX_SESSIONS_LIMIT),
});

export interface BoxRouteDeps {
  sessionStore: BoxSessionStore;
  takeStore: BoxTakeStore;
  preservation: BoxPreservationConfig;
  /** Minimum usable-takes-per-class for GET /api/box/summary's on-demand training report -- see docs/box-experiment.md. Defaults to DEFAULT_MIN_TAKES_PER_CLASS. */
  minTakesPerClass?: number;
  /** Minimum preserved-record count for a take to count as usable at all -- see @homecsi/box's takeWindow.ts. Defaults to DEFAULT_MIN_TAKE_RECORDS. */
  minTakeRecords?: number;
  /** k for the k-NN classifier backing GET /api/box/summary's on-demand training report. Defaults to DEFAULT_K. */
  k?: number;
}

function serializeSession(
  s: { id: number; startedAtMs: number; endedAtMs: number | null; gestureClass: string; geometryNote: string | null; notes: string | null },
  recordCount: number,
) {
  return {
    id: s.id,
    startedAt: new Date(s.startedAtMs).toISOString(),
    endedAt: s.endedAtMs === null ? null : new Date(s.endedAtMs).toISOString(),
    gestureClass: s.gestureClass,
    geometryNote: s.geometryNote,
    notes: s.notes,
    recordCount,
  };
}

/**
 * The recreational "hand in a closed box" gesture-classification experiment
 * (docs/box-experiment.md): take recording (start/stop/list/delete) and an
 * on-demand honest training report. `@homecsi/box` owns everything below
 * `csi_records`/`nodes.role` -- this route is thin wiring, mirroring
 * `routes/labels.ts`'s stop-time preservation failure semantics exactly
 * (a preservation failure never fails the HTTP request).
 */
export function registerBoxRoutes(app: FastifyInstance, deps: BoxRouteDeps): void {
  const minTakesPerClass = deps.minTakesPerClass ?? DEFAULT_MIN_TAKES_PER_CLASS;
  const minTakeRecords = deps.minTakeRecords ?? DEFAULT_MIN_TAKE_RECORDS;
  const k = deps.k ?? DEFAULT_K;

  app.post('/api/box/sessions', async (request, reply) => {
    const body = parseOrThrow(createSessionBodySchema, request.body ?? {});
    const session = await deps.sessionStore.createSession({
      startedAtMs: Date.now(),
      gestureClass: body.gestureClass,
      geometryNote: body.geometryNote ?? null,
      notes: body.notes ?? null,
    });
    reply.code(201);
    return {
      id: session.id,
      startedAt: new Date(session.startedAtMs).toISOString(),
      gestureClass: session.gestureClass,
      geometryNote: session.geometryNote,
      notes: session.notes,
    };
  });

  app.post('/api/box/sessions/:id/stop', async (request, reply) => {
    const { id } = parseOrThrow(sessionIdParamsSchema, request.params);
    const session = await deps.sessionStore.stopSession(id, Date.now());
    if (!session) {
      reply.code(404);
      return { error: 'box session not found' };
    }

    // Mirrors POST /api/labels/sessions/:sessionId/stop's failure semantics
    // exactly (routes/labels.ts): a preservation failure never fails this
    // request -- the take was still recorded, so this stays 200 with a
    // preservationWarning describing what went wrong. A PARTIAL node
    // dropout (some, not all, registered box nodes reported -- see
    // preserveSessionTake's nodeDropoutWarning) is surfaced the same way:
    // still a successful stop, just with a warning naming both counts.
    let preservationWarning: string | undefined;
    try {
      const outcome = await preserveSessionTake(session, deps.takeStore, deps.preservation);
      if (outcome.status === 'preserved' && outcome.nodeDropoutWarning !== undefined) {
        preservationWarning = outcome.nodeDropoutWarning;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error({ err, sessionId: session.id }, 'box take preservation failed');
      preservationWarning =
        `box take preservation failed for this take: ${message} -- the take was still recorded; ` +
        `re-run \`homecsi box preserve --session ${session.id}\` once the underlying issue is resolved.`;
    }
    const recordCount = await deps.takeStore.countPreserved(session.id);

    return {
      id: session.id,
      startedAt: new Date(session.startedAtMs).toISOString(),
      endedAt: session.endedAtMs === null ? null : new Date(session.endedAtMs).toISOString(),
      gestureClass: session.gestureClass,
      recordCount,
      ...(preservationWarning !== undefined ? { preservationWarning } : {}),
    };
  });

  app.get('/api/box/sessions', async (request) => {
    const { limit } = parseOrThrow(sessionsQuerySchema, request.query);
    const sessions = await deps.sessionStore.listSessions(limit);
    const counts = await deps.takeStore.countPreservedBySession(sessions.map((s) => s.id));
    return { sessions: sessions.map((s) => serializeSession(s, counts.get(s.id) ?? 0)) };
  });

  app.delete('/api/box/sessions/:id', async (request, reply) => {
    const { id } = parseOrThrow(sessionIdParamsSchema, request.params);
    const deleted = await deps.sessionStore.deleteSession(id);
    if (!deleted) {
      return reply.code(404).send({ error: 'box session not found' });
    }
    // No-op when the real Postgres-backed store's ON DELETE CASCADE
    // (migration 012) already removed these -- the in-memory store used by
    // tests has no such cascade, so this is always called explicitly rather
    // than relying on hidden cascade semantics (see BoxTakeStore.deleteForSession's doc comment).
    await deps.takeStore.deleteForSession(id);
    return reply.code(204).send();
  });

  app.get('/api/box/summary', async () => {
    const sessions = await deps.sessionStore.listSessions(SUMMARY_SESSION_SCAN_LIMIT);
    const closed = sessions.filter((s) => s.endedAtMs !== null);
    const counts = await deps.takeStore.countPreservedBySession(closed.map((s) => s.id));

    const classCounts = new Map<string, { takeCount: number; totalRecords: number }>();
    for (const s of closed) {
      const entry = classCounts.get(s.gestureClass) ?? { takeCount: 0, totalRecords: 0 };
      entry.takeCount += 1;
      entry.totalRecords += counts.get(s.id) ?? 0;
      classCounts.set(s.gestureClass, entry);
    }
    const classes = [...classCounts.entries()]
      .map(([gestureClass, v]) => ({ gestureClass, ...v }))
      .sort((a, b) => a.gestureClass.localeCompare(b.gestureClass));

    // "Last training": there is no persisted training-run history (this
    // brief's only new table is box_take_records) -- this always computes a
    // FRESH leave-one-take-out report over whatever is currently preserved
    // and usable, on demand, rather than caching a stale one.
    const examples: TakeExample[] = [];
    for (const s of closed) {
      const recordCount = counts.get(s.id) ?? 0;
      if (!isTakeUsable(recordCount, minTakeRecords)) continue;
      const window = computeTakeWindow(s, deps.preservation.leadInMs, deps.preservation.leadOutMs);
      if (window === null) continue;
      const records = await deps.takeStore.fetchPreserved(s.id);
      const vector = computeTakeFeatureVector(records, window);
      if (vector === null) continue;
      examples.push({ sessionId: s.id, gestureClass: s.gestureClass, vector });
    }

    const report = knnLeaveOneOut(examples, k, minTakesPerClass);
    const lastTraining =
      report.status === 'ok'
        ? {
            at: new Date().toISOString(),
            accuracy: report.accuracy,
            majorityBaseline: report.majorityBaseline,
            randomBaseline: report.randomBaseline,
            confusion: report.confusion,
          }
        : null;

    return { classes, minTakesPerClass, lastTraining };
  });
}
