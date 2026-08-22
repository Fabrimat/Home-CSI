import type { BaselineSnapshot, BaselineThresholds } from './baseline.js';
import { EmaBaseline } from './baseline.js';
import {
  CsiParseError,
  SubcarrierSelectionError,
  excludeNullSubcarriers,
  normalizeAmplitudes,
  parseCsiAmplitudes,
  selectSubcarriers,
  type SubcarrierSelection,
} from './csiParsing.js';
import { dopplerProxy, laggedAutocorrelation, mean, medianAbsoluteDeviation, variance } from './dsp.js';

/** One raw CSI record, reduced to just what the feature pipeline needs. */
export interface CsiSample {
  timeMs: number;
  rssi: number;
  csiFormat: number;
  csiData: Buffer;
}

/**
 * The per-link, per-window feature vector persisted to the `features`
 * hypertable's `feature_vector` jsonb column.
 *
 * Units: every amplitude-derived quantity below is computed *after*
 * per-record RMS normalisation (see csiParsing.normalizeAmplitudes), so raw
 * ESP32 amplitude units (unitless sqrt(I^2+Q^2) ADC counts) have already
 * been divided out — these are all dimensionless "relative to this
 * record's own overall channel gain" numbers, comparable across time and
 * AGC gain steps. `baselineDeviation` is expressed in the adaptive
 * baseline's own standard-deviation units, which is what
 * `occupancy.thresholds.motionOn/OffThreshold` are calibrated against.
 */
export interface LinkFeatureVector {
  /** Number of CSI records aggregated into this window. */
  sampleCount: number;
  /** Subcarrier count of the most recent record in this window — documents that layout is record/format-dependent, not a pipeline constant. */
  subcarrierCount: number;
  /** Average, across this window's records, of the per-record variance of (normalised, selected) amplitude across subcarriers — a frequency-domain / spatial fluctuation measure. */
  meanSubcarrierVariance: number;
  /** Average, across this window's records, of the per-record median absolute deviation of amplitude across subcarriers — a robust counterpart to meanSubcarrierVariance. */
  meanSubcarrierMad: number;
  /** Variance, across this window's records, of each record's own mean amplitude — a time-domain fluctuation measure. */
  temporalVariance: number;
  /** Combined scalar motion-energy summary for this window (temporalVariance + meanSubcarrierVariance) — this is the value the adaptive baseline tracks. */
  motionEnergy: number;
  /** Lag-1 autocorrelation of the per-record mean-amplitude series across the window. Near 1 = static channel; drops as motion decorrelates the channel over time. Dimensionless, range [-1, 1]. */
  temporalCorrelation: number;
  /** Crude, irregular-sampling-tolerant proxy for spectral spread / Doppler width of the amplitude fluctuation (see dsp.ts dopplerProxy) — NOT an FFT-based estimate. Dimensionless. */
  dopplerProxy: number;
  /** Adaptive baseline mean of motionEnergy for this link, as of (and including) this window — persisted so pipeline runs can resume without a separate checkpoint table. */
  baselineMean: number;
  /** Adaptive baseline variance of motionEnergy for this link. */
  baselineVariance: number;
  /** (motionEnergy - baselineMean) / sqrt(baselineVariance) — the PRIMARY motion signal. This is what `occupancy.thresholds.motionOnThreshold` / `motionOffThreshold` are compared against downstream. */
  baselineDeviation: number;
  /** True if this window's motionEnergy was locally classified as motion, and the baseline EMA was therefore *not* updated from it (see docs/architecture.md — baseline must not adapt while motion is present). */
  baselineFrozen: boolean;
  /** Mean RSSI (dBm) across this window's records — diagnostic context, not used in the motion math (amplitude is already normalised independently of RSSI). */
  meanRssi: number;
}

export interface ComputeWindowFeatureResult {
  vector: LinkFeatureVector;
  baselineSnapshot: BaselineSnapshot;
  /** Records in this window whose csi_data could not be parsed/selected (corrupt, unknown format, or an out-of-range explicit subcarrier selection) — dropped from the computation, counted for observability. */
  droppedSampleCount: number;
}

export interface ComputeWindowFeatureOptions {
  subcarrierSelection: SubcarrierSelection;
  baselineAdaptationRate: number;
  baselineThresholds: BaselineThresholds;
  /** Baseline state carried over from a previous window/run for this link, if any. */
  previousBaseline?: BaselineSnapshot;
}

interface PerRecordStats {
  meanAmplitude: number;
  subcarrierVariance: number;
  subcarrierMad: number;
  subcarrierCount: number;
  rssi: number;
}

/**
 * Parses, sanitises (drops corrupt/unknown-format/null-subcarrier-only
 * records, validates any explicit subcarrier selection against this
 * record's actual layout) and reduces one CSI record to the small set of
 * per-record scalars the window-level statistics are built from. Returns
 * `null` for a record that should be dropped, rather than throwing —
 * dropping a single bad record must not fail the whole window.
 */
function reduceSample(
  sample: CsiSample,
  selection: SubcarrierSelection,
): PerRecordStats | null {
  let parsed;
  try {
    parsed = parseCsiAmplitudes(sample.csiData, sample.csiFormat);
  } catch (err) {
    if (err instanceof CsiParseError) return null;
    throw err;
  }

  const nonNull = excludeNullSubcarriers(parsed);
  if (nonNull.length === 0) return null;

  let selected;
  try {
    selected = selectSubcarriers(nonNull, selection, nonNull.length);
  } catch (err) {
    if (err instanceof SubcarrierSelectionError) return null;
    throw err;
  }
  if (selected.length === 0) return null;

  const normalized = normalizeAmplitudes(selected);
  const values = Array.from(normalized);

  return {
    meanAmplitude: mean(values),
    subcarrierVariance: variance(values),
    subcarrierMad: medianAbsoluteDeviation(values),
    subcarrierCount: parsed.subcarrierCount,
    rssi: sample.rssi,
  };
}

/**
 * Computes the full feature vector for one link's one window, and advances
 * that link's adaptive baseline exactly once (using this window's
 * `motionEnergy`). This is the single place that ties together parsing,
 * sanitisation, the temporal/spectral/spatial statistics, and the
 * baseline-relative deviation that is the primary motion signal.
 */
export function computeWindowFeature(
  samples: readonly CsiSample[],
  options: ComputeWindowFeatureOptions,
): ComputeWindowFeatureResult | null {
  const perRecord: PerRecordStats[] = [];
  let dropped = 0;
  for (const sample of samples) {
    const stats = reduceSample(sample, options.subcarrierSelection);
    if (stats === null) {
      dropped++;
      continue;
    }
    perRecord.push(stats);
  }

  if (perRecord.length === 0) {
    // Every record in this window was unusable — no feature can be honestly computed.
    return null;
  }

  const meanAmplitudeSeries = perRecord.map((r) => r.meanAmplitude);
  const meanSubcarrierVariance = mean(perRecord.map((r) => r.subcarrierVariance));
  const meanSubcarrierMad = mean(perRecord.map((r) => r.subcarrierMad));
  const temporalVarianceValue = variance(meanAmplitudeSeries);
  const motionEnergy = temporalVarianceValue + meanSubcarrierVariance;
  const temporalCorrelation = laggedAutocorrelation(meanAmplitudeSeries);
  const doppler = dopplerProxy(meanAmplitudeSeries);
  const meanRssi = mean(perRecord.map((r) => r.rssi));
  const subcarrierCount = perRecord[perRecord.length - 1]!.subcarrierCount;

  const baseline = new EmaBaseline(options.baselineAdaptationRate, options.previousBaseline);
  const { deviation, motionActive, snapshot } = baseline.update(motionEnergy, options.baselineThresholds);

  const vector: LinkFeatureVector = {
    sampleCount: perRecord.length,
    subcarrierCount,
    meanSubcarrierVariance,
    meanSubcarrierMad,
    temporalVariance: temporalVarianceValue,
    motionEnergy,
    temporalCorrelation,
    dopplerProxy: doppler,
    baselineMean: snapshot.mean,
    baselineVariance: snapshot.variance,
    baselineDeviation: deviation,
    baselineFrozen: motionActive,
    meanRssi,
  };

  return { vector, baselineSnapshot: snapshot, droppedSampleCount: dropped };
}
