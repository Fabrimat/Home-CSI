/**
 * The "hand in a closed box" recreational gesture-classification experiment:
 * labelled take recording, raw-CSI preservation, and an offline
 * leave-one-take-out k-NN classifier with honest accuracy reporting. See
 * docs/box-experiment.md for the framing and packages/cli/CONTRACTS.md
 * ("box") for this package's exact exported function contract
 * (`runBoxCli`). Owned by brief B3.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '@homecsi/config';
import { createPool } from '@homecsi/db';
import { optionalIntFlag, optionalStringFlag, parseArgs, requireStringFlag } from './argParsing.js';
import {
  DEFAULT_K,
  DEFAULT_MIN_TAKES_PER_CLASS,
  computeTakeFeatureVector,
  formatTrainReport,
  knnLeaveOneOut,
  type TakeExample,
  type TrainReport,
} from './classifier.js';
import {
  createInMemoryBoxTakeStore,
  createPgBoxTakeStore,
  sweepPreserveBoxTakes,
  type BoxPreservationConfig,
  type BoxSweepErrorResult,
  type BoxTakeStore,
} from './preservation.js';
import { createInMemoryBoxSessionStore, createPgBoxSessionStore, type BoxSession, type BoxSessionStore } from './sessions.js';
import { DEFAULT_LEAD_TRIM_MS, DEFAULT_MIN_TAKE_RECORDS, computeTakeWindow, isTakeUsable } from './takeWindow.js';

export type { BoxSession, BoxSessionStore } from './sessions.js';
export { createInMemoryBoxSessionStore, createPgBoxSessionStore } from './sessions.js';

export type {
  BoxEmptyWindowResult,
  BoxPreservationConfig,
  BoxPreserveOutcome,
  BoxPreserveResult,
  BoxSkippedOpenResult,
  BoxSweepErrorResult,
  BoxSweepResult,
  BoxTakeRecord,
  BoxTakeStore,
} from './preservation.js';
export {
  createInMemoryBoxTakeStore,
  createPgBoxTakeStore,
  preserveSessionTake,
  sweepPreserveBoxTakes,
} from './preservation.js';

export type { TakeWindow } from './takeWindow.js';
export { DEFAULT_LEAD_TRIM_MS, DEFAULT_MIN_TAKE_RECORDS, computeTakeWindow, isTakeUsable } from './takeWindow.js';

export type { ConfusionMatrix, TakeExample, TrainReport, TrainReportInsufficientData, TrainReportOk } from './classifier.js';
export { DEFAULT_K, DEFAULT_MIN_TAKES_PER_CLASS, computeTakeFeatureVector, formatTrainReport, knnLeaveOneOut } from './classifier.js';

function formatSession(s: BoxSession, recordCount?: number): string {
  const status = s.endedAtMs === null ? 'open' : `ended ${new Date(s.endedAtMs).toISOString()}`;
  const countStr = recordCount === undefined ? '' : `  records=${recordCount}`;
  return `#${s.id}  ${s.gestureClass}  started ${new Date(s.startedAtMs).toISOString()}  ${status}${countStr}`;
}

/** Sessions to scan for `list`/`train`/`export`/`preserve`'s "operate over everything" default -- bounded by how many takes an operator records by hand, same reasoning as this package's tables having no retention policy (migration 012). */
const ALL_SESSIONS_SCAN_LIMIT = 100_000;

/**
 * Builds one `TakeExample` per usable, closed session, computing its
 * feature vector from preserved raw CSI. Sessions that are still open, that
 * the lead-in/lead-out trim reduces to an empty window, that don't clear
 * `minTakeRecords`, or whose preserved records never produce a usable
 * feature vector (e.g. every record was corrupt) are silently excluded --
 * counts of each are returned alongside for CLI reporting.
 */
async function buildTakeExamples(
  sessions: readonly BoxSession[],
  takeStore: BoxTakeStore,
  preservation: BoxPreservationConfig,
  minTakeRecords: number,
): Promise<{ examples: TakeExample[]; excludedCount: number }> {
  const closed = sessions.filter((s) => s.endedAtMs !== null);
  const counts = await takeStore.countPreservedBySession(closed.map((s) => s.id));

  const examples: TakeExample[] = [];
  let excludedCount = 0;
  for (const session of closed) {
    const recordCount = counts.get(session.id) ?? 0;
    const window = computeTakeWindow(session, preservation.leadInMs, preservation.leadOutMs);
    if (window === null || !isTakeUsable(recordCount, minTakeRecords)) {
      excludedCount++;
      continue;
    }
    const records = await takeStore.fetchPreserved(session.id);
    const vector = computeTakeFeatureVector(records, window);
    if (vector === null) {
      excludedCount++;
      continue;
    }
    examples.push({ sessionId: session.id, gestureClass: session.gestureClass, vector });
  }
  return { examples, excludedCount };
}

function toCsvValue(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface BoxCliDeps {
  sessionStore: BoxSessionStore;
  takeStore: BoxTakeStore;
  preservation: BoxPreservationConfig;
}

/**
 * Dispatches one `box` sub-command. Exported (like `@homecsi/labeling`'s
 * `runLabelSubcommand`) so it can be driven directly by tests against
 * in-memory stores, with no Postgres involved.
 */
export async function runBoxSubcommand(
  positionals: readonly string[],
  flags: Record<string, string | boolean>,
  deps: BoxCliDeps,
): Promise<void> {
  const [sub] = positionals;

  if (sub === 'list') {
    const limit = optionalIntFlag(flags, 'limit') ?? ALL_SESSIONS_SCAN_LIMIT;
    const sessions = await deps.sessionStore.listSessions(limit);
    if (sessions.length === 0) {
      console.log('no box sessions yet');
      return;
    }
    const counts = await deps.takeStore.countPreservedBySession(sessions.map((s) => s.id));
    for (const s of sessions) console.log(formatSession(s, counts.get(s.id) ?? 0));
    return;
  }

  if (sub === 'train') {
    const k = optionalIntFlag(flags, 'k') ?? DEFAULT_K;
    const minTakes = optionalIntFlag(flags, 'min-takes') ?? DEFAULT_MIN_TAKES_PER_CLASS;
    const minTakeRecords = optionalIntFlag(flags, 'min-records') ?? DEFAULT_MIN_TAKE_RECORDS;
    const outDir = optionalStringFlag(flags, 'out');

    const sessions = await deps.sessionStore.listSessions(ALL_SESSIONS_SCAN_LIMIT);
    const { examples, excludedCount } = await buildTakeExamples(sessions, deps.takeStore, deps.preservation, minTakeRecords);
    if (excludedCount > 0) {
      console.log(`excluded ${excludedCount} take(s): still open, trim consumed the whole hold, or too few usable records.`);
    }

    const report: TrainReport = knnLeaveOneOut(examples, k, minTakes);
    console.log(formatTrainReport(report));

    if (outDir !== undefined) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
      writeFileSync(path.join(outDir, 'report.txt'), formatTrainReport(report), 'utf8');
      console.log(`wrote report.json / report.txt to ${outDir}`);
    }
    return;
  }

  if (sub === 'export') {
    const outPath = requireStringFlag(flags, 'out');
    const minTakeRecords = optionalIntFlag(flags, 'min-records') ?? DEFAULT_MIN_TAKE_RECORDS;

    const sessions = await deps.sessionStore.listSessions(ALL_SESSIONS_SCAN_LIMIT);
    const closed = sessions.filter((s) => s.endedAtMs !== null);
    const counts = await deps.takeStore.countPreservedBySession(closed.map((s) => s.id));

    const rows: string[] = [];
    let featureCount = 0;
    let written = 0;
    for (const session of closed) {
      const recordCount = counts.get(session.id) ?? 0;
      const window = computeTakeWindow(session, deps.preservation.leadInMs, deps.preservation.leadOutMs);
      if (window === null) continue;
      const records = await deps.takeStore.fetchPreserved(session.id);
      const vector = computeTakeFeatureVector(records, window);
      if (vector === null) continue;
      featureCount = vector.length;
      const usable = isTakeUsable(recordCount, minTakeRecords);
      rows.push(
        [
          session.id,
          session.gestureClass,
          session.geometryNote ?? '',
          recordCount,
          usable ? 1 : 0,
          ...vector,
        ]
          .map(toCsvValue)
          .join(','),
      );
      written++;
    }

    const header = [
      'sessionId',
      'gestureClass',
      'geometryNote',
      'recordCount',
      'usable',
      ...Array.from({ length: featureCount }, (_, i) => `feature_${i}`),
    ].join(',');
    writeFileSync(outPath, [header, ...rows].join('\n') + '\n', 'utf8');
    console.log(`wrote ${written} row(s) to ${outPath} (a row's own \`usable\` column reflects --min-records=${minTakeRecords}).`);
    return;
  }

  if (sub === 'preserve') {
    const explicitId = optionalIntFlag(flags, 'session');
    const allSessions = await deps.sessionStore.listSessions(ALL_SESSIONS_SCAN_LIMIT);
    const targets = explicitId === undefined ? allSessions : allSessions.filter((s) => s.id === explicitId);
    if (explicitId !== undefined && targets.length === 0) {
      throw new Error(`no box_session with id ${explicitId}`);
    }
    if (targets.length === 0) {
      console.log('no box sessions to preserve');
      return;
    }

    const openTargets = targets.filter((s) => s.endedAtMs === null);
    for (const s of openTargets) {
      console.warn(`session #${s.id} is still open (no \`stop\`) -- its window isn't final yet, skipping.`);
    }

    const results = await sweepPreserveBoxTakes(targets, deps.takeStore, deps.preservation);
    for (const result of results) {
      if (result.status === 'error') {
        console.error(`session #${result.sessionId}: ${result.error}`);
      } else if (result.status === 'preserved') {
        console.log(`session #${result.sessionId}: preserved ${result.inserted} record(s) (${result.found} found).`);
        if (result.nodeDropoutWarning !== undefined) {
          console.warn(`session #${result.sessionId}: ${result.nodeDropoutWarning}`);
        }
      } else if (result.status === 'empty-window') {
        console.warn(`session #${result.sessionId}: lead-in/lead-out trim consumed the entire hold -- nothing to preserve.`);
      } else {
        console.log(`session #${result.sessionId}: still open -- skipped.`);
      }
    }

    const failures = results.filter((r): r is BoxSweepErrorResult => r.status === 'error');
    if (failures.length > 0) {
      throw new Error(`box take preservation failed for ${failures.length} of ${results.length} session(s) -- see errors above.`);
    }
    return;
  }

  throw new Error(`unknown box sub-command "${positionals.join(' ')}". Expected one of: list, train, export, preserve`);
}

/**
 * Box-experiment sub-CLI: take listing, the offline k-NN train report,
 * dataset export, and the `preserve` backstop sweep. See
 * packages/cli/CONTRACTS.md ("box"). Owned by brief B3.
 */
export async function runBoxCli(args: string[], config: Config): Promise<void> {
  const { positionals, flags } = parseArgs(args);
  const pool = createPool(config.database);
  try {
    const leadInMs = optionalIntFlag(flags, 'lead-in-ms') ?? DEFAULT_LEAD_TRIM_MS;
    const leadOutMs = optionalIntFlag(flags, 'lead-out-ms') ?? DEFAULT_LEAD_TRIM_MS;
    const deps: BoxCliDeps = {
      sessionStore: createPgBoxSessionStore(pool),
      takeStore: createPgBoxTakeStore(pool),
      preservation: { leadInMs, leadOutMs },
    };
    await runBoxSubcommand(positionals, flags, deps);
  } finally {
    await pool.end();
  }
}

// Re-exported for tests/callers that want a fully in-memory `BoxCliDeps`
// with no Postgres involved.
export function createInMemoryBoxCliDeps(
  preservation: BoxPreservationConfig = { leadInMs: DEFAULT_LEAD_TRIM_MS, leadOutMs: DEFAULT_LEAD_TRIM_MS },
): BoxCliDeps {
  return {
    sessionStore: createInMemoryBoxSessionStore(),
    takeStore: createInMemoryBoxTakeStore(),
    preservation,
  };
}
