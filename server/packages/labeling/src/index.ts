import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '@homecsi/config';
import { createPool } from '@homecsi/db';
import {
  optionalIntFlag,
  optionalNumberFlag,
  optionalStringFlag,
  parseArgs,
  requireStringFlag,
} from './argParsing.js';
import {
  generateTrainingReadme,
  joinLabelsWithFeatures,
  temporalSplit,
  toCsv,
  type LabelForExport,
} from './datasetExport.js';
import { createPgFeaturesReader, type FeaturesReader } from './featuresSource.js';
import {
  DEFAULT_PRESENCE_FILE,
  addDevice,
  createTcpConnector,
  deriveWeakOccupancyCount,
  loadPresenceFile,
  probeAllDevices,
  removeDevice,
  savePresenceFile,
} from './presence.js';
import {
  DEFAULT_RETENTION_SAFETY_MARGIN_MS,
  openSessionRetentionWarnings,
  retentionEdgeWarning,
  type RetentionWarningConfig,
} from './retentionWarning.js';
import {
  WEAK_LABEL_PREFIX,
  createPgLabelStore,
  findOrCreateWeakSession,
  type LabelSource,
  type LabelStore,
} from './sessions.js';
import {
  DEFAULT_BASELINE_WINDOW_MS,
  DEFAULT_MIN_DENSITY_FRACTION,
  createPgTrainingFeaturesStore,
  preserveSessionFeatures,
  sweepPreserveTrainingFeatures,
  type PreservationConfig,
  type SweepErrorResult,
  type TrainingFeaturesStore,
} from './trainingPreservation.js';

export { createInMemoryFeaturesReader } from './featuresSource.js';
export { createInMemoryLabelStore } from './sessions.js';
export {
  createInMemoryTrainingFeaturesStore,
  createPgTrainingFeaturesStore,
  preserveSessionFeatures,
  DEFAULT_BASELINE_WINDOW_MS,
  DEFAULT_MIN_DENSITY_FRACTION,
} from './trainingPreservation.js';
export type { FeaturesReader } from './featuresSource.js';
export type { LabelStore } from './sessions.js';
export type { PreservationConfig, PreserveResult, TrainingFeaturesStore } from './trainingPreservation.js';
export { DEFAULT_RETENTION_SAFETY_MARGIN_MS } from './retentionWarning.js';
export type { RetentionWarningConfig } from './retentionWarning.js';
export type { LabelSource } from './sessions.js';

/**
 * Dependencies `runLabelSubcommand` needs beyond `store`/`featuresReader`
 * for training-set preservation (trainingPreservation.ts) and the
 * retention-edge warning (retentionWarning.ts). Bundled into one object
 * so adding a future cross-cutting dependency doesn't mean touching every
 * call site's positional argument list again.
 */
export interface LabelCliDeps {
  trainingStore: TrainingFeaturesStore;
  preservation: PreservationConfig;
  retentionWarning: RetentionWarningConfig;
  /**
   * Config datasetExport needs beyond what's already threaded through
   * per-command flags (`--tolerance-ms`, `--motion-on-threshold`):
   * `hopMs` is `config.features.hopMs`, the feature pipeline's hop-grid
   * spacing, needed only to compute an interval label's `expectedTicks`
   * for coverage reporting (see datasetExport.ts's `joinLabelsWithFeatures`).
   */
  datasetExport: { hopMs: number };
}

// ---------------------------------------------------------------------
// `label` sub-commands — core logic, decoupled from Postgres via `store`
// and `featuresReader` so tests never need a live database (see
// packages/db's existing pattern). `runLabelCli` below wires this up to
// real `label_sessions`/`labels`/`features` tables for CLI use.
// ---------------------------------------------------------------------

/**
 * Marker prefix a training-mode `label_sessions.notes` row starts with —
 * mirrors `web/ui/src/views/training.ts`'s `TRAINING_MARKER` exactly
 * (brief B14). Kept as a separate constant here (not imported, since
 * `@homecsi/labeling` cannot depend on `@homecsi/web`'s UI package) —
 * if that string ever changes, this one must be updated to match.
 */
const TRAINING_SESSION_MARKER = '[training]';

function isTrainingSessionNotes(notes: string | null): boolean {
  return notes !== null && notes.startsWith(TRAINING_SESSION_MARKER);
}

function formatSession(s: { id: number; startedAtMs: number; endedAtMs: number | null; notes: string | null }): string {
  const status = s.endedAtMs === null ? 'open' : `ended ${new Date(s.endedAtMs).toISOString()}`;
  return `#${s.id}  started ${new Date(s.startedAtMs).toISOString()}  ${status}  ${s.notes ?? ''}`;
}

function formatLabel(l: {
  id: number;
  sessionId: number;
  timeMs: number;
  endTimeMs: number | null;
  occupancyCount: number;
  source: LabelSource;
  notes: string | null;
}): string {
  // Real provenance straight from `labels.source` (migration 008) -- no
  // more isWeakLabel(notes) string-sniffing here (datasetExport.ts's
  // `resolveLabelSource` still keeps that as a fallback for legacy rows,
  // but the CLI display always has the real column available).
  const until = l.endTimeMs === null ? '' : `..${new Date(l.endTimeMs).toISOString()}`;
  return `#${l.id}  session=${l.sessionId}  ${new Date(l.timeMs).toISOString()}${until}  count=${l.occupancyCount}  source=${l.source}`;
}

/**
 * Dispatches one `label` sub-command. Exported (unlike a typical "private"
 * helper) specifically so it can be driven directly by tests against an
 * in-memory `LabelStore`/`FeaturesReader`, with no Postgres involved.
 */
export async function runLabelSubcommand(
  positionals: readonly string[],
  flags: Record<string, string | boolean>,
  store: LabelStore,
  featuresReader: FeaturesReader,
  deps: LabelCliDeps,
): Promise<void> {
  const [group, sub] = positionals;

  if (group === 'session' && sub === 'start') {
    const notes = optionalStringFlag(flags, 'notes') ?? null;
    const startedAtMs = Date.now();
    // Always "now" today (session start takes no --time flag), so this
    // never actually fires yet -- kept for parity with `add`'s check and
    // in case a backdated start is ever supported.
    const warning = retentionEdgeWarning(startedAtMs, deps.retentionWarning);
    if (warning) console.warn(warning);
    const session = await store.createSession(startedAtMs, notes);
    console.log(`started session ${formatSession(session)}`);
    return;
  }

  if (group === 'session' && sub === 'stop') {
    const explicitId = optionalIntFlag(flags, 'session');
    const open = explicitId === undefined ? await store.getOpenSession() : undefined;
    const sessionId = explicitId ?? open?.id;
    if (sessionId === undefined) {
      throw new Error('no open session to stop; pass --session <id> or start one first');
    }

    // Guard: refuse to stop a live training-mode walk (brief B14) via the
    // DEFAULT session resolution above ("most recently started open
    // session"). While an operator is mid-walk, that IS the training
    // session -- a routine, unrelated `label session stop` (no --session)
    // would otherwise close and preserve it out from under them mid-
    // capture. Only fires for the implicit/default resolution: an explicit
    // `--session <id>` naming the training session is a deliberate act and
    // is allowed through unchanged.
    if (explicitId === undefined && open !== undefined && open !== null && isTrainingSessionNotes(open.notes)) {
      throw new Error(
        `refusing to stop session #${open.id} implicitly -- its notes mark it as an active training-mode walk ` +
          `("${TRAINING_SESSION_MARKER}"). Pass --session ${open.id} explicitly if you really mean to stop it.`,
      );
    }

    const session = await store.stopSession(sessionId, Date.now());
    console.log(`stopped session ${formatSession(session)}`);

    // Session-close hook: the natural moment to preserve this session's
    // raw per-link features into training_features (trainingPreservation.ts)
    // -- data is guaranteed alive if the session is under 7 days old. Left
    // uncaught deliberately: if the window is already past retention, this
    // throws with expected-vs-found counts rather than silently succeeding
    // (the session itself is still stopped by this point; `homecsi label
    // preserve` is the backstop for exactly this situation).
    //
    // The 'permanently-lost' branch below is handled here for correct,
    // exhaustive handling of `preserveSessionFeatures`'s return type, but
    // is practically UNREACHABLE at this exact call site: `endedAtMs` is
    // always `Date.now()` right above, so the window's end is always "now"
    // at the moment of this call, and "entirely past retention" can never
    // be true for a window that just closed. The realistic trigger for
    // this branch is `homecsi label preserve` re-sweeping an
    // ALREADY-closed old session (see the `preserve` sub-command below,
    // and trainingPreservation.test.ts for the downgrade logic itself) --
    // e.g. the dashboard allows creating a correction whose time already
    // predates the 7-day retention window, which becomes exactly such a
    // session once stopped.
    const result = await preserveSessionFeatures(session, deps.trainingStore, deps.preservation);
    if (result.status === 'preserved') {
      console.log(
        `preserved ${result.inserted} training-feature row(s) for retraining (${result.found} found in features).`,
      );
      if (result.densityCheckSkipped) {
        console.warn(
          'no live feature-row baseline was available to sanity-check this window density -- preserved as-is, unchecked.',
        );
      }
    } else if (result.status === 'permanently-lost') {
      console.warn(
        `session #${session.id}'s raw per-link features are permanently lost for retraining (window entirely ` +
          `past the retention deadline, zero rows found in features/training_features) -- occupancyCount is ` +
          `still recorded, just without per-link training data for this window.`,
      );
    }
    return;
  }

  if (group === 'session' && sub === 'list') {
    const sessions = await store.listSessions();
    if (sessions.length === 0) {
      console.log('no label sessions yet');
      return;
    }
    for (const session of sessions) console.log(formatSession(session));
    return;
  }

  if (group === 'add') {
    const countStr = requireStringFlag(flags, 'count');
    const occupancyCount = Number.parseInt(countStr, 10);
    if (Number.isNaN(occupancyCount)) throw new Error(`--count must be an integer, got "${countStr}"`);

    const timeStr = optionalStringFlag(flags, 'time');
    const timeMs = timeStr === undefined ? Date.now() : Date.parse(timeStr);
    if (Number.isNaN(timeMs)) throw new Error(`--time must be a parseable date/time, got "${timeStr}"`);

    const explicitId = optionalIntFlag(flags, 'session');
    const open = explicitId === undefined ? await store.getOpenSession() : undefined;
    const sessionId = explicitId ?? open?.id;
    if (sessionId === undefined) {
      throw new Error(
        'no open session; pass --session <id> or start one with `homecsi label session start`',
      );
    }

    const untilStr = optionalStringFlag(flags, 'until');
    let endTimeMs: number | null = null;
    if (untilStr !== undefined) {
      endTimeMs = Date.parse(untilStr);
      if (Number.isNaN(endTimeMs)) throw new Error(`--until must be a parseable date/time, got "${untilStr}"`);
      if (endTimeMs <= timeMs) {
        throw new Error(
          `--until (${new Date(endTimeMs).toISOString()}) must be after --time (${new Date(timeMs).toISOString()})`,
        );
      }
    }

    // The retention-edge check looks at `timeMs` -- the interval's START,
    // not its end -- which is already correct for an interval label: the
    // OLDEST part of a labelled span is what ages out of the 7-day debug
    // window first (retentionWarning.ts), so warning on the start is the
    // earlier and more conservative of the two possible choices.
    const warning = retentionEdgeWarning(timeMs, deps.retentionWarning);
    if (warning) console.warn(warning);

    const notes = optionalStringFlag(flags, 'notes') ?? null;
    const label = await store.addLabel(sessionId, timeMs, occupancyCount, notes, endTimeMs);
    console.log(`added label ${formatLabel(label)}`);
    return;
  }

  if (group === 'list') {
    const sessionId = optionalIntFlag(flags, 'session');
    const labels = await store.listLabels(sessionId);
    if (labels.length === 0) {
      console.log('no labels yet');
      return;
    }
    for (const label of labels) console.log(formatLabel(label));
    return;
  }

  if (group === 'export') {
    const outPath = requireStringFlag(flags, 'out');
    const sessionId = optionalIntFlag(flags, 'session');
    const toleranceMs = optionalIntFlag(flags, 'tolerance-ms') ?? 2000;
    const motionOnThreshold = optionalNumberFlag(flags, 'motion-on-threshold') ?? 3.0;

    const labelRows = await store.listLabels(sessionId);
    const labels: LabelForExport[] = labelRows.map((l) => ({
      labelId: l.id,
      timeMs: l.timeMs,
      endTimeMs: l.endTimeMs,
      occupancyCount: l.occupancyCount,
      source: l.source,
      notes: l.notes,
    }));
    if (labels.length === 0) {
      console.log('no labels to export');
      return;
    }
    // Range must cover each label's FULL span, not just its start -- an
    // interval label's body (everything between `timeMs` and `endTimeMs`)
    // needs feature rows fetched too, or every expanded row past
    // `timeMs + toleranceMs` would silently join to nothing (see
    // joinLabelsWithFeatures's interval branch). `endTimeMs ?? l.timeMs`
    // makes this a no-op for point labels.
    const minMs = Math.min(...labels.map((l) => l.timeMs)) - toleranceMs;
    const maxMs = Math.max(...labels.map((l) => l.endTimeMs ?? l.timeMs)) + toleranceMs;
    // NOTE (not fixed here, see brief): this loads the whole [minMs, maxMs]
    // span into memory in one call -- fine at current data volume, but a
    // multi-day interval label would make that range large. Revisit with
    // paging if/when that becomes a real problem.
    const features = await featuresReader.fetchFeaturesForExport(minMs, maxMs);
    const { rows, skippedLabelCount, partiallyCoveredIntervalCount, conflictingTickCount } = joinLabelsWithFeatures(
      labels,
      features,
      toleranceMs,
      motionOnThreshold,
      deps.datasetExport.hopMs,
    );

    writeFileSync(outPath, toCsv(rows), 'utf8');
    console.log(
      `wrote ${rows.length} rows to ${outPath} (${skippedLabelCount} labels skipped: no nearby feature data; ` +
        `${partiallyCoveredIntervalCount} interval label(s) only partially covered; ` +
        `${conflictingTickCount} tick(s) had overlapping contradictory labels, resolved by highest labelId)`,
    );
    return;
  }

  if (group === 'presence' && sub === 'add-device') {
    const name = positionals[2];
    const host = positionals[3];
    if (name === undefined || host === undefined) {
      throw new Error('usage: label presence add-device <name> <host> [--port <n>] [--file <path>]');
    }
    const port = optionalIntFlag(flags, 'port') ?? 62078;
    const filePath = optionalStringFlag(flags, 'file') ?? DEFAULT_PRESENCE_FILE;
    const file = addDevice(loadPresenceFile(filePath), name, host, port);
    savePresenceFile(filePath, file);
    console.log(`saved device "${name}" (${host}:${port}) to ${filePath}`);
    return;
  }

  if (group === 'presence' && sub === 'remove-device') {
    const name = positionals[2];
    if (name === undefined) throw new Error('usage: label presence remove-device <name> [--file <path>]');
    const filePath = optionalStringFlag(flags, 'file') ?? DEFAULT_PRESENCE_FILE;
    savePresenceFile(filePath, removeDevice(loadPresenceFile(filePath), name));
    console.log(`removed device "${name}" from ${filePath}`);
    return;
  }

  if (group === 'presence' && sub === 'list-devices') {
    const filePath = optionalStringFlag(flags, 'file') ?? DEFAULT_PRESENCE_FILE;
    const file = loadPresenceFile(filePath);
    if (file.devices.length === 0) {
      console.log(`no devices configured in ${filePath}`);
      return;
    }
    for (const device of file.devices) console.log(`${device.name}  ${device.host}:${device.port}`);
    return;
  }

  if (group === 'presence' && sub === 'probe') {
    const filePath = optionalStringFlag(flags, 'file') ?? DEFAULT_PRESENCE_FILE;
    const file = loadPresenceFile(filePath);
    if (file.devices.length === 0) {
      console.log(`no devices configured in ${filePath} — add one with \`homecsi label presence add-device\``);
      return;
    }
    // Individually time-bounded and try/caught per device (see presence.ts)
    // — a bad entry can only ever read as "unreachable", never throw here.
    const results = await probeAllDevices(file.devices, createTcpConnector());
    const occupancyCount = deriveWeakOccupancyCount(results);
    const reachableNames = results.filter((r) => r.reachable).map((r) => r.device.name);

    const session = await findOrCreateWeakSession(store, Date.now());
    const notes = `${WEAK_LABEL_PREFIX} devices=${reachableNames.join('|') || 'none'}`;
    // Explicit provenance (migration 008's `source` column), not just the
    // notes-prefix convention `isWeakLabel` reads -- see sessions.ts's
    // LabelSource doc comment. The notes prefix is still written above so
    // nothing that already reads it regresses.
    const label = await store.addLabel(session.id, Date.now(), occupancyCount, notes, undefined, 'weak:phone-presence');
    console.log(
      `probed ${file.devices.length} device(s), ${reachableNames.length} reachable -> weak label ${formatLabel(label)}`,
    );
    return;
  }

  if (group === 'preserve') {
    const explicitId = optionalIntFlag(flags, 'session');
    const allSessions = await store.listSessions();
    const targets = explicitId === undefined ? allSessions : allSessions.filter((s) => s.id === explicitId);
    if (explicitId !== undefined && targets.length === 0) {
      throw new Error(`no label_session with id ${explicitId}`);
    }
    if (targets.length === 0) {
      console.log('no label sessions to preserve');
      return;
    }

    // Proactive check, independent of preservation itself: an open session
    // ages toward the retention edge with no `add`/`session start` call
    // ever seeing an old timestamp to warn about (both always use "now").
    // `label preserve` -- already the backstop an operator runs
    // periodically -- is the natural place to surface that before it
    // becomes the hard error below.
    for (const { sessionId, warning } of openSessionRetentionWarnings(targets, deps.retentionWarning)) {
      console.warn(`session #${sessionId} is still open -- ${warning}`);
    }

    const results = await sweepPreserveTrainingFeatures(targets, deps.trainingStore, deps.preservation);
    for (const result of results) {
      if (result.status === 'error') {
        console.error(`session #${result.sessionId}: ${result.error}`);
      } else if (result.status === 'preserved') {
        console.log(
          `session #${result.sessionId}: preserved ${result.inserted} training-feature row(s) (${result.found} found in features).`,
        );
        if (result.densityCheckSkipped) {
          console.warn(
            `session #${result.sessionId}: no live feature-row baseline was available to sanity-check this window's density -- preserved as-is, unchecked.`,
          );
        }
      } else if (result.status === 'permanently-lost') {
        // Not a sweep failure (see preserveSessionFeatures's doc comment):
        // a correction whose window is entirely past the retention deadline
        // with zero rows found anywhere can never be recovered by
        // re-running this sweep, so counting it as fresh, actionable
        // failure on EVERY future run would bury genuinely new problems
        // under a permanent non-zero exit code.
        console.warn(
          `session #${result.sessionId}: permanently lost -- window entirely past retention with zero feature ` +
            `rows found anywhere; not counted as a sweep failure.`,
        );
      } else {
        console.log(`session #${result.sessionId}: skipped (weak/presence-probe session -- not preserved).`);
      }
    }

    const failures = results.filter((r): r is SweepErrorResult => r.status === 'error');
    const permanentlyLost = results.filter((r) => r.status === 'permanently-lost');
    if (permanentlyLost.length > 0) {
      console.warn(
        `${permanentlyLost.length} session(s) have permanently lost raw per-link features (see above) -- ` +
          `these are reported, not treated as sweep failures.`,
      );
    }
    if (failures.length > 0) {
      throw new Error(
        `training-set preservation failed for ${failures.length} of ${results.length} session(s) -- see errors above.`,
      );
    }
    return;
  }

  throw new Error(
    `unknown label sub-command "${positionals.join(' ')}". Expected one of: session start|stop|list, add, list, export, preserve, presence add-device|remove-device|list-devices|probe`,
  );
}

/**
 * Ground-truth labeling sub-CLI: session management, manual labels, an
 * automatic weak-label source (phone-presence probing), and dataset
 * export. See packages/cli/CONTRACTS.md ("label"). Owned by brief B4.
 */
export async function runLabelCli(args: string[], config: Config): Promise<void> {
  const { positionals, flags } = parseArgs(args);
  const pool = createPool(config.database);
  try {
    const store = createPgLabelStore(pool);
    const featuresReader = createPgFeaturesReader(pool);
    const deps: LabelCliDeps = {
      trainingStore: createPgTrainingFeaturesStore(pool),
      preservation: {
        toleranceMs: config.features.windowMs,
        baselineWindowMs: config.training?.preservation.baselineWindowMs ?? DEFAULT_BASELINE_WINDOW_MS,
        minDensityFraction: config.training?.preservation.minDensityFraction ?? DEFAULT_MIN_DENSITY_FRACTION,
        retentionMaxAgeMs: config.storage.retention.maxAgeMs,
      },
      retentionWarning: {
        maxAgeMs: config.storage.retention.maxAgeMs,
        safetyMarginMs: DEFAULT_RETENTION_SAFETY_MARGIN_MS,
      },
      datasetExport: { hopMs: config.features.hopMs },
    };
    await runLabelSubcommand(positionals, flags, store, featuresReader, deps);
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------
// `train`
// ---------------------------------------------------------------------

export interface TrainOptions {
  outDir: string;
  trainRatio: number;
  sessionId: number | undefined;
  toleranceMs: number;
  motionOnThreshold: number;
  /** `config.features.hopMs` — see `joinLabelsWithFeatures`'s `hopMs` param (interval coverage reporting only). */
  hopMs: number;
}

export interface TrainWriter {
  mkdir(dirPath: string): void;
  writeFile(filePath: string, contents: string): void;
}

function nodeFsTrainWriter(): TrainWriter {
  return {
    mkdir: (dirPath) => mkdirSync(dirPath, { recursive: true }),
    writeFile: (filePath, contents) => writeFileSync(filePath, contents, 'utf8'),
  };
}

export interface TrainResult {
  status: 'written' | 'no-labels' | 'no-joinable-rows';
  trainRowCount: number;
  testRowCount: number;
  skippedLabelCount: number;
  /** See datasetExport.ts's `JoinResult.partiallyCoveredIntervalCount`. */
  partiallyCoveredIntervalCount: number;
  /** See datasetExport.ts's `JoinResult.conflictingTickCount`. */
  conflictingTickCount: number;
}

/**
 * Core export logic behind `train`, decoupled from Postgres/the real
 * filesystem via `store`/`featuresReader`/`writer` — this is what tests
 * drive directly. Per docs/roadmap.md, this only ever exports data; it
 * never trains a model in-process.
 */
export async function runTrainCore(
  options: TrainOptions,
  store: LabelStore,
  featuresReader: FeaturesReader,
  writer: TrainWriter = nodeFsTrainWriter(),
): Promise<TrainResult> {
  const labelRows = await store.listLabels(options.sessionId);
  const labels: LabelForExport[] = labelRows.map((l) => ({
    labelId: l.id,
    timeMs: l.timeMs,
    endTimeMs: l.endTimeMs,
    occupancyCount: l.occupancyCount,
    source: l.source,
    notes: l.notes,
  }));

  if (labels.length === 0) {
    return {
      status: 'no-labels',
      trainRowCount: 0,
      testRowCount: 0,
      skippedLabelCount: 0,
      partiallyCoveredIntervalCount: 0,
      conflictingTickCount: 0,
    };
  }

  // Range must cover each label's FULL span, not just its start -- see the
  // matching comment on the `export` sub-command above (same bug, same fix).
  const minMs = Math.min(...labels.map((l) => l.timeMs)) - options.toleranceMs;
  const maxMs = Math.max(...labels.map((l) => l.endTimeMs ?? l.timeMs)) + options.toleranceMs;
  // NOTE (not fixed here, see brief): loads the whole span into memory in
  // one call -- fine at current data volume, revisit with paging later.
  const features = await featuresReader.fetchFeaturesForExport(minMs, maxMs);
  const { rows, skippedLabelCount, partiallyCoveredIntervalCount, conflictingTickCount } = joinLabelsWithFeatures(
    labels,
    features,
    options.toleranceMs,
    options.motionOnThreshold,
    options.hopMs,
  );

  if (rows.length === 0) {
    return {
      status: 'no-joinable-rows',
      trainRowCount: 0,
      testRowCount: 0,
      skippedLabelCount,
      partiallyCoveredIntervalCount,
      conflictingTickCount,
    };
  }

  const { train, test } = temporalSplit(rows, options.trainRatio);

  writer.mkdir(options.outDir);
  writer.writeFile(path.join(options.outDir, 'train.csv'), toCsv(train));
  writer.writeFile(path.join(options.outDir, 'test.csv'), toCsv(test));
  writer.writeFile(
    path.join(options.outDir, 'README.md'),
    generateTrainingReadme({
      totalLabels: labels.length,
      skippedLabelCount,
      partiallyCoveredIntervalCount,
      conflictingTickCount,
      trainRowCount: train.length,
      testRowCount: test.length,
      trainRatio: options.trainRatio,
      toleranceMs: options.toleranceMs,
    }),
  );

  return {
    status: 'written',
    trainRowCount: train.length,
    testRowCount: test.length,
    skippedLabelCount,
    partiallyCoveredIntervalCount,
    conflictingTickCount,
  };
}

/**
 * Exports a training-ready, temporally-split dataset and a README
 * describing how to train externally (Python) and bring a model back as
 * ONNX later. Per docs/roadmap.md ("Trained-model inference"), this never
 * trains a model in-process — Node is not the training environment.
 * See packages/cli/CONTRACTS.md ("train"). Owned by brief B4.
 */
export async function runTrain(args: string[], config: Config): Promise<void> {
  const { flags } = parseArgs(args);
  const options: TrainOptions = {
    outDir:
      optionalStringFlag(flags, 'out') ?? `training-export-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    trainRatio: optionalNumberFlag(flags, 'split') ?? 0.8,
    sessionId: optionalIntFlag(flags, 'session'),
    toleranceMs: optionalIntFlag(flags, 'tolerance-ms') ?? config.features.windowMs,
    motionOnThreshold: config.occupancy.thresholds.motionOnThreshold,
    hopMs: config.features.hopMs,
  };

  const pool = createPool(config.database);
  try {
    const store = createPgLabelStore(pool);
    const featuresReader = createPgFeaturesReader(pool);
    const result = await runTrainCore(options, store, featuresReader);

    if (result.status === 'no-labels') {
      console.error(
        'no labels found to export. Note: the unsupervised occupancy pipeline (features + occupancy) does not need labels to run at all — this only affects future model training.',
      );
      process.exitCode = 1;
      return;
    }
    if (result.status === 'no-joinable-rows') {
      console.error(
        'every label was skipped (no nearby feature data) — is the features pipeline running for this time range?',
      );
      process.exitCode = 1;
      return;
    }

    console.log(`wrote ${result.trainRowCount} train / ${result.testRowCount} test rows to ${options.outDir}`);
    if (result.partiallyCoveredIntervalCount > 0) {
      console.log(
        `note: ${result.partiallyCoveredIntervalCount} interval label(s) were only PARTIALLY covered ` +
          `(produced some rows, but less than their full span) — see README.md for detail, and consider ` +
          `whether the feature pipeline had a gap during that window.`,
      );
    }
    if (result.conflictingTickCount > 0) {
      console.log(
        `note: ${result.conflictingTickCount} tick(s) were claimed by more than one label with different ` +
          `occupancyCount values (labels are append-only, so overlapping corrections are expected) — resolved ` +
          `by keeping the highest labelId's row; see README.md.`,
      );
    }
    console.log('Training happens outside Node — see the generated README.md for next steps.');
  } finally {
    await pool.end();
  }
}

