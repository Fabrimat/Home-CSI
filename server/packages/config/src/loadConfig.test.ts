import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from './loadConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PATH = path.resolve(__dirname, '../config.example.yaml');

function writeTempYaml(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'homecsi-config-test-'));
  const file = path.join(dir, 'config.yaml');
  writeFileSync(file, contents, 'utf8');
  return file;
}

describe('loadConfig', () => {
  it('parses the committed config.example.yaml successfully', () => {
    const config = loadConfig(EXAMPLE_PATH, {});
    expect(config.server.udp.port).toBe(5566);
    expect(config.database.database).toBe('homecsi');
    expect(config.nodes).toHaveLength(2);
    expect(config.nodes[0]?.name).toBe('node-living-room');
    expect(config.storage.retention.maxTotalBytes).toBeGreaterThan(0);
    expect(config.features.subcarrierSelection).toBe('all');
    expect(config.occupancy.multiOccupancy.crossNodeSimultaneityThresholdMs).toBe(5000);
    expect(config.logging.level).toBe('info');
  });

  it('every section named in the brief is present in the example file', () => {
    const raw = readFileSync(EXAMPLE_PATH, 'utf8');
    for (const section of [
      'server:',
      'database:',
      'nodes:',
      'storage:',
      'features:',
      'occupancy:',
      'logging:',
    ]) {
      expect(raw).toContain(section);
    }
  });

  it('applies HOMECSI_* environment overrides on top of the file', () => {
    const config = loadConfig(EXAMPLE_PATH, {
      HOMECSI_SERVER_UDP_PORT: '9999',
      HOMECSI_DATABASE_HOST: 'db.internal',
      HOMECSI_LOGGING_LEVEL: 'debug',
    });
    expect(config.server.udp.port).toBe(9999);
    expect(config.database.host).toBe('db.internal');
    expect(config.logging.level).toBe('debug');
    // Untouched values still come from the file.
    expect(config.server.http.port).toBe(8080);
  });

  it('rejects a config missing a required section with a useful message', () => {
    const file = writeTempYaml(`
server:
  udp:
    host: "0.0.0.0"
    port: 5566
  http:
    host: "0.0.0.0"
    port: 8080
  apiToken: "0123456789abcdef"
`);
    expect(() => loadConfig(file, {})).toThrow(ConfigError);
    try {
      loadConfig(file, {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('database');
    }
  });

  it('rejects an invalid node PSK (not 32 bytes when base64-decoded)', () => {
    const file = writeTempYaml(`
server:
  udp: { host: "0.0.0.0", port: 5566 }
  http: { host: "0.0.0.0", port: 8080 }
  apiToken: "0123456789abcdef"
database:
  host: "127.0.0.1"
  port: 5432
  database: "homecsi"
  user: "homecsi"
  password: "x"
  pool: { min: 1, max: 10 }
nodes:
  - id: 1
    name: "n1"
    room: "r1"
    psk: "dG9vc2hvcnQ="
storage:
  captureDir: "./data"
  rotation: { maxBytes: 1000, maxIntervalMs: 1000 }
  retention: { maxAgeMs: 1000, maxTotalBytes: 1000 }
  compression: { enabled: true, afterMs: 1000 }
features:
  windowMs: 2000
  hopMs: 500
  subcarrierSelection: "all"
  baselineAdaptationRate: 0.02
occupancy:
  thresholds: { motionOnThreshold: 1, motionOffThreshold: 1 }
  latchDecayHorizonMs: 1000
  hysteresisMs: 1000
  multiOccupancy: { crossNodeSimultaneityThresholdMs: 1000 }
logging:
  level: "info"
  file: { path: "./log", maxFiles: 1, maxSizeMb: 1 }
`);
    expect(() => loadConfig(file, {})).toThrow(/psk/);
  });

  it('rejects a nonexistent file with a useful message', () => {
    expect(() => loadConfig('/does/not/exist.yaml', {})).toThrow(ConfigError);
  });
});
