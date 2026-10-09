import type { DbPool } from '@homecsi/db';
import { computeTakeWindow } from './takeWindow.js';
import type { BoxSession } from './sessions.js';

/** One raw CSI record preserved for a take -- everything @homecsi/features' `computeWindowFeature`/`parseCsiAmplitudes` need, plus enough identity to group by link. */
export interface BoxTakeRecord {
  timeMs: number;
  nodeId: number;
  linkMac: string;
  rssi: number;
  csiFormat: number;
  csiData: Buffer;
}

/**
 * Injectable access to the `csi_records` (role='box' nodes only) ->
 * `box_take_records` copy-out (migration 012, docs/box-experiment.md).
 * Mirrors `@homecsi/labeling`'s `TrainingFeaturesStore` discipline closely:
 * count what's currently known for a take's window across BOTH tables
 * (so an already-preserved take whose `csi_records` rows have since aged
 * out of the 7-day debug window still reads as found, not lost), and copy a
 * window out, idempotently.
 */
export interface BoxTakeStore {
  /**
   * Distinct (time, node_id, link_mac) rows for this session's trimmed
   * window, counted across `csi_records` (role='box' nodes only, within
   * [fromMs, toMs)) UNIONed with `box_take_records` (scoped to this
   * session_id) -- NOT `csi_records` alone. See `preserveSessionTake`'s doc
   * comment for why this dedup matters.
   */
  countRows(sessionId: number, fromMs: number, toMs: number): Promise<number>;
  /**
   * Copies `csi_records` rows (role='box' nodes only) within [fromMs, toMs)
   * into `box_take_records` for this session, `ON CONFLICT (session_id,
   * time, node_id, link_mac) DO NOTHING`. Returns the number of rows
   * actually inserted (0 on a fully-duplicate re-run).
   */
  preserveWindow(sessionId: number, fromMs: number, toMs: number): Promise<number>;
  /**
   * Number of currently-registered `role = 'box'` nodes -- the "expected"
   * side of the partial-dropout check in `preserveSessionTake` (a node
   * powered off, a firmware fault, or a UDP loss burst hitting most but not
   * all links during a take is a real, plausible failure mode for this
   * bench rig, distinct from total loss).
   */
  countExpectedBoxNodes(): Promise<number>;
  /**
   * Distinct `node_id`s actually represented in this take's trimmed window,
   * across `csi_records` (role='box' nodes only, within [fromMs, toMs))
   * UNIONed with `box_take_records` (scoped to this session_id) -- same
   * source/dedup as `countRows`, but counting distinct NODES rather than
   * distinct rows, so a node that dropped out entirely (zero rows from it)
   * is visible even when the OTHER nodes' rows keep `countRows` well above
   * zero.
   */
  countDistinctNodesFound(sessionId: number, fromMs: number, toMs: number): Promise<number>;
  /** Count of `box_take_records` rows already preserved for this session -- this is the take's reported `recordCount`. */
  countPreserved(sessionId: number): Promise<number>;
  /** Batch form of `countPreserved`, for listing/summary endpoints that need one count per session without an N+1 query per session. Sessions with zero preserved rows are simply absent from the returned map. */
  countPreservedBySession(sessionIds: readonly number[]): Promise<Map<number, number>>;
  /** All preserved raw records for this session, time-ascending -- the input to feature computation at train time (@homecsi/box's classifier.ts). */
  fetchPreserved(sessionId: number): Promise<BoxTakeRecord[]>;
  /**
   * Deletes all `box_take_records` for a session. The real Postgres-backed
   * store's `box_sessions` deletion already cascades this via `ON DELETE
   * CASCADE` (migration 012), so calling this after `BoxSessionStore.
   * deleteSession` is a harmless no-op there -- but the in-memory store has
   * no such cascade, so callers (the API route, the CLI) always call both
   * explicitly rather than relying on hidden cascade semantics.
   */
  deleteForSession(sessionId: number): Promise<void>;
}

interface RawTakeRecordRow {
  time: Date;
  node_id: number;
  link_mac: string;
  rssi: number;
  csi_format: number;
  csi_data: Buffer;
}

/** Real Postgres-backed BoxTakeStore, used by the CLI/API in production. */
export function createPgBoxTakeStore(pool: DbPool): BoxTakeStore {
  return {
    async countRows(sessionId, fromMs, toMs) {
      const result = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM (
           SELECT cr.time, cr.node_id, cr.src_mac AS link_mac
           FROM csi_records cr
           JOIN nodes n ON n.id = cr.node_id
           WHERE n.role = 'box' AND cr.time >= $1::timestamptz AND cr.time < $2::timestamptz
           UNION
           SELECT time, node_id, link_mac FROM box_take_records WHERE session_id = $3
         ) AS combined`,
        [new Date(fromMs).toISOString(), new Date(toMs).toISOString(), sessionId],
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    async preserveWindow(sessionId, fromMs, toMs) {
      const result = await pool.query(
        `INSERT INTO box_take_records (session_id, time, node_id, link_mac, rssi, csi_format, csi_data)
         SELECT $3, cr.time, cr.node_id, cr.src_mac, cr.rssi, cr.csi_format, cr.csi_data
         FROM csi_records cr
         JOIN nodes n ON n.id = cr.node_id
         WHERE n.role = 'box' AND cr.time >= $1::timestamptz AND cr.time < $2::timestamptz
         ON CONFLICT (session_id, time, node_id, link_mac) DO NOTHING`,
        [new Date(fromMs).toISOString(), new Date(toMs).toISOString(), sessionId],
      );
      return result.rowCount ?? 0;
    },

    async countExpectedBoxNodes() {
      const result = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM nodes WHERE role = 'box'`);
      return Number(result.rows[0]?.count ?? 0);
    },

    async countDistinctNodesFound(sessionId, fromMs, toMs) {
      const result = await pool.query<{ count: string }>(
        `SELECT COUNT(DISTINCT node_id) AS count FROM (
           SELECT cr.node_id
           FROM csi_records cr
           JOIN nodes n ON n.id = cr.node_id
           WHERE n.role = 'box' AND cr.time >= $1::timestamptz AND cr.time < $2::timestamptz
           UNION
           SELECT node_id FROM box_take_records WHERE session_id = $3
         ) AS combined`,
        [new Date(fromMs).toISOString(), new Date(toMs).toISOString(), sessionId],
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    async countPreserved(sessionId) {
      const result = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM box_take_records WHERE session_id = $1`,
        [sessionId],
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    async countPreservedBySession(sessionIds) {
      if (sessionIds.length === 0) return new Map();
      const result = await pool.query<{ session_id: string | number; count: string }>(
        `SELECT session_id, COUNT(*) AS count FROM box_take_records WHERE session_id = ANY($1) GROUP BY session_id`,
        [sessionIds],
      );
      return new Map(result.rows.map((r) => [Number(r.session_id), Number(r.count)]));
    },

    async fetchPreserved(sessionId) {
      const result = await pool.query<RawTakeRecordRow>(
        `SELECT time, node_id, link_mac, rssi, csi_format, csi_data
         FROM box_take_records WHERE session_id = $1 ORDER BY time ASC`,
        [sessionId],
      );
      return result.rows.map((r) => ({
        timeMs: r.time.getTime(),
        nodeId: r.node_id,
        linkMac: r.link_mac,
        rssi: r.rssi,
        csiFormat: r.csi_format,
        csiData: r.csi_data,
      }));
    },

    async deleteForSession(sessionId) {
      await pool.query(`DELETE FROM box_take_records WHERE session_id = $1`, [sessionId]);
    },
  };
}

/**
 * In-memory BoxTakeStore, used by tests. `seedCsiRecords` stands in for
 * whatever is currently live in `csi_records` for role='box' nodes.
 *
 * `expectedBoxNodeCount` stands in for `SELECT COUNT(*) FROM nodes WHERE
 * role = 'box'` -- when omitted, it defaults to the number of DISTINCT
 * `nodeId`s appearing anywhere in `seedCsiRecords`, so a test that doesn't
 * care about partial-dropout detection (the common case: a single-node
 * seed) gets "expected == found" for free and sees no warning. Tests that
 * DO want to exercise dropout pass this explicitly (e.g. 3 registered
 * nodes, but a seed touching only 1 of them).
 */
export function createInMemoryBoxTakeStore(
  seedCsiRecords: readonly BoxTakeRecord[] = [],
  expectedBoxNodeCount?: number,
): BoxTakeStore {
  const preserved = new Map<number, BoxTakeRecord[]>();
  const expectedNodes = expectedBoxNodeCount ?? new Set(seedCsiRecords.map((r) => r.nodeId)).size;

  function key(r: { timeMs: number; nodeId: number; linkMac: string }): string {
    return `${r.timeMs}:${r.nodeId}:${r.linkMac}`;
  }

  return {
    async countRows(sessionId, fromMs, toMs) {
      const keys = new Set<string>();
      for (const r of seedCsiRecords) {
        if (r.timeMs >= fromMs && r.timeMs < toMs) keys.add(key(r));
      }
      for (const r of preserved.get(sessionId) ?? []) keys.add(key(r));
      return keys.size;
    },

    async preserveWindow(sessionId, fromMs, toMs) {
      const existing = preserved.get(sessionId) ?? [];
      const existingKeys = new Set(existing.map(key));
      let inserted = 0;
      for (const r of seedCsiRecords) {
        if (r.timeMs < fromMs || r.timeMs >= toMs) continue;
        const k = key(r);
        if (existingKeys.has(k)) continue;
        existingKeys.add(k);
        existing.push(r);
        inserted++;
      }
      preserved.set(sessionId, existing);
      return inserted;
    },

    async countExpectedBoxNodes() {
      return expectedNodes;
    },

    async countDistinctNodesFound(sessionId, fromMs, toMs) {
      const nodeIds = new Set<number>();
      for (const r of seedCsiRecords) {
        if (r.timeMs >= fromMs && r.timeMs < toMs) nodeIds.add(r.nodeId);
      }
      for (const r of preserved.get(sessionId) ?? []) nodeIds.add(r.nodeId);
      return nodeIds.size;
    },

    async countPreserved(sessionId) {
      return (preserved.get(sessionId) ?? []).length;
    },

    async countPreservedBySession(sessionIds) {
      const out = new Map<number, number>();
      for (const id of sessionIds) {
        const count = preserved.get(id)?.length ?? 0;
        if (count > 0) out.set(id, count);
      }
      return out;
    },

    async fetchPreserved(sessionId) {
      return [...(preserved.get(sessionId) ?? [])].sort((a, b) => a.timeMs - b.timeMs);
    },

    async deleteForSession(sessionId) {
      preserved.delete(sessionId);
    },
  };
}

export interface BoxPreservationConfig {
  leadInMs: number;
  leadOutMs: number;
}

export interface BoxPreserveResult {
  status: 'preserved';
  sessionId: number;
  fromMs: number;
  toMs: number;
  found: number;
  inserted: number;
  /**
   * Present when fewer than every currently-registered `role = 'box'` node
   * reported CSI in this take's trimmed window (a node powered off, a
   * firmware fault, a UDP loss burst hitting most but not all links --
   * see `preserveSessionTake`'s doc comment). Names both counts so this is
   * diagnosable, not vague. Absent (not merely empty-string) when every
   * registered box node reported -- callers should treat its presence, not
   * its truthiness, as the signal.
   */
  nodeDropoutWarning?: string;
}

/** The take is still open (`endedAtMs === null`) -- its window isn't final yet, so preservation is deferred, not attempted. */
export interface BoxSkippedOpenResult {
  status: 'skipped-open';
  sessionId: number;
}

/** The lead-in/lead-out trim consumed the entire hold -- nothing to preserve (see `computeTakeWindow`). */
export interface BoxEmptyWindowResult {
  status: 'empty-window';
  sessionId: number;
}

export type BoxPreserveOutcome = BoxPreserveResult | BoxSkippedOpenResult | BoxEmptyWindowResult;

/**
 * Preserves one box take's raw per-link CSI into `box_take_records`, for
 * future retraining, before the 7-day `csi_records` retention policy
 * (migration 007) drops it. Called from the session-stop hook (CLI and API,
 * the natural moment -- data is guaranteed alive if the take is fresh) and
 * from the `box preserve` CLI sweep backstop for takes the hook missed.
 *
 * Fails loudly (throws) rather than silently under-preserving if the window
 * shows literally ZERO rows anywhere (`csi_records` UNION `box_take_records`)
 * -- a flat "found > 0" floor for TOTAL loss, deliberately simpler than
 * `@homecsi/labeling`'s baseline-relative density check: that check exists
 * because `features` is a continuous always-on stream with a meaningful
 * "recent live density" to compare against, whereas box nodes are silent
 * outside a take (they only bypass the rate ceiling while a `box_sessions`
 * row is open) -- there is no continuous baseline to build a density floor
 * from here, so a flat total-loss floor is the right level of complexity
 * for THAT case, not a simplification that was skipped.
 *
 * That flat floor alone would silently accept PARTIAL under-preservation,
 * though: a take where only one of the box rig's several registered nodes
 * reported CSI still has `found > 0`. This is a real, plausible failure
 * mode for a bench rig (a node powered off, a firmware fault, a UDP loss
 * burst hitting most links but not all) -- so this ALSO compares the number
 * of DISTINCT nodes actually found (`countDistinctNodesFound`) against the
 * number of currently-registered `role = 'box'` nodes
 * (`countExpectedBoxNodes`), which this function already has everything it
 * needs to compute (the store already joins `nodes` and filters
 * `role = 'box'` for `countRows`/`preserveWindow`). Unlike total loss, a
 * partial dropout does NOT throw -- it is a normal, expected occurrence on
 * a bench rig, not a preservation failure -- it is reported via
 * `BoxPreserveResult.nodeDropoutWarning`, naming both counts so it stays
 * diagnosable rather than a vague alarm the operator learns to ignore. The
 * take is still preserved either way.
 *
 * IMPORTANT: `found` (via `BoxTakeStore.countRows`) counts across
 * `csi_records` AND `box_take_records` together, not `csi_records` alone --
 * otherwise a take that was already safely preserved, whose `csi_records`
 * rows have since been legitimately dropped by 7-day retention, would read
 * as `found = 0` and throw here forever on every future sweep run (there
 * would be no way to tell "lost" from "already preserved" apart). The same
 * reasoning applies to `countDistinctNodesFound`.
 */
export async function preserveSessionTake(
  session: Pick<BoxSession, 'id' | 'startedAtMs' | 'endedAtMs'>,
  store: BoxTakeStore,
  config: BoxPreservationConfig,
): Promise<BoxPreserveOutcome> {
  if (session.endedAtMs === null) {
    return { status: 'skipped-open', sessionId: session.id };
  }

  const window = computeTakeWindow(session, config.leadInMs, config.leadOutMs);
  if (window === null) {
    return { status: 'empty-window', sessionId: session.id };
  }

  const found = await store.countRows(session.id, window.fromMs, window.toMs);
  if (found === 0) {
    throw new Error(
      `box take preservation for session #${session.id} (${new Date(window.fromMs).toISOString()} .. ` +
        `${new Date(window.toMs).toISOString()}) found ZERO CSI rows for role='box' nodes in this window ` +
        `(counted across \`csi_records\` AND \`box_take_records\`, so this is not simply "not yet preserved") -- ` +
        `this take's raw CSI is likely permanently lost (past the 7-day \`csi_records\` retention window, ` +
        `migration 007, and never preserved) or the box nodes never captured anything for it.`,
    );
  }

  const inserted = await store.preserveWindow(session.id, window.fromMs, window.toMs);

  const expectedNodes = await store.countExpectedBoxNodes();
  const foundNodes = await store.countDistinctNodesFound(session.id, window.fromMs, window.toMs);
  const nodeDropoutWarning =
    expectedNodes > 0 && foundNodes < expectedNodes
      ? `only ${foundNodes} of ${expectedNodes} registered role='box' node(s) reported CSI for session #${session.id}'s ` +
        `take window (${new Date(window.fromMs).toISOString()} .. ${new Date(window.toMs).toISOString()}) -- ` +
        `likely a node powered off, a firmware fault, or a UDP loss burst during this take, not a lost take. The ` +
        `take was still preserved (${found} row(s)); re-record it if the missing node(s)' vantage point matters ` +
        `for this gesture class.`
      : undefined;

  return {
    status: 'preserved',
    sessionId: session.id,
    fromMs: window.fromMs,
    toMs: window.toMs,
    found,
    inserted,
    ...(nodeDropoutWarning !== undefined ? { nodeDropoutWarning } : {}),
  };
}

export interface BoxSweepErrorResult {
  status: 'error';
  sessionId: number;
  error: string;
}

export type BoxSweepResult = BoxPreserveOutcome | BoxSweepErrorResult;

/**
 * CLI-sweep backstop (`homecsi box preserve`): attempts to preserve every
 * given session's window, independent of whether the session-stop hook
 * already ran for it (idempotent via `ON CONFLICT DO NOTHING`). One
 * session's failure does not stop the others -- errors are collected
 * per-session and reported at the end, mirroring `@homecsi/labeling`'s
 * `sweepPreserveTrainingFeatures`.
 */
export async function sweepPreserveBoxTakes(
  sessions: readonly Pick<BoxSession, 'id' | 'startedAtMs' | 'endedAtMs'>[],
  store: BoxTakeStore,
  config: BoxPreservationConfig,
): Promise<BoxSweepResult[]> {
  const results: BoxSweepResult[] = [];
  for (const session of sessions) {
    try {
      results.push(await preserveSessionTake(session, store, config));
    } catch (err) {
      results.push({ status: 'error', sessionId: session.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
