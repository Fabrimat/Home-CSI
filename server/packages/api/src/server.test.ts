import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './server.js';
import { FakeHomeCsiDb } from './testUtils/fakeDb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_TOKEN = 'a-long-enough-test-token-1234567890';
const NONEXISTENT_ASSETS_DIR = path.join(__dirname, '__no-such-web-assets-dir__');

function makeApp(db = new FakeHomeCsiDb()) {
  return { app: buildApp({ db, apiToken: API_TOKEN, webAssetsDir: NONEXISTENT_ASSETS_DIR }), db };
}

function authHeader(token = API_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

describe('health route (unauthenticated)', () => {
  it('responds 200 without any token when the db is healthy', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', dbReachable: true });
  });

  it('responds 503 without a token when the db is unreachable, but is still not an auth failure', async () => {
    const db = new FakeHomeCsiDb();
    db.healthy = false;
    const { app } = makeApp(db);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
  });
});

describe('bearer auth on every /api/* route', () => {
  const protectedRoutes: Array<{ method: 'GET' | 'POST'; url: string }> = [
    { method: 'GET', url: '/api/status' },
    { method: 'GET', url: '/api/nodes' },
    { method: 'GET', url: '/api/links' },
    { method: 'GET', url: '/api/logs' },
    { method: 'GET', url: '/api/labels/sessions' },
  ];

  for (const route of protectedRoutes) {
    it(`rejects ${route.method} ${route.url} with no Authorization header`, async () => {
      const { app } = makeApp();
      const res = await app.inject({ method: route.method, url: route.url });
      expect(res.statusCode).toBe(401);
    });

    it(`rejects ${route.method} ${route.url} with a well-formed but wrong token`, async () => {
      const { app } = makeApp();
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: authHeader('wrong-token-but-same-ish-length!!'),
      });
      expect(res.statusCode).toBe(401);
    });

    it(`rejects ${route.method} ${route.url} with a token of a different length than expected`, async () => {
      const { app } = makeApp();
      const res = await app.inject({ method: route.method, url: route.url, headers: authHeader('short') });
      expect(res.statusCode).toBe(401);
    });

    it(`rejects ${route.method} ${route.url} with a malformed Authorization header (no Bearer prefix)`, async () => {
      const { app } = makeApp();
      const res = await app.inject({
        method: route.method,
        url: route.url,
        headers: { authorization: API_TOKEN },
      });
      expect(res.statusCode).toBe(401);
    });

    it(`accepts ${route.method} ${route.url} with the correct token`, async () => {
      const { app } = makeApp();
      const res = await app.inject({ method: route.method, url: route.url, headers: authHeader() });
      expect(res.statusCode).toBeLessThan(400);
    });
  }
});

describe('input validation', () => {
  it('rejects /api/csi missing required time-range parameters', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/csi?nodeId=1&srcMac=aa:bb:cc:dd:ee:01&dstMac=aa:bb:cc:dd:ee:02',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid request');
  });

  it('rejects /api/csi with an invalid MAC address', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/csi?nodeId=1&srcMac=not-a-mac&dstMac=aa:bb:cc:dd:ee:02&from=2026-01-01T00:00:00Z&to=2026-01-01T01:00:00Z',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a time range where from is after to', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/occupancy?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('bounded result sets', () => {
  let db: FakeHomeCsiDb;

  beforeEach(() => {
    db = new FakeHomeCsiDb();
  });

  it('never returns more heartbeats than the max limit, even if more exist and a huge limit is requested', async () => {
    for (let i = 0; i < 5000; i++) {
      db.heartbeats.push({
        time: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        nodeId: 1,
        uptimeS: i,
        freeHeapBytes: 100000,
        minFreeHeapBytes: 90000,
        framesCaptured: i,
        framesDropped: 0,
        batchesSent: i,
        sendFailures: 0,
        rssiToAp: -50,
        channel: 6,
        sntpSynced: true,
        fwVersion: '1.0.0',
      });
    }
    const { app } = makeApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/nodes/1/heartbeats?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&limit=999999999',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { heartbeats: unknown[]; limit: number };
    expect(body.limit).toBeLessThan(999999999);
    expect(body.heartbeats.length).toBeLessThanOrEqual(body.limit);
    expect(body.heartbeats.length).toBeLessThan(5000);
  });

  it('never returns more occupancy states than the max limit', async () => {
    for (let i = 0; i < 20000; i++) {
      db.occupancyStates.push({
        time: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        estimate: i % 2,
        confidence: 0.5,
        state: 'unoccupied',
        details: null,
      });
    }
    const { app } = makeApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/occupancy?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&limit=1000000',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { states: unknown[]; limit: number };
    expect(body.limit).toBeLessThanOrEqual(10000);
    expect(body.states.length).toBeLessThanOrEqual(body.limit);
  });

  it('downsamples /api/csi to at most the requested maxPoints', async () => {
    for (let i = 0; i < 1000; i++) {
      db.csiRecords.push({
        nodeId: 1,
        srcMac: 'aa:bb:cc:dd:ee:01',
        dstMac: 'aa:bb:cc:dd:ee:02',
        time: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
        rssi: -40,
        noiseFloor: -90,
        csiFormat: 0,
        amplitudes: [1, 2, 3],
      });
    }
    const { app } = makeApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/csi?nodeId=1&srcMac=aa:bb:cc:dd:ee:01&dstMac=aa:bb:cc:dd:ee:02&from=2026-01-01T00:00:00Z&to=2026-01-01T00:00:01Z&maxPoints=50',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { points: unknown[]; maxPoints: number };
    expect(body.maxPoints).toBe(50);
    expect(body.points.length).toBeLessThanOrEqual(50);
  });

  it('rejects a maxPoints request above the hard cap rather than silently ignoring it', async () => {
    const { app } = makeApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/csi?nodeId=1&srcMac=aa:bb:cc:dd:ee:01&dstMac=aa:bb:cc:dd:ee:02&from=2026-01-01T00:00:00Z&to=2026-01-01T00:00:01Z&maxPoints=999999999',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('time-range parameters are honoured', () => {
  it('excludes heartbeats outside the requested [from, to) window', async () => {
    const db = new FakeHomeCsiDb();
    db.heartbeats.push(
      {
        time: '2025-12-31T23:00:00.000Z',
        nodeId: 1,
        uptimeS: 1,
        freeHeapBytes: 1,
        minFreeHeapBytes: 1,
        framesCaptured: 1,
        framesDropped: 0,
        batchesSent: 1,
        sendFailures: 0,
        rssiToAp: -50,
        channel: 6,
        sntpSynced: true,
        fwVersion: '1.0.0',
      },
      {
        time: '2026-01-01T12:00:00.000Z',
        nodeId: 1,
        uptimeS: 2,
        freeHeapBytes: 1,
        minFreeHeapBytes: 1,
        framesCaptured: 2,
        framesDropped: 0,
        batchesSent: 2,
        sendFailures: 0,
        rssiToAp: -50,
        channel: 6,
        sntpSynced: true,
        fwVersion: '1.0.0',
      },
      {
        time: '2026-01-02T01:00:00.000Z',
        nodeId: 1,
        uptimeS: 3,
        freeHeapBytes: 1,
        minFreeHeapBytes: 1,
        framesCaptured: 3,
        framesDropped: 0,
        batchesSent: 3,
        sendFailures: 0,
        rssiToAp: -50,
        channel: 6,
        sntpSynced: true,
        fwVersion: '1.0.0',
      },
    );
    const { app } = makeApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/nodes/1/heartbeats?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { heartbeats: Array<{ time: string }> };
    expect(body.heartbeats).toHaveLength(1);
    expect(body.heartbeats[0]?.time).toBe('2026-01-01T12:00:00.000Z');
  });
});

describe('occupancy view exposes internal state, not just the estimate', () => {
  it('returns state and confidence alongside the estimate', async () => {
    const db = new FakeHomeCsiDb();
    db.occupancyStates.push({
      time: '2026-01-01T00:00:00.000Z',
      estimate: 1,
      confidence: 0.82,
      state: 'occupied',
      details: { motionLinks: ['aa:bb:cc:dd:ee:01'] },
    });
    const { app } = makeApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/occupancy?from=2025-12-31T00:00:00Z&to=2026-01-02T00:00:00Z',
      headers: authHeader(),
    });
    const body = res.json() as { states: Array<Record<string, unknown>> };
    expect(body.states[0]).toMatchObject({ estimate: 1, confidence: 0.82, state: 'occupied' });
  });
});

describe('label session lifecycle', () => {
  it('starts a session, annotates it, and stops it', async () => {
    const { app } = makeApp();
    const start = await app.inject({ method: 'POST', url: '/api/labels/sessions', headers: authHeader(), payload: { notes: 'test' } });
    expect(start.statusCode).toBe(201);
    const sessionId = (start.json() as { session: { id: number } }).session.id;

    const label = await app.inject({
      method: 'POST',
      url: '/api/labels',
      headers: authHeader(),
      payload: { sessionId, occupancyCount: 2, time: '2026-01-01T00:00:00Z' },
    });
    expect(label.statusCode).toBe(201);

    const stop = await app.inject({ method: 'POST', url: `/api/labels/sessions/${sessionId}/stop`, headers: authHeader() });
    expect(stop.statusCode).toBe(200);
    expect((stop.json() as { session: { endedAt: string | null } }).session.endedAt).not.toBeNull();
  });

  it('404s stopping a session that does not exist', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/labels/sessions/999/stop', headers: authHeader() });
    expect(res.statusCode).toBe(404);
  });
});
