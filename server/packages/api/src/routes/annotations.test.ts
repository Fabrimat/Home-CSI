import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../server.js';
import { FakeHomeCsiDb } from '../testUtils/fakeDb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_TOKEN = 'a-long-enough-test-token-1234567890';
const NONEXISTENT_ASSETS_DIR = path.join(__dirname, '__no-such-web-assets-dir__');

function authHeader(token = API_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

function makeApp(db = new FakeHomeCsiDb()) {
  return { app: buildApp({ db, apiToken: API_TOKEN, webAssetsDir: NONEXISTENT_ASSETS_DIR }), db };
}

describe('POST /api/annotations', () => {
  it('records a point event with no occupancy count anywhere in the request or the stored row', async () => {
    const { app, db } = makeApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/annotations',
      headers: authHeader(),
      payload: { category: 'appliance', label: 'microwave' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { annotation: Record<string, unknown> };
    expect(body.annotation.category).toBe('appliance');
    expect(body.annotation.label).toBe('microwave');
    expect(body.annotation.endTime).toBeNull();
    expect(body.annotation.source).toBe('manual');
    expect(JSON.stringify(body.annotation)).not.toMatch(/occupancy/i);

    const stored = await db.listAnnotationsInRange({
      from: new Date(0),
      to: new Date(Date.now() + 1000),
      limit: 10,
    });
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0])).not.toMatch(/occupancy/i);
  });

  it('records an interval event given an explicit time and endTime', async () => {
    const { app } = makeApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/annotations',
      headers: authHeader(),
      payload: {
        time: '2026-01-01T00:00:00Z',
        endTime: '2026-01-01T00:05:00Z',
        category: 'hvac',
        notes: 'furnace cycling',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { annotation: { time: string; endTime: string | null; notes: string | null } };
    expect(body.annotation.time).toBe('2026-01-01T00:00:00.000Z');
    expect(body.annotation.endTime).toBe('2026-01-01T00:05:00.000Z');
    expect(body.annotation.notes).toBe('furnace cycling');
  });

  it('400s when endTime <= time', async () => {
    const { app } = makeApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/annotations',
      headers: authHeader(),
      payload: {
        time: '2026-01-01T01:00:00Z',
        endTime: '2026-01-01T00:00:00Z',
        category: 'door',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  // `time` omitted means "now", resolved in the handler rather than in the
  // body schema's refine. The ordering check has to happen against that same
  // instant: validating against a separate, earlier clock read would let an
  // `endTime` in between the two reads through, and it would then violate
  // migration 009's `end_time > time` CHECK -- surfacing as a 500 from the
  // database instead of the 400 this is.
  it('400s when endTime is already in the past and time is omitted (defaults to now)', async () => {
    const { app } = makeApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/annotations',
      headers: authHeader(),
      payload: {
        endTime: '2020-01-01T00:00:00Z',
        category: 'appliance',
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('400s on a category outside the CHECK-constrained vocabulary (no `activity` category)', async () => {
    const { app } = makeApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/annotations',
      headers: authHeader(),
      payload: { category: 'activity' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/annotations (range query)', () => {
  it('returns an annotation whose interval overlaps the window, using the same overlap predicate as /api/labels', async () => {
    const { app, db } = makeApp();
    await db.createAnnotation({
      time: new Date('2026-01-01T00:00:00Z'),
      endTime: new Date('2026-01-01T02:00:00Z'),
      category: 'hvac',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/annotations?from=2026-01-01T01:00:00Z&to=2026-01-01T03:00:00Z',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { annotations: Array<{ time: string; endTime: string | null }> };
    expect(body.annotations).toHaveLength(1);
    expect(body.annotations[0]?.endTime).toBe('2026-01-01T02:00:00.000Z');
  });

  it('excludes an annotation whose interval ends before the window starts', async () => {
    const { app, db } = makeApp();
    await db.createAnnotation({
      time: new Date('2026-01-01T00:00:00Z'),
      endTime: new Date('2026-01-01T00:30:00Z'),
      category: 'door',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/annotations?from=2026-01-01T01:00:00Z&to=2026-01-01T03:00:00Z',
      headers: authHeader(),
    });

    expect((res.json() as { annotations: unknown[] }).annotations).toHaveLength(0);
  });

  it('includes a point annotation whose time is exactly `from`', async () => {
    const { app, db } = makeApp();
    await db.createAnnotation({ time: new Date('2026-01-01T01:00:00Z'), category: 'pet' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/annotations?from=2026-01-01T01:00:00Z&to=2026-01-01T03:00:00Z',
      headers: authHeader(),
    });

    expect((res.json() as { annotations: unknown[] }).annotations).toHaveLength(1);
  });

  it('400s when to <= from', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/annotations?from=2026-01-01T03:00:00Z&to=2026-01-01T01:00:00Z',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/annotations/:id', () => {
  it('204s and removes the row, then 404s on a second delete', async () => {
    const { app, db } = makeApp();
    const annotation = await db.createAnnotation({ time: new Date(), category: 'interference' });

    const first = await app.inject({
      method: 'DELETE',
      url: `/api/annotations/${annotation.id}`,
      headers: authHeader(),
    });
    expect(first.statusCode).toBe(204);

    const remaining = await db.listAnnotationsInRange({
      from: new Date(0),
      to: new Date(Date.now() + 1000),
      limit: 10,
    });
    expect(remaining).toHaveLength(0);

    const second = await app.inject({
      method: 'DELETE',
      url: `/api/annotations/${annotation.id}`,
      headers: authHeader(),
    });
    expect(second.statusCode).toBe(404);
  });

  it('404s for an id that never existed', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/annotations/999', headers: authHeader() });
    expect(res.statusCode).toBe(404);
  });
});
