/**
 * Windowed amplitude feature extraction pipeline: reads `csi_records` from
 * TimescaleDB, computes per-link (not per-node — see
 * docs/architecture.md "broadcast-sounding mesh") sliding-window amplitude
 * features per `config.features` (window/hop/subcarrier
 * selection/baseline adaptation), and writes them to the `features`
 * hypertable. Amplitude-first per docs/architecture.md — never assumes a
 * fixed subcarrier count or that phase is meaningful.
 *
 * Contract: see packages/cli/CONTRACTS.md ("features"). Owned by brief B4.
 */
export { runFeaturePipeline, runFeaturePipelineCore } from './pipeline.js';
export type {
  CsiRecordRow,
  CsiRecordSource,
  FeaturePipelineDeps,
  FeaturePipelineResult,
  FeatureRow,
  FeatureSink,
} from './pipeline.js';

export type { LinkFeatureVector, CsiSample } from './featureVector.js';
export { computeWindowFeature } from './featureVector.js';

export {
  parseCsiAmplitudes,
  selectSubcarriers,
  excludeNullSubcarriers,
  normalizeAmplitudes,
  isKnownCsiFormat,
  CsiParseError,
  SubcarrierSelectionError,
} from './csiParsing.js';
export type { ParsedCsi, SubcarrierSelection } from './csiParsing.js';

export { EmaBaseline } from './baseline.js';
export type { BaselineSnapshot, BaselineThresholds, BaselineUpdateResult } from './baseline.js';

export { buildWindows, alignToHopGrid } from './windowing.js';
export type { Window, TimedSample, WindowSpec } from './windowing.js';
