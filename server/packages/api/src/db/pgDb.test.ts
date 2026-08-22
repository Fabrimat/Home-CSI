import { describe, expect, it } from 'vitest';
import type { DbPool } from '@homecsi/db';
import { PgHomeCsiDb } from './pgDb.js';

// Optional real-database smoke test, following packages/db's pattern
// (migrationRunner.test.ts): skipped cleanly unless an operator has
// explicitly pointed HOMECSI_TEST_DATABASE_URL at a disposable
// Postgres+TimescaleDB instance with migrations already applied. Never
// required for `npm test` to pass.
const REAL_DB_URL = process.env.HOMECSI_TEST_DATABASE_URL;

describe.skipIf(!REAL_DB_URL)('PgHomeCsiDb (real database, opt-in)', () => {
  it('healthCheck round-trips against a real Postgres instance', async () => {
    const { default: pg } = await import('pg');
    const { PgHomeCsiDb } = await import('./pgDb.js');
    const pool = new pg.Pool({ connectionString: REAL_DB_URL });
    try {
      const db = new PgHomeCsiDb(pool);
      expect(await db.healthCheck()).toBe(true);
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------
// Carry-in semantics for the now-sparse occupancy_states event log, tested
// against a fake pool (no live DB). See listOccupancyStates for why the
// carry-in is a *separate* query rather than a widened range.
// ---------------------------------------------------------------------
class FakePool {
  public readonly queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  constructor(private readonly handler: (sql: string) => Array<Record<string, unknown>>) {}
  async query(sql: string, values: readonly unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.queries.push({ sql, values });
    return { rows: this.handler(sql) };
  }
}

const CARRY_IN_ROW = {
  time: new Date('2026-01-01T00:00:00.000Z'),
  estimate: 1,
  confidence: 0.8,
  state: 'OCCUPIED',
  row_kind: 'transition',
  details: null,
};

describe('PgHomeCsiDb.listOccupancyStates (sparse event log)', () => {
  it('returns the carry-in row, with its real pre-window timestamp, when the window itself holds no events', async () => {
    const pool = new FakePool((sql) => (sql.includes('time <= $1') ? [CARRY_IN_ROW] : []));
    const db = new PgHomeCsiDb(pool as unknown as DbPool);

    const rows = await db.listOccupancyStates({
      from: new Date('2026-01-01T03:00:00.000Z'),
      to: new Date('2026-01-01T04:00:00.000Z'),
      limit: 100,
    });

    expect(rows).toHaveLength(1);
    // Real timestamp, three hours before the window — this is what lets the
    // UI say "occupied since 03:00" instead of rendering "no data".
    expect(rows[0]?.time).toBe('2026-01-01T00:00:00.000Z');
    expect(rows[0]?.state).toBe('OCCUPIED');
    expect(rows[0]?.kind).toBe('transition');
  });

  it('fetches the carry-in with a separate bounded query rather than widening the in-window range', async () => {
    const pool = new FakePool((sql) => (sql.includes('time <= $1') ? [CARRY_IN_ROW] : []));
    const db = new PgHomeCsiDb(pool as unknown as DbPool);
    const from = new Date('2026-01-01T03:00:00.000Z');

    await db.listOccupancyStates({ from, to: new Date('2026-01-01T04:00:00.000Z'), limit: 100 });

    const carryIn = pool.queries.find((q) => q.sql.includes('time <= $1'));
    const inWindow = pool.queries.find((q) => q.sql.includes('time >= $1 AND time < $2'));
    expect(carryIn).toBeDefined();
    expect(carryIn?.sql).toContain('LIMIT 1');
    expect(carryIn?.values).toEqual([from]);
    // The in-window query still starts at `from`: widening it would make the
    // DESC + LIMIT trim the oldest rows, which is exactly the carry-in.
    expect(inWindow?.values?.[0]).toBe(from);
  });

  it('does not duplicate a row that is both the carry-in and inside the window', async () => {
    const inWindow = { ...CARRY_IN_ROW, time: new Date('2026-01-01T03:30:00.000Z') };
    const pool = new FakePool((sql) => (sql.includes('time <= $1') ? [inWindow] : [inWindow]));
    const db = new PgHomeCsiDb(pool as unknown as DbPool);

    const rows = await db.listOccupancyStates({
      from: new Date('2026-01-01T03:00:00.000Z'),
      to: new Date('2026-01-01T04:00:00.000Z'),
      limit: 100,
    });

    expect(rows).toHaveLength(1);
  });

  it('honours `limit` overall, keeping the carry-in and the newest events', async () => {
    const inWindow = [3, 2, 1].map((h) => ({
      ...CARRY_IN_ROW,
      time: new Date(`2026-01-01T0${h + 3}:00:00.000Z`),
    }));
    const pool = new FakePool((sql) => (sql.includes('time <= $1') ? [CARRY_IN_ROW] : inWindow));
    const db = new PgHomeCsiDb(pool as unknown as DbPool);

    const rows = await db.listOccupancyStates({
      from: new Date('2026-01-01T03:00:00.000Z'),
      to: new Date('2026-01-01T08:00:00.000Z'),
      limit: 2,
    });

    expect(rows.map((r) => r.time)).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-01T06:00:00.000Z']);
  });
});

describe('PgHomeCsiDb.getLatestOccupancyState', () => {
  it('returns the most recent row regardless of how old it is (no recency filter)', async () => {
    const pool = new FakePool(() => [CARRY_IN_ROW]);
    const db = new PgHomeCsiDb(pool as unknown as DbPool);

    const row = await db.getLatestOccupancyState();

    expect(row?.time).toBe('2026-01-01T00:00:00.000Z');
    expect(pool.queries[0]?.sql).not.toContain('now()');
  });
});

// ---------------------------------------------------------------------
// listLabelsInRange: overlap predicate, not containment (see the method's
// own comment in pgDb.ts). The point of this suite is the specific case a
// naive "time BETWEEN from AND to" filter would miss: a label that started
// before the window and ends *inside* it.
// ---------------------------------------------------------------------
const LABEL_ROW = {
  id: '1',
  session_id: '1',
  time: new Date('2026-01-01T00:00:00.000Z'),
  end_time: new Date('2026-01-01T02:00:00.000Z'),
  occupancy_count: 1,
  source: 'manual',
  notes: null,
};

describe('PgHomeCsiDb.listLabelsInRange', () => {
  it('returns a label whose interval starts before `from` and ends inside the window (overlap, not containment)', async () => {
    const from = new Date('2026-01-01T01:00:00.000Z');
    const to = new Date('2026-01-01T03:00:00.000Z');
    const pool = new FakePool((sql) => (sql.includes('FROM labels') ? [LABEL_ROW] : []));
    const db = new PgHomeCsiDb(pool as unknown as DbPool);

    const rows = await db.listLabelsInRange({ from, to, limit: 100 });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.time).toBe('2026-01-01T00:00:00.000Z');
    expect(rows[0]?.endTime).toBe('2026-01-01T02:00:00.000Z');

    const query = pool.queries.find((q) => q.sql.includes('FROM labels'));
    expect(query?.sql).toContain('time < $2');
    expect(query?.sql).toContain('end_time IS NULL AND time >= $1');
    expect(query?.sql).toContain('end_time IS NOT NULL AND end_time > $1');
    expect(query?.values).toEqual([from, to, 100]);
  });

  it('maps a point label (end_time null) with its real source and null endTime', async () => {
    const pool = new FakePool(() => [{ ...LABEL_ROW, end_time: null, source: 'weak:phone-presence' }]);
    const db = new PgHomeCsiDb(pool as unknown as DbPool);

    const rows = await db.listLabelsInRange({
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-01-01T03:00:00.000Z'),
      limit: 100,
    });

    expect(rows[0]?.endTime).toBeNull();
    expect(rows[0]?.source).toBe('weak:phone-presence');
  });

  // NOTE: `FakePool` here returns whatever the handler hands back regardless
  // of the actual bound $1/$2/$3 values -- it cannot evaluate the real SQL
  // WHERE clause, only fixture-match on the query text. So the boundary
  // semantics below (end_time is EXCLUSIVE: an interval ending exactly at
  // `from` does NOT overlap, but a point label sitting exactly at `from`
  // DOES) can only be verified where the equivalent filter actually runs in
  // JS against real values -- see testUtils/fakeDb.ts's listLabelsInRange
  // and its exercise via routes/labels.test.ts. This suite instead asserts
  // the SQL text embeds the right (asymmetric) predicate, above.
});

// ---------------------------------------------------------------------
// updateLabelEndTime: fetches the label's current `time` first, so the
// route can tell "no such label" (404) apart from "endTime not after
// time" (400) -- see the method's own comment in pgDb.ts.
// ---------------------------------------------------------------------
describe('PgHomeCsiDb.updateLabelEndTime', () => {
  it('returns not-found when no label has this id', async () => {
    const pool = new FakePool(() => []);
    const db = new PgHomeCsiDb(pool as unknown as DbPool);

    const result = await db.updateLabelEndTime({ id: 999, endTime: new Date('2026-01-01T01:00:00.000Z') });

    expect(result.status).toBe('not-found');
  });

  it('returns invalid-end-time (and never issues the UPDATE) when endTime <= the label\'s own time', async () => {
    const pool = new FakePool((sql) =>
      sql.startsWith('SELECT time FROM labels') ? [{ time: new Date('2026-01-01T01:00:00.000Z') }] : [LABEL_ROW],
    );
    const db = new PgHomeCsiDb(pool as unknown as DbPool);

    const result = await db.updateLabelEndTime({ id: 1, endTime: new Date('2026-01-01T01:00:00.000Z') });

    expect(result.status).toBe('invalid-end-time');
    expect(pool.queries.some((q) => q.sql.startsWith('UPDATE labels'))).toBe(false);
  });

  it('updates end_time and returns the full label when the new endTime is after the label\'s time', async () => {
    const pool = new FakePool((sql) =>
      sql.startsWith('SELECT time FROM labels')
        ? [{ time: new Date('2026-01-01T00:00:00.000Z') }]
        : [{ ...LABEL_ROW, end_time: new Date('2026-01-01T05:00:00.000Z') }],
    );
    const db = new PgHomeCsiDb(pool as unknown as DbPool);

    const result = await db.updateLabelEndTime({ id: 1, endTime: new Date('2026-01-01T05:00:00.000Z') });

    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.label.endTime).toBe('2026-01-01T05:00:00.000Z');
    }
  });
});

describe('PgHomeCsiDb.getStatusSummary', () => {
  it('still reports the latest occupancy however old it is (no recency filter), which is what sparse rows require', async () => {
    const pool = new FakePool((sql) => {
      if (sql.includes('SELECT 1 AS ok')) return [{ ok: 1 }];
      if (sql.includes('FROM occupancy_states')) return [CARRY_IN_ROW];
      return [{ count: '0' }];
    });
    const db = new PgHomeCsiDb(pool as unknown as DbPool);

    const summary = await db.getStatusSummary(60_000);

    expect(summary.latestOccupancy?.time).toBe('2026-01-01T00:00:00.000Z');
    expect(summary.latestOccupancy?.kind).toBe('transition');
    const occupancyQuery = pool.queries.find((q) => q.sql.includes('FROM occupancy_states'));
    expect(occupancyQuery?.sql).not.toContain('now()');
  });
});
