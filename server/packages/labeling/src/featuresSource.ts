import type { DbPool } from '@homecsi/db';
import type { FeatureSampleForExport } from './datasetExport.js';

/**
 * Read-only access to the `features` hypertable for dataset export/`label
 * export`. `@homecsi/features` owns writing this table; this package only
 * ever reads it. Injectable so tests never need a live Postgres (see
 * packages/db's existing pattern).
 */
export interface FeaturesReader {
  fetchFeaturesForExport(fromMs: number, toMs: number): Promise<FeatureSampleForExport[]>;
}

interface RawFeatureRow {
  time: Date;
  node_id: number;
  link_mac: string;
  feature_vector: {
    baselineDeviation?: number;
    motionEnergy?: number;
    temporalCorrelation?: number;
    dopplerProxy?: number;
  };
}

/** Real Postgres-backed FeaturesReader, used by the CLI entry point. */
export function createPgFeaturesReader(pool: DbPool): FeaturesReader {
  return {
    async fetchFeaturesForExport(fromMs, toMs) {
      const result = await pool.query<RawFeatureRow>(
        `SELECT time, node_id, link_mac, feature_vector
         FROM features
         WHERE time >= $1::timestamptz AND time <= $2::timestamptz AND link_mac IS NOT NULL
         ORDER BY time ASC`,
        [new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
      );
      return result.rows.map((r) => ({
        timeMs: r.time.getTime(),
        nodeId: r.node_id,
        linkMac: r.link_mac,
        baselineDeviation: r.feature_vector.baselineDeviation ?? 0,
        motionEnergy: r.feature_vector.motionEnergy ?? 0,
        temporalCorrelation: r.feature_vector.temporalCorrelation ?? 1,
        dopplerProxy: r.feature_vector.dopplerProxy ?? 0,
      }));
    },
  };
}

/** In-memory FeaturesReader, used by tests. */
export function createInMemoryFeaturesReader(rows: readonly FeatureSampleForExport[]): FeaturesReader {
  return {
    async fetchFeaturesForExport(fromMs, toMs) {
      return rows.filter((r) => r.timeMs >= fromMs && r.timeMs <= toMs);
    },
  };
}
