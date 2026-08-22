import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETENTION_SAFETY_MARGIN_MS,
  openSessionRetentionWarnings,
  retentionEdgeWarning,
  type RetentionWarningConfig,
} from './retentionWarning.js';

const CONFIG: RetentionWarningConfig = {
  maxAgeMs: 7 * 86_400_000, // 7 days
  safetyMarginMs: DEFAULT_RETENTION_SAFETY_MARGIN_MS, // 1 day
};

const NOW_MS = 100 * 86_400_000; // arbitrary fixed "now"

describe('retentionEdgeWarning', () => {
  it('returns undefined for a comfortably recent target time', () => {
    const targetMs = NOW_MS - 1 * 86_400_000; // 1 day old
    expect(retentionEdgeWarning(targetMs, CONFIG, NOW_MS)).toBeUndefined();
  });

  it('warns once the target time is inside the safety margin but not yet past retention', () => {
    const targetMs = NOW_MS - 6.5 * 86_400_000; // 6.5 days old, inside the 1-day margin before 7
    const warning = retentionEdgeWarning(targetMs, CONFIG, NOW_MS);
    expect(warning).toBeDefined();
    expect(warning).toMatch(/ages out/);
  });

  it('warns with a different message once the target time is already past retention', () => {
    const targetMs = NOW_MS - 10 * 86_400_000; // 10 days old, past the 7-day window
    const warning = retentionEdgeWarning(targetMs, CONFIG, NOW_MS);
    expect(warning).toBeDefined();
    expect(warning).toMatch(/already past/);
    expect(warning).toMatch(/label preserve.*will error/);
  });
});

describe('openSessionRetentionWarnings', () => {
  it('warns for a currently-open session whose startedAtMs is inside the safety margin, with no `add` call involved', () => {
    const openSession = { id: 1, startedAtMs: NOW_MS - 6.9 * 86_400_000, endedAtMs: null };
    const warnings = openSessionRetentionWarnings([openSession], CONFIG, NOW_MS);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.sessionId).toBe(1);
    expect(warnings[0]!.warning).toMatch(/ages out|already past/);
  });

  it('does not warn for a recently-started open session', () => {
    const openSession = { id: 1, startedAtMs: NOW_MS - 1 * 86_400_000, endedAtMs: null };
    expect(openSessionRetentionWarnings([openSession], CONFIG, NOW_MS)).toHaveLength(0);
  });

  it('ignores closed sessions entirely, however old', () => {
    const closedSession = { id: 1, startedAtMs: NOW_MS - 20 * 86_400_000, endedAtMs: NOW_MS - 19 * 86_400_000 };
    expect(openSessionRetentionWarnings([closedSession], CONFIG, NOW_MS)).toHaveLength(0);
  });

  it('reports one warning per over-the-margin open session, skipping healthy ones', () => {
    const sessions = [
      { id: 1, startedAtMs: NOW_MS - 1 * 86_400_000, endedAtMs: null }, // healthy
      { id: 2, startedAtMs: NOW_MS - 8 * 86_400_000, endedAtMs: null }, // already past retention
      { id: 3, startedAtMs: NOW_MS - 6.9 * 86_400_000, endedAtMs: null }, // inside margin
    ];
    const warnings = openSessionRetentionWarnings(sessions, CONFIG, NOW_MS);
    expect(warnings.map((w) => w.sessionId).sort()).toEqual([2, 3]);
  });
});
