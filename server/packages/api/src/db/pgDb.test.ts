import { describe, expect, it } from 'vitest';

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
