import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../server.js';
import { FakeHomeCsiDb } from '../testUtils/fakeDb.js';
import { DEFAULT_RETENTION_MAX_AGE_MS } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_TOKEN = 'a-long-enough-test-token-1234567890';
const NONEXISTENT_ASSETS_DIR = path.join(__dirname, '__no-such-web-assets-dir__');

function authHeader(token = API_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

describe('GET /api/config', () => {
  it('falls back to the documented default retention window when no clientConfig is wired (tests without a live config)', async () => {
    const app = buildApp({ db: new FakeHomeCsiDb(), apiToken: API_TOKEN, webAssetsDir: NONEXISTENT_ASSETS_DIR });
    const res = await app.inject({ method: 'GET', url: '/api/config', headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      retentionMaxAgeMs: DEFAULT_RETENTION_MAX_AGE_MS,
      retentionSafetyMarginMs: expect.any(Number),
    });
  });

  it('returns the real wired clientConfig values, not the defaults, when supplied', async () => {
    const app = buildApp({
      db: new FakeHomeCsiDb(),
      apiToken: API_TOKEN,
      webAssetsDir: NONEXISTENT_ASSETS_DIR,
      clientConfig: { retentionMaxAgeMs: 123_456, retentionSafetyMarginMs: 789 },
    });
    const res = await app.inject({ method: 'GET', url: '/api/config', headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ retentionMaxAgeMs: 123_456, retentionSafetyMarginMs: 789 });
  });

  it('requires bearer auth, like every other /api/* route', async () => {
    const app = buildApp({ db: new FakeHomeCsiDb(), apiToken: API_TOKEN, webAssetsDir: NONEXISTENT_ASSETS_DIR });
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(401);
  });
});
