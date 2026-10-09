import type { DbPool } from '@homecsi/db';

/**
 * One `box_sessions` row -- one TAKE (one hold-to-record of one gesture).
 * Storage: migration 011 (brief B1) -- `id`/`started_at`/`ended_at`/
 * `gesture_class`/`geometry_note`/`notes`, `started_at DEFAULT now()`.
 */
export interface BoxSession {
  id: number;
  startedAtMs: number;
  endedAtMs: number | null;
  gestureClass: string;
  geometryNote: string | null;
  notes: string | null;
}

/**
 * Storage interface for `box_sessions`, injectable so tests never need a
 * live Postgres (see packages/db's existing pattern, mirrored by
 * `@homecsi/labeling`'s `LabelStore`).
 */
export interface BoxSessionStore {
  createSession(input: {
    startedAtMs: number;
    gestureClass: string;
    geometryNote: string | null;
    notes: string | null;
  }): Promise<BoxSession>;
  /**
   * Stops a session by setting `ended_at`, but ONLY if it is not already
   * stopped (`ended_at IS NULL`) -- re-stopping an already-stopped session
   * would move its window's END *after* preservation may already have run
   * against the ORIGINAL window (`preserveSessionTake`, preservation.ts),
   * silently leaving previously-preserved rows outside the new window and
   * corrupting that take's feature vector at train time. An
   * already-stopped session is returned UNCHANGED (its original
   * `endedAtMs`, not re-stamped with the new one) -- kinder than an error
   * for what is most likely a duplicate/retried stop call (only reachable
   * via manual API misuse in the first place), and still lets a caller
   * notice by comparing the returned `endedAtMs` against what it expected.
   * Returns `null` only when no session with this id exists at all.
   */
  stopSession(id: number, endedAtMs: number): Promise<BoxSession | null>;
  /** Newest `started_at` first. */
  listSessions(limit: number): Promise<BoxSession[]>;
  getSession(id: number): Promise<BoxSession | null>;
  /** Returns whether a row actually existed to delete. */
  deleteSession(id: number): Promise<boolean>;
}

interface RawSessionRow {
  id: string | number;
  started_at: Date;
  ended_at: Date | null;
  gesture_class: string;
  geometry_note: string | null;
  notes: string | null;
}

function toSession(row: RawSessionRow): BoxSession {
  return {
    id: Number(row.id),
    startedAtMs: row.started_at.getTime(),
    endedAtMs: row.ended_at ? row.ended_at.getTime() : null,
    gestureClass: row.gesture_class,
    geometryNote: row.geometry_note,
    notes: row.notes,
  };
}

const SELECT_COLUMNS = 'id, started_at, ended_at, gesture_class, geometry_note, notes';

/** Real Postgres-backed BoxSessionStore, used by the CLI/API in production. */
export function createPgBoxSessionStore(pool: DbPool): BoxSessionStore {
  return {
    async createSession({ gestureClass, geometryNote, notes }) {
      const result = await pool.query<RawSessionRow>(
        `INSERT INTO box_sessions (gesture_class, geometry_note, notes) VALUES ($1, $2, $3)
         RETURNING ${SELECT_COLUMNS}`,
        [gestureClass, geometryNote, notes],
      );
      return toSession(result.rows[0] as RawSessionRow);
    },

    async stopSession(id, endedAtMs) {
      // `AND ended_at IS NULL` -- see the interface doc comment: a session
      // already stopped must not be re-stamped with a new ended_at.
      const result = await pool.query<RawSessionRow>(
        `UPDATE box_sessions SET ended_at = $2 WHERE id = $1 AND ended_at IS NULL RETURNING ${SELECT_COLUMNS}`,
        [id, new Date(endedAtMs).toISOString()],
      );
      const row = result.rows[0];
      if (row) return toSession(row);
      // The UPDATE matched nothing -- either no such session, or it exists
      // but was already stopped. Distinguish with a plain SELECT so the
      // former still reads as `null` (404 at the route) and the latter
      // reads as the existing, unchanged session.
      const existing = await pool.query<RawSessionRow>(
        `SELECT ${SELECT_COLUMNS} FROM box_sessions WHERE id = $1`,
        [id],
      );
      const existingRow = existing.rows[0];
      return existingRow ? toSession(existingRow) : null;
    },

    async listSessions(limit) {
      const result = await pool.query<RawSessionRow>(
        `SELECT ${SELECT_COLUMNS} FROM box_sessions ORDER BY started_at DESC LIMIT $1`,
        [limit],
      );
      return result.rows.map(toSession);
    },

    async getSession(id) {
      const result = await pool.query<RawSessionRow>(
        `SELECT ${SELECT_COLUMNS} FROM box_sessions WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row ? toSession(row) : null;
    },

    async deleteSession(id) {
      const result = await pool.query(`DELETE FROM box_sessions WHERE id = $1`, [id]);
      return (result.rowCount ?? 0) > 0;
    },
  };
}

/** In-memory BoxSessionStore, used by tests and available for any caller that wants a DB-free store. */
export function createInMemoryBoxSessionStore(): BoxSessionStore {
  const sessions: BoxSession[] = [];
  let nextId = 1;

  return {
    async createSession({ startedAtMs, gestureClass, geometryNote, notes }) {
      const session: BoxSession = { id: nextId++, startedAtMs, endedAtMs: null, gestureClass, geometryNote, notes };
      sessions.push(session);
      return session;
    },
    async stopSession(id, endedAtMs) {
      const session = sessions.find((s) => s.id === id);
      if (!session) return null;
      // Already stopped -- return UNCHANGED, do not re-stamp (see the
      // interface doc comment for why).
      if (session.endedAtMs === null) session.endedAtMs = endedAtMs;
      return session;
    },
    async listSessions(limit) {
      return [...sessions].sort((a, b) => b.startedAtMs - a.startedAtMs).slice(0, limit);
    },
    async getSession(id) {
      return sessions.find((s) => s.id === id) ?? null;
    },
    async deleteSession(id) {
      const index = sessions.findIndex((s) => s.id === id);
      if (index === -1) return false;
      sessions.splice(index, 1);
      return true;
    },
  };
}
