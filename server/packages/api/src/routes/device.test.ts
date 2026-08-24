import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DeviceTokenRegistry, deriveDeviceToken } from '../deviceAuth.js';
import { attachLiveAndStatic, buildApp } from '../server.js';
import { FakeHomeCsiDb } from '../testUtils/fakeDb.js';
import { DeviceHelloStore } from './device.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_TOKEN = 'a-long-enough-test-token-1234567890';
const NONEXISTENT_ASSETS_DIR = path.join(__dirname, '..', '__no-such-web-assets-dir__');

const NODE_1_PSK = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const NODE_2_PSK = 'Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=';
const NODE_1_TOKEN = deriveDeviceToken(NODE_1_PSK);
const NODE_2_TOKEN = deriveDeviceToken(NODE_2_PSK);

function deviceAuthHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

function apiAuthHeader() {
  return { authorization: `Bearer ${API_TOKEN}` };
}

/** A firmware directory the test owns for its own lifetime, cleaned up in afterEach. */
function makeFirmwareDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'homecsi-ota-test-'));
}

function makeApp(firmwareDir: string, helloStore = new DeviceHelloStore()) {
  const db = new FakeHomeCsiDb();
  const deviceTokenRegistry = new DeviceTokenRegistry([
    { id: 1, psk: NODE_1_PSK },
    { id: 2, psk: NODE_2_PSK },
  ]);
  const app = buildApp({
    db,
    apiToken: API_TOKEN,
    webAssetsDir: NONEXISTENT_ASSETS_DIR,
    deviceTokenRegistry,
    otaFirmwareDir: firmwareDir,
    deviceHelloStore: helloStore,
  });
  return { app, helloStore };
}

describe('POST /device/hello', () => {
  const firmwareDir = makeFirmwareDir();

  it('records telemetry and returns 200 with a valid device token', async () => {
    const { app, helloStore } = makeApp(firmwareDir);
    const res = await app.inject({
      method: 'POST',
      url: '/device/hello',
      headers: deviceAuthHeader(NODE_1_TOKEN),
      payload: { fwVersion: '0.1.0', bootEpoch: 3, uptimeS: 120, otaState: 'idle' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(helloStore.list()).toHaveLength(1);
    expect(helloStore.list()[0]).toMatchObject({ nodeId: 1, fwVersion: '0.1.0', bootEpoch: 3, otaState: 'idle' });
  });

  it('rejects with 401 when no Authorization header is present', async () => {
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({
      method: 'POST',
      url: '/device/hello',
      payload: { fwVersion: '0.1.0', bootEpoch: 3, uptimeS: 120, otaState: 'idle' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects with 401 when the dashboard apiToken is presented instead of a device token', async () => {
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({
      method: 'POST',
      url: '/device/hello',
      headers: apiAuthHeader(),
      payload: { fwVersion: '0.1.0', bootEpoch: 3, uptimeS: 120, otaState: 'idle' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('auth realm isolation between /api/* and /device/*', () => {
  const firmwareDir = makeFirmwareDir();

  it('a valid device token does not grant access to /api/status', async () => {
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'GET', url: '/api/status', headers: deviceAuthHeader(NODE_1_TOKEN) });
    expect(res.statusCode).toBe(401);
  });

  it('a valid device token does not grant access to /api/nodes', async () => {
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'GET', url: '/api/nodes', headers: deviceAuthHeader(NODE_1_TOKEN) });
    expect(res.statusCode).toBe(401);
  });

  it('the dashboard apiToken does not grant access to /device/ota/manifest', async () => {
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'GET', url: '/device/ota/manifest', headers: apiAuthHeader() });
    expect(res.statusCode).toBe(401);
  });
});

describe('percent-encoded prefix cannot bypass the /device/* auth hook', () => {
  // Same class of bug the /api/* hook had (server.ts): a hook that gates on
  // the raw request.url instead of the matched route sees `/%64evice/hello`
  // ('%64' = 'd') as not starting with `/device/` and skips the check
  // entirely, while the router still decodes and runs the real
  // `/device/hello` handler. Gating on request.routeOptions.url instead
  // fixes this for both realms at once (see server.ts).
  const firmwareDir = makeFirmwareDir();

  it('rejects the percent-encoded prefix with no token', async () => {
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'POST', url: '/%64evice/hello', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the percent-encoded prefix with a valid device token, same as the unencoded path', async () => {
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({
      method: 'POST',
      url: '/%64evice/hello',
      headers: deviceAuthHeader(NODE_1_TOKEN),
      payload: { fwVersion: '0.1.0', bootEpoch: 1, uptimeS: 10, otaState: 'idle' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /device/ota/manifest', () => {
  it('returns 204 when no manifest.json exists', async () => {
    const firmwareDir = makeFirmwareDir();
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'GET', url: '/device/ota/manifest', headers: deviceAuthHeader(NODE_1_TOKEN) });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    rmSync(firmwareDir, { recursive: true, force: true });
  });

  it('returns 204 when the calling node is not in rollout', async () => {
    const firmwareDir = makeFirmwareDir();
    const imageContents = Buffer.from('firmware-bytes-node-not-in-rollout');
    writeFileSync(path.join(firmwareDir, 'image.bin'), imageContents);
    writeFileSync(
      path.join(firmwareDir, 'manifest.json'),
      JSON.stringify({
        version: '0.2.0',
        file: 'image.bin',
        sha256: createHash('sha256').update(imageContents).digest('hex'),
        rollout: [2], // only node 2 -- node 1 is calling below
      }),
    );
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'GET', url: '/device/ota/manifest', headers: deviceAuthHeader(NODE_1_TOKEN) });
    expect(res.statusCode).toBe(204);
    rmSync(firmwareDir, { recursive: true, force: true });
  });

  it('returns 200 with version/sizeBytes/sha256 when rollout is "all"', async () => {
    const firmwareDir = makeFirmwareDir();
    const imageContents = Buffer.from('firmware-image-for-everyone');
    const sha256 = createHash('sha256').update(imageContents).digest('hex');
    writeFileSync(path.join(firmwareDir, 'image.bin'), imageContents);
    writeFileSync(
      path.join(firmwareDir, 'manifest.json'),
      JSON.stringify({ version: '0.2.0', file: 'image.bin', sha256, rollout: 'all' }),
    );
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'GET', url: '/device/ota/manifest', headers: deviceAuthHeader(NODE_1_TOKEN) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: '0.2.0', sizeBytes: imageContents.length, sha256 });
    rmSync(firmwareDir, { recursive: true, force: true });
  });

  it('returns 200 when rollout is an explicit array containing the calling node', async () => {
    const firmwareDir = makeFirmwareDir();
    const imageContents = Buffer.from('staged-image-for-node-2-only');
    const sha256 = createHash('sha256').update(imageContents).digest('hex');
    writeFileSync(path.join(firmwareDir, 'image.bin'), imageContents);
    writeFileSync(
      path.join(firmwareDir, 'manifest.json'),
      JSON.stringify({ version: '0.3.0', file: 'image.bin', sha256, rollout: [2] }),
    );
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'GET', url: '/device/ota/manifest', headers: deviceAuthHeader(NODE_2_TOKEN) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: '0.3.0' });
    rmSync(firmwareDir, { recursive: true, force: true });
  });

  it('never compares the manifest version to a "current" version -- there is no such input to this route at all', async () => {
    // The route takes no fwVersion/current-version parameter whatsoever; a
    // manifest whose version is "older" than anything is still served as
    // long as the node is in rollout, because the server has no opinion on
    // that (docs/device-api.md) -- the node decides.
    const firmwareDir = makeFirmwareDir();
    const imageContents = Buffer.from('a-lower-version-image');
    const sha256 = createHash('sha256').update(imageContents).digest('hex');
    writeFileSync(path.join(firmwareDir, 'image.bin'), imageContents);
    writeFileSync(
      path.join(firmwareDir, 'manifest.json'),
      JSON.stringify({ version: '0.0.1', file: 'image.bin', sha256, rollout: 'all' }),
    );
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'GET', url: '/device/ota/manifest', headers: deviceAuthHeader(NODE_1_TOKEN) });
    expect(res.statusCode).toBe(200);
    rmSync(firmwareDir, { recursive: true, force: true });
  });

  it('returns 204, never 500, for a manifest.json that is not valid JSON', async () => {
    const firmwareDir = makeFirmwareDir();
    writeFileSync(path.join(firmwareDir, 'manifest.json'), '{not valid json');
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'GET', url: '/device/ota/manifest', headers: deviceAuthHeader(NODE_1_TOKEN) });
    expect(res.statusCode).toBe(204);
    rmSync(firmwareDir, { recursive: true, force: true });
  });

  it('returns 204, never 500, for a manifest.json that fails schema validation', async () => {
    const firmwareDir = makeFirmwareDir();
    writeFileSync(path.join(firmwareDir, 'manifest.json'), JSON.stringify({ version: '0.1.0' }));
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'GET', url: '/device/ota/manifest', headers: deviceAuthHeader(NODE_1_TOKEN) });
    expect(res.statusCode).toBe(204);
    rmSync(firmwareDir, { recursive: true, force: true });
  });
});

describe('GET /device/ota/firmware', () => {
  it('streams the image bytes for an in-rollout node', async () => {
    const firmwareDir = makeFirmwareDir();
    const imageContents = Buffer.from('the-actual-firmware-image-bytes');
    const sha256 = createHash('sha256').update(imageContents).digest('hex');
    writeFileSync(path.join(firmwareDir, 'image.bin'), imageContents);
    writeFileSync(
      path.join(firmwareDir, 'manifest.json'),
      JSON.stringify({ version: '0.2.0', file: 'image.bin', sha256, rollout: 'all' }),
    );
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'GET', url: '/device/ota/firmware', headers: deviceAuthHeader(NODE_1_TOKEN) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.rawPayload.equals(imageContents)).toBe(true);
    rmSync(firmwareDir, { recursive: true, force: true });
  });

  it('returns 404, never 500, when manifest.json is not valid JSON', async () => {
    const firmwareDir = makeFirmwareDir();
    writeFileSync(path.join(firmwareDir, 'manifest.json'), '{not valid json');
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'GET', url: '/device/ota/firmware', headers: deviceAuthHeader(NODE_1_TOKEN) });
    expect(res.statusCode).toBe(404);
    rmSync(firmwareDir, { recursive: true, force: true });
  });

  it('returns 404 when the calling node is not in rollout', async () => {
    const firmwareDir = makeFirmwareDir();
    const imageContents = Buffer.from('not-for-node-1');
    writeFileSync(path.join(firmwareDir, 'image.bin'), imageContents);
    writeFileSync(
      path.join(firmwareDir, 'manifest.json'),
      JSON.stringify({
        version: '0.2.0',
        file: 'image.bin',
        sha256: createHash('sha256').update(imageContents).digest('hex'),
        rollout: [2],
      }),
    );
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'GET', url: '/device/ota/firmware', headers: deviceAuthHeader(NODE_1_TOKEN) });
    expect(res.statusCode).toBe(404);
    rmSync(firmwareDir, { recursive: true, force: true });
  });

  it('returns 404 and does not read outside the firmware directory for a "../" path escape', async () => {
    const firmwareDir = makeFirmwareDir();
    const secretDir = mkdtempSync(path.join(tmpdir(), 'homecsi-ota-secret-'));
    const secretContents = Buffer.from('this must never be served');
    writeFileSync(path.join(secretDir, 'secret.bin'), secretContents);
    const escapePath = path.relative(firmwareDir, path.join(secretDir, 'secret.bin'));
    writeFileSync(
      path.join(firmwareDir, 'manifest.json'),
      JSON.stringify({
        version: '0.2.0',
        file: escapePath,
        sha256: createHash('sha256').update(secretContents).digest('hex'),
        rollout: 'all',
      }),
    );
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'GET', url: '/device/ota/firmware', headers: deviceAuthHeader(NODE_1_TOKEN) });
    expect(res.statusCode).toBe(404);
    expect(res.rawPayload.includes(secretContents)).toBe(false);
    rmSync(firmwareDir, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
  });

  it('returns 404 for an absolute-path escape in manifest.file', async () => {
    const firmwareDir = makeFirmwareDir();
    const secretFile = path.join(mkdtempSync(path.join(tmpdir(), 'homecsi-ota-secret-')), 'secret.bin');
    writeFileSync(secretFile, 'must not be served');
    writeFileSync(
      path.join(firmwareDir, 'manifest.json'),
      JSON.stringify({ version: '0.2.0', file: secretFile, sha256: 'a'.repeat(64), rollout: 'all' }),
    );
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'GET', url: '/device/ota/firmware', headers: deviceAuthHeader(NODE_1_TOKEN) });
    expect(res.statusCode).toBe(404);
    rmSync(firmwareDir, { recursive: true, force: true });
  });

  it('returns 404 for a nested-subdirectory path in manifest.file', async () => {
    const firmwareDir = makeFirmwareDir();
    const nestedDir = path.join(firmwareDir, 'nested');
    mkdirSync(nestedDir);
    const nestedImage = Buffer.from('nested-image-must-not-be-served-directly');
    writeFileSync(path.join(nestedDir, 'image.bin'), nestedImage);
    writeFileSync(
      path.join(firmwareDir, 'manifest.json'),
      JSON.stringify({
        version: '0.2.0',
        file: 'nested/image.bin',
        sha256: createHash('sha256').update(nestedImage).digest('hex'),
        rollout: 'all',
      }),
    );
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'GET', url: '/device/ota/firmware', headers: deviceAuthHeader(NODE_1_TOKEN) });
    expect(res.statusCode).toBe(404);
    rmSync(firmwareDir, { recursive: true, force: true });
  });
});

describe('GET /api/devices', () => {
  it('requires the dashboard apiToken, not a device token', async () => {
    const firmwareDir = makeFirmwareDir();
    const { app } = makeApp(firmwareDir);
    const unauth = await app.inject({ method: 'GET', url: '/api/devices' });
    expect(unauth.statusCode).toBe(401);
    const withDeviceToken = await app.inject({ method: 'GET', url: '/api/devices', headers: deviceAuthHeader(NODE_1_TOKEN) });
    expect(withDeviceToken.statusCode).toBe(401);
    rmSync(firmwareDir, { recursive: true, force: true });
  });

  it('rejects a percent-encoded /%61pi/devices with no token (the encoding cannot skip the auth hook)', async () => {
    const firmwareDir = makeFirmwareDir();
    const { app } = makeApp(firmwareDir);
    const res = await app.inject({ method: 'GET', url: '/%61pi/devices' });
    expect(res.statusCode).toBe(401);
    rmSync(firmwareDir, { recursive: true, force: true });
  });

  it('exposes the in-memory hello state recorded via /device/hello', async () => {
    const firmwareDir = makeFirmwareDir();
    const helloStore = new DeviceHelloStore();
    const { app } = makeApp(firmwareDir, helloStore);
    await app.inject({
      method: 'POST',
      url: '/device/hello',
      headers: deviceAuthHeader(NODE_1_TOKEN),
      payload: { fwVersion: '0.1.0', bootEpoch: 1, uptimeS: 10, otaState: 'idle' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/devices', headers: apiAuthHeader() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { devices: Array<{ nodeId: number; fwVersion: string }> };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).toMatchObject({ nodeId: 1, fwVersion: '0.1.0' });
    rmSync(firmwareDir, { recursive: true, force: true });
  });
});

describe('/device/* does not fall through to static asset serving', () => {
  it('an authenticated GET /device/ota/manifest is handled by the device route, not the SPA index, even when static assets exist', async () => {
    const firmwareDir = makeFirmwareDir();
    const webAssetsDir = mkdtempSync(path.join(tmpdir(), 'homecsi-web-assets-test-'));
    writeFileSync(path.join(webAssetsDir, 'index.html'), '<html>dashboard</html>');

    const db = new FakeHomeCsiDb();
    const deviceTokenRegistry = new DeviceTokenRegistry([{ id: 1, psk: NODE_1_PSK }]);
    const app = buildApp({ db, apiToken: API_TOKEN, webAssetsDir, deviceTokenRegistry, otaFirmwareDir: firmwareDir });
    await attachLiveAndStatic(app, { db, apiToken: API_TOKEN, webAssetsDir, deviceTokenRegistry, otaFirmwareDir: firmwareDir });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/device/ota/manifest', headers: deviceAuthHeader(NODE_1_TOKEN) });
    expect(res.statusCode).toBe(204); // our route's "no manifest staged" response, not the SPA's index.html
    expect(res.body).not.toContain('dashboard');

    await app.close();
    rmSync(firmwareDir, { recursive: true, force: true });
    rmSync(webAssetsDir, { recursive: true, force: true });
  });
});
