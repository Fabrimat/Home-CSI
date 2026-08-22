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
  WEAK_LABEL_PREFIX,
  createPgLabelStore,
  findOrCreateWeakSession,
  isWeakLabel,
  type LabelStore,
} from './sessions.js';

export { createInMemoryFeaturesReader } from './featuresSource.js';
export { createInMemoryLabelStore } from './sessions.js';
export type { FeaturesReader } from './featuresSource.js';
export type { LabelStore } from './sessions.js';

// ---------------------------------------------------------------------
// `label` sub-commands — core logic, decoupled from Postgres via `store`
// and `featuresReader` so tests never need a live database (see
// packages/db's existing pattern). `runLabelCli` below wires this up to
// real `label_sessions`/`labels`/`features` tables for CLI use.
// ---------------------------------------------------------------------

function formatSession(s: { id: number; startedAtMs: number; endedAtMs: number | null; notes: string | null }): string {
  const status = s.endedAtMs === null ? 'open' : `ended ${new Date(s.endedAtMs).toISOString()}`;
  return `#${s.id}  started ${new Date(s.startedAtMs).toISOString()}  ${status}  ${s.notes ?? ''}`;
}

function formatLabel(l: {
  id: number;
  sessionId: number;
  timeMs: number;
  occupancyCount: number;
  notes: string | null;
}): string {
  const source = isWeakLabel(l.notes) ? 'weak' : 'manual';
  return `#${l.id}  session=${l.sessionId}  ${new Date(l.timeMs).toISOString()}  count=${l.occupancyCount}  source=${source}`;
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
): Promise<void> {
  const [group, sub] = positionals;

  if (group === 'session' && sub === 'start') {
    const notes = optionalStringFlag(flags, 'notes') ?? null;
    const session = await store.createSession(Date.now(), notes);
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
    const session = await store.stopSession(sessionId, Date.now());
    console.log(`stopped session ${formatSession(session)}`);
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

    const notes = optionalStringFlag(flags, 'notes') ?? null;
    const label = await store.addLabel(sessionId, timeMs, occupancyCount, notes);
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
      timeMs: l.timeMs,
      occupancyCount: l.occupancyCount,
      notes: l.notes,
    }));
    if (labels.length === 0) {
      console.log('no labels to export');
      return;
    }
    const minMs = Math.min(...labels.map((l) => l.timeMs)) - toleranceMs;
    const maxMs = Math.max(...labels.map((l) => l.timeMs)) + toleranceMs;
    const features = await featuresReader.fetchFeaturesForExport(minMs, maxMs);
    const { rows, skippedLabelCount } = joinLabelsWithFeatures(labels, features, toleranceMs, motionOnThreshold);

    writeFileSync(outPath, toCsv(rows), 'utf8');
    console.log(
      `wrote ${rows.length} rows to ${outPath} (${skippedLabelCount} labels skipped: no nearby feature data)`,
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
    const label = await store.addLabel(session.id, Date.now(), occupancyCount, notes);
    console.log(
      `probed ${file.devices.length} device(s), ${reachableNames.length} reachable -> weak label ${formatLabel(label)}`,
    );
    return;
  }

  throw new Error(
    `unknown label sub-command "${positionals.join(' ')}". Expected one of: session start|stop|list, add, list, export, presence add-device|remove-device|list-devices|probe`,
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
    await runLabelSubcommand(positionals, flags, store, featuresReader);
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
    timeMs: l.timeMs,
    occupancyCount: l.occupancyCount,
    notes: l.notes,
  }));

  if (labels.length === 0) {
    return { status: 'no-labels', trainRowCount: 0, testRowCount: 0, skippedLabelCount: 0 };
  }

  const minMs = Math.min(...labels.map((l) => l.timeMs)) - options.toleranceMs;
  const maxMs = Math.max(...labels.map((l) => l.timeMs)) + options.toleranceMs;
  const features = await featuresReader.fetchFeaturesForExport(minMs, maxMs);
  const { rows, skippedLabelCount } = joinLabelsWithFeatures(
    labels,
    features,
    options.toleranceMs,
    options.motionOnThreshold,
  );

  if (rows.length === 0) {
    return { status: 'no-joinable-rows', trainRowCount: 0, testRowCount: 0, skippedLabelCount };
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
      trainRowCount: train.length,
      testRowCount: test.length,
      trainRatio: options.trainRatio,
      toleranceMs: options.toleranceMs,
    }),
  );

  return { status: 'written', trainRowCount: train.length, testRowCount: test.length, skippedLabelCount };
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
    console.log('Training happens outside Node — see the generated README.md for next steps.');
  } finally {
    await pool.end();
  }
}

