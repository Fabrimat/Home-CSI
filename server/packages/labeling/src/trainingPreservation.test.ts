import { describe, expect, it } from 'vitest';
import { WEAK_SESSION_NOTES } from './sessions.js';
import {
  checkDensity,
  createInMemoryTrainingFeaturesStore,
  preserveSessionFeatures,
  sweepPreserveTrainingFeatures,
  type PreservationConfig,
  type PreserveResult,
} from './trainingPreservation.js';

// Fixed anchor for "now" so baseline/target windows are deterministic and
// independent of real wall-clock time (unlike Date.now()).
const NOW_MS = 10_000_000;

const CONFIG: PreservationConfig = { toleranceMs: 0, baselineWindowMs: 3_600_000, minDensityFraction: 0.5 };

function manualSession(
  overrides: Partial<{ id: number; startedAtMs: number; endedAtMs: number | null; notes: string | null }> = {},
) {
  return { id: 1, startedAtMs: NOW_MS - 20_000, endedAtMs: NOW_MS - 10_000, notes: 'manual: evening test', ...overrides };
}

/** One reporting link, dense at every `hopMs` tick across [fromMs, toMs]. */
function denseFeatures(fromMs: number, toMs: number, hopMs: number, linkMac = 'aa:aa:aa:aa:aa:01') {
  const rows: { timeMs: number; nodeId: number; linkMac: string }[] = [];
  for (let t = fromMs; t <= toMs; t += hopMs) {
    rows.push({ timeMs: t, nodeId: 1, linkMac });
  }
  return rows;
}

/** `linkCount` distinct reporting links, each dense at every `hopMs` tick across [fromMs, toMs]. */
function manyLinks(fromMs: number, toMs: number, hopMs: number, linkCount: number) {
  const rows: { timeMs: number; nodeId: number; linkMac: string }[] = [];
  for (let t = fromMs; t <= toMs; t += hopMs) {
    for (let link = 0; link < linkCount; link++) {
      rows.push({ timeMs: t, nodeId: 1, linkMac: `link-${link}` });
    }
  }
  return rows;
}

describe('checkDensity', () => {
  it('returns disabled when minDensityFraction <= 0 (operator opt-out)', async () => {
    const store = createInMemoryTrainingFeaturesStore([]);
    const result = await checkDensity(store, 10_000, { ...CONFIG, minDensityFraction: 0 }, NOW_MS);
    expect(result.kind).toBe('disabled');
  });

  it('returns no-baseline when the baseline window itself has zero rows (bootstrap)', async () => {
    const store = createInMemoryTrainingFeaturesStore([]);
    const result = await checkDensity(store, 10_000, CONFIG, NOW_MS);
    expect(result.kind).toBe('no-baseline');
  });

  it('scales the expected floor by live baseline density and minDensityFraction', async () => {
    const baselineSeed = denseFeatures(NOW_MS - CONFIG.baselineWindowMs, NOW_MS, 500); // 1 link, dense
    const store = createInMemoryTrainingFeaturesStore(baselineSeed);
    const baselineCount = await store.countFeatureRows(NOW_MS - CONFIG.baselineWindowMs, NOW_MS);
    const result = await checkDensity(store, 10_000, CONFIG, NOW_MS);
    expect(result.kind).toBe('checked');
    // Computed the same way `checkDensity` does, rather than hardcoding a
    // magic number that would silently drift if the seed helper's own
    // (inclusive-of-both-endpoints) tick count ever changes.
    const expectedFloor = Math.max(
      1,
      Math.ceil((baselineCount / CONFIG.baselineWindowMs) * 10_000 * CONFIG.minDensityFraction),
    );
    if (result.kind === 'checked') expect(result.expected).toBe(expectedFloor);
  });
});

describe('preserveSessionFeatures', () => {
  it('copies raw per-link features for a manual session whose window is still fully alive', async () => {
    const session = manualSession();
    // Baseline range covers the session's own (much smaller) window.
    const seed = denseFeatures(NOW_MS - CONFIG.baselineWindowMs, NOW_MS, 500);
    const store = createInMemoryTrainingFeaturesStore(seed);

    const result = (await preserveSessionFeatures(session, store, CONFIG, NOW_MS)) as PreserveResult;

    expect(result.status).toBe('preserved');
    expect(result.inserted).toBeGreaterThan(0);
    expect(result.densityCheckSkipped).toBe(false);
  });

  it('is idempotent: preserving the same session twice inserts no duplicates the second time', async () => {
    const session = manualSession();
    const seed = denseFeatures(NOW_MS - CONFIG.baselineWindowMs, NOW_MS, 500);
    const store = createInMemoryTrainingFeaturesStore(seed);

    const first = (await preserveSessionFeatures(session, store, CONFIG, NOW_MS)) as PreserveResult;
    const second = (await preserveSessionFeatures(session, store, CONFIG, NOW_MS)) as PreserveResult;

    expect(first.inserted).toBeGreaterThan(0);
    expect(second.inserted).toBe(0);
  });

  it('skips a weak/presence-probe session without copying any raw per-link features', async () => {
    const weakSession = manualSession({ notes: WEAK_SESSION_NOTES });
    const seed = denseFeatures(NOW_MS - CONFIG.baselineWindowMs, NOW_MS, 500);
    const store = createInMemoryTrainingFeaturesStore(seed);

    const result = (await preserveSessionFeatures(weakSession, store, CONFIG, NOW_MS)) as PreserveResult;

    expect(result.status).toBe('skipped-weak');
    expect(result.inserted).toBe(0);

    // Confirm nothing was copied at all, even though plenty of feature data existed.
    const again = (await preserveSessionFeatures({ ...weakSession, notes: null }, store, CONFIG, NOW_MS)) as PreserveResult;
    // Sanity check on the seed/store itself: a manual session over the same window WOULD find data.
    expect(again.status).toBe('preserved');
  });

  it('errors with expected-vs-found counts when this window was NEVER preserved and is genuinely lost (no rows in features OR training_features), even though the deployment is otherwise healthy right now', async () => {
    // Baseline: deployment is healthy RIGHT NOW.
    const baselineSeed = denseFeatures(NOW_MS - CONFIG.baselineWindowMs, NOW_MS, 500);
    // The session itself is much older than the baseline lookback and has
    // NO surviving rows in EITHER table -- its `features` chunks already
    // got dropped, and it was never preserved into `training_features`
    // either (unlike the "preserved, then aged out" scenario below, which
    // must NOT throw). This is the case the density check must still catch.
    const session = manualSession({ startedAtMs: NOW_MS - 10_000_000, endedAtMs: NOW_MS - 9_990_000 });
    const store = createInMemoryTrainingFeaturesStore(baselineSeed); // no seedTrainingFeatures either

    await expect(preserveSessionFeatures(session, store, CONFIG, NOW_MS)).rejects.toThrow(/expected >= \d+, found 0/);
    await expect(preserveSessionFeatures(session, store, CONFIG, NOW_MS)).rejects.toThrow(/session #1/);
  });

  it('preserved, then aged out of features -> reports 0 inserted, no error, even though the window has zero features rows now', async () => {
    // Baseline: deployment is healthy RIGHT NOW.
    const baselineSeed = denseFeatures(NOW_MS - CONFIG.baselineWindowMs, NOW_MS, 500);
    // The session's own window has NO rows left in `features` (its chunk
    // was dropped by the 7-day retention policy, migration 007) -- BUT it
    // was already preserved into `training_features` by an earlier run.
    const session = manualSession({ startedAtMs: NOW_MS - 10_000_000, endedAtMs: NOW_MS - 9_990_000 });
    const alreadyPreserved = denseFeatures(session.startedAtMs, session.endedAtMs!, 500);
    const store = createInMemoryTrainingFeaturesStore(baselineSeed, alreadyPreserved);

    const result = (await preserveSessionFeatures(session, store, CONFIG, NOW_MS)) as PreserveResult;

    expect(result.status).toBe('preserved');
    expect(result.inserted).toBe(0); // nothing left in `features` to copy -- already there
    expect(result.found).toBeGreaterThan(0); // but still "found" via training_features
  });

  it('errors on a partially-drained window at a realistic 12-link density, not just near-total loss', async () => {
    // Concrete regression case: this deployment normally sees ~12 links'
    // worth of density (its own live baseline). A 1-hour manual session
    // that lost 90% of its rows (an ingest outage, a window straddling the
    // retention boundary, several nodes down) leaves ~10% remaining --
    // comfortably above a flat "at least 1 row" floor (which would
    // silently accept it), and this must still reject it.
    const hopMs = 500;
    const linkCount = 12;
    const config: PreservationConfig = { toleranceMs: 0, baselineWindowMs: 3_600_000, minDensityFraction: 0.5 };
    const baselineSeed = manyLinks(NOW_MS - config.baselineWindowMs, NOW_MS, hopMs, linkCount); // ~86,400 rows/hour

    const sessionDurationMs = 60 * 60 * 1000;
    const session = manualSession({
      startedAtMs: NOW_MS - 10_000_000,
      endedAtMs: NOW_MS - 10_000_000 + sessionDurationMs,
    });
    const fullSessionDensity = manyLinks(session.startedAtMs, session.endedAtMs!, hopMs, linkCount).length; // ~86,400
    const survivingCount = Math.round(fullSessionDensity * 0.1); // ~10% remains
    const sessionSeed = Array.from({ length: survivingCount }, (_, i) => ({
      timeMs: session.startedAtMs + Math.floor((i / survivingCount) * sessionDurationMs),
      nodeId: 1,
      linkMac: 'aa:aa:aa:aa:aa:01',
    }));

    const store = createInMemoryTrainingFeaturesStore([...baselineSeed, ...sessionSeed]);

    await expect(preserveSessionFeatures(session, store, config, NOW_MS)).rejects.toThrow(
      new RegExp(`expected >= \\d+, found ${survivingCount}\\b`),
    );
  });

  it('does NOT false-alarm on a partial-but-healthy mesh (N=4, only the 4 node-to-AP links audible)', async () => {
    // N=4 nodes: 4 node-to-AP links + up to 4*3=12 directional node-to-node
    // links = 16 theoretical vantage points (docs/architecture.md
    // "broadcast-sounding mesh"). Real multi-room attenuation means not
    // every node hears every other node -- here only the 4 node-to-AP
    // links report, which is perfectly healthy for THIS house, just far
    // from the theoretical maximum.
    //
    // This count is chosen deliberately to make the test DISCRIMINATING.
    // The removed topology-derived floor demanded 50% of N^2 = 8 links'
    // worth of rows; 4 of 16 (25%) is below that, so the old code threw
    // here and the current baseline-relative code does not. A higher
    // count (e.g. 10 of 16 = 62.5%) would clear the old floor too and
    // would therefore prove nothing about the fix.
    const reportingLinkCount = 4;
    const hopMs = 500;
    const config: PreservationConfig = { toleranceMs: 0, baselineWindowMs: 60_000, minDensityFraction: 0.5 };

    const baselineSeed = manyLinks(NOW_MS - config.baselineWindowMs, NOW_MS, hopMs, reportingLinkCount);
    const session = manualSession({ startedAtMs: NOW_MS - 200_000, endedAtMs: NOW_MS - 190_000 }); // 10s, well before the baseline range
    const sessionSeed = manyLinks(session.startedAtMs, session.endedAtMs!, hopMs, reportingLinkCount);
    const store = createInMemoryTrainingFeaturesStore([...baselineSeed, ...sessionSeed]);

    const result = (await preserveSessionFeatures(session, store, config, NOW_MS)) as PreserveResult;

    expect(result.status).toBe('preserved');
    expect(result.densityCheckSkipped).toBe(false); // a live baseline WAS available and used, not skipped
  });

  it('still catches real degradation relative to a partial-mesh baseline, not just a full-mesh one', async () => {
    const reportingLinkCount = 10;
    const hopMs = 500;
    const config: PreservationConfig = { toleranceMs: 0, baselineWindowMs: 60_000, minDensityFraction: 0.5 };
    const baselineSeed = manyLinks(NOW_MS - config.baselineWindowMs, NOW_MS, hopMs, reportingLinkCount);

    const session = manualSession({ startedAtMs: NOW_MS - 200_000, endedAtMs: NOW_MS - 190_000 });
    // Only 1 of the normal 10 links reporting during this window -- real degradation, not just "not the theoretical max".
    const sessionSeed = manyLinks(session.startedAtMs, session.endedAtMs!, hopMs, 1);
    const store = createInMemoryTrainingFeaturesStore([...baselineSeed, ...sessionSeed]);

    await expect(preserveSessionFeatures(session, store, config, NOW_MS)).rejects.toThrow(/expected >=/);
  });

  it('degrades to a warning, not an error, when no live baseline is available yet (bootstrap)', async () => {
    const session = manualSession({ startedAtMs: NOW_MS - 10_000_000, endedAtMs: NOW_MS - 9_990_000 });
    const sessionSeed = denseFeatures(session.startedAtMs, session.endedAtMs!, 500); // healthy data for the session itself
    // Nothing seeded near "now" -- e.g. the pipeline isn't currently running, or this is a fresh backfill.
    const store = createInMemoryTrainingFeaturesStore(sessionSeed);

    const result = (await preserveSessionFeatures(session, store, CONFIG, NOW_MS)) as PreserveResult;

    expect(result.status).toBe('preserved');
    expect(result.densityCheckSkipped).toBe(true);
  });

  it('skips the density check entirely when minDensityFraction is 0 (operator opt-out)', async () => {
    const session = manualSession({ startedAtMs: NOW_MS - 10_000_000, endedAtMs: NOW_MS - 9_990_000 });
    const store = createInMemoryTrainingFeaturesStore([]); // zero rows anywhere, found = 0
    const config: PreservationConfig = { ...CONFIG, minDensityFraction: 0 };

    const result = (await preserveSessionFeatures(session, store, config, NOW_MS)) as PreserveResult;

    expect(result.status).toBe('preserved');
    expect(result.found).toBe(0);
    expect(result.densityCheckSkipped).toBe(false); // deliberately disabled, not "unavailable"
  });

  it('uses "now" as the window end for a still-open session', async () => {
    const openSession = manualSession({ endedAtMs: null });
    const seed = denseFeatures(NOW_MS - CONFIG.baselineWindowMs, NOW_MS + 1000, 500);
    const store = createInMemoryTrainingFeaturesStore(seed);

    const result = (await preserveSessionFeatures(openSession, store, CONFIG, NOW_MS)) as PreserveResult;
    expect(result.status).toBe('preserved');
    expect(result.toMs).toBe(NOW_MS + CONFIG.toleranceMs);
  });
});

describe('preserveSessionFeatures: permanently-lost downgrade (config.retentionMaxAgeMs)', () => {
  const RETENTION_MAX_AGE_MS = 7 * 86_400_000;

  it('returns permanently-lost (does not throw) when the window is entirely past retentionMaxAgeMs with zero rows found anywhere', async () => {
    const baselineSeed = denseFeatures(NOW_MS - CONFIG.baselineWindowMs, NOW_MS, 500);
    // Session window ends well over 7 days before "now" -- entirely past
    // retention -- and has genuinely nothing in either table.
    const longAgoMs = NOW_MS - RETENTION_MAX_AGE_MS - 1_000_000;
    const session = manualSession({ startedAtMs: longAgoMs, endedAtMs: longAgoMs + 10_000 });
    const store = createInMemoryTrainingFeaturesStore(baselineSeed); // nothing seeded for the session's own window
    const config: PreservationConfig = { ...CONFIG, retentionMaxAgeMs: RETENTION_MAX_AGE_MS };

    const result = await preserveSessionFeatures(session, store, config, NOW_MS);
    expect(result.status).toBe('permanently-lost');
    expect(result.sessionId).toBe(session.id);
  });

  it('still throws (does not downgrade) when the window is NOT entirely past retention, even with zero rows found', async () => {
    // Recent enough to still be within the retention window -- a real,
    // actionable problem (e.g. mesh outage), not a provably-gone window.
    const session = manualSession({ startedAtMs: NOW_MS - 20_000, endedAtMs: NOW_MS - 10_000 });
    // Baseline is healthy everywhere EXCEPT exactly the session's own
    // window (simulating an outage during that window specifically) --
    // otherwise a baseline dense across its whole lookback would always
    // overlap and "find" data for any recent session window.
    const before = denseFeatures(NOW_MS - CONFIG.baselineWindowMs, session.startedAtMs - 500, 500);
    const after = denseFeatures(session.endedAtMs! + 500, NOW_MS, 500);
    const store = createInMemoryTrainingFeaturesStore([...before, ...after]);
    const config: PreservationConfig = { ...CONFIG, retentionMaxAgeMs: RETENTION_MAX_AGE_MS };

    await expect(preserveSessionFeatures(session, store, config, NOW_MS)).rejects.toThrow(/expected >=/);
  });

  it('still throws when retentionMaxAgeMs is omitted, even for a window that would otherwise qualify as permanently-lost (backward compatible default)', async () => {
    const baselineSeed = denseFeatures(NOW_MS - CONFIG.baselineWindowMs, NOW_MS, 500);
    const longAgoMs = NOW_MS - RETENTION_MAX_AGE_MS - 1_000_000;
    const session = manualSession({ startedAtMs: longAgoMs, endedAtMs: longAgoMs + 10_000 });
    const store = createInMemoryTrainingFeaturesStore(baselineSeed);

    // CONFIG has no retentionMaxAgeMs -- original always-fail-loud behaviour.
    await expect(preserveSessionFeatures(session, store, CONFIG, NOW_MS)).rejects.toThrow(/expected >=/);
  });

  it('still throws when the window is entirely past retention but SOME rows were found (partial loss is still actionable)', async () => {
    const baselineSeed = denseFeatures(NOW_MS - CONFIG.baselineWindowMs, NOW_MS, 500);
    const longAgoMs = NOW_MS - RETENTION_MAX_AGE_MS - 1_000_000;
    const session = manualSession({ startedAtMs: longAgoMs, endedAtMs: longAgoMs + 10_000 });
    // A handful of surviving rows -- found > 0, so NOT "permanently-lost"
    // (which requires literally zero), even though it's below the density
    // threshold and the window is old.
    const partialSeed = [{ timeMs: longAgoMs + 100, nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:01' }];
    const store = createInMemoryTrainingFeaturesStore([...baselineSeed, ...partialSeed]);
    const config: PreservationConfig = { ...CONFIG, retentionMaxAgeMs: RETENTION_MAX_AGE_MS };

    await expect(preserveSessionFeatures(session, store, config, NOW_MS)).rejects.toThrow(/expected >=/);
  });
});

describe('sweepPreserveTrainingFeatures', () => {
  it('preserves multiple sessions and continues past one that errors', async () => {
    const goodSession = manualSession({ id: 1 });
    const badSession = manualSession({
      id: 2,
      startedAtMs: NOW_MS - 10_000_000,
      endedAtMs: NOW_MS - 9_990_000,
    }); // no seed data for this window, outside the baseline lookback
    const weakSession = manualSession({ id: 3, notes: WEAK_SESSION_NOTES });

    const seed = denseFeatures(NOW_MS - CONFIG.baselineWindowMs, NOW_MS, 500);
    const store = createInMemoryTrainingFeaturesStore(seed);

    const results = await sweepPreserveTrainingFeatures([goodSession, badSession, weakSession], store, CONFIG, NOW_MS);

    expect(results.find((r) => r.sessionId === 1)?.status).toBe('preserved');
    expect(results.find((r) => r.sessionId === 2)?.status).toBe('error');
    expect(results.find((r) => r.sessionId === 3)?.status).toBe('skipped-weak');
  });

  it('preserved, then aged out of features -> sweep reports 0 inserted, no error', async () => {
    // Regression test for the alarm-fatigue bug: a healthy deployment whose
    // sessions have ALL already been preserved and have since aged out of
    // `features` retention must sweep clean, forever -- not fail every
    // single run.
    const baselineSeed = denseFeatures(NOW_MS - CONFIG.baselineWindowMs, NOW_MS, 500);
    const session = manualSession({
      id: 1,
      startedAtMs: NOW_MS - 10_000_000,
      endedAtMs: NOW_MS - 9_990_000,
    });
    const alreadyPreserved = denseFeatures(session.startedAtMs, session.endedAtMs!, 500);
    const store = createInMemoryTrainingFeaturesStore(baselineSeed, alreadyPreserved);

    const results = await sweepPreserveTrainingFeatures([session], store, CONFIG, NOW_MS);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 'preserved', inserted: 0 });
  });
});
