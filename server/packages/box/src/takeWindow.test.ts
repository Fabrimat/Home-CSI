import { describe, expect, it } from 'vitest';
import { DEFAULT_LEAD_TRIM_MS, computeTakeWindow, isTakeUsable } from './takeWindow.js';

describe('computeTakeWindow', () => {
  it('trims leadInMs off the start and leadOutMs off the end', () => {
    const window = computeTakeWindow({ startedAtMs: 1000, endedAtMs: 3000 }, 200, 300);
    expect(window).toEqual({ fromMs: 1200, toMs: 2700 });
  });

  it('returns null for a still-open session (endedAtMs is null)', () => {
    const window = computeTakeWindow({ startedAtMs: 1000, endedAtMs: null }, DEFAULT_LEAD_TRIM_MS, DEFAULT_LEAD_TRIM_MS);
    expect(window).toBeNull();
  });

  it('returns null when the lead-in/lead-out trim consumes the entire hold', () => {
    // A 300ms hold cannot survive a 200ms trim on each side.
    const window = computeTakeWindow({ startedAtMs: 1000, endedAtMs: 1300 }, 200, 200);
    expect(window).toBeNull();
  });

  it('returns null (not a zero/negative-width window) exactly at the boundary', () => {
    const window = computeTakeWindow({ startedAtMs: 1000, endedAtMs: 1400 }, 200, 200);
    expect(window).toBeNull();
  });
});

describe('isTakeUsable', () => {
  it('is usable at or above the minimum', () => {
    expect(isTakeUsable(20, 20)).toBe(true);
    expect(isTakeUsable(21, 20)).toBe(true);
  });

  it('is not usable below the minimum', () => {
    expect(isTakeUsable(19, 20)).toBe(false);
    expect(isTakeUsable(0, 20)).toBe(false);
  });
});
