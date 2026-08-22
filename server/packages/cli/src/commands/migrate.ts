import { loadConfig } from '@homecsi/config';
import { createPool, runMigrations, MIGRATIONS_DIR } from '@homecsi/db';

/**
 * Applies all pending schema_migrations against the configured database.
 * Implemented directly in packages/cli/@homecsi/db (not delegated to a
 * sibling stub) since migrations are this brief's responsibility.
 */
export async function runMigrateCommand(configPath: string): Promise<void> {
  const config = loadConfig(configPath);
  const pool = createPool(config.database);
  try {
    const result = await runMigrations(pool, MIGRATIONS_DIR);
    if (result.applied.length === 0) {
      console.log('Database already up to date, nothing to apply.');
    } else {
      for (const migration of result.applied) {
        console.log(`Applied ${migration.filename}`);
      }
    }
  } finally {
    await pool.end();
  }
}
