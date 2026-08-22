import pg from 'pg';
import type { Config } from '@homecsi/config';

const { Pool } = pg;
export type DbPool = pg.Pool;

/** Builds a `pg.Pool` from the `database` section of the validated Config. */
export function createPool(database: Config['database']): DbPool {
  return new Pool({
    host: database.host,
    port: database.port,
    database: database.database,
    user: database.user,
    password: database.password,
    ssl: database.ssl,
    min: database.pool.min,
    max: database.pool.max,
  });
}

/** Simple liveness check: true if the pool can round-trip a trivial query. */
export async function healthCheck(pool: DbPool): Promise<boolean> {
  try {
    const result = await pool.query('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}
