import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createInMemoryBoxSessionStore, createInMemoryBoxTakeStore, type BoxTakeRecord } from '@homecsi/box';
import { buildApp } from '../server.js';
import { FakeHomeCsiDb } from '../testUtils/fakeDb.js';
import type { BoxRouteDeps } from './box.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_TOKEN = 'a-long-enough-test-token-1234567890';
const NONEXISTENT_ASSETS_DIR = path.join(__dirname, '__no-such-web-assets-dir__');

function authHeader(token = API_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

const LLTF = 0;
function csiData(amplitudes: readonly number[]): Buffer {
  const buf = Buffer.alloc(amplitudes.length * 2);
  amplitudes.forEach((a, i) => {
    buf.writeInt8(a, i * 2);
    buf.writeInt8(0, i * 2 + 1);
  });
  return buf;
}
function record(overrides: Partial<BoxTakeRecord> & { amplitudes?: readonly number[] } = {}): BoxTakeRecord {
  const { amplitudes, ...rest } = overrides;
  return {
    timeMs: 1000,
    nodeId: 1,
    linkMac: 'aa:aa:aa:aa:aa:01',
    rssi: -50,
    csiFormat: LLTF,
    csiData: csiData(amplitudes ?? [10, 20, 30]),
    ...rest,
  };
}

function makeApp(box?: BoxRouteDeps) {
  return { app: buildApp({ db: new FakeHomeCsiDb(), apiToken: API_TOKEN, webAssetsDir: NONEXISTENT_ASSETS_DIR, box }) };
}

describe('POST /api/box/sessions', () => {
  it('creates a session with the given gesture class', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/box/sessions',
      headers: authHeader(),
      payload: { gestureClass: 'fist', geometryNote: 'north wall' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body.gestureClass).toBe('fist');
    expect(body.geometryNote).toBe('north wall');
    expect(body.notes).toBeNull();
    expect(typeof body.startedAt).toBe('string');
  });

  it('rejects a missing gestureClass', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/box/sessions', headers: authHeader(), payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('requires auth', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/box/sessions', payload: { gestureClass: 'fist' } });
    expect(res.statusCode).toBe(401);
  });
});

// The stop route always resolves `endedAt` to the real wall clock (the
// exact API contract takes no `endedAt` override, unlike labels' stop
// route) -- so these tests seed a session that STARTED long in the past
// (via the store directly, bypassing the create-session route) and seed a
// take record at a small, fixed timestamp comfortably inside
// [startedAtMs, realNow) with leadInMs/leadOutMs both 0.
const FAR_PAST_STARTED_AT_MS = 1000;

describe('POST /api/box/sessions/:id/stop', () => {
  it('stops a session and reports its preserved record count', async () => {
    const sessionStore = createInMemoryBoxSessionStore();
    const session = await sessionStore.createSession({
      startedAtMs: FAR_PAST_STARTED_AT_MS,
      gestureClass: 'fist',
      geometryNote: null,
      notes: null,
    });
    const takeStore = createInMemoryBoxTakeStore([record({ timeMs: 5000 })]);
    const box: BoxRouteDeps = { sessionStore, takeStore, preservation: { leadInMs: 0, leadOutMs: 0 } };
    const { app } = makeApp(box);

    const stop = await app.inject({ method: 'POST', url: `/api/box/sessions/${session.id}/stop`, headers: authHeader() });
    expect(stop.statusCode).toBe(200);
    const body = stop.json() as { recordCount: number; endedAt: string; preservationWarning?: string };
    expect(body.recordCount).toBe(1);
    expect(body.endedAt).not.toBeNull();
    expect(body.preservationWarning).toBeUndefined();
  });

  it('reports a preservationWarning (never a failed request) when nothing was captured for this take', async () => {
    const sessionStore = createInMemoryBoxSessionStore();
    const session = await sessionStore.createSession({
      startedAtMs: FAR_PAST_STARTED_AT_MS,
      gestureClass: 'fist',
      geometryNote: null,
      notes: null,
    });
    const takeStore = createInMemoryBoxTakeStore([]); // nothing seeded anywhere
    const box: BoxRouteDeps = { sessionStore, takeStore, preservation: { leadInMs: 0, leadOutMs: 0 } };
    const { app } = makeApp(box);

    const stop = await app.inject({ method: 'POST', url: `/api/box/sessions/${session.id}/stop`, headers: authHeader() });
    expect(stop.statusCode).toBe(200);
    const body = stop.json() as { recordCount: number; preservationWarning?: string };
    expect(body.recordCount).toBe(0);
    expect(body.preservationWarning).toMatch(/box take preservation failed/);
  });

  it('reports a preservationWarning naming both node counts on a partial node dropout, still 200', async () => {
    const sessionStore = createInMemoryBoxSessionStore();
    const session = await sessionStore.createSession({
      startedAtMs: FAR_PAST_STARTED_AT_MS,
      gestureClass: 'fist',
      geometryNote: null,
      notes: null,
    });
    // 2 registered box nodes, but only node 1 reported CSI for this window.
    const takeStore = createInMemoryBoxTakeStore([record({ timeMs: 5000, nodeId: 1 })], 2);
    const box: BoxRouteDeps = { sessionStore, takeStore, preservation: { leadInMs: 0, leadOutMs: 0 } };
    const { app } = makeApp(box);

    const stop = await app.inject({ method: 'POST', url: `/api/box/sessions/${session.id}/stop`, headers: authHeader() });
    expect(stop.statusCode).toBe(200);
    const body = stop.json() as { recordCount: number; preservationWarning?: string };
    expect(body.recordCount).toBe(1); // the take was still preserved
    expect(body.preservationWarning).toMatch(/1 of 2/);
  });

  it('re-stopping an already-stopped session leaves its endedAt/recordCount unchanged (does not re-run against a moved window)', async () => {
    const sessionStore = createInMemoryBoxSessionStore();
    const session = await sessionStore.createSession({
      startedAtMs: FAR_PAST_STARTED_AT_MS,
      gestureClass: 'fist',
      geometryNote: null,
      notes: null,
    });
    const takeStore = createInMemoryBoxTakeStore([record({ timeMs: 5000 })]);
    const box: BoxRouteDeps = { sessionStore, takeStore, preservation: { leadInMs: 0, leadOutMs: 0 } };
    const { app } = makeApp(box);

    const first = await app.inject({ method: 'POST', url: `/api/box/sessions/${session.id}/stop`, headers: authHeader() });
    const firstBody = first.json() as { endedAt: string; recordCount: number };

    const second = await app.inject({ method: 'POST', url: `/api/box/sessions/${session.id}/stop`, headers: authHeader() });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { endedAt: string; recordCount: number };

    expect(secondBody.endedAt).toBe(firstBody.endedAt);
    expect(secondBody.recordCount).toBe(firstBody.recordCount);
  });

  it('404s for a nonexistent session', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/box/sessions/999/stop', headers: authHeader() });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/box/sessions', () => {
  it('lists sessions newest-first with their recordCount', async () => {
    const sessionStore = createInMemoryBoxSessionStore();
    const session = await sessionStore.createSession({
      startedAtMs: FAR_PAST_STARTED_AT_MS,
      gestureClass: 'fist',
      geometryNote: null,
      notes: null,
    });
    const takeStore = createInMemoryBoxTakeStore([record({ timeMs: 5000 })]);
    const box: BoxRouteDeps = { sessionStore, takeStore, preservation: { leadInMs: 0, leadOutMs: 0 } };
    const { app } = makeApp(box);

    await app.inject({ method: 'POST', url: `/api/box/sessions/${session.id}/stop`, headers: authHeader() });

    const list = await app.inject({ method: 'GET', url: '/api/box/sessions', headers: authHeader() });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { sessions: { id: number; recordCount: number }[] };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.recordCount).toBe(1);
  });
});

describe('DELETE /api/box/sessions/:id', () => {
  it('deletes a session and its preserved records', async () => {
    const sessionStore = createInMemoryBoxSessionStore();
    const session = await sessionStore.createSession({
      startedAtMs: FAR_PAST_STARTED_AT_MS,
      gestureClass: 'fist',
      geometryNote: null,
      notes: null,
    });
    const takeStore = createInMemoryBoxTakeStore([record({ timeMs: 5000 })]);
    const box: BoxRouteDeps = { sessionStore, takeStore, preservation: { leadInMs: 0, leadOutMs: 0 } };
    const { app } = makeApp(box);

    await app.inject({ method: 'POST', url: `/api/box/sessions/${session.id}/stop`, headers: authHeader() });
    expect(await takeStore.countPreserved(session.id)).toBe(1);

    const del = await app.inject({ method: 'DELETE', url: `/api/box/sessions/${session.id}`, headers: authHeader() });
    expect(del.statusCode).toBe(204);
    expect(await sessionStore.getSession(session.id)).toBeNull();
    expect(await takeStore.countPreserved(session.id)).toBe(0);
  });

  it('404s for a nonexistent session', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/box/sessions/999', headers: authHeader() });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/box/summary', () => {
  it('reports zero classes and no lastTraining when there are no sessions', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/box/summary', headers: authHeader() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { classes: unknown[]; lastTraining: unknown; minTakesPerClass: number };
    expect(body.classes).toEqual([]);
    expect(body.lastTraining).toBeNull();
    expect(typeof body.minTakesPerClass).toBe('number');
  });

  it('aggregates take/record counts per gesture class', async () => {
    const sessionStore = createInMemoryBoxSessionStore();
    const session = await sessionStore.createSession({
      startedAtMs: FAR_PAST_STARTED_AT_MS,
      gestureClass: 'fist',
      geometryNote: null,
      notes: null,
    });
    const takeStore = createInMemoryBoxTakeStore([record({ timeMs: 5000 })]);
    const box: BoxRouteDeps = { sessionStore, takeStore, preservation: { leadInMs: 0, leadOutMs: 0 } };
    const { app } = makeApp(box);

    await app.inject({ method: 'POST', url: `/api/box/sessions/${session.id}/stop`, headers: authHeader() });

    const summary = await app.inject({ method: 'GET', url: '/api/box/summary', headers: authHeader() });
    const body = summary.json() as { classes: { gestureClass: string; takeCount: number; totalRecords: number }[] };
    expect(body.classes).toEqual([{ gestureClass: 'fist', takeCount: 1, totalRecords: 1 }]);
  });
});
