import type { DbPool } from '@homecsi/db';

/**
 * `labels.notes` prefix marking a row as an *automatically derived* weak
 * label (see presence.ts) rather than a manually entered one.
 *
 * Why encoded in `notes` rather than a dedicated column: `labels` (see
 * packages/db/migrations/002_core_schema.sql) has no `source`/`is_weak`
 * column, and this brief avoids adding a new migration (that's owned by
 * B3's migration sequence — flagged in this brief's final report instead).
 * A short, stable, greppable prefix on the existing free-text `notes`
 * column gets the same "stored distinguishably from manual ones"
 * requirement without a schema change; `isWeakLabel`/`stripWeakPrefix`
 * below are the single place that convention is interpreted.
 */
export const WEAK_LABEL_PREFIX = '[weak:phone-presence]';

/**
 * KNOWN LIMITATION: this is a notes-STRING check, not a provenance check —
 * there is no column recording whether a session/label was actually
 * created by the weak-label code path (presence.ts) versus typed by a
 * human. A manually-created session/label whose notes a human happens to
 * start with `WEAK_LABEL_PREFIX` reads as weak here, same as a real one —
 * in particular, trainingPreservation.ts's manual-only raw per-link
 * preservation would silently skip it. Low probability in practice, but
 * worth knowing before debugging "why didn't my session get preserved".
 */
export function isWeakLabel(notes: string | null): boolean {
  return notes !== null && notes.startsWith(WEAK_LABEL_PREFIX);
}

export function stripWeakPrefix(notes: string | null): string {
  if (notes === null) return '';
  return isWeakLabel(notes) ? notes.slice(WEAK_LABEL_PREFIX.length).trimStart() : notes;
}

/**
 * Marker `label_sessions.notes` value for the single, long-running session
 * that automatic phone-presence weak labels get filed under. Kept separate
 * from user-managed manual sessions (`label session start`/`stop`) — weak
 * labeling runs continuously regardless of whether a human happens to have
 * a manual session open.
 */
export const WEAK_SESSION_NOTES = `${WEAK_LABEL_PREFIX} auto-session`;

export async function findOrCreateWeakSession(store: LabelStore, nowMs: number): Promise<LabelSession> {
  const sessions = await store.listSessions();
  const existing = sessions.find((s) => s.notes === WEAK_SESSION_NOTES && s.endedAtMs === null);
  if (existing) return existing;
  return store.createSession(nowMs, WEAK_SESSION_NOTES);
}

export interface LabelSession {
  id: number;
  startedAtMs: number;
  endedAtMs: number | null;
  notes: string | null;
}

/**
 * Explicit label provenance (migration 008's `labels.source` CHECK
 * constraint admits exactly these four values):
 *  - `manual`: typed by an operator (`label add`, or the dashboard
 *    correction UI before B13 lands).
 *  - `weak:phone-presence`: the always-on presence-probe cron
 *    (presence.ts) -- coarse, best-effort, never raw-per-link preserved
 *    (see trainingPreservation.ts).
 *  - `confirmed`: an operator explicitly agreeing the system's own
 *    estimate was right for a stretch (as opposed to correcting it).
 *  - `training`: produced by the guided walk-the-house cold-start flow
 *    (docs/roadmap.md "Training mode for cold-start bootstrap", brief B14).
 *
 * This is the new, authoritative way to ask "how was this label
 * produced" -- `WEAK_LABEL_PREFIX`/`isWeakLabel` above remain a
 * notes-string convention kept for backward compatibility (existing
 * readers of `notes`), not replaced by this column.
 */
export type LabelSource = 'manual' | 'weak:phone-presence' | 'confirmed' | 'training';

export interface LabelRow {
  id: number;
  sessionId: number;
  timeMs: number;
  /** EXCLUSIVE end of the labelled interval, or `null` for a point label (migration 008). */
  endTimeMs: number | null;
  occupancyCount: number;
  source: LabelSource;
  notes: string | null;
}

/**
 * Storage interface for label_sessions/labels, injectable so tests never
 * need a live Postgres (see packages/db's existing pattern).
 */
export interface LabelStore {
  createSession(startedAtMs: number, notes: string | null): Promise<LabelSession>;
  stopSession(sessionId: number, endedAtMs: number): Promise<LabelSession>;
  listSessions(): Promise<LabelSession[]>;
  /** Most recently started session with no `ended_at` yet, if any. */
  getOpenSession(): Promise<LabelSession | null>;
  /**
   * `endTimeMs`/`source` are optional and default to `null` (point label)
   * and `'manual'` respectively, matching pre-migration-008 behaviour for
   * every existing call site that doesn't pass them.
   */
  addLabel(
    sessionId: number,
    timeMs: number,
    occupancyCount: number,
    notes: string | null,
    endTimeMs?: number | null,
    source?: LabelSource,
  ): Promise<LabelRow>;
  listLabels(sessionId?: number): Promise<LabelRow[]>;
  /** Sets (or replaces) a label's interval end -- used to close a previously-open declaration when the next state is declared (brief B14's training mode). */
  setLabelEndTime(labelId: number, endTimeMs: number): Promise<LabelRow>;
}

interface RawSessionRow {
  id: string | number;
  started_at: Date;
  ended_at: Date | null;
  notes: string | null;
}

interface RawLabelRow {
  id: string | number;
  session_id: string | number;
  time: Date;
  end_time: Date | null;
  occupancy_count: number;
  source: string;
  notes: string | null;
}

function toSession(row: RawSessionRow): LabelSession {
  return {
    id: Number(row.id),
    startedAtMs: row.started_at.getTime(),
    endedAtMs: row.ended_at ? row.ended_at.getTime() : null,
    notes: row.notes,
  };
}

function toLabel(row: RawLabelRow): LabelRow {
  return {
    id: Number(row.id),
    sessionId: Number(row.session_id),
    timeMs: row.time.getTime(),
    endTimeMs: row.end_time ? row.end_time.getTime() : null,
    occupancyCount: row.occupancy_count,
    // CHECK-constrained to LabelSource's union by migration 008.
    source: row.source as LabelSource,
    notes: row.notes,
  };
}

/** Real Postgres-backed LabelStore, used by the CLI entry point. */
export function createPgLabelStore(pool: DbPool): LabelStore {
  return {
    async createSession(startedAtMs, notes) {
      const result = await pool.query<RawSessionRow>(
        `INSERT INTO label_sessions (started_at, notes) VALUES ($1, $2)
         RETURNING id, started_at, ended_at, notes`,
        [new Date(startedAtMs).toISOString(), notes],
      );
      return toSession(result.rows[0] as RawSessionRow);
    },

    async stopSession(sessionId, endedAtMs) {
      const result = await pool.query<RawSessionRow>(
        `UPDATE label_sessions SET ended_at = $2 WHERE id = $1
         RETURNING id, started_at, ended_at, notes`,
        [sessionId, new Date(endedAtMs).toISOString()],
      );
      const row = result.rows[0];
      if (!row) throw new Error(`no label_session with id ${sessionId}`);
      return toSession(row);
    },

    async listSessions() {
      const result = await pool.query<RawSessionRow>(
        `SELECT id, started_at, ended_at, notes FROM label_sessions ORDER BY started_at ASC`,
      );
      return result.rows.map(toSession);
    },

    async getOpenSession() {
      const result = await pool.query<RawSessionRow>(
        `SELECT id, started_at, ended_at, notes FROM label_sessions
         WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      );
      const row = result.rows[0];
      return row ? toSession(row) : null;
    },

    async addLabel(sessionId, timeMs, occupancyCount, notes, endTimeMs = null, source = 'manual') {
      const result = await pool.query<RawLabelRow>(
        `INSERT INTO labels (session_id, time, end_time, occupancy_count, source, notes) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, session_id, time, end_time, occupancy_count, source, notes`,
        [
          sessionId,
          new Date(timeMs).toISOString(),
          endTimeMs === null || endTimeMs === undefined ? null : new Date(endTimeMs).toISOString(),
          occupancyCount,
          source,
          notes,
        ],
      );
      return toLabel(result.rows[0] as RawLabelRow);
    },

    async setLabelEndTime(labelId, endTimeMs) {
      const result = await pool.query<RawLabelRow>(
        `UPDATE labels SET end_time = $2 WHERE id = $1
         RETURNING id, session_id, time, end_time, occupancy_count, source, notes`,
        [labelId, new Date(endTimeMs).toISOString()],
      );
      const row = result.rows[0];
      if (!row) throw new Error(`no label with id ${labelId}`);
      return toLabel(row);
    },

    async listLabels(sessionId) {
      if (sessionId !== undefined) {
        const result = await pool.query<RawLabelRow>(
          `SELECT id, session_id, time, end_time, occupancy_count, source, notes FROM labels
           WHERE session_id = $1 ORDER BY time ASC`,
          [sessionId],
        );
        return result.rows.map(toLabel);
      }
      const result = await pool.query<RawLabelRow>(
        `SELECT id, session_id, time, end_time, occupancy_count, source, notes FROM labels ORDER BY time ASC`,
      );
      return result.rows.map(toLabel);
    },
  };
}

/** In-memory LabelStore, used by tests and available for any caller that wants a DB-free store. */
export function createInMemoryLabelStore(): LabelStore {
  const sessions: LabelSession[] = [];
  const labels: LabelRow[] = [];
  let nextSessionId = 1;
  let nextLabelId = 1;

  return {
    async createSession(startedAtMs, notes) {
      const session: LabelSession = { id: nextSessionId++, startedAtMs, endedAtMs: null, notes };
      sessions.push(session);
      return session;
    },
    async stopSession(sessionId, endedAtMs) {
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) throw new Error(`no label_session with id ${sessionId}`);
      session.endedAtMs = endedAtMs;
      return session;
    },
    async listSessions() {
      return [...sessions].sort((a, b) => a.startedAtMs - b.startedAtMs);
    },
    async getOpenSession() {
      const open = sessions.filter((s) => s.endedAtMs === null);
      if (open.length === 0) return null;
      return open.reduce((a, b) => (b.startedAtMs > a.startedAtMs ? b : a));
    },
    async addLabel(sessionId, timeMs, occupancyCount, notes, endTimeMs = null, source = 'manual') {
      const label: LabelRow = {
        id: nextLabelId++,
        sessionId,
        timeMs,
        endTimeMs: endTimeMs ?? null,
        occupancyCount,
        source,
        notes,
      };
      labels.push(label);
      return label;
    },
    async setLabelEndTime(labelId, endTimeMs) {
      const label = labels.find((l) => l.id === labelId);
      if (!label) throw new Error(`no label with id ${labelId}`);
      label.endTimeMs = endTimeMs;
      return label;
    },
    async listLabels(sessionId) {
      const filtered = sessionId === undefined ? labels : labels.filter((l) => l.sessionId === sessionId);
      return [...filtered].sort((a, b) => a.timeMs - b.timeMs);
    },
  };
}
