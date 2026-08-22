import { describe, expect, it } from 'vitest';
import { createPgFeaturesReader } from './featuresSource.js';
import { createPgTrainingFeaturesStore } from './trainingPreservation.js';

/**
 * Optional real-database smoke tests for the two DB-touching pieces of
 * this brief (migration 007, docs/architecture.md "Data lifecycle"):
 *   * `createPgFeaturesReader` reading the UNION of `features` and
 *     `training_features` (so `homecsi train` still sees rows for a
 *     session whose `features` rows have already aged out).
 *   * `createPgTrainingFeaturesStore.preserveWindow` being idempotent
 *     against the real `training_features` PK/ON CONFLICT, not just the
 *     in-memory fake used elsewhere (trainingPreservation.test.ts).
 *
 * Skipped cleanly unless an operator has explicitly pointed
 * HOMECSI_TEST_DATABASE_URL at a disposable Postgres+TimescaleDB
 * (Community-features-enabled) instance with migrations 001-007 already
 * applied (or applyable) — see packages/db's migrationRunner.test.ts for
 * the same pattern. Never required for `npm test` to pass.
 */
const REAL_DB_URL = process.env.HOMECSI_TEST_DATABASE_URL;

describe.skipIf(!REAL_DB_URL)('features/training_features (real database, opt-in)', () => {
  it('fetchFeaturesForExport unions features and training_features, and preserveWindow is idempotent', async () => {
    const { default: pg } = await import('pg');
    const { runMigrations, MIGRATIONS_DIR } = await import('@homecsi/db');
    const pool = new pg.Pool({ connectionString: REAL_DB_URL });
    try {
      await runMigrations(pool, MIGRATIONS_DIR);

      const nodeId = 9001;
      await pool.query(
        `INSERT INTO nodes (id, name, room) VALUES ($1, 'test-node', 'test-room')
         ON CONFLICT (id) DO NOTHING`,
        [nodeId],
      );

      const liveTimeMs = Date.now();
      const preservedOnlyTimeMs = liveTimeMs - 1000;
      const linkMac = 'aa:aa:aa:aa:aa:09';
      const vector = JSON.stringify({ baselineDeviation: 1, motionEnergy: 2, temporalCorrelation: 0.5, dopplerProxy: 0.1 });

      // A row that's still live in `features` (not yet retention-dropped)...
      await pool.query(
        `INSERT INTO features (time, node_id, link_mac, window_ms, feature_vector) VALUES ($1, $2, $3, 2000, $4::jsonb)`,
        [new Date(liveTimeMs).toISOString(), nodeId, linkMac, vector],
      );
      // ...and a row that exists ONLY in training_features, simulating a
      // `features` row that has already been dropped by the 7-day
      // retention policy after being preserved.
      await pool.query(
        `INSERT INTO training_features (time, node_id, link_mac, window_ms, feature_vector) VALUES ($1, $2, $3, 2000, $4::jsonb)`,
        [new Date(preservedOnlyTimeMs).toISOString(), nodeId, linkMac, vector],
      );

      const reader = createPgFeaturesReader(pool);
      const rows = await reader.fetchFeaturesForExport(preservedOnlyTimeMs - 500, liveTimeMs + 500);
      const foundTimes = rows.map((r) => r.timeMs).sort((a, b) => a - b);
      expect(foundTimes).toContain(liveTimeMs);
      expect(foundTimes).toContain(preservedOnlyTimeMs);

      // preserveWindow idempotency against the real PK/ON CONFLICT: the
      // live `features` row above should copy once, then no-op.
      const store = createPgTrainingFeaturesStore(pool);
      const first = await store.preserveWindow(liveTimeMs - 500, liveTimeMs + 500);
      const second = await store.preserveWindow(liveTimeMs - 500, liveTimeMs + 500);
      expect(first).toBe(1);
      expect(second).toBe(0);

      // Cleanup so re-running this opt-in test against a persistent DB stays repeatable.
      await pool.query(`DELETE FROM training_features WHERE node_id = $1`, [nodeId]);
      await pool.query(`DELETE FROM features WHERE node_id = $1`, [nodeId]);
      await pool.query(`DELETE FROM nodes WHERE id = $1`, [nodeId]);
    } finally {
      await pool.end();
    }
  });
});
