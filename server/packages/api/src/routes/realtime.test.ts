import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DeviceModeStore } from '../realtime/deviceModeStore.js';
import { buildApp } from '../server.js';
import { FakeHomeCsiDb } from '../testUtils/fakeDb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_TOKEN = 'a-long-enough-test-token-1234567890';
const NONEXISTENT_ASSETS_DIR = path.join(__dirname, '..', '__no-such-web-assets-dir__');

function apiAuthHeader() {
  return { authorization: `Bearer ${API_TOKEN}` };
}

function makeApp(deviceModeStore = new DeviceModeStore()) {
  const db = new FakeHomeCsiDb();
  const app = buildApp({ db, apiToken: API_TOKEN, webAssetsDir: NONEXISTENT_ASSETS_DIR, deviceModeStore });
  return { app, deviceModeStore };
}

describe('GET /api/realtime', () => {
  it('requires the dashboard apiToken', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/realtime' });
    expect(res.statusCode).toBe(401);
  });

  it('reports mode "unknown" (never a bare "normal") and knownSinceRestart false before any toggle since restart', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/realtime', headers: apiAuthHeader() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { mode: string; knownSinceRestart: boolean };
    expect(body.knownSinceRestart).toBe(false);
    expect(body.mode).toBe('unknown');
  });

  it('reports the real mode, a hard expiresAt, and per-node poll info once toggled at least once since restart', async () => {
    const { app } = makeApp();
    await app.inject({
      method: 'POST',
      url: '/api/realtime',
      headers: apiAuthHeader(),
      payload: { enabled: true, durationS: 300 },
    });

    const res = await app.inject({ method: 'GET', url: '/api/realtime', headers: apiAuthHeader() });
    const body = res.json() as {
      mode: string;
      knownSinceRestart: boolean;
      expiresAt: string | null;
      nodes: unknown[];
    };
    expect(body.knownSinceRestart).toBe(true);
    expect(body.mode).toBe('realtime');
    expect(body.expiresAt).not.toBeNull();
    expect(body.nodes).toEqual([]); // no node has polled /device/mode yet in this test
  });
});

describe('POST /api/realtime', () => {
  it('rejects a durationS above the configured maximum (3600s default)', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/realtime',
      headers: apiAuthHeader(),
      payload: { enabled: true, durationS: 999_999 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('enables realtime with the default duration (600s) when durationS is omitted', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/realtime',
      headers: apiAuthHeader(),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { mode: string; expiresAt: string | null };
    expect(body.mode).toBe('realtime');
    expect(body.expiresAt).not.toBeNull();
  });

  it('disables realtime, reverting to normal with a null expiresAt', async () => {
    const { app } = makeApp();
    await app.inject({ method: 'POST', url: '/api/realtime', headers: apiAuthHeader(), payload: { enabled: true } });

    const res = await app.inject({
      method: 'POST',
      url: '/api/realtime',
      headers: apiAuthHeader(),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { mode: string; expiresAt: string | null };
    expect(body.mode).toBe('normal');
    expect(body.expiresAt).toBeNull();
  });

  it('requires the dashboard apiToken', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/realtime', payload: { enabled: true } });
    expect(res.statusCode).toBe(401);
  });
});
