import { describe, expect, it } from 'vitest';
import {
  INITIAL_LATCH_STATE,
  stepLatch,
  type LatchState,
  type LatchThresholds,
  type LinkObservation,
} from './stateMachine.js';

const THRESHOLDS: LatchThresholds = {
  motionOnThreshold: 3.0,
  motionOffThreshold: 1.5,
  latchDecayHorizonMs: 1_800_000, // 30 minutes
  hysteresisMs: 30_000, // 30 seconds
  crossNodeSimultaneityThresholdMs: 5_000,
};

const EXPECTED_LINK_COUNT = 2;

function motion(linkKey: string, deviation = 5): LinkObservation {
  return { linkKey, baselineDeviation: deviation };
}
function quiet(linkKey: string): LinkObservation {
  return { linkKey, baselineDeviation: 0 };
}

/** Runs a scripted sequence of (timeMs, observations) ticks through the latch, returning every step's result. */
function run(
  ticks: Array<{ timeMs: number; observations: LinkObservation[] }>,
  thresholds: LatchThresholds = THRESHOLDS,
  expectedLinkCount = EXPECTED_LINK_COUNT,
) {
  let state: LatchState = INITIAL_LATCH_STATE;
  const results = [];
  for (const tick of ticks) {
    const result = stepLatch(state, tick.observations, tick.timeMs, thresholds, expectedLinkCount);
    state = result.state;
    results.push(result);
  }
  return results;
}

describe('scenario: still-occupant-does-not-decay-early', () => {
  it('a person who moves once then stays still must NOT decay to 0 before the configured horizon', () => {
    const ticks: Array<{ timeMs: number; observations: LinkObservation[] }> = [
      { timeMs: 0, observations: [motion('1:aa')] },
    ];
    // Quiet (still) for just under the 30-minute decay horizon, sampled every minute.
    for (let t = 60_000; t < THRESHOLDS.latchDecayHorizonMs; t += 60_000) {
      ticks.push({ timeMs: t, observations: [quiet('1:aa')] });
    }

    const results = run(ticks);

    for (const result of results) {
      expect(result.estimate).not.toBe(0);
      expect(result.state.state).not.toBe('UNOCCUPIED');
    }
    // Sanity: the scenario did actually go quiet (DECAYING), it just never fully reverted.
    expect(results[results.length - 1]!.state.state).toBe('DECAYING');
  });
});

describe('scenario: genuine-exit-reaches-zero', () => {
  it('sustained silence past the decay horizon eventually reaches estimate 0', () => {
    const ticks: Array<{ timeMs: number; observations: LinkObservation[] }> = [
      { timeMs: 0, observations: [motion('1:aa')] },
    ];
    // Quiet well past the horizon (+ hysteresis window), sampled every minute.
    const totalDurationMs = THRESHOLDS.latchDecayHorizonMs + THRESHOLDS.hysteresisMs + 120_000;
    for (let t = 60_000; t <= totalDurationMs; t += 60_000) {
      ticks.push({ timeMs: t, observations: [quiet('1:aa')] });
    }

    const results = run(ticks);
    const finalResult = results[results.length - 1]!;

    expect(finalResult.estimate).toBe(0);
    expect(finalResult.state.state).toBe('UNOCCUPIED');
    // And it must have passed through DECAYING on the way, not jumped straight there.
    expect(results.some((r) => r.state.state === 'DECAYING')).toBe(true);
  });
});

describe('scenario: flapping-is-suppressed-by-hysteresis', () => {
  it('a motion blip immediately after an UNOCCUPIED transition is suppressed until hysteresisMs elapses', () => {
    const horizon = THRESHOLDS.latchDecayHorizonMs;
    const hysteresis = THRESHOLDS.hysteresisMs;

    let state: LatchState = INITIAL_LATCH_STATE;

    // t=0: motion turns the latch on.
    let result = stepLatch(state, [motion('1:aa')], 0, THRESHOLDS, EXPECTED_LINK_COUNT);
    state = result.state;
    expect(result.estimate).toBe(1);

    // Quiet all the way past the decay horizon -> reverts to UNOCCUPIED.
    const exitTimeMs = horizon + 1_000;
    result = stepLatch(state, [quiet('1:aa')], exitTimeMs, THRESHOLDS, EXPECTED_LINK_COUNT);
    state = result.state;
    expect(result.estimate).toBe(0);
    expect(result.state.lastEstimateChangeAtMs).toBe(exitTimeMs);

    // A motion blip 1 second later (well within hysteresisMs of the exit) must NOT flip the reported estimate back on.
    const blipTimeMs = exitTimeMs + 1_000;
    result = stepLatch(state, [motion('1:aa')], blipTimeMs, THRESHOLDS, EXPECTED_LINK_COUNT);
    state = result.state;
    expect(result.estimate).toBe(0);
    expect(result.state.state).toBe('UNOCCUPIED');

    // Once hysteresisMs has elapsed since the exit, renewed motion IS allowed to flip it back.
    const retryTimeMs = exitTimeMs + hysteresis + 1_000;
    result = stepLatch(state, [motion('1:aa')], retryTimeMs, THRESHOLDS, EXPECTED_LINK_COUNT);
    expect(result.estimate).toBe(1);
    expect(result.state.state).toBe('OCCUPIED');
  });
});

describe('scenario: two-simultaneous-distinct-links-yields-2plus', () => {
  it('motion onset on two spatially-distinct (different node) links within the simultaneity window yields estimate 2, with lower confidence than a single-link 1', () => {
    // Same number of reporting links (dataSufficiency) in both cases, so the
    // comparison below isolates the "1 vs 2" confidence effect rather than
    // mesh-coverage differences.
    const singleLinkResult = stepLatch(
      INITIAL_LATCH_STATE,
      [motion('1:aa'), quiet('2:bb')],
      0,
      THRESHOLDS,
      EXPECTED_LINK_COUNT,
    );
    expect(singleLinkResult.estimate).toBe(1);

    const dualLinkResult = stepLatch(
      INITIAL_LATCH_STATE,
      [motion('1:aa'), motion('2:bb')],
      0,
      THRESHOLDS,
      EXPECTED_LINK_COUNT,
    );
    expect(dualLinkResult.estimate).toBe(2);
    expect(dualLinkResult.multiOccupancy.detected).toBe(true);

    // Be honest about confidence: 2+ must not be reported with confidence >= a plain single-occupant read.
    expect(dualLinkResult.confidence).toBeLessThan(singleLinkResult.confidence);
  });

  it('does NOT claim 2+ from two links on the SAME node (not spatially distinct)', () => {
    const result = stepLatch(
      INITIAL_LATCH_STATE,
      [motion('1:aa'), motion('1:cc')],
      0,
      THRESHOLDS,
      EXPECTED_LINK_COUNT,
    );
    expect(result.estimate).toBe(1);
    expect(result.multiOccupancy.detected).toBe(false);
  });

  it('does NOT claim 2+ when two distinct-node links go active far apart in time (outside the simultaneity window)', () => {
    let state: LatchState = INITIAL_LATCH_STATE;
    let result = stepLatch(state, [motion('1:aa')], 0, THRESHOLDS, EXPECTED_LINK_COUNT);
    state = result.state;
    result = stepLatch(
      state,
      [motion('1:aa'), motion('2:bb')],
      THRESHOLDS.crossNodeSimultaneityThresholdMs * 10,
      THRESHOLDS,
      EXPECTED_LINK_COUNT,
    );
    expect(result.multiOccupancy.detected).toBe(false);
    expect(result.estimate).toBe(1);
  });

  it('2+ reverts to reporting at-most-1 once motion stops (no live simultaneity evidence during decay)', () => {
    let state: LatchState = INITIAL_LATCH_STATE;
    let result = stepLatch(state, [motion('1:aa'), motion('2:bb')], 0, THRESHOLDS, EXPECTED_LINK_COUNT);
    state = result.state;
    expect(result.estimate).toBe(2);

    result = stepLatch(state, [quiet('1:aa'), quiet('2:bb')], 1_000, THRESHOLDS, EXPECTED_LINK_COUNT);
    expect(result.state.state).toBe('DECAYING');
    expect(result.estimate).toBe(1);
  });
});

describe('per-link Schmitt-trigger hysteresis', () => {
  it('a single link does not flicker on/off for deviation values between the off- and on-thresholds', () => {
    let state: LatchState = INITIAL_LATCH_STATE;
    let result = stepLatch(state, [motion('1:aa', 3.5)], 0, THRESHOLDS, EXPECTED_LINK_COUNT);
    state = result.state;
    expect(result.activeLinks).toContain('1:aa');

    // Deviation drops into the hysteresis band (between off=1.5 and on=3.0) — should stay active.
    result = stepLatch(state, [{ linkKey: '1:aa', baselineDeviation: 2.0 }], 500, THRESHOLDS, EXPECTED_LINK_COUNT);
    expect(result.activeLinks).toContain('1:aa');

    // Drops at/below the off-threshold — now deactivates.
    result = stepLatch(state, [{ linkKey: '1:aa', baselineDeviation: 1.0 }], 1000, THRESHOLDS, EXPECTED_LINK_COUNT);
    expect(result.activeLinks).not.toContain('1:aa');
  });
});

describe('confidence', () => {
  it('is high for a fully-reporting UNOCCUPIED house', () => {
    const result = stepLatch(INITIAL_LATCH_STATE, [quiet('1:aa'), quiet('2:bb')], 0, THRESHOLDS, EXPECTED_LINK_COUNT);
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it('is scaled down when only a fraction of the expected mesh reported data this tick', () => {
    const fullMesh = stepLatch(
      INITIAL_LATCH_STATE,
      [quiet('1:aa'), quiet('2:bb')],
      0,
      THRESHOLDS,
      EXPECTED_LINK_COUNT,
    );
    const sparseMesh = stepLatch(INITIAL_LATCH_STATE, [quiet('1:aa')], 0, THRESHOLDS, EXPECTED_LINK_COUNT);
    expect(sparseMesh.confidence).toBeLessThan(fullMesh.confidence);
  });

  it('decreases over the course of DECAYING as the silence approaches the horizon', () => {
    let state: LatchState = INITIAL_LATCH_STATE;
    let result = stepLatch(state, [motion('1:aa')], 0, THRESHOLDS, EXPECTED_LINK_COUNT);
    state = result.state;
    result = stepLatch(state, [quiet('1:aa')], 1_000, THRESHOLDS, EXPECTED_LINK_COUNT);
    state = result.state;
    const earlyDecayConfidence = result.confidence;

    result = stepLatch(
      state,
      [quiet('1:aa')],
      THRESHOLDS.latchDecayHorizonMs - 1_000,
      THRESHOLDS,
      EXPECTED_LINK_COUNT,
    );
    const lateDecayConfidence = result.confidence;

    expect(lateDecayConfidence).toBeLessThan(earlyDecayConfidence);
  });
});

describe('no data ever observed', () => {
  it('reports 0 with low confidence rather than a confident guess', () => {
    const result = stepLatch(INITIAL_LATCH_STATE, [], 0, THRESHOLDS, EXPECTED_LINK_COUNT);
    expect(result.estimate).toBe(0);
    expect(result.confidence).toBe(0);
  });
});
