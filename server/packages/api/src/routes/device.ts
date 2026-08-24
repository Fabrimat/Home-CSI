import { createReadStream, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseOrThrow } from '../validate.js';

/**
 * In-container default firmware/OTA artifact directory (see
 * ops/docker-compose.yml's /data bind mount), used when the whole optional
 * `config.ota` section is omitted (packages/config/src/schema.ts).
 */
export const DEFAULT_OTA_FIRMWARE_DIR = '/data/firmware';

const helloBodySchema = z.object({
  fwVersion: z.string().min(1),
  bootEpoch: z.coerce.number().int().nonnegative(),
  uptimeS: z.coerce.number().nonnegative(),
  otaState: z.string().min(1),
});

const otaManifestSchema = z.object({
  version: z.string().min(1),
  file: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters'),
  rollout: z.union([z.literal('all'), z.array(z.coerce.number().int().min(1).max(65535))]),
});

type OtaManifest = z.infer<typeof otaManifestSchema>;

export interface DeviceHelloRecord {
  nodeId: number;
  fwVersion: string;
  bootEpoch: number;
  uptimeS: number;
  otaState: string;
  /** ISO timestamp this record was last updated, so an operator can tell a live node from a stale one. */
  lastSeenAt: string;
}

/**
 * In-memory-only record of each node's last `POST /device/hello` (pure
 * telemetry, see routes/device.ts's `registerDeviceRoutes` doc comment) --
 * deliberately not persisted. A process restart simply waits for the next
 * hello; that's an acceptable, intended gap, not a bug (see CLAUDE.md:
 * no retention/policy additions belong in the base DB schema for this).
 */
export class DeviceHelloStore {
  private readonly records = new Map<number, DeviceHelloRecord>();

  record(nodeId: number, hello: Omit<DeviceHelloRecord, 'nodeId' | 'lastSeenAt'>): void {
    this.records.set(nodeId, { nodeId, ...hello, lastSeenAt: new Date().toISOString() });
  }

  list(): DeviceHelloRecord[] {
    return [...this.records.values()];
  }
}

/** Reads and validates `<firmwareDir>/manifest.json`. Returns `null` (never throws) if it's absent or malformed -- an operator hasn't staged an update yet, or made a mistake; either way the right response is "nothing to offer", not a crash. */
async function readManifest(
  firmwareDir: string,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<OtaManifest | null> {
  const manifestPath = path.join(firmwareDir, 'manifest.json');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn({ manifestPath }, 'OTA manifest.json is not valid JSON');
    return null;
  }
  const result = otaManifestSchema.safeParse(parsed);
  if (!result.success) {
    log.warn({ manifestPath, issues: result.error.issues }, 'OTA manifest.json failed schema validation');
    return null;
  }
  return result.data;
}

function inRollout(manifest: OtaManifest, nodeId: number): boolean {
  return manifest.rollout === 'all' || manifest.rollout.includes(nodeId);
}

/**
 * Resolves `manifest.file` (operator-written, therefore untrusted) against
 * `firmwareDir`, accepting only a direct child of that directory -- never
 * a `..` escape, an absolute path, or a nested subdirectory path. Returns
 * `null` if the resolved path would not have `firmwareDir` as its exact
 * parent, in which case the caller must treat it as "no image available",
 * not read from the resolved location.
 */
function resolveFirmwareFile(firmwareDir: string, file: string): string | null {
  const firmwareDirResolved = path.resolve(firmwareDir);
  const resolved = path.resolve(firmwareDir, file);
  if (path.dirname(resolved) !== firmwareDirResolved) return null;
  return resolved;
}

/**
 * Device-facing HTTP surface (docs/device-api.md), authenticated by the
 * `/device/*` bearer-token realm set up in server.ts (see deviceAuth.ts) --
 * never the dashboard's `apiToken`.
 *
 * - `POST /device/hello` is pure telemetry: it records the caller's
 *   self-reported firmware/OTA state in memory, keyed by the node id the
 *   auth hook already resolved, and nothing else -- no DB write, no
 *   migration.
 * - `GET /device/ota/manifest` / `GET /device/ota/firmware` serve whatever
 *   `<firmwareDir>/manifest.json` currently describes, filtered ONLY on
 *   `rollout` membership. The server deliberately never compares the
 *   node's running firmware version against the manifest -- it has no
 *   reliable knowledge of that version (in-memory, empty after a restart),
 *   so the node itself decides whether the manifest's version is actually
 *   an upgrade over what it's running and over its known-bad OTA slot.
 * - `GET /api/devices` sits under `/api/`, guarded by the *dashboard*
 *   token hook instead, so an operator can observe a staged rollout.
 */
export function registerDeviceRoutes(
  app: FastifyInstance,
  options: { firmwareDir: string; helloStore: DeviceHelloStore },
): void {
  const { firmwareDir, helloStore } = options;

  app.post('/device/hello', async (request, reply) => {
    const nodeId = request.deviceNodeId;
    if (nodeId === null) return reply.code(401).send({ error: 'unauthorized' });
    const hello = parseOrThrow(helloBodySchema, request.body);
    helloStore.record(nodeId, hello);
    return { ok: true };
  });

  app.get('/device/ota/manifest', async (request, reply) => {
    const nodeId = request.deviceNodeId;
    if (nodeId === null) return reply.code(401).send({ error: 'unauthorized' });

    const manifest = await readManifest(firmwareDir, request.log);
    if (!manifest || !inRollout(manifest, nodeId)) {
      return reply.code(204).send();
    }

    const resolved = resolveFirmwareFile(firmwareDir, manifest.file);
    if (!resolved) {
      request.log.warn({ file: manifest.file, firmwareDir }, 'OTA manifest.file escapes the firmware directory');
      return reply.code(204).send();
    }
    let sizeBytes: number;
    try {
      sizeBytes = statSync(resolved).size;
    } catch {
      return reply.code(204).send();
    }

    return { version: manifest.version, sizeBytes, sha256: manifest.sha256 };
  });

  app.get('/device/ota/firmware', async (request, reply) => {
    const nodeId = request.deviceNodeId;
    if (nodeId === null) return reply.code(401).send({ error: 'unauthorized' });

    const manifest = await readManifest(firmwareDir, request.log);
    if (!manifest || !inRollout(manifest, nodeId)) {
      return reply.code(404).send();
    }

    const resolved = resolveFirmwareFile(firmwareDir, manifest.file);
    if (!resolved) {
      request.log.warn({ file: manifest.file, firmwareDir }, 'OTA manifest.file escapes the firmware directory');
      return reply.code(404).send();
    }
    try {
      statSync(resolved);
    } catch {
      return reply.code(404).send();
    }

    reply.header('content-type', 'application/octet-stream');
    return reply.send(createReadStream(resolved));
  });

  // Dashboard-token-guarded (it lives under /api/, not /device/) -- lets an
  // operator actually observe a staged rollout's progress via hellos.
  app.get('/api/devices', async () => {
    return { devices: helloStore.list() };
  });
}
