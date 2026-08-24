import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverMigrations, runMigrations, type DbExecutor } from './migrationRunner.js';

function makeMigrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'homecsi-migrations-test-'));
  for (const [filename, sql] of Object.entries(files)) {
    writeFileSync(path.join(dir, filename), sql, 'utf8');
  }
  return dir;
}

/** In-memory fake standing in for a real Postgres connection. No network, no DB. */
class FakeExecutor implements DbExecutor {
  public readonly calls: string[] = [];
  private appliedIds = new Set<number>();
  private hasTable = false;

  async query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.calls.push(sql.trim().split('\n')[0] ?? sql);

    if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
      this.hasTable = true;
      return { rows: [] };
    }
    if (sql.trim() === 'SELECT id FROM schema_migrations') {
      return { rows: [...this.appliedIds].map((id) => ({ id })) };
    }
    if (sql.startsWith('INSERT INTO schema_migrations')) {
      const [id] = params as [number, string];
      this.appliedIds.add(id);
      return { rows: [] };
    }
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [] };
    }
    // Any other query is treated as "running the migration's own SQL".
    return { rows: [] };
  }
}

describe('discoverMigrations', () => {
  it('sorts by numeric id ascending regardless of filesystem order', () => {
    const dir = makeMigrationsDir({
      '002_second.sql': 'SELECT 2;',
      '001_first.sql': 'SELECT 1;',
      '010_tenth.sql': 'SELECT 10;',
    });
    const migrations = discoverMigrations(dir);
    expect(migrations.map((m) => m.id)).toEqual([1, 2, 10]);
    expect(migrations.map((m) => m.name)).toEqual(['first', 'second', 'tenth']);
  });

  it('throws on a duplicate migration id', () => {
    const dir = makeMigrationsDir({
      '001_first.sql': 'SELECT 1;',
      '001_also_first.sql': 'SELECT 1;',
    });
    expect(() => discoverMigrations(dir)).toThrow(/duplicate migration id/);
  });

  it('throws on a filename that does not match NNN_name.sql', () => {
    const dir = makeMigrationsDir({
      'not-a-migration.sql': 'SELECT 1;',
    });
    expect(() => discoverMigrations(dir)).toThrow(/does not match/);
  });
});

describe('runMigrations (against a fake executor, no live DB)', () => {
  it('applies all pending migrations in order on first run', async () => {
    const dir = makeMigrationsDir({
      '001_first.sql': 'CREATE TABLE a (id int);',
      '002_second.sql': 'CREATE TABLE b (id int);',
    });
    const executor = new FakeExecutor();
    const result = await runMigrations(executor, dir);
    expect(result.applied.map((m) => m.id)).toEqual([1, 2]);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const dir = makeMigrationsDir({
      '001_first.sql': 'CREATE TABLE a (id int);',
      '002_second.sql': 'CREATE TABLE b (id int);',
    });
    const executor = new FakeExecutor();
    await runMigrations(executor, dir);
    const second = await runMigrations(executor, dir);
    expect(second.applied).toEqual([]);
  });

  it('applies only newly added migrations on a later run', async () => {
    const dir = makeMigrationsDir({
      '001_first.sql': 'CREATE TABLE a (id int);',
    });
    const executor = new FakeExecutor();
    await runMigrations(executor, dir);

    writeFileSync(path.join(dir, '002_second.sql'), 'CREATE TABLE b (id int);', 'utf8');
    const second = await runMigrations(executor, dir);
    expect(second.applied.map((m) => m.id)).toEqual([2]);
  });

  it('wraps each migration in BEGIN/COMMIT', async () => {
    const dir = makeMigrationsDir({
      '001_first.sql': 'CREATE TABLE a (id int);',
    });
    const executor = new FakeExecutor();
    await runMigrations(executor, dir);
    expect(executor.calls).toContain('BEGIN');
    expect(executor.calls).toContain('COMMIT');
  });
});

// Optional real-database smoke test. Skipped cleanly unless an operator
// has explicitly pointed HOMECSI_TEST_DATABASE_URL at a disposable
// Postgres+TimescaleDB instance. Never required for `npm test` to pass.
const REAL_DB_URL = process.env.HOMECSI_TEST_DATABASE_URL;

describe.skipIf(!REAL_DB_URL)('runMigrations (real database, opt-in)', () => {
  it('applies every migration in order against a real TimescaleDB instance', async () => {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: REAL_DB_URL });
    await client.connect();
    try {
      const migrationsDir = path.resolve(import.meta.dirname, '../migrations');
      await runMigrations(client, migrationsDir);

      // Assert the end state, not the return value. The previous assertion
      // here (`applied.length` >= 0) was vacuously true, so this test could
      // only ever fail by throwing -- and the whole point of pointing it at a
      // real TimescaleDB is that some migrations are rejected only by the real
      // engine. Migration 004 spent two production deploys discovering that a
      // compression-enabled hypertable refuses both `ADD COLUMN ... NOT NULL`
      // without a default and `ALTER COLUMN ... DROP DEFAULT`; this test had
      // the reach to catch it and nobody had run it.
      const applied = await client.query('SELECT id FROM schema_migrations');
      const appliedIds = new Set(applied.rows.map((row: { id: number }) => Number(row.id)));
      for (const migration of discoverMigrations(migrationsDir)) {
        expect(appliedIds.has(migration.id), `migration ${migration.filename} not applied`).toBe(
          true,
        );
      }
    } finally {
      await client.end();
    }
  });
});
