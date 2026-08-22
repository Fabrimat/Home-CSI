import { isWeakLabel } from './sessions.js';

/** A ground-truth label reduced to what dataset export needs. */
export interface LabelForExport {
  timeMs: number;
  occupancyCount: number;
  notes: string | null;
}

/** A `features` hypertable row reduced to the scalars this export cares about (see @homecsi/features LinkFeatureVector for the full, per-link vector). */
export interface FeatureSampleForExport {
  timeMs: number;
  nodeId: number;
  linkMac: string;
  baselineDeviation: number;
  motionEnergy: number;
  temporalCorrelation: number;
  dopplerProxy: number;
}

/**
 * One row of the flat, model-ready CSV. Per-link raw features remain
 * available in the `features` table for anyone who wants finer granularity
 * later — this export reduces to whole-house summary statistics at each
 * label's timestamp so the schema is stable regardless of how many links a
 * given deployment happens to have (4 nodes vs 9 nodes, some nodes
 * temporarily offline, etc.).
 */
export interface DatasetRow {
  timestampIso: string;
  /** "manual" (label_sessions/labels entered by hand) or "weak" (derived from phone-presence probing, see presence.ts) — kept as a column so training can weight/filter by label quality. */
  labelSource: 'manual' | 'weak';
  occupancyCount: number;
  linkCountObserved: number;
  activeLinkCount: number;
  maxBaselineDeviation: number;
  meanBaselineDeviation: number;
  maxMotionEnergy: number;
  meanMotionEnergy: number;
  meanTemporalCorrelation: number;
  meanDopplerProxy: number;
}

export interface JoinResult {
  rows: DatasetRow[];
  /** Labels that had no feature data within `toleranceMs` of their timestamp, and were therefore dropped rather than exported with fabricated/misleading feature values. */
  skippedLabelCount: number;
}

/**
 * Joins labels to the nearest feature observation per link within
 * `toleranceMs`, then reduces each label's link observations to a fixed
 * set of whole-house summary columns (see DatasetRow doc).
 * `motionOnThreshold` is only used to compute `activeLinkCount` (a link
 * counts as "active" for this purpose using the same threshold the
 * occupancy state machine uses, for consistency).
 */
export function joinLabelsWithFeatures(
  labels: readonly LabelForExport[],
  features: readonly FeatureSampleForExport[],
  toleranceMs: number,
  motionOnThreshold: number,
): JoinResult {
  const rows: DatasetRow[] = [];
  let skippedLabelCount = 0;

  for (const label of labels) {
    const nearby = features.filter((f) => Math.abs(f.timeMs - label.timeMs) <= toleranceMs);
    if (nearby.length === 0) {
      skippedLabelCount++;
      continue;
    }

    // Nearest sample per link (a link may have multiple windows within tolerance).
    const nearestByLink = new Map<string, FeatureSampleForExport>();
    for (const sample of nearby) {
      const key = `${sample.nodeId}:${sample.linkMac}`;
      const existing = nearestByLink.get(key);
      if (!existing || Math.abs(sample.timeMs - label.timeMs) < Math.abs(existing.timeMs - label.timeMs)) {
        nearestByLink.set(key, sample);
      }
    }
    const perLink = [...nearestByLink.values()];

    const deviations = perLink.map((s) => s.baselineDeviation);
    const energies = perLink.map((s) => s.motionEnergy);
    const correlations = perLink.map((s) => s.temporalCorrelation);
    const dopplers = perLink.map((s) => s.dopplerProxy);

    rows.push({
      timestampIso: new Date(label.timeMs).toISOString(),
      labelSource: isWeakLabel(label.notes) ? 'weak' : 'manual',
      occupancyCount: label.occupancyCount,
      linkCountObserved: perLink.length,
      activeLinkCount: deviations.filter((d) => d >= motionOnThreshold).length,
      maxBaselineDeviation: Math.max(...deviations),
      meanBaselineDeviation: average(deviations),
      maxMotionEnergy: Math.max(...energies),
      meanMotionEnergy: average(energies),
      meanTemporalCorrelation: average(correlations),
      meanDopplerProxy: average(dopplers),
    });
  }

  return { rows, skippedLabelCount };
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export interface TemporalSplitResult {
  train: DatasetRow[];
  test: DatasetRow[];
}

/**
 * Splits rows into train/test by TIME, not a random shuffle.
 *
 * Why: this is a time series with strong short-range autocorrelation —
 * adjacent windows overlap (features.hopMs < features.windowMs) and
 * whole-house occupancy state changes slowly relative to the label rate.
 * A random shuffle would routinely put a window's near-duplicate neighbour
 * on the other side of the split, letting a model "cheat" by memorizing
 * essentially-the-same-moment examples instead of generalizing, and would
 * leak future information into training relative to a chronologically
 * earlier test set — overstating real-world accuracy. Splitting
 * chronologically (train = past, test = future) approximates how the
 * model will actually be used: trained on history, evaluated on data it
 * could not have seen yet.
 */
export function temporalSplit(rows: readonly DatasetRow[], trainRatio: number): TemporalSplitResult {
  const sorted = [...rows].sort((a, b) => a.timestampIso.localeCompare(b.timestampIso));
  const splitIndex = Math.floor(sorted.length * trainRatio);
  return { train: sorted.slice(0, splitIndex), test: sorted.slice(splitIndex) };
}

const CSV_COLUMNS: Array<keyof DatasetRow> = [
  'timestampIso',
  'labelSource',
  'occupancyCount',
  'linkCountObserved',
  'activeLinkCount',
  'maxBaselineDeviation',
  'meanBaselineDeviation',
  'maxMotionEnergy',
  'meanMotionEnergy',
  'meanTemporalCorrelation',
  'meanDopplerProxy',
];

export function toCsv(rows: readonly DatasetRow[]): string {
  const header = CSV_COLUMNS.join(',');
  const lines = rows.map((row) => CSV_COLUMNS.map((col) => String(row[col])).join(','));
  return [header, ...lines].join('\n') + '\n';
}

export function generateTrainingReadme(options: {
  totalLabels: number;
  skippedLabelCount: number;
  trainRowCount: number;
  testRowCount: number;
  trainRatio: number;
  toleranceMs: number;
}): string {
  return `# Home CSI training export

Generated by \`homecsi train\` (packages/labeling, brief B4). This directory
contains a flat, model-ready dataset joining ground-truth occupancy labels
(\`label_sessions\`/\`labels\`) against windowed amplitude features
(\`features\`, see @homecsi/features for exactly how each column is
computed).

## Files

- \`train.csv\` — ${options.trainRowCount} rows, the chronologically earlier
  ${(options.trainRatio * 100).toFixed(0)}% of labelled examples.
- \`test.csv\` — ${options.testRowCount} rows, the chronologically later
  ${((1 - options.trainRatio) * 100).toFixed(0)}%.

**The split is by TIME, not a random shuffle** — train is strictly earlier
than test. Do not re-shuffle these files together and re-split randomly:
adjacent windows in this dataset are highly autocorrelated (overlapping
sliding windows, slowly-changing occupancy state), so a random split lets a
model memorize near-duplicate neighbours across the train/test boundary and
reports misleadingly high accuracy. Evaluating on the chronologically later
data approximates how the model will actually be used: trained on history,
tested on the future.

Of ${options.totalLabels} total labels, ${options.skippedLabelCount} were
skipped because no feature data existed within ${options.toleranceMs}ms of
the label's timestamp (e.g. gaps in feature-pipeline coverage).

## Columns

- \`timestampIso\` — label timestamp, ISO-8601 UTC.
- \`labelSource\` — \`manual\` (entered via \`homecsi label add\`) or \`weak\`
  (derived from phone-presence probing, see packages/labeling/src/presence.ts).
  Weak labels are noisier ground truth; consider weighting or filtering by
  this column during training.
- \`occupancyCount\` — ground truth, same 0/1/2+ scale as
  \`occupancy_states.estimate\`.
- \`linkCountObserved\` — number of distinct (node, link) vantage points
  that had a feature window within the join tolerance of this label.
- \`activeLinkCount\` — of those, how many had baselineDeviation at/above
  \`occupancy.thresholds.motionOnThreshold\` (same threshold the v1 latch
  uses).
- \`max/meanBaselineDeviation\` — the primary motion signal (see
  @homecsi/features), summarised across links.
- \`max/meanMotionEnergy\` — pre-baseline-normalisation fluctuation
  magnitude, summarised across links.
- \`meanTemporalCorrelation\` — mean lag-1 autocorrelation across links (near
  1 = static channel, lower = motion-driven decorrelation).
- \`meanDopplerProxy\` — mean crude spectral-fluctuation proxy across links
  (NOT an FFT-based Doppler estimate — see @homecsi/features dsp.ts).

Per-link (rather than whole-house-summarised) raw feature vectors remain
queryable directly from the \`features\` hypertable if a future iteration
wants finer-grained model inputs.

## Training (outside Node)

Per docs/roadmap.md ("Trained-model inference"), training happens outside
Node — this package only exports data, it never trains a model in-process.
A minimal starting point in Python:

\`\`\`python
import pandas as pd
from sklearn.ensemble import RandomForestClassifier

train = pd.read_csv("train.csv")
test = pd.read_csv("test.csv")

feature_cols = [
    "linkCountObserved", "activeLinkCount",
    "maxBaselineDeviation", "meanBaselineDeviation",
    "maxMotionEnergy", "meanMotionEnergy",
    "meanTemporalCorrelation", "meanDopplerProxy",
]

model = RandomForestClassifier()
model.fit(train[feature_cols], train["occupancyCount"])
print(model.score(test[feature_cols], test["occupancyCount"]))
\`\`\`

## Bringing a trained model back (future work)

Export the trained model to **ONNX** (e.g. \`skl2onnx\`/\`sklearn-onnx\` for
scikit-learn, or the framework's native ONNX exporter) and either load it
from a small Node inference step alongside the existing pipeline, or serve
it from a narrow Python sidecar the occupancy pipeline calls into — see
docs/roadmap.md ("Trained-model inference") for the deferred decision on
which. A trained model would primarily refine the 2+ stretch-goal estimate
and confidence; it does not replace the v1 latched state machine's role as
the 0-vs-1+ safety net.
`;
}
