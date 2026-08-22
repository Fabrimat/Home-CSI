import { isWeakLabel, type LabelSource } from './sessions.js';

/** A ground-truth label reduced to what dataset export needs. */
export interface LabelForExport {
  labelId: number;
  timeMs: number;
  /**
   * EXCLUSIVE end of the labelled interval, or `null` for a point label
   * (migration 008, mirrors `sessions.ts`'s `LabelRow.endTimeMs`). A point
   * label is joined to the single nearest feature sample per link within
   * `toleranceMs`; an interval label is expanded into one row per
   * hop-grid tick inside `[timeMs, endTimeMs)` — see `joinLabelsWithFeatures`.
   */
  endTimeMs: number | null;
  occupancyCount: number;
  /** Real provenance (migration 008's `labels.source` column) — see `resolveLabelSource` below for how this combines with the legacy notes-prefix convention. */
  source: LabelSource;
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
 * One row of the flat, model-ready CSV. Per-link raw features are NOT kept
 * indefinitely in the `features` table — it has only a 7-day retention
 * policy (docs/architecture.md "Data lifecycle", migration 007). Anyone
 * wanting finer per-link granularity for a MANUAL label session older than
 * that should look at `training_features` instead (preserved deliberately
 * at session close / via `homecsi label preserve`, see
 * trainingPreservation.ts), not `features` directly. This export itself
 * reduces to whole-house summary statistics at each **tick** (see
 * `joinLabelsWithFeatures`) so the schema is stable regardless of how many
 * links a given deployment happens to have (4 nodes vs 9 nodes, some nodes
 * temporarily offline, etc.).
 */
export interface DatasetRow {
  timestampIso: string;
  /**
   * Which `labels` row produced this DatasetRow. Multiple DatasetRows share
   * a `labelId` when the label is an interval spanning several hop-grid
   * ticks (see `joinLabelsWithFeatures`). This is the join key a training
   * script needs to (a) reweight so one long human drag doesn't dominate
   * (`sample_weight = 1 / rows_for_that_label`), (b) do grouped
   * cross-validation so a single judgement never leaks across a CV fold
   * boundary, and (c) reconstruct which rows came from the same underlying
   * human decision at all — none of which can be reconstructed after the
   * fact from `timestampIso` alone once a CSV has shipped.
   */
  labelId: number;
  /** `endTimeMs - timeMs` for an interval label, or 0 for a point label — lets a training script tell "one instant" apart from "an hour-long drag" without re-deriving it from counting sibling rows. */
  labelDurationMs: number;
  /** Real provenance (`labels.source`, migration 008) — see `resolveLabelSource`. Kept as the full `LabelSource` union (not collapsed to a manual/weak boolean) so training can filter/weight by `'confirmed'` vs `'training'` vs `'manual'` vs `'weak:phone-presence'` independently. */
  labelSource: LabelSource;
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

/**
 * Per-label reporting of how much of a label's data actually made it into
 * `rows` — see `joinLabelsWithFeatures`'s doc comment for why this exists
 * as a third bucket distinct from "joined" and "skipped".
 */
export interface LabelCoverage {
  labelId: number;
  /** How many DatasetRows this label produced. 0 means this label is counted in `skippedLabelCount`. */
  rowsEmitted: number;
  /**
   * For an interval label, the number of hop-grid ticks expected across
   * `[timeMs, endTimeMs)` given `hopMs` (rounded — the label's boundaries
   * are wall-clock times chosen by a human, not necessarily hop-grid
   * aligned). `null` for a point label: there is no span to divide, so
   * "expected ticks" is not a meaningful question.
   */
  expectedTicks: number | null;
  /**
   * `rowsEmitted / expectedTicks` for an interval label, capped at 1 (a
   * label slightly misaligned with the hop grid can otherwise round up to
   * one more expected tick than actually exists). `null` for a point label
   * — a point label's outcome is binary (joined or skipped), not a
   * fraction of an expected span.
   */
  coverageFraction: number | null;
}

export interface JoinResult {
  rows: DatasetRow[];
  /** Labels that had no feature data within `toleranceMs` (point) / anywhere inside their span (interval), and were therefore dropped rather than exported with fabricated/misleading feature values. */
  skippedLabelCount: number;
  /** One entry per input label, same order as `labels`. */
  coverage: LabelCoverage[];
  /**
   * Count of interval labels that produced at least one row but with
   * `coverageFraction < 1` — i.e. neither cleanly joined (full span
   * covered) nor skipped (zero rows). A 6-hour correction that only
   * yielded 40 minutes of data (say, because the feature pipeline was down
   * for the rest of it) falls in this bucket: the operator needs to see
   * that number, not have it silently disappear into either of the other
   * two counters.
   */
  partiallyCoveredIntervalCount: number;
  /**
   * Number of ticks claimed by more than one label with DIFFERING
   * `occupancyCount` values. Labels are append-only (no delete, and
   * `PATCH /api/labels/:id` only ever touches `end_time`), so the only way
   * an operator can fix a wrong judgement -- a fat-fingered count, or a
   * "confirm correct" they immediately realise was wrong -- is to label
   * the same span again. That means overlapping, contradictory labels over
   * the same tick(s) are an expected occurrence, not a data-integrity bug.
   * Resolved deterministically (highest `labelId` wins, see
   * `resolveTickConflicts`) rather than emitted twice or averaged; this
   * count is how an operator (or a training script) can tell how often
   * that resolution actually fired.
   */
  conflictingTickCount: number;
  /** `labelId`s that were on EITHER side of at least one conflicting tick (the label that won, and every label it superseded there), sorted ascending -- the per-label breakdown for `conflictingTickCount`. */
  conflictingLabelIds: number[];
}

/**
 * `label.source` (migration 008) is the authoritative provenance signal.
 * `WEAK_LABEL_PREFIX`/`isWeakLabel` (sessions.ts) is kept ONLY as a
 * fallback for a label whose `source` still reads the pre-008 default
 * (`'manual'`) despite its notes carrying the old weak-label convention —
 * e.g. a row read from a cache/export produced before migration 008's
 * backfill ran, or a caller that hasn't been updated to pass `source`
 * explicitly. Once every caller and every existing row is on the `source`
 * column (which migration 008 backfills for pre-existing rows), this
 * fallback should never actually fire — it is defense-in-depth, not the
 * primary mechanism.
 */
function resolveLabelSource(label: LabelForExport): LabelSource {
  if (label.source !== 'manual') return label.source;
  return isWeakLabel(label.notes) ? 'weak:phone-presence' : 'manual';
}

/** Nearest feature sample per (node, link) to `referenceMs`, from a set already filtered to within tolerance. */
function nearestPerLink(
  samples: readonly FeatureSampleForExport[],
  referenceMs: number,
): FeatureSampleForExport[] {
  const nearestByLink = new Map<string, FeatureSampleForExport>();
  for (const sample of samples) {
    const key = `${sample.nodeId}:${sample.linkMac}`;
    const existing = nearestByLink.get(key);
    if (!existing || Math.abs(sample.timeMs - referenceMs) < Math.abs(existing.timeMs - referenceMs)) {
      nearestByLink.set(key, sample);
    }
  }
  return [...nearestByLink.values()];
}

/**
 * Reduces one tick's (or one point label's nearest-sample) per-link feature
 * rows to a single DatasetRow of whole-house summary statistics.
 */
function buildRow(
  label: LabelForExport,
  tickMs: number,
  linkSamplesRaw: readonly FeatureSampleForExport[],
  motionOnThreshold: number,
): DatasetRow {
  // Defensive per-link dedup: normally each link contributes at most one
  // sample per exact tick timestamp already (callers either pre-dedup via
  // nearestPerLink, or group by exact shared timestamp the same way
  // occupancy/pipeline.ts's `byTick` does), but a duplicate insert should
  // never silently double-count a link in the summary stats below.
  const perLink = new Map<string, FeatureSampleForExport>();
  for (const s of linkSamplesRaw) perLink.set(`${s.nodeId}:${s.linkMac}`, s);
  const linkSamples = [...perLink.values()];

  const deviations = linkSamples.map((s) => s.baselineDeviation);
  const energies = linkSamples.map((s) => s.motionEnergy);
  const correlations = linkSamples.map((s) => s.temporalCorrelation);
  const dopplers = linkSamples.map((s) => s.dopplerProxy);

  return {
    timestampIso: new Date(tickMs).toISOString(),
    labelId: label.labelId,
    labelDurationMs: label.endTimeMs === null ? 0 : label.endTimeMs - label.timeMs,
    labelSource: resolveLabelSource(label),
    occupancyCount: label.occupancyCount,
    linkCountObserved: linkSamples.length,
    activeLinkCount: deviations.filter((d) => d >= motionOnThreshold).length,
    maxBaselineDeviation: Math.max(...deviations),
    meanBaselineDeviation: average(deviations),
    maxMotionEnergy: Math.max(...energies),
    meanMotionEnergy: average(energies),
    meanTemporalCorrelation: average(correlations),
    meanDopplerProxy: average(dopplers),
  };
}

/**
 * Joins labels to feature data and reduces each observation instant to a
 * fixed set of whole-house summary columns (see DatasetRow doc).
 * `motionOnThreshold` is only used to compute `activeLinkCount` (a link
 * counts as "active" for this purpose using the same threshold the
 * occupancy state machine uses, for consistency). `hopMs` is
 * `config.features.hopMs` — the feature pipeline's hop-grid spacing — used
 * only to compute each interval label's `expectedTicks` for coverage
 * reporting; it never affects which rows are emitted.
 *
 * Two very different join strategies, one per label shape:
 *
 * - **Point label** (`endTimeMs === null`): unchanged from pre-interval
 *   behaviour — nearest feature sample per link within `±toleranceMs` of
 *   the label's instant, producing exactly one DatasetRow (or zero, if
 *   nothing is within tolerance).
 * - **Interval label**: a human judgement over a stretch of time (a range
 *   correction, or one leg of a training-mode walk) should yield one
 *   training row per feature window actually observed inside that
 *   stretch, not one row for the whole stretch — otherwise almost all of
 *   the signal an interval label carries would be thrown away. Feature
 *   windows are computed on a shared hop-grid (see @homecsi/features
 *   windowing.ts and occupancy/src/pipeline.ts's `byTick` grouping, which
 *   this mirrors exactly): every features row sharing the same timestamp
 *   is one whole-house observation instant. So for an interval label, this
 *   function filters features to `[timeMs, endTimeMs)` (end EXCLUSIVE, per
 *   migration 008), groups the survivors by their exact shared timestamp,
 *   and emits one DatasetRow per group — a tick observed by 6 links
 *   produces ONE row with `linkCountObserved: 6`, never 6 near-duplicate
 *   single-link rows. `toleranceMs` does not apply here: there is no
 *   "nearest" to search for when the whole span is already being walked
 *   tick-by-tick.
 *
 * Coverage, not silent skipping: `skippedLabelCount` means "this label
 * produced zero rows" (no feature data anywhere in its tolerance/span).
 * That is a DIFFERENT situation from an interval label whose span had a
 * mid-window gap (e.g. the feature pipeline was down for an hour of a
 * six-hour correction) — that label is neither cleanly joined (full
 * coverage) nor skipped (zero rows), so `coverage`/`partiallyCoveredIntervalCount`
 * exist to surface it explicitly rather than have it disappear into either
 * bucket. Nothing here pads a gap with fabricated values, and nothing
 * silently drops a partially-covered interval's real rows.
 *
 * Overlapping, contradictory labels (append-only correction): labels can
 * never be deleted or have their `occupancyCount` replaced in place — the
 * only way an operator fixes a wrong judgement is to label the same span
 * again with a new row. So two labels' spans/ticks can legitimately
 * overlap with DIFFERENT `occupancyCount` values (a correction of a
 * correction, or a "confirm" the operator immediately took back). Every
 * label is still expanded into its own candidate rows independently
 * above/below; `resolveTickConflicts` then collapses same-tick candidates
 * across ALL labels — highest `labelId` wins (the most recently created
 * label is, by construction, the operator's most recent word on that
 * moment) — so the final `rows` never contains two rows for the same tick,
 * agreeing or not. See `conflictingTickCount`/`conflictingLabelIds` for
 * how that resolution is surfaced rather than silent.
 */
export function joinLabelsWithFeatures(
  labels: readonly LabelForExport[],
  features: readonly FeatureSampleForExport[],
  toleranceMs: number,
  motionOnThreshold: number,
  hopMs: number,
): JoinResult {
  // Candidate rows keyed by exact tick timestamp -- may hold more than one
  // entry per tick if labels overlap; resolved below.
  const candidatesByTick = new Map<number, DatasetRow[]>();
  const coverage: LabelCoverage[] = [];
  let skippedLabelCount = 0;
  let partiallyCoveredIntervalCount = 0;

  function addCandidate(tickMs: number, row: DatasetRow): void {
    const list = candidatesByTick.get(tickMs) ?? [];
    list.push(row);
    candidatesByTick.set(tickMs, list);
  }

  for (const label of labels) {
    if (label.endTimeMs === null) {
      // --- Point label: nearest sample per link within tolerance (unchanged behaviour) ---
      const nearby = features.filter((f) => Math.abs(f.timeMs - label.timeMs) <= toleranceMs);
      if (nearby.length === 0) {
        skippedLabelCount++;
        coverage.push({ labelId: label.labelId, rowsEmitted: 0, expectedTicks: null, coverageFraction: null });
        continue;
      }
      addCandidate(label.timeMs, buildRow(label, label.timeMs, nearestPerLink(nearby, label.timeMs), motionOnThreshold));
      coverage.push({ labelId: label.labelId, rowsEmitted: 1, expectedTicks: null, coverageFraction: null });
      continue;
    }

    // --- Interval label: one row per shared hop-grid tick inside [timeMs, endTimeMs) ---
    // Defensive: `endTimeMs > timeMs` should already be enforced at write
    // time (see index.ts's `label add --until` validation), but a
    // legacy/imported row could still violate it -- treat as producing no
    // rows rather than iterating a negative/zero span.
    const spanMs = label.endTimeMs - label.timeMs;
    if (spanMs <= 0) {
      skippedLabelCount++;
      coverage.push({ labelId: label.labelId, rowsEmitted: 0, expectedTicks: 0, coverageFraction: null });
      continue;
    }

    const inSpan = features.filter((f) => f.timeMs >= label.timeMs && f.timeMs < (label.endTimeMs as number));

    // Group by exact shared timestamp -- see occupancy/src/pipeline.ts's
    // `byTick`, whose grouping assumption (links align on the hop grid) is
    // reused here rather than re-derived.
    const byTick = new Map<number, FeatureSampleForExport[]>();
    for (const f of inSpan) {
      const list = byTick.get(f.timeMs) ?? [];
      list.push(f);
      byTick.set(f.timeMs, list);
    }
    const tickTimes = [...byTick.keys()].sort((a, b) => a - b);
    const expectedTicks = Math.max(1, Math.round(spanMs / hopMs));

    if (tickTimes.length === 0) {
      skippedLabelCount++;
      coverage.push({ labelId: label.labelId, rowsEmitted: 0, expectedTicks, coverageFraction: 0 });
      continue;
    }

    for (const tickMs of tickTimes) {
      addCandidate(tickMs, buildRow(label, tickMs, byTick.get(tickMs) as FeatureSampleForExport[], motionOnThreshold));
    }

    const coverageFraction = Math.min(1, tickTimes.length / expectedTicks);
    if (coverageFraction < 1) partiallyCoveredIntervalCount++;
    coverage.push({ labelId: label.labelId, rowsEmitted: tickTimes.length, expectedTicks, coverageFraction });
  }

  const { rows, conflictingTickCount, conflictingLabelIds } = resolveTickConflicts(candidatesByTick);

  return { rows, skippedLabelCount, coverage, partiallyCoveredIntervalCount, conflictingTickCount, conflictingLabelIds };
}

/**
 * Collapses same-tick candidate DatasetRows (produced when two labels'
 * spans overlap -- see `joinLabelsWithFeatures`'s doc comment) into exactly
 * one row per tick: the candidate with the HIGHEST `labelId`. That holds
 * whether or not the overlapping labels agree — two labels landing on the
 * same tick always collapse to one row (never two identical-looking rows
 * silently doubling that moment's weight in the dataset), and a tick is
 * additionally counted as "conflicting" only when the overlapping labels
 * actually DISAGREE on `occupancyCount` (agreement is not a data-integrity
 * problem worth flagging, just redundant corroboration).
 */
function resolveTickConflicts(candidatesByTick: ReadonlyMap<number, DatasetRow[]>): {
  rows: DatasetRow[];
  conflictingTickCount: number;
  conflictingLabelIds: number[];
} {
  const rows: DatasetRow[] = [];
  let conflictingTickCount = 0;
  const conflictingLabelIds = new Set<number>();

  const tickTimes = [...candidatesByTick.keys()].sort((a, b) => a - b);
  for (const tickMs of tickTimes) {
    const candidates = candidatesByTick.get(tickMs) as DatasetRow[];
    if (candidates.length === 1) {
      rows.push(candidates[0] as DatasetRow);
      continue;
    }

    const distinctCounts = new Set(candidates.map((c) => c.occupancyCount));
    if (distinctCounts.size > 1) {
      conflictingTickCount++;
      for (const c of candidates) conflictingLabelIds.add(c.labelId);
    }

    const winner = candidates.reduce((a, b) => (b.labelId > a.labelId ? b : a));
    rows.push(winner);
  }

  return { rows, conflictingTickCount, conflictingLabelIds: [...conflictingLabelIds].sort((a, b) => a - b) };
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
 *
 * EXTENSION for interval labels: the split boundary is chosen by whole
 * LABEL, not by row. Since `joinLabelsWithFeatures` now expands one
 * interval label into many DatasetRows sharing a `labelId`, splitting by
 * raw row position (as a naive `sort-then-slice` would) could cut a single
 * label's ticks across the boundary — putting the SAME human judgement,
 * plus its immediately-adjacent, heavily overlapping feature windows, on
 * both sides. That is exactly the leakage this function exists to
 * prevent, just at the label level instead of the individual-window level:
 * a model could "cheat" on a test row by having seen a training row from
 * one tick earlier carrying literally the same label. So rows are first
 * grouped by `labelId`, each label's rows sorted chronologically among
 * themselves, the resulting label-groups sorted chronologically by their
 * own earliest tick, and then whole groups (never partial groups) are
 * assigned to train/test by walking that ordered list until roughly
 * `trainRatio` of the total ROW count has been placed in train. Because
 * groups are indivisible, the realized ratio can overshoot `trainRatio`
 * slightly (a large interval label landing right at the boundary goes
 * entirely to whichever side it started accumulating on) — that is the
 * correct trade-off: an approximate ratio that never leaks a label beats
 * an exact ratio that does.
 */
export function temporalSplit(rows: readonly DatasetRow[], trainRatio: number): TemporalSplitResult {
  const groups = new Map<number, DatasetRow[]>();
  for (const row of rows) {
    const list = groups.get(row.labelId) ?? [];
    list.push(row);
    groups.set(row.labelId, list);
  }
  const groupList = [...groups.values()];
  for (const group of groupList) group.sort((a, b) => a.timestampIso.localeCompare(b.timestampIso));
  groupList.sort((a, b) => a[0]!.timestampIso.localeCompare(b[0]!.timestampIso));

  const targetTrainRows = Math.floor(rows.length * trainRatio);
  const train: DatasetRow[] = [];
  const test: DatasetRow[] = [];
  for (const group of groupList) {
    if (train.length < targetTrainRows) {
      train.push(...group);
    } else {
      test.push(...group);
    }
  }
  return { train, test };
}

const CSV_COLUMNS: Array<keyof DatasetRow> = [
  'timestampIso',
  'labelId',
  'labelDurationMs',
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
  partiallyCoveredIntervalCount: number;
  conflictingTickCount: number;
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

- \`train.csv\` — ${options.trainRowCount} rows.
- \`test.csv\` — ${options.testRowCount} rows.

**The split is by TIME, not a random shuffle, AND it never splits a single
label's rows across the boundary.** A label spans one human judgement,
possibly expanded into many rows (see "One row per label per tick" below);
\`temporalSplit\` assigns whole labels to train or test, sorted
chronologically by each label's own earliest row, so the realized
train/test row-count ratio approximates but will not exactly equal
${(options.trainRatio * 100).toFixed(0)}% / ${((1 - options.trainRatio) * 100).toFixed(0)}%. Do not re-shuffle
these files together and re-split randomly, and do not re-split by row
position if you regenerate this dataset by hand: adjacent windows are
highly autocorrelated (overlapping sliding windows, slowly-changing
occupancy state, and now also literal shared labels), so a random or
row-count split lets a model memorize near-duplicate neighbours — or the
exact same human judgement — across the train/test boundary and reports
misleadingly high accuracy. Evaluating on the chronologically later data
approximates how the model will actually be used: trained on history,
tested on the future.

Of ${options.totalLabels} total labels, ${options.skippedLabelCount} were
skipped (produced zero rows: no feature data anywhere within tolerance/span)
and ${options.partiallyCoveredIntervalCount} interval label(s) were
PARTIALLY covered (produced at least one row, but less than their full
expected span — e.g. a 6-hour correction that only yielded 40 minutes of
data because the feature pipeline had a gap). Partially-covered labels are
still included in the CSVs with exactly the rows they actually produced —
nothing is padded or fabricated to fill the gap, and nothing is dropped
just because coverage was incomplete. See each row's \`labelId\` if you need
to inspect per-label coverage in more detail than this summary.

## Columns

- \`timestampIso\` — this row's own tick timestamp, ISO-8601 UTC. For an
  interval label expanded into multiple rows, each row keeps its OWN tick's
  timestamp, not the label's start time.
- \`labelId\` — the \`labels.id\` row this DatasetRow was derived from.
  **Required for any correct reweighting/grouping** — see "Reweighting"
  below. Multiple rows share a \`labelId\` when the label was an interval
  spanning several feature ticks.
- \`labelDurationMs\` — \`endTimeMs - timeMs\` for the source label, or 0 for
  a point label. A large value means many rows below share this
  \`labelId\` and came from ONE human decision, not independent evidence.
- \`labelSource\` — real provenance from \`labels.source\` (migration 008):
  \`manual\` (typed via \`homecsi label add\` or the pre-B13 dashboard
  correction UI), \`confirmed\` (operator explicitly agreeing a stretch was
  right), \`training\` (guided cold-start walk, brief B14), or
  \`weak:phone-presence\` (the always-on presence-probe cron, noisiest
  ground truth). A pre-migration-008 row whose \`source\` was never
  explicitly set falls back to the legacy \`[weak:phone-presence]\`
  notes-prefix convention (see \`resolveLabelSource\` in datasetExport.ts) —
  kept only for backward compatibility with data that predates the
  \`source\` column, not the primary mechanism.
- \`occupancyCount\` — ground truth, same 0/1/2+ scale as
  \`occupancy_states.estimate\`.
- \`linkCountObserved\` — number of distinct (node, link) vantage points
  observed at this row's tick (point label: within the join tolerance;
  interval label: exactly at the shared tick timestamp).
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

## One row per label per tick — and the class-imbalance hazard this creates

An interval label (a range correction, or one leg of a training-mode walk)
is now expanded into one row per feature tick inside it, not one row for
the whole stretch. This is deliberate — it is the whole point of this
export being interval-aware — but it means **row count is a function of
how long a human happened to hold a selection open, which is NOT evidence
about how common that occupancy state actually is.** An operator who
declared "empty" for a 30-second confirmation and "2+" for a six-hour
family gathering did not thereby generate 720x more evidence that the
house is occupied by 2+ people than that it is empty; they generated one
long, highly autocorrelated run of near-identical rows. Training on raw
row counts without accounting for this will happily learn "predict
whatever the longest drag in the training set was."

### Reweighting (do this before training on \`occupancyCount\`)

Per-label reweighting so no single label dominates is one line, using the
\`labelId\` column:

\`\`\`python
weights = train.groupby("labelId")["labelId"].transform("count")
sample_weight = 1.0 / weights
model.fit(train[feature_cols], train["occupancyCount"], sample_weight=sample_weight)
\`\`\`

The same \`labelId\` column is what makes grouped cross-validation
(\`sklearn.model_selection.GroupKFold\`, grouping on \`labelId\`) and
class-balancing by label (rather than by row) straightforward — this is
also why \`labelId\` could not be safely retrofitted after the fact:
without it, there is no way to tell which rows came from the same
underlying human judgement once the CSV has already shipped.

**Deliberately NOT built into this exporter:** downsampling / a
\`--max-rows-per-label\` stride to cap how many ticks a single long label
contributes. A stride flag is reasonable future work, but it is a policy
choice (which ticks to keep, how aggressively to cap) that belongs next to
the training step that consumes it, not baked irreversibly into the
export. \`labelId\`/\`labelDurationMs\` are the part that CANNOT be
retrofitted after the fact (see above) — a downsampling policy always can
be, later, by anyone with this CSV and the \`labelId\` column.

## Overlapping, contradictory labels (labels are append-only)

There is no delete for a label, and \`PATCH /api/labels/:id\` only ever
touches \`end_time\` — there is no way to replace a wrong
\`occupancyCount\` in place. So the ONLY way an operator can fix a mistake
(a fat-fingered count, or a "confirm correct" they immediately realise was
wrong) is to label the same span again. This WILL happen: two labels can
legitimately claim the same feature tick with different \`occupancyCount\`
values.

This exporter resolves that deterministically, not silently: for any tick
claimed by more than one label, **the label with the highest \`labelId\`
wins** — by construction, the most recently created label is the
operator's most recent (and presumably corrected) word on that moment.
The superseded label's row for that tick is dropped entirely; nothing is
averaged, and nothing is emitted twice.

Of ${options.totalLabels} total labels in this export,
${options.conflictingTickCount} tick(s) had more than one label claiming
them with DIFFERING \`occupancyCount\` values, resolved as above. This is
not necessarily a problem — it is exactly what "the operator corrected a
mistake" looks like in an append-only log — but a large number here across
a short time span is worth a manual look: it can also mean two genuinely
different corrections are fighting over the same stretch, which the
\`labelId\`-wins rule will still resolve, but silently in favour of
whichever was created later, not necessarily whichever is right.

Per-link (rather than whole-house-summarised) raw feature vectors are NOT
queryable indefinitely from the \`features\` hypertable -- it is retained
for only 7 days (docs/architecture.md "Data lifecycle"). For labels in a
MANUAL session, the underlying per-link rows are preserved past that
window in the plain \`training_features\` table (copied at session close,
or via \`homecsi label preserve\`) if a future iteration wants
finer-grained model inputs; weak/presence-probe labels have no such
per-link preservation (see packages/labeling/src/trainingPreservation.ts).

## Training (outside Node)

Per docs/roadmap.md ("Trained-model inference"), training happens outside
Node — this package only exports data, it never trains a model in-process.
A minimal starting point in Python (see "Reweighting" above for why
\`sample_weight\` matters as much as the feature columns themselves):

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

sample_weight = 1.0 / train.groupby("labelId")["labelId"].transform("count")
model = RandomForestClassifier()
model.fit(train[feature_cols], train["occupancyCount"], sample_weight=sample_weight)
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
