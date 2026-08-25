import type { Config } from '@homecsi/config';

/** Deterministic 32-byte PSK for tests, base64-encoded. */
export function testPsk(seedByte: number): string {
  return Buffer.alloc(32, seedByte).toString('base64');
}

export interface TestNodeSpec {
  id: number;
  name?: string;
  room?: string;
  psk: string;
  expectedMac?: string;
  floor?: number;
  position?: { x: number; y: number };
}

/** Builds a minimal, schema-shaped `Config` for tests without touching `@homecsi/config`'s zod parsing. */
export function makeTestConfig(nodes: TestNodeSpec[]): Config {
  return {
    server: {
      udp: { host: '127.0.0.1', port: 0 },
      http: { host: '127.0.0.1', port: 0 },
      apiToken: 'x'.repeat(16),
    },
    database: {
      host: '127.0.0.1',
      port: 5432,
      database: 'homecsi_test',
      user: 'homecsi',
      password: 'x',
      ssl: false,
      pool: { min: 1, max: 5 },
    },
    nodes: nodes.map((n) => ({
      id: n.id,
      name: n.name ?? `node-${n.id}`,
      room: n.room ?? 'test-room',
      psk: n.psk,
      expectedMac: n.expectedMac,
      floor: n.floor ?? 0,
      position: n.position,
    })),
    storage: {
      captureDir: 'unused-in-engine-tests',
      rotation: { maxBytes: 1_000_000, maxIntervalMs: 3_600_000 },
      retention: { maxAgeMs: 1, maxTotalBytes: 1 },
      compression: { enabled: false, afterMs: 1 },
    },
    features: {
      windowMs: 2000,
      hopMs: 500,
      subcarrierSelection: 'all',
      baselineAdaptationRate: 0.02,
    },
    occupancy: {
      thresholds: { motionOnThreshold: 3, motionOffThreshold: 1.5 },
      latchDecayHorizonMs: 1_800_000,
      hysteresisMs: 30_000,
      multiOccupancy: { crossNodeSimultaneityThresholdMs: 5000 },
    },
    logging: {
      level: 'error',
      file: { path: 'unused.log', maxFiles: 1, maxSizeMb: 1 },
    },
  };
}
