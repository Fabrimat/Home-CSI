import { describe, expect, it } from 'vitest';
import { configSchema } from './schema.js';

const VALID_PSK = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

/** Every section required by configSchema, minimal but valid, so tests can plug in just the `nodes` list under test. */
function baseConfig(nodes: unknown[]): unknown {
  return {
    server: {
      udp: { host: '0.0.0.0', port: 5566 },
      http: { host: '0.0.0.0', port: 8080 },
      apiToken: '0123456789abcdef',
    },
    database: {
      host: '127.0.0.1',
      port: 5432,
      database: 'homecsi',
      user: 'homecsi',
      password: 'x',
      pool: { min: 1, max: 10 },
    },
    nodes,
    storage: {
      captureDir: './data',
      rotation: { maxBytes: 1000, maxIntervalMs: 1000 },
      retention: { maxAgeMs: 1000, maxTotalBytes: 1000 },
      compression: { enabled: true, afterMs: 1000 },
    },
    features: {
      windowMs: 2000,
      hopMs: 500,
      subcarrierSelection: 'all',
      baselineAdaptationRate: 0.02,
    },
    occupancy: {
      thresholds: { motionOnThreshold: 1, motionOffThreshold: 1 },
      latchDecayHorizonMs: 1000,
      hysteresisMs: 1000,
      multiOccupancy: { crossNodeSimultaneityThresholdMs: 1000 },
    },
    logging: {
      level: 'info',
      file: { path: './log', maxFiles: 1, maxSizeMb: 1 },
    },
  };
}

describe('nodeSchema placement (floor/position)', () => {
  it('validates a node with neither floor nor position -- placement is optional, floor defaults to 0', () => {
    const config = configSchema.parse(baseConfig([{ id: 1, name: 'n1', room: 'kitchen', psk: VALID_PSK }]));
    expect(config.nodes[0]?.floor).toBe(0);
    expect(config.nodes[0]?.position).toBeUndefined();
  });

  it('validates a negative (basement) floor and a relative position, and both reach the parsed node unchanged', () => {
    const config = configSchema.parse(
      baseConfig([
        {
          id: 1,
          name: 'n1',
          room: 'basement',
          psk: VALID_PSK,
          floor: -1,
          position: { x: 1.5, y: -2.25 },
        },
      ]),
    );
    expect(config.nodes[0]?.floor).toBe(-1);
    expect(config.nodes[0]?.position).toEqual({ x: 1.5, y: -2.25 });
  });
});
