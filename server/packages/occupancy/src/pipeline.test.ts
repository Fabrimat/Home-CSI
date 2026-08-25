import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '@homecsi/config';
import type { DbPool } from '@homecsi/db';
import {
  createPgOccupancySink,
  KEEPALIVE_INTERVAL_MS,
  runOccupancyPipelineCore,
  type FeatureRow,
  type FeatureSource,
  type OccupancyCheckpoint,
  type OccupancySink,
  type OccupancyStateRow,
} from './pipeline.js';
import { INITIAL_LATCH_STATE } from './stateMachine.js';

function configWithNodes(nodeCount: number): Config {
  return {
    server: { udp: { host: '0.0.0.0', port: 1 }, http: { host: '0.0.0.0', port: 2 }, apiToken: 'x'.repeat(16) },
    database: {
      host: 'localhost',
      port: 5432,
      database: 'db',
      user: 'u',
      password: 'p',
      ssl: false,
      pool: { min: 1, max: 1 },
    },
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      id: i + 1,
      name: `node-${i + 1}`,
      room: `room-${i + 1}`,
      psk: Buffer.alloc(32).toString('base64'),
      floor: 0,
    })),
    storage: {
      captureDir: '.',
      rotation: { maxBytes: 1, maxIntervalMs: 1 },
      retention: { maxAgeMs: 1, maxTotalBytes: 1 },
      compression: { enabled: false, afterMs: 1 },
    },
    features: { windowMs: 2000, hopMs: 500, subcarrierSelection: 'all', baselineAdaptationRate: 0.1 },
    occupancy: {
      thresholds: { motionOnThreshold: 3.0, motionOffThreshold: 1.5 },
      latchDecayHorizonMs: 1_800_000,
      hysteresisMs: 30_000,
      multiOccupancy: { crossNodeSimultaneityThresholdMs: 5000 },
    },
    logging: { level: 'info', file: { path: '.', maxFiles: 1, maxSizeMb: 1 } },
  };
}

class FakeFeatureSource implements FeatureSource {
  constructor(private readonly rows: FeatureRow[]) {}
  async fetchFeatures(sinceExclusiveMs: number | null, limit: number): Promise<FeatureRow[]> {
    const filtered = this.rows.filter((r) => sinceExclusiveMs === null || r.timeMs > sinceExclusiveMs);
    return filtered.slice(0, limit);
  }
}

/**
 * In-memory stand-in for the `occupancy_states` + `occupancy_checkpoint`
 * pair. `commit` is deliberately modelled as a real transaction: rows and
 * the checkpoint are applied together or not at all. `failCommit` simulates
 * a process/DB failure *between* the two writes — with a transactional sink
 * that has to leave both untouched.
 */
class FakeOccupancySink implements OccupancySink {
  public rows: OccupancyStateRow[] = [];
  public checkpoint: OccupancyCheckpoint | null = null;
  public commits = 0;
  public failCommit = false;

  async loadCheckpoint(): Promise<OccupancyCheckpoint | null> {
    return this.checkpoint;
  }

  async commit(rows: readonly OccupancyStateRow[], checkpoint: OccupancyCheckpoint): Promise<void> {
    this.commits += 1;
    if (this.failCommit) {
      // BEGIN; INSERT ...; <crash>; ROLLBACK — neither write survives.
      throw new Error('simulated failure between the occupancy_states INSERT and the checkpoint UPDATE');
    }
    this.rows.push(...rows);
    this.checkpoint = checkpoint;
  }
}

function motionRow(timeMs: number, nodeId = 1): FeatureRow {
  return { timeMs, nodeId, linkMac: `aa:aa:aa:aa:aa:0${nodeId}`, baselineDeviation: 5 };
}
function quietRow(timeMs: number, nodeId = 1): FeatureRow {
  return { timeMs, nodeId, linkMac: `aa:aa:aa:aa:aa:0${nodeId}`, baselineDeviation: 0 };
}

/** A checkpoint that says "we already recorded UNOCCUPIED at t=-1" — the steady state a long-running install is in. */
function unoccupiedCheckpoint(): OccupancyCheckpoint {
  return {
    lastTickMs: -1,
    latchState: INITIAL_LATCH_STATE,
    lastWritten: { timeMs: -1, estimate: 0, state: 'UNOCCUPIED' },
  };
}

describe('runOccupancyPipelineCore: transition-only writes', () => {
  it('writes one row on the very first tick, to establish the baseline state', async () => {
    const sink = new FakeOccupancySink();
    const result = await runOccupancyPipelineCore(configWithNodes(2), {
      source: new FakeFeatureSource([motionRow(0)]),
      sink,
    });

    expect(result.transitionsWritten).toBe(1);
    expect(sink.rows[0]!.kind).toBe('transition');
    expect(sink.rows[0]!.estimate).toBe(1);
    expect(sink.rows[0]!.state).toBe('OCCUPIED');
  });

  it('writes NO row for ticks where neither estimate nor state changed', async () => {
    const sink = new FakeOccupancySink();
    sink.checkpoint = unoccupiedCheckpoint();
    const rows: FeatureRow[] = [];
    // 10 minutes of quiet ticks — under the keepalive interval, so nothing at all should be written.
    for (let t = 0; t < 600_000; t += 500) rows.push(quietRow(t));

    const result = await runOccupancyPipelineCore(configWithNodes(2), {
      source: new FakeFeatureSource(rows),
      sink,
    });

    expect(result.ticksProcessed).toBe(rows.length);
    expect(result.transitionsWritten).toBe(0);
    expect(result.keepalivesWritten).toBe(0);
    expect(sink.rows).toEqual([]);
  });

  it('writes exactly N rows for N state changes, with the right estimate/state on each', async () => {
    const sink = new FakeOccupancySink();
    sink.checkpoint = unoccupiedCheckpoint();
    const result = await runOccupancyPipelineCore(configWithNodes(2), {
      source: new FakeFeatureSource([
        quietRow(0), // UNOCCUPIED — unchanged, no row
        motionRow(1_000), // -> OCCUPIED
        quietRow(2_000), // -> DECAYING
        motionRow(3_000), // -> OCCUPIED
      ]),
      sink,
    });

    expect(result.transitionsWritten).toBe(3);
    expect(sink.rows.map((r) => [r.timeMs, r.estimate, r.state])).toEqual([
      [1_000, 1, 'OCCUPIED'],
      [2_000, 1, 'DECAYING'],
      [3_000, 1, 'OCCUPIED'],
    ]);
    expect(sink.rows.every((r) => r.kind === 'transition')).toBe(true);
  });

  it('advances the checkpoint even when it wrote nothing, so the next run does not replay those ticks', async () => {
    const sink = new FakeOccupancySink();
    sink.checkpoint = unoccupiedCheckpoint();
    await runOccupancyPipelineCore(configWithNodes(2), {
      source: new FakeFeatureSource([quietRow(0), quietRow(500)]),
      sink,
    });

    expect(sink.rows).toEqual([]);
    expect(sink.checkpoint?.lastTickMs).toBe(500);
  });
});

describe('runOccupancyPipelineCore: keepalive rows', () => {
  it('emits at most one thin keepalive per keepalive interval of TICK time during a long quiet stretch', async () => {
    const sink = new FakeOccupancySink();
    sink.checkpoint = unoccupiedCheckpoint();
    const rows: FeatureRow[] = [];
    // 45 minutes of quiet, sampled once a minute.
    for (let t = 0; t <= 45 * 60_000; t += 60_000) rows.push(quietRow(t));

    const result = await runOccupancyPipelineCore(configWithNodes(2), {
      source: new FakeFeatureSource(rows),
      sink,
    });

    expect(result.transitionsWritten).toBe(0);
    expect(sink.rows.map((r) => r.timeMs)).toEqual([
      KEEPALIVE_INTERVAL_MS,
      2 * KEEPALIVE_INTERVAL_MS,
      3 * KEEPALIVE_INTERVAL_MS,
    ]);
    expect(sink.rows.every((r) => r.kind === 'keepalive')).toBe(true);
    // Thin: resume reads the checkpoint now, so a keepalive carries no details payload.
    expect(sink.rows.every((r) => r.details === null)).toBe(true);
  });

  it('never emits a keepalive when there were zero feature ticks — a gap must honestly mean "no observations"', async () => {
    const sink = new FakeOccupancySink();
    sink.checkpoint = {
      lastTickMs: 0,
      latchState: INITIAL_LATCH_STATE,
      // Last write is hours old: wall-clock-wise a keepalive would be "due".
      lastWritten: { timeMs: 0, estimate: 0, state: 'UNOCCUPIED' },
    };

    const result = await runOccupancyPipelineCore(configWithNodes(2), {
      source: new FakeFeatureSource([]),
      sink,
    });

    expect(result).toEqual({
      ticksProcessed: 0,
      statesWritten: 0,
      transitionsWritten: 0,
      keepalivesWritten: 0,
    });
    expect(sink.rows).toEqual([]);
    expect(sink.commits).toBe(0);
  });

  it('resets the keepalive clock on a transition (a transition is itself proof of life)', async () => {
    const sink = new FakeOccupancySink();
    sink.checkpoint = unoccupiedCheckpoint();
    const rows: FeatureRow[] = [];
    // Quiet for ten minutes, then sustained motion for another ten.
    for (let t = 0; t <= 20 * 60_000; t += 60_000) {
      rows.push(t < 10 * 60_000 ? quietRow(t) : motionRow(t));
    }

    await runOccupancyPipelineCore(configWithNodes(2), { source: new FakeFeatureSource(rows), sink });

    // Without the reset, a keepalive would have landed at t=15min (one
    // interval after the checkpoint's last write). The t=10min transition is
    // itself proof of life, so the next keepalive is not due until t=25min —
    // past the end of this run.
    expect(sink.rows.map((r) => [r.timeMs, r.kind])).toEqual([[10 * 60_000, 'transition']]);
  });
});

describe('runOccupancyPipelineCore: resumability and duplicate protection', () => {
  it('resumes the latch from the checkpoint, not from the last written row', async () => {
    const sink = new FakeOccupancySink();
    const config = configWithNodes(2);

    await runOccupancyPipelineCore(config, { source: new FakeFeatureSource([motionRow(0)]), sink });
    expect(sink.rows[sink.rows.length - 1]!.estimate).toBe(1);

    // Second run (fresh process): only new, quiet feature rows arrive. The
    // latch must remember it was OCCUPIED and only just went quiet.
    const secondRunRows: FeatureRow[] = [];
    for (let t = 500; t <= 5_000; t += 500) secondRunRows.push(quietRow(t));
    await runOccupancyPipelineCore(config, { source: new FakeFeatureSource(secondRunRows), sink });

    const finalRow = sink.rows[sink.rows.length - 1]!;
    expect(finalRow.estimate).not.toBe(0); // nowhere near the 30-minute decay horizon yet
    expect(finalRow.state).toBe('DECAYING');
  });

  it('produces no duplicate rows when rerun over exactly the same features', async () => {
    const sink = new FakeOccupancySink();
    const config = configWithNodes(2);
    const rows: FeatureRow[] = [motionRow(0), quietRow(500), motionRow(1_000)];

    await runOccupancyPipelineCore(config, { source: new FakeFeatureSource(rows), sink });
    const afterFirst = sink.rows.map((r) => r.timeMs);

    const second = await runOccupancyPipelineCore(config, { source: new FakeFeatureSource(rows), sink });
    expect(second.statesWritten).toBe(0);
    expect(sink.rows.map((r) => r.timeMs)).toEqual(afterFirst);
  });

  it('produces no duplicate transitions when the previous run died between the INSERT and the checkpoint UPDATE', async () => {
    const sink = new FakeOccupancySink();
    const config = configWithNodes(2);
    const rows: FeatureRow[] = [motionRow(0), quietRow(500), motionRow(1_000)];

    sink.failCommit = true;
    await expect(
      runOccupancyPipelineCore(config, { source: new FakeFeatureSource(rows), sink }),
    ).rejects.toThrow(/simulated failure/);
    expect(sink.rows).toEqual([]); // the transaction rolled both writes back
    expect(sink.checkpoint).toBeNull();

    // Rerun after the crash: the same transitions must be written exactly once.
    sink.failCommit = false;
    await runOccupancyPipelineCore(config, { source: new FakeFeatureSource(rows), sink });
    expect(sink.rows.map((r) => r.timeMs)).toEqual([0, 500, 1_000]);

    // And a third run adds nothing.
    await runOccupancyPipelineCore(config, { source: new FakeFeatureSource(rows), sink });
    expect(sink.rows.map((r) => r.timeMs)).toEqual([0, 500, 1_000]);
  });
});

describe('runOccupancyPipelineCore: persisted details', () => {
  it('never persists falsy linkActive entries on a transition row', async () => {
    const sink = new FakeOccupancySink();
    await runOccupancyPipelineCore(configWithNodes(2), {
      source: new FakeFeatureSource([motionRow(0, 1), quietRow(500, 1), quietRow(1_000, 2)]),
      sink,
    });

    for (const row of sink.rows) {
      const linkActive = row.details?.latchState.linkActive ?? {};
      expect(Object.values(linkActive).filter((v) => !v)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------
// The Postgres sink's transactionality, exercised against a fake client.
// This is the guard on the single most important correctness requirement
// here: the occupancy_states INSERT and the occupancy_checkpoint UPDATE
// must be one transaction, or a crash between them reintroduces duplicate
// transitions on the next run.
// ---------------------------------------------------------------------

interface FakeClientOptions {
  failOn?: RegExp;
}

class FakeClient {
  public readonly sql: string[] = [];
  public released = false;
  constructor(private readonly options: FakeClientOptions = {}) {}
  async query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.sql.push(sql.trim().split('\n')[0] ?? sql);
    if (this.options.failOn?.test(sql)) throw new Error('boom');
    return { rows: [] };
  }
  release(): void {
    this.released = true;
  }
}

function poolWithClient(client: FakeClient): DbPool {
  return { connect: async () => client } as unknown as DbPool;
}

const SAMPLE_ROW: OccupancyStateRow = {
  timeMs: 0,
  estimate: 1,
  confidence: 0.8,
  state: 'OCCUPIED',
  kind: 'transition',
  details: {
    latchState: INITIAL_LATCH_STATE,
    activeLinks: [],
    multiOccupancy: { detected: false, links: [] },
    dataSufficiency: 1,
  },
};

const SAMPLE_CHECKPOINT: OccupancyCheckpoint = {
  lastTickMs: 0,
  latchState: INITIAL_LATCH_STATE,
  lastWritten: { timeMs: 0, estimate: 1, state: 'OCCUPIED' },
};

describe('createPgOccupancySink.commit', () => {
  it('wraps the occupancy_states INSERT and the occupancy_checkpoint UPDATE in one transaction', async () => {
    const client = new FakeClient();
    await createPgOccupancySink(poolWithClient(client)).commit([SAMPLE_ROW], SAMPLE_CHECKPOINT);

    expect(client.sql[0]).toBe('BEGIN');
    expect(client.sql[client.sql.length - 1]).toBe('COMMIT');
    expect(client.sql.some((s) => s.startsWith('INSERT INTO occupancy_states'))).toBe(true);
    expect(client.sql.some((s) => s.includes('occupancy_checkpoint'))).toBe(true);
    expect(client.released).toBe(true);
  });

  it('rolls back the inserted rows when the checkpoint write fails', async () => {
    const client = new FakeClient({ failOn: /occupancy_checkpoint/ });

    await expect(
      createPgOccupancySink(poolWithClient(client)).commit([SAMPLE_ROW], SAMPLE_CHECKPOINT),
    ).rejects.toThrow('boom');

    expect(client.sql).toContain('ROLLBACK');
    expect(client.sql).not.toContain('COMMIT');
    expect(client.released).toBe(true);
  });

  it('still advances the checkpoint transactionally when there are no rows to write', async () => {
    const client = new FakeClient();
    await createPgOccupancySink(poolWithClient(client)).commit([], SAMPLE_CHECKPOINT);

    expect(client.sql[0]).toBe('BEGIN');
    expect(client.sql.some((s) => s.startsWith('INSERT INTO occupancy_states'))).toBe(false);
    expect(client.sql.some((s) => s.includes('occupancy_checkpoint'))).toBe(true);
    expect(client.sql[client.sql.length - 1]).toBe('COMMIT');
  });
});

// ---------------------------------------------------------------------
// Optional real-database test, following packages/db's pattern
// (migrationRunner.test.ts): skipped cleanly unless an operator has
// explicitly pointed HOMECSI_TEST_DATABASE_URL at a *disposable*
// Postgres+TimescaleDB instance. Never required for `npm test` to pass.
// This is what actually proves migration 006 applies and that the sink's
// duplicate protection holds against real SQL.
// ---------------------------------------------------------------------
const REAL_DB_URL = process.env.HOMECSI_TEST_DATABASE_URL;

describe.skipIf(!REAL_DB_URL)('occupancy schema + Postgres sink (real database, opt-in)', () => {
  it('applies migration 006 and round-trips a commit without ever duplicating a row', async () => {
    const { default: pg } = await import('pg');
    const { MIGRATIONS_DIR, runMigrations } = await import('@homecsi/db');

    const migrationClient = new pg.Client({ connectionString: REAL_DB_URL });
    await migrationClient.connect();
    try {
      await runMigrations(migrationClient, MIGRATIONS_DIR);
    } finally {
      await migrationClient.end();
    }

    const pool = new pg.Pool({ connectionString: REAL_DB_URL });
    try {
      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'occupancy_checkpoint'`,
      );
      expect(columns.rows.map((r) => r.column_name).sort()).toEqual([
        'last_estimate',
        'last_state',
        'last_tick_ms',
        'last_written_tick_ms',
        'latch_state',
        'singleton',
        'updated_at',
      ]);

      const at = new Date('2001-01-01T00:00:00.000Z');
      await pool.query('DELETE FROM occupancy_states WHERE time = $1', [at]);
      await pool.query('DELETE FROM occupancy_checkpoint');

      const sink = createPgOccupancySink(pool as unknown as DbPool);
      const row: OccupancyStateRow = { ...SAMPLE_ROW, timeMs: at.getTime() };
      const checkpoint: OccupancyCheckpoint = {
        ...SAMPLE_CHECKPOINT,
        lastTickMs: at.getTime(),
        lastWritten: { timeMs: at.getTime(), estimate: 1, state: 'OCCUPIED' },
      };

      await sink.commit([row], checkpoint);
      expect(await sink.loadCheckpoint()).toEqual(checkpoint);

      // Re-committing the same batch (the crash-and-rerun case) must not duplicate.
      await sink.commit([row], checkpoint);
      const count = await pool.query<{ count: string }>(
        'SELECT count(*)::bigint AS count FROM occupancy_states WHERE time = $1',
        [at],
      );
      expect(Number(count.rows[0]?.count)).toBe(1);

      const kind = await pool.query<{ row_kind: string }>(
        'SELECT row_kind FROM occupancy_states WHERE time = $1',
        [at],
      );
      expect(kind.rows[0]?.row_kind).toBe('transition');

      await pool.query('DELETE FROM occupancy_states WHERE time = $1', [at]);
      await pool.query('DELETE FROM occupancy_checkpoint');
    } finally {
      await pool.end();
    }
  });
});

// ---------------------------------------------------------------------
// Migration 006 is this package's schema. It cannot be applied here without
// a live database, but the one thing that goes wrong silently — a bare DDL
// statement that aborts with a raw Postgres error instead of telling the
// operator what the rows are and what to do with them — is checkable from
// the file itself.
// ---------------------------------------------------------------------
describe('migration 006', () => {
  const migrationSql = readFileSync(
    path.resolve(import.meta.dirname, '../../db/migrations/006_occupancy_event_log_and_checkpoint.sql'),
    'utf8',
  );

  it('refuses a non-empty occupancy_states up front, with instructions, instead of failing on the DDL', () => {
    // Pre-006 rows are 500 ms samples, not events: there is no honest
    // row_kind for them, and they may share timestamps.
    expect(migrationSql).toMatch(/SELECT count\(\*\) INTO total_rows FROM occupancy_states/);
    expect(migrationSql).toMatch(/RAISE EXCEPTION 'Migration 006 requires occupancy_states to be empty/);
    expect(migrationSql).toContain('TRUNCATE occupancy_states;');
  });

  it('leaves no bare DDL that could abort with a raw Postgres error', () => {
    // Both of these fail on a non-empty table ("contains null values" /
    // unique violation), so both must be wrapped in the DO ... EXCEPTION
    // convention migrations 003/005/007 use.
    expect(migrationSql).not.toMatch(/^ALTER TABLE occupancy_states ADD COLUMN row_kind/m);
    expect(migrationSql).not.toMatch(/^CREATE UNIQUE INDEX idx_occupancy_states_time/m);
    expect(migrationSql).toMatch(
      /EXECUTE \$sql\$ ALTER TABLE occupancy_states ADD COLUMN row_kind text NOT NULL \$sql\$;[\s\S]*?EXCEPTION WHEN OTHERS THEN\s+RAISE EXCEPTION/,
    );
    expect(migrationSql).toMatch(
      /EXECUTE \$sql\$ CREATE UNIQUE INDEX idx_occupancy_states_time[\s\S]*?EXCEPTION WHEN OTHERS THEN\s+RAISE EXCEPTION/,
    );
  });
});
