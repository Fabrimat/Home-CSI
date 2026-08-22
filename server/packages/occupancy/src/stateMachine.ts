/**
 * The latched occupancy state machine (docs/architecture.md "Motion, not
 * people"). This module is pure and DB-free by design: it is the single
 * most important piece of logic in this brief, so it is kept small,
 * readable, and exhaustively testable in isolation (see
 * stateMachine.test.ts) rather than tangled into I/O.
 *
 * ## Why a latch, not a per-window classifier
 *
 * A still or sleeping occupant looks identical to an empty house on any
 * single window of amplitude features. So this machine never asks "is
 * someone here right now" from one window — it integrates *motion
 * transitions* over time: motion evidence raises the estimate; only a
 * sustained absence of motion across the configured decay horizon lowers
 * it. See docs/architecture.md and the brief for the full rationale.
 *
 * ## Two layers of hysteresis
 *
 * 1. Per-link (Schmitt trigger): each link has its own "is this link
 *    currently showing motion" boolean, using `motionOnThreshold` to turn
 *    on and the lower `motionOffThreshold` to turn off. This prevents a
 *    single link's baseline-deviation value from chattering across one
 *    threshold every few ms of noise.
 * 2. Whole-house (`hysteresisMs`): once the *reported* estimate flips
 *    between 0 and 1+, no further flip is allowed until `hysteresisMs` has
 *    elapsed since that flip. Transitions that do not change the reported
 *    estimate (OCCUPIED <-> DECAYING) are not hysteresis-gated, since they
 *    only affect the internal state label / confidence, not the number a
 *    user sees.
 */

export type OccupancyState = 'UNOCCUPIED' | 'OCCUPIED' | 'DECAYING';

export interface LatchThresholds {
  /** Per-link deviation (in the adaptive baseline's own std-dev units) at/above which a link is classified "in motion". */
  motionOnThreshold: number;
  /** Per-link deviation at/below which a link is classified "quiet" again (must be <= motionOnThreshold for real hysteresis). */
  motionOffThreshold: number;
  /** How long sustained no-motion across every link must persist before OCCUPIED/DECAYING reverts to UNOCCUPIED. */
  latchDecayHorizonMs: number;
  /** Minimum time between reported-estimate-changing transitions, to suppress flapping. */
  hysteresisMs: number;
  /** How close in time two spatially-distinct links' motion onsets must be to count as multi-occupancy (2+ stretch goal). */
  crossNodeSimultaneityThresholdMs: number;
}

/** One link's baseline-relative deviation observation at a single tick (see @homecsi/features LinkFeatureVector.baselineDeviation). */
export interface LinkObservation {
  /** `${nodeId}:${linkMac}` — matches the link key convention used by @homecsi/features. */
  linkKey: string;
  baselineDeviation: number;
}

export interface LatchState {
  state: OccupancyState;
  /** Timestamp (ms) of the last transition that changed the *reported* estimate (0 <-> 1+); null if none has ever happened. */
  lastEstimateChangeAtMs: number | null;
  /** Timestamp (ms) of the most recent tick where any link was active; null if motion has never been observed. */
  lastMotionAtMs: number | null;
  /** Per-link "is currently active" Schmitt-trigger state. */
  linkActive: Record<string, boolean>;
  /** Per-link timestamp (ms) of the most recent false->true activation, used for the cross-link simultaneity check. */
  activeSinceMs: Record<string, number>;
}

export const INITIAL_LATCH_STATE: LatchState = {
  state: 'UNOCCUPIED',
  lastEstimateChangeAtMs: null,
  lastMotionAtMs: null,
  linkActive: {},
  activeSinceMs: {},
};

export interface MultiOccupancyResult {
  detected: boolean;
  /** The distinct-node links whose near-simultaneous activation triggered the 2+ heuristic, if detected. */
  links: string[];
}

export interface LatchStepResult {
  state: LatchState;
  /** 0, 1, or 2 (meaning "2+") — matches occupancy_states.estimate. */
  estimate: 0 | 1 | 2;
  /** 0..1. See computeConfidence for exactly what this represents. */
  confidence: number;
  activeLinks: string[];
  multiOccupancy: MultiOccupancyResult;
  /** Fraction (0..1) of `expectedLinkCount` that reported an observation this tick — mesh-coverage component of confidence. */
  dataSufficiency: number;
}

function nodeIdOf(linkKey: string): string {
  const sep = linkKey.indexOf(':');
  return sep === -1 ? linkKey : linkKey.slice(0, sep);
}

/**
 * Detects the 2+ stretch-goal signal: motion onset on two or more links
 * belonging to physically distinct nodes, within
 * `crossNodeSimultaneityThresholdMs` of each other. Explicitly NOT "two
 * links active at once" in general — many links share a node (a node's
 * links to several peers all reflect the same physical vantage point), so
 * distinctness is checked by node id, per docs/architecture.md ("2+ is ...
 * defined ... by detecting spatially distinct simultaneous motion").
 */
function detectMultiOccupancy(
  activeLinks: readonly string[],
  activeSinceMs: Readonly<Record<string, number>>,
  crossNodeSimultaneityThresholdMs: number,
): MultiOccupancyResult {
  for (let i = 0; i < activeLinks.length; i++) {
    for (let j = i + 1; j < activeLinks.length; j++) {
      const linkA = activeLinks[i] as string;
      const linkB = activeLinks[j] as string;
      if (nodeIdOf(linkA) === nodeIdOf(linkB)) continue; // same physical vantage point, not spatially distinct
      const tA = activeSinceMs[linkA];
      const tB = activeSinceMs[linkB];
      if (tA === undefined || tB === undefined) continue;
      if (Math.abs(tA - tB) <= crossNodeSimultaneityThresholdMs) {
        return { detected: true, links: [linkA, linkB] };
      }
    }
  }
  return { detected: false, links: [] };
}

/**
 * Confidence heuristic. Deliberately simple and documented rather than
 * "learned": this is a rule-based system end to end (see the brief's
 * "Honest fallback"), so confidence is a transparent function of (a) how
 * much of the mesh is actually reporting data this tick, and (b) how
 * directly the current state is supported by evidence.
 *
 *  - UNOCCUPIED: high confidence — reached only after a full decay horizon
 *    of confirmed silence across every link.
 *  - OCCUPIED (estimate 1): high confidence — direct, current motion
 *    evidence on at least one link.
 *  - OCCUPIED (estimate 2, stretch heuristic): capped well below the
 *    estimate-1 case. Per the brief: "be honest about confidence rather
 *    than reporting a confident 2" — this is inferred from *which* links
 *    moved together, a weaker signal than "something is moving at all".
 *  - DECAYING: confidence decays linearly from just under the OCCUPIED
 *    figure down to a floor as the silence approaches the full horizon —
 *    the longer it's been quiet, the less sure we are that anyone is still
 *    there, even though the latch hasn't given up yet.
 *
 * Every case is scaled by `dataSufficiency` (fraction of the expected mesh
 * that actually reported data this tick) — sparse data should never look
 * as confident as a fully-reporting mesh.
 */
function computeConfidence(
  state: OccupancyState,
  estimate: 0 | 1 | 2,
  dataSufficiency: number,
  timeSinceLastMotionMs: number | null,
  latchDecayHorizonMs: number,
): number {
  let base: number;
  if (state === 'UNOCCUPIED') {
    base = 0.9;
  } else if (state === 'OCCUPIED') {
    base = estimate === 2 ? 0.5 : 0.85;
  } else {
    // DECAYING
    const elapsed = timeSinceLastMotionMs ?? 0;
    const fractionOfHorizon = Math.min(1, elapsed / latchDecayHorizonMs);
    base = 0.85 - 0.45 * fractionOfHorizon; // 0.85 -> 0.4 as we approach the horizon
  }
  return Math.max(0, Math.min(1, base * dataSufficiency));
}

/**
 * Advances the latch by one tick. `observations` should be every link's
 * feature-derived baseline deviation for this tick's timestamp (links with
 * no observation this tick simply keep their previous Schmitt-trigger
 * state — "no new data" is not the same as "confirmed quiet").
 */
export function stepLatch(
  prev: LatchState,
  observations: readonly LinkObservation[],
  timeMs: number,
  thresholds: LatchThresholds,
  expectedLinkCount: number,
): LatchStepResult {
  // 1. Per-link Schmitt trigger.
  const linkActive: Record<string, boolean> = { ...prev.linkActive };
  const activeSinceMs: Record<string, number> = { ...prev.activeSinceMs };

  for (const obs of observations) {
    const wasActive = linkActive[obs.linkKey] ?? false;
    const nowActive = wasActive
      ? obs.baselineDeviation > thresholds.motionOffThreshold
      : obs.baselineDeviation >= thresholds.motionOnThreshold;

    if (nowActive && !wasActive) {
      activeSinceMs[obs.linkKey] = timeMs;
    } else if (!nowActive) {
      delete activeSinceMs[obs.linkKey];
    }
    linkActive[obs.linkKey] = nowActive;
  }

  const activeLinks = Object.keys(linkActive).filter((k) => linkActive[k]);
  const anyActive = activeLinks.length > 0;

  const multiOccupancy = detectMultiOccupancy(
    activeLinks,
    activeSinceMs,
    thresholds.crossNodeSimultaneityThresholdMs,
  );

  // 2. Whole-house FSM.
  //
  // Computed from continuous elapsed time (not "how many ticks have gone
  // by"), so a run with sparse/irregular ticks still reaches the correct
  // state in one step rather than needing to visit every intermediate
  // state — e.g. a single tick whose timestamp is already well past the
  // decay horizon should land directly on UNOCCUPIED, not get stuck one
  // step behind at DECAYING.
  let lastEstimateChangeAtMs = prev.lastEstimateChangeAtMs;
  let lastMotionAtMs = prev.lastMotionAtMs;
  if (anyActive) lastMotionAtMs = timeMs;

  const hysteresisElapsed =
    lastEstimateChangeAtMs === null || timeMs - lastEstimateChangeAtMs >= thresholds.hysteresisMs;

  const withinDecayHorizon =
    lastMotionAtMs !== null && timeMs - lastMotionAtMs < thresholds.latchDecayHorizonMs;

  // The state the evidence alone (ignoring hysteresis) would justify right now.
  const rawState: OccupancyState = anyActive ? 'OCCUPIED' : withinDecayHorizon ? 'DECAYING' : 'UNOCCUPIED';

  const wasReportedOccupied = prev.state !== 'UNOCCUPIED'; // i.e. previously-reported estimate was >= 1
  const rawReportedOccupied = rawState !== 'UNOCCUPIED';

  let state: OccupancyState;
  if (rawReportedOccupied !== wasReportedOccupied) {
    // Evidence wants to flip the *reported* estimate across 0 <-> 1+.
    if (hysteresisElapsed) {
      state = rawState;
      lastEstimateChangeAtMs = timeMs;
    } else {
      // Suppressed: hold the previous reported bucket (flapping guard).
      state = wasReportedOccupied ? 'DECAYING' : 'UNOCCUPIED';
    }
  } else {
    // No reported-estimate change — free to move within the same bucket
    // (OCCUPIED <-> DECAYING), no hysteresis gate needed.
    state = rawState;
  }

  // 3. Estimate + confidence.
  // The 2+ heuristic only applies while there is *current* active,
  // simultaneous evidence (state === 'OCCUPIED') — once motion stops
  // (DECAYING/UNOCCUPIED), there is no live simultaneity signal to justify
  // a 2+ claim, so it is honest to fall back to "at least 1" or "0".
  const estimate: 0 | 1 | 2 =
    state === 'UNOCCUPIED' ? 0 : state === 'OCCUPIED' && multiOccupancy.detected ? 2 : 1;

  const dataSufficiency =
    expectedLinkCount > 0 ? Math.min(1, observations.length / expectedLinkCount) : observations.length > 0 ? 1 : 0;

  const timeSinceLastMotionMs = lastMotionAtMs === null ? null : timeMs - lastMotionAtMs;
  const confidence = computeConfidence(
    state,
    estimate,
    dataSufficiency,
    timeSinceLastMotionMs,
    thresholds.latchDecayHorizonMs,
  );

  return {
    state: { state, lastEstimateChangeAtMs, lastMotionAtMs, linkActive, activeSinceMs },
    estimate,
    confidence,
    activeLinks,
    multiOccupancy,
    dataSufficiency,
  };
}
