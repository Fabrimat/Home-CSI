import { computeWindowFeature, type CsiSample, type LinkFeatureVector } from '@homecsi/features';
import type { TakeWindow } from './takeWindow.js';
import type { BoxTakeRecord } from './preservation.js';

export const DEFAULT_K = 3;
export const DEFAULT_MIN_TAKES_PER_CLASS = 5;

/**
 * Scalar `LinkFeatureVector` fields used for the box classifier, reduced
 * from one take's per-link windows. Deliberately EXCLUDES
 * `baselineMean`/`baselineVariance`/`baselineDeviation`/`baselineFrozen`:
 * those are meaningful only across a continuous series of windows for the
 * same link (an adaptive EMA that tracks "normal" over time), but a take is
 * reduced to exactly ONE window per link with no prior history --
 * `computeWindowFeature`'s first-ever observation for an unseeded baseline
 * always seeds directly and reports `deviation = 0` (see
 * @homecsi/features' `EmaBaseline.update`), so those fields would carry
 * zero cross-take signal here, not a weaker version of it.
 */
const FEATURE_FIELDS = [
  'sampleCount',
  'meanSubcarrierVariance',
  'meanSubcarrierMad',
  'temporalVariance',
  'motionEnergy',
  'temporalCorrelation',
  'dopplerProxy',
  'meanRssi',
] as const satisfies readonly (keyof LinkFeatureVector)[];

/**
 * `computeWindowFeature` needs baseline options even though this path never
 * uses the resulting baseline-relative fields (see `FEATURE_FIELDS`'
 * comment) -- fixed constants, not exposed as tuning knobs, since nothing
 * downstream reads `baselineDeviation`/`baselineFrozen` from this path.
 */
const BASELINE_ADAPTATION_RATE = 0.1;
const BASELINE_THRESHOLDS = { motionOnThreshold: 3, motionOffThreshold: 1 };

function linkVectorToArray(vector: LinkFeatureVector): number[] {
  return FEATURE_FIELDS.map((field) => vector[field] as number);
}

/**
 * Reduces one take's preserved raw CSI records to a single fixed-length
 * feature vector, tolerant of a link being absent from this take and never
 * assuming a fixed subcarrier count (both requirements flow straight from
 * `@homecsi/features`' own parsing, which already derives layout from each
 * record's own `csi_format`/byte length).
 *
 * Groups records by (nodeId, linkMac) -- the same per-link identity
 * `@homecsi/features` uses -- and computes ONE window per link spanning the
 * take's whole trimmed span (`window`), via the same
 * `computeWindowFeature` the whole-house feature pipeline uses. Per-link
 * vectors are then aggregated ACROSS LINKS as elementwise mean and max,
 * concatenated -- fixed length regardless of how many (or which) links this
 * particular take happened to see, so a link being quiet (or a node being
 * offline) for one take never changes the vector's shape, only which links
 * fed into the aggregate.
 *
 * Returns `null` if no link in this take produced a usable window (e.g.
 * every record was corrupt/unknown-format) -- the caller should exclude
 * this take from training rather than feed in a fabricated vector.
 */
export function computeTakeFeatureVector(records: readonly BoxTakeRecord[], window: TakeWindow): number[] | null {
  const byLink = new Map<string, CsiSample[]>();
  for (const r of records) {
    if (r.timeMs < window.fromMs || r.timeMs >= window.toMs) continue;
    const key = `${r.nodeId}:${r.linkMac}`;
    const arr = byLink.get(key) ?? [];
    arr.push({ timeMs: r.timeMs, rssi: r.rssi, csiFormat: r.csiFormat, csiData: r.csiData });
    byLink.set(key, arr);
  }
  if (byLink.size === 0) return null;

  const perLinkVectors: number[][] = [];
  for (const samples of byLink.values()) {
    const result = computeWindowFeature(samples, {
      subcarrierSelection: 'all',
      baselineAdaptationRate: BASELINE_ADAPTATION_RATE,
      baselineThresholds: BASELINE_THRESHOLDS,
    });
    if (result === null) continue; // every record on this link was unusable
    perLinkVectors.push(linkVectorToArray(result.vector));
  }
  if (perLinkVectors.length === 0) return null;

  const n = FEATURE_FIELDS.length;
  const mean = new Array<number>(n).fill(0);
  const max = new Array<number>(n).fill(Number.NEGATIVE_INFINITY);
  for (const vec of perLinkVectors) {
    for (let i = 0; i < n; i++) {
      mean[i] = (mean[i] as number) + (vec[i] as number) / perLinkVectors.length;
      if ((vec[i] as number) > (max[i] as number)) max[i] = vec[i] as number;
    }
  }
  return [...mean, ...max];
}

export interface TakeExample {
  sessionId: number;
  gestureClass: string;
  vector: number[];
}

export interface ConfusionMatrix {
  /** Ordered, alphabetical class labels -- both the row and column order of `matrix`. */
  classes: string[];
  /** `matrix[trueIndex][predictedIndex]` -- counts, not fractions. */
  matrix: number[][];
}

export interface TrainReportOk {
  status: 'ok';
  k: number;
  takeCount: number;
  perClassCounts: Record<string, number>;
  accuracy: number;
  /** Fraction correct a classifier gets for free by always guessing the most frequent class. */
  majorityBaseline: number;
  /** 1 / number of classes -- chance accuracy for this many classes. */
  randomBaseline: number;
  confusion: ConfusionMatrix;
}

/**
 * Refused to report an accuracy figure at all -- below `minTakesPerClass`
 * usable takes for at least one class (or fewer than 2 classes present), a
 * number here would be noise wearing a percentage sign (see
 * docs/box-experiment.md).
 */
export interface TrainReportInsufficientData {
  status: 'insufficient-data';
  minTakesPerClass: number;
  perClassCounts: Record<string, number>;
  reason: string;
}

export type TrainReport = TrainReportOk | TrainReportInsufficientData;

function computeStats(vectors: readonly number[][]): { mean: number[]; sd: number[] } {
  const n = (vectors[0] as number[]).length;
  const mean = new Array<number>(n).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < n; i++) mean[i] = (mean[i] as number) + (v[i] as number) / vectors.length;
  }
  const variance = new Array<number>(n).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < n; i++) {
      const delta = (v[i] as number) - (mean[i] as number);
      variance[i] = (variance[i] as number) + (delta * delta) / vectors.length;
    }
  }
  // A feature that is exactly constant across the training fold would
  // otherwise divide by zero -- fall back to 1 (leaves that feature
  // un-scaled rather than producing NaN/Infinity distances).
  const sd = variance.map((v) => Math.sqrt(v) || 1);
  return { mean, sd };
}

function standardize(vector: readonly number[], stats: { mean: number[]; sd: number[] }): number[] {
  return vector.map((x, i) => (x - (stats.mean[i] as number)) / (stats.sd[i] as number));
}

function euclideanDistance(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] as number) - (b[i] as number);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Plain k-NN majority vote, nearest neighbours first for a deterministic tie-break (first-reached label among those tied for the most votes wins). */
function knnPredict(train: readonly { vector: number[]; label: string }[], target: readonly number[], k: number): string {
  const byDistance = [...train]
    .map((e) => ({ label: e.label, dist: euclideanDistance(e.vector, target) }))
    .sort((a, b) => a.dist - b.dist);
  const neighbors = byDistance.slice(0, Math.min(k, byDistance.length));

  const votes = new Map<string, number>();
  let bestLabel = neighbors[0]?.label ?? '';
  let bestCount = 0;
  for (const neighbor of neighbors) {
    const count = (votes.get(neighbor.label) ?? 0) + 1;
    votes.set(neighbor.label, count);
    if (count > bestCount) {
      bestCount = count;
      bestLabel = neighbor.label;
    }
  }
  return bestLabel;
}

/**
 * k-NN classifier with leave-one-take-out cross-validation, over one take
 * per example (`TakeExample`). Feature standardisation (z-score) is fit
 * PER FOLD from the training takes only (excluding the held-out take), to
 * avoid the held-out take leaking into its own normalisation.
 *
 * Honest reporting is a hard requirement (docs/box-experiment.md): below
 * `minTakesPerClass` usable takes for any class, or with fewer than 2
 * distinct classes, this refuses to compute an accuracy figure at all and
 * explains why, rather than reporting a number computed from too little
 * data. Otherwise it ALWAYS reports accuracy alongside the majority-class
 * and random-chance baselines, per-class take counts, and a confusion
 * matrix -- never accuracy alone.
 */
export function knnLeaveOneOut(examples: readonly TakeExample[], k: number, minTakesPerClass: number): TrainReport {
  const perClassCounts: Record<string, number> = {};
  for (const e of examples) perClassCounts[e.gestureClass] = (perClassCounts[e.gestureClass] ?? 0) + 1;
  const classes = Object.keys(perClassCounts).sort();

  if (classes.length < 2) {
    return {
      status: 'insufficient-data',
      minTakesPerClass,
      perClassCounts,
      reason: `need at least 2 distinct gesture classes with usable takes to report an accuracy figure; found ${classes.length}.`,
    };
  }

  const shortfallClass = classes.find((c) => (perClassCounts[c] as number) < minTakesPerClass);
  if (shortfallClass !== undefined) {
    return {
      status: 'insufficient-data',
      minTakesPerClass,
      perClassCounts,
      reason:
        `class "${shortfallClass}" has only ${perClassCounts[shortfallClass]} usable take(s), below the ` +
        `configured minimum of ${minTakesPerClass} per class -- an accuracy figure from this few examples is ` +
        `noise wearing a percentage sign.`,
    };
  }

  const matrix = classes.map(() => classes.map(() => 0));
  let correct = 0;
  for (let i = 0; i < examples.length; i++) {
    const held = examples[i] as TakeExample;
    const train = examples.filter((_, idx) => idx !== i);
    const stats = computeStats(train.map((e) => e.vector));
    const trainStd = train.map((e) => ({ label: e.gestureClass, vector: standardize(e.vector, stats) }));
    const heldStd = standardize(held.vector, stats);

    const predicted = knnPredict(trainStd, heldStd, k);
    if (predicted === held.gestureClass) correct++;
    const row = matrix[classes.indexOf(held.gestureClass)] as number[];
    const col = classes.indexOf(predicted);
    row[col] = (row[col] as number) + 1;
  }

  const accuracy = correct / examples.length;
  const majorityBaseline = Math.max(...classes.map((c) => perClassCounts[c] as number)) / examples.length;
  const randomBaseline = 1 / classes.length;

  return {
    status: 'ok',
    k,
    takeCount: examples.length,
    perClassCounts,
    accuracy,
    majorityBaseline,
    randomBaseline,
    confusion: { classes, matrix },
  };
}

/** Renders a `TrainReport` as human-readable text for CLI output. */
export function formatTrainReport(report: TrainReport): string {
  if (report.status === 'insufficient-data') {
    const counts = Object.entries(report.perClassCounts)
      .map(([c, n]) => `${c}=${n}`)
      .join(', ');
    return (
      `refusing to report an accuracy figure: ${report.reason}\n` +
      `per-class usable take counts: ${counts || '(none)'}\n` +
      `(configured minimum: ${report.minTakesPerClass} takes per class)`
    );
  }

  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const counts = Object.entries(report.perClassCounts)
    .map(([c, n]) => `${c}=${n}`)
    .join(', ');

  const { classes, matrix } = report.confusion;
  const header = ['true\\pred', ...classes].join('\t');
  const rows = classes.map((c, i) => [c, ...(matrix[i] as number[]).map(String)].join('\t'));

  return [
    `k-NN (k=${report.k}) leave-one-take-out accuracy: ${pct(report.accuracy)} over ${report.takeCount} takes`,
    `majority-class baseline: ${pct(report.majorityBaseline)}  |  random-chance baseline (${classes.length} classes): ${pct(report.randomBaseline)}`,
    `per-class usable take counts: ${counts}`,
    'confusion matrix (rows = true class, columns = predicted):',
    header,
    ...rows,
  ].join('\n');
}
