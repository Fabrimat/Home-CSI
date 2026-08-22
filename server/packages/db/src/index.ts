export { discoverMigrations, runMigrations } from './migrationRunner.js';
export type { DbExecutor, MigrationFile, RunMigrationsResult } from './migrationRunner.js';

export { createPool, healthCheck } from './pool.js';
export type { DbPool } from './pool.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to this package's migrations/ directory, for CLI/ops use. */
export const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');
