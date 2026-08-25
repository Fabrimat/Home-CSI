import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CoverageInputs } from '../db/types.js';
import { buildApp } from '../server.js';
import { FakeHomeCsiDb } from '../testUtils/fakeDb.js';
import { computeCoverage, type CoverageResponse } from './coverage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_TOKEN = 'a-long-enough-test-token-1234567890';
const NONEXISTENT_ASSETS_DIR = path.join(__dirname, '__no-such-web-assets-dir__');

function authHeader(token = API_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

const HOUR_MS = 60 * 60 * 1000;

describe('computeCoverage (pure logic, no clock/HTTP involved)', () => {
  const window = { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-01-01T10:00:00Z') }; // 10h window

  it('reviewedFraction reflects merged reviewed-source coverage, ignoring overlaps and zero-width point labels', () => {
    const inputs: CoverageInputs = {
      // Two overlapping reviewed intervals covering [0h,3h) and [2h,5h) -- merge to [0h,5h), i.e. half the window.
      // Plus a zero-width point label at 6h, which must contribute nothing.
      reviewedIntervals: [
        { fromMs: new Date('2026-01-01T00:00:00Z').getTime(), toMs: new Date('2026-01-01T03:00:00Z').getTime() },
        { fromMs: new Date('2026-01-01T02:00:00Z').getTime(), toMs: new Date('2026-01-01T05:00:00Z').getTime() },
        { fromMs: new Date('2026-01-01T06:00:00Z').getTime(), toMs: new Date('2026-01-01T06:00:00Z').getTime() },
      ],
      labelSourceCounts: {},
      annotationCount: 0,
      annotationCategories: [],
    };

    const result = computeCoverage(inputs, window, 30 * 60 * 1000);
    expect(result.reviewedFraction).toBeCloseTo(0.5, 5);
  });

  it('expiringSoon only surfaces the part of an unreviewed gap within the safety margin of the window start', () => {
    const inputs: CoverageInputs = {
      reviewedIntervals: [], // nothing reviewed anywhere in the window
      labelSourceCounts: {},
      annotationCount: 0,
      annotationCategories: [],
    };

    const safetyMarginMs = 30 * 60 * 1000; // 30 minutes
    const result = computeCoverage(inputs, window, safetyMarginMs);

    expect(result.expiringSoon).toHaveLength(1);
    expect(result.expiringSoon[0]?.from).toBe(window.from.toISOString());
    expect(result.expiringSoon[0]?.to).toBe(new Date(window.from.getTime() + safetyMarginMs).toISOString());
    expect(result.expiringSoon[0]?.reason).toBe('unreviewed');
  });

  it('a reviewed interval covering the window start leaves nothing expiring soon', () => {
    const inputs: CoverageInputs = {
      reviewedIntervals: [
        { fromMs: window.from.getTime(), toMs: window.from.getTime() + HOUR_MS },
      ],
      labelSourceCounts: {},
      annotationCount: 0,
      annotationCategories: [],
    };

    const result = computeCoverage(inputs, window, 30 * 60 * 1000);
    expect(result.expiringSoon).toHaveLength(0);
  });

  it('maps labelSourceCounts to confirmations/corrections, and passes through annotation count/categories', () => {
    const inputs: CoverageInputs = {
      reviewedIntervals: [],
      labelSourceCounts: { manual: 3, confirmed: 2, 'weak:phone-presence': 100, training: 1 },
      annotationCount: 7,
      annotationCategories: ['appliance', 'hvac'],
    };

    const result = computeCoverage(inputs, window, 30 * 60 * 1000);
    expect(result.corrections).toBe(3);
    expect(result.confirmations).toBe(2);
    expect(result.annotations).toBe(7);
    expect(result.categoriesUsed).toEqual(['appliance', 'hvac']);
  });

  it('never returns a total-labels/volume-score or streak field', () => {
    const inputs: CoverageInputs = {
      reviewedIntervals: [],
      labelSourceCounts: { manual: 1, confirmed: 1, training: 1, 'weak:phone-presence': 1 },
      annotationCount: 1,
      annotationCategories: ['other'],
    };

    const result = computeCoverage(inputs, window, 30 * 60 * 1000) as CoverageResponse & Record<string, unknown>;
    const keys = Object.keys(result);
    expect(keys).not.toContain('totalLabels');
    expect(keys.some((k) => /streak|total|score/i.test(k))).toBe(false);
  });
});

describe('GET /api/coverage', () => {
  function makeApp(db: FakeHomeCsiDb, retentionMaxAgeMs: number, retentionSafetyMarginMs: number) {
    return buildApp({
      db,
      apiToken: API_TOKEN,
      webAssetsDir: NONEXISTENT_ASSETS_DIR,
      clientConfig: { retentionMaxAgeMs, retentionSafetyMarginMs },
    });
  }

  it('reflects seeded labels/annotations from the last retentionMaxAgeMs', async () => {
    const db = new FakeHomeCsiDb();
    const nowMs = Date.now();
    const retentionMaxAgeMs = 4 * HOUR_MS;
    const safetyMarginMs = 30 * 60 * 1000;

    const session = await db.createLabelSession({ startedAt: new Date(nowMs - 3 * HOUR_MS) });
    // Reviewed correction covering the first half of the (4h) window.
    await db.createLabel({
      sessionId: session.id,
      time: new Date(nowMs - 4 * HOUR_MS),
      endTime: new Date(nowMs - 2 * HOUR_MS),
      occupancyCount: 0,
      source: 'manual',
    });
    await db.createLabel({
      sessionId: session.id,
      time: new Date(nowMs - HOUR_MS),
      occupancyCount: 1,
      source: 'confirmed',
    });
    await db.createAnnotation({ time: new Date(nowMs - HOUR_MS), category: 'appliance', label: 'microwave' });

    const app = makeApp(db, retentionMaxAgeMs, safetyMarginMs);
    const res = await app.inject({ method: 'GET', url: '/api/coverage', headers: authHeader() });

    expect(res.statusCode).toBe(200);
    const body = res.json() as CoverageResponse;
    expect(body.reviewedFraction).toBeGreaterThan(0.4);
    expect(body.reviewedFraction).toBeLessThanOrEqual(1);
    expect(body.corrections).toBe(1);
    expect(body.confirmations).toBe(1);
    expect(body.annotations).toBe(1);
    expect(body.categoriesUsed).toEqual(['appliance']);
    expect(Array.isArray(body.expiringSoon)).toBe(true);
    expect(Object.keys(body)).not.toContain('totalLabels');
  });

  it('401s without a bearer token, same as every other /api/* route', async () => {
    const app = makeApp(new FakeHomeCsiDb(), HOUR_MS, 5 * 60 * 1000);
    const res = await app.inject({ method: 'GET', url: '/api/coverage' });
    expect(res.statusCode).toBe(401);
  });
});
