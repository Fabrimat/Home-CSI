import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Minimal query surface this runner needs — satisfied by `pg.Pool`/`pg.Client` and by test fakes. */
export interface DbExecutor {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface MigrationFile {
  id: number;
  name: string;
  filename: string;
  sql: string;
}

const MIGRATION_FILENAME_RE = /^(\d+)_([a-zA-Z0-9_-]+)\.sql$/;

/**
 * Discovers forward-only, numbered `.sql` migrations in `dir` (filenames
 * like `001_enable_timescaledb.sql`), sorted ascending by their numeric
 * prefix. Throws on a duplicate id or a filename that doesn't match the
 * expected pattern, so a typo fails loudly instead of silently sorting
 * wrong.
 */
export function discoverMigrations(dir: string): MigrationFile[] {
  const entries = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const files: MigrationFile[] = [];
  const seenIds = new Set<number>();

  for (const filename of entries) {
    const match = MIGRATION_FILENAME_RE.exec(filename);
    if (!match) {
      throw new Error(
        `migration filename "${filename}" does not match the required pattern NNN_name.sql`,
      );
    }
    const id = Number(match[1]);
    const name = match[2] as string;
    if (seenIds.has(id)) {
      throw new Error(`duplicate migration id ${id} (from "${filename}")`);
    }
    seenIds.add(id);
    files.push({ id, name, filename, sql: readFileSync(path.join(dir, filename), 'utf8') });
  }

  files.sort((a, b) => a.id - b.id);
  return files;
}

const ENSURE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`;

async function ensureMigrationsTable(executor: DbExecutor): Promise<void> {
  await executor.query(ENSURE_TABLE_SQL);
}

async function getAppliedIds(executor: DbExecutor): Promise<Set<number>> {
  const result = await executor.query('SELECT id FROM schema_migrations');
  return new Set(result.rows.map((row) => Number(row.id)));
}

export interface RunMigrationsResult {
  /** Migrations actually applied during this call (empty if already up to date). */
  applied: MigrationFile[];
}

/**
 * Applies every migration in `dir` whose id has not yet been recorded in
 * `schema_migrations`, in ascending id order, each wrapped in its own
 * transaction. Safe to call repeatedly (idempotent): a second call with
 * nothing new to apply returns `{ applied: [] }` without re-running
 * anything.
 */
export async function runMigrations(
  executor: DbExecutor,
  dir: string,
): Promise<RunMigrationsResult> {
  await ensureMigrationsTable(executor);
  const applied = await getAppliedIds(executor);
  const migrations = discoverMigrations(dir);
  const pending = migrations.filter((m) => !applied.has(m.id));

  const ran: MigrationFile[] = [];
  for (const migration of pending) {
    await executor.query('BEGIN');
    try {
      await executor.query(migration.sql);
      await executor.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [
        migration.id,
        migration.name,
      ]);
      await executor.query('COMMIT');
      ran.push(migration);
    } catch (err) {
      await executor.query('ROLLBACK');
      throw new Error(
        `migration ${migration.filename} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { applied: ran };
}
