/**
 * Latched occupancy state machine pipeline: reads the `features`
 * hypertable, integrates motion transitions per `config.occupancy`
 * (thresholds, latch decay horizon, hysteresis, cross-node simultaneity
 * threshold for the 2+ stretch goal), and writes results to the
 * `occupancy_states` hypertable as a *sparse event log* — one row per
 * transition plus a periodic keepalive, never one row per tick (see
 * README.md for the full write semantics). See docs/architecture.md
 * ("Motion, not people") for why this is a latched state machine, not a
 * per-window classifier, and stateMachine.ts for the machine itself.
 *
 * Contract: see packages/cli/CONTRACTS.md ("occupancy"). Owned by brief B4.
 */
export {
  createPgOccupancySink,
  KEEPALIVE_INTERVAL_MS,
  runOccupancyPipeline,
  runOccupancyPipelineCore,
} from './pipeline.js';
export type {
  FeatureRow,
  FeatureSource,
  LastWrittenRow,
  OccupancyCheckpoint,
  OccupancyDetails,
  OccupancyPipelineDeps,
  OccupancyPipelineResult,
  OccupancyRowKind,
  OccupancySink,
  OccupancyStateRow,
} from './pipeline.js';

export { INITIAL_LATCH_STATE, stepLatch } from './stateMachine.js';
export type {
  LatchState,
  LatchStepResult,
  LatchThresholds,
  LinkObservation,
  MultiOccupancyResult,
  OccupancyState,
} from './stateMachine.js';
