import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../server.js';
import { FakeHomeCsiDb } from '../testUtils/fakeDb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_TOKEN = 'a-long-enough-test-token-1234567890';
const NONEXISTENT_ASSETS_DIR = path.join(__dirname, '__no-such-web-assets-dir__');

describe('GET /api/nodes', () => {
  it('surfaces floor and position placement additively, alongside the existing fields', async () => {
    const db = new FakeHomeCsiDb();
    db.nodes = [
      {
        id: 1,
        name: 'node-kitchen',
        room: 'kitchen',
        expectedMac: null,
        createdAt: '2026-01-01T00:00:00Z',
        lastHeartbeatAt: null,
        lastCsiRecordAt: null,
        floor: -1,
        position: { x: 1.5, y: 2.25 },
      },
    ];
    const app = buildApp({ db, apiToken: API_TOKEN, webAssetsDir: NONEXISTENT_ASSETS_DIR });

    const res = await app.inject({
      method: 'GET',
      url: '/api/nodes',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { nodes: Array<{ floor: number; position: { x: number; y: number } | null }> };
    expect(body.nodes[0]?.floor).toBe(-1);
    expect(body.nodes[0]?.position).toEqual({ x: 1.5, y: 2.25 });
  });
});
