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

export interface LabelRow {
  id: number;
  sessionId: number;
  timeMs: number;
  occupancyCount: number;
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
  addLabel(sessionId: number, timeMs: number, occupancyCount: number, notes: string | null): Promise<LabelRow>;
  listLabels(sessionId?: number): Promise<LabelRow[]>;
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
  occupancy_count: number;
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
    occupancyCount: row.occupancy_count,
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

    async addLabel(sessionId, timeMs, occupancyCount, notes) {
      const result = await pool.query<RawLabelRow>(
        `INSERT INTO labels (session_id, time, occupancy_count, notes) VALUES ($1, $2, $3, $4)
         RETURNING id, session_id, time, occupancy_count, notes`,
        [sessionId, new Date(timeMs).toISOString(), occupancyCount, notes],
      );
      return toLabel(result.rows[0] as RawLabelRow);
    },

    async listLabels(sessionId) {
      if (sessionId !== undefined) {
        const result = await pool.query<RawLabelRow>(
          `SELECT id, session_id, time, occupancy_count, notes FROM labels
           WHERE session_id = $1 ORDER BY time ASC`,
          [sessionId],
        );
        return result.rows.map(toLabel);
      }
      const result = await pool.query<RawLabelRow>(
        `SELECT id, session_id, time, occupancy_count, notes FROM labels ORDER BY time ASC`,
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
    async addLabel(sessionId, timeMs, occupancyCount, notes) {
      const label: LabelRow = { id: nextLabelId++, sessionId, timeMs, occupancyCount, notes };
      labels.push(label);
      return label;
    },
    async listLabels(sessionId) {
      const filtered = sessionId === undefined ? labels : labels.filter((l) => l.sessionId === sessionId);
      return [...filtered].sort((a, b) => a.timeMs - b.timeMs);
    },
  };
}
