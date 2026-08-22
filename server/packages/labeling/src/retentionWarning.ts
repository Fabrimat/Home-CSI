/**
 * config.storage.retention.maxAgeMs (docs/architecture.md "Data lifecycle",
 * migration 007) is now the whole system's debug window — raw csi_records,
 * features, and the on-disk capture tree all age out around the same 7-day
 * point. A label naming a time already near or past that edge can never be
 * joined to feature data again (`joinLabelsWithFeatures` already degrades
 * gracefully at *query* time via `skippedLabelCount`, kept as-is), and its
 * raw per-link features can no longer be preserved into
 * `training_features` either (see trainingPreservation.ts, which will
 * error rather than silently skip it). Warning here, at label-add time, is
 * the cheaper and earlier check — it fires while a human can still act
 * (e.g. replay from raw captures, which are also on the same 7-day clock,
 * making this warning the last exit).
 */
export interface RetentionWarningConfig {
  /** config.storage.retention.maxAgeMs — the debug window shared by raw captures, csi_records, and features. */
  maxAgeMs: number;
  /** How far before the edge to start warning, so there's still time to act. */
  safetyMarginMs: number;
}

/** Default safety margin: start warning a full day before the data would actually age out. */
export const DEFAULT_RETENTION_SAFETY_MARGIN_MS = 24 * 60 * 60 * 1000;

function formatDuration(ms: number): string {
  const days = ms / 86_400_000;
  if (Math.abs(days) >= 1) return `${days.toFixed(1)}d`;
  const hours = ms / 3_600_000;
  return `${hours.toFixed(1)}h`;
}

/**
 * Returns a human-readable warning string if `targetMs` is already inside
 * the retention safety margin, or `undefined` if it's comfortably within
 * the debug window. Pure function (no I/O), so callers (index.ts) decide
 * how to surface it (`console.warn`, etc) and it's trivially unit-tested.
 */
export function retentionEdgeWarning(
  targetMs: number,
  config: RetentionWarningConfig,
  nowMs: number = Date.now(),
): string | undefined {
  const ageMs = nowMs - targetMs;
  const warnAtAgeMs = config.maxAgeMs - config.safetyMarginMs;
  if (ageMs < warnAtAgeMs) return undefined;

  const remainingMs = config.maxAgeMs - ageMs;
  if (remainingMs > 0) {
    return (
      `warning: this label's time is ${formatDuration(ageMs)} old -- raw data (csi_records, features, ` +
      `and the on-disk capture tree) is retained for only ${formatDuration(config.maxAgeMs)}. Only ` +
      `~${formatDuration(remainingMs)} left before it ages out -- replay from raw captures now (\`homecsi ` +
      `replay\`) if you need this window's raw per-link features preserved.`
    );
  }
  return (
    `warning: this label's time is ${formatDuration(ageMs)} old, already past the ` +
    `${formatDuration(config.maxAgeMs)} retention window -- raw csi_records/features for it are likely ` +
    `already gone, and \`homecsi label preserve\` will error rather than silently skip it.`
  );
}

/** The subset of a label_session `openSessionRetentionWarnings` needs. */
export interface OpenSessionForRetentionWarning {
  id: number;
  startedAtMs: number;
  endedAtMs: number | null;
}

/**
 * `retentionEdgeWarning` above fires on the age of a specific *target
 * timestamp*, which works for `label add` (a timestamp someone is choosing
 * right now) but is structurally blind to the actual scenario this
 * warning system exists for: a session left open for days. `session
 * start` always passes `Date.now()` (never old), and a label added to a
 * long-open session in real time carries a fresh timestamp too -- neither
 * path ever ages into the warning. What actually needs watching is the
 * session's own `startedAtMs`, independent of whether/when anyone adds a
 * label to it.
 *
 * `homecsi label preserve` (the CLI sweep backstop, index.ts) is the
 * natural place to run this check: it's the command an operator already
 * runs periodically as a backstop, so surfacing "this open session is
 * about to (or already did) age past the debug window" here gives a human
 * a chance to close it and preserve its data while that's still possible,
 * instead of only ever finding out via the hard error `preserveSessionFeatures`
 * throws once the data is already gone.
 */
export function openSessionRetentionWarnings(
  sessions: readonly OpenSessionForRetentionWarning[],
  config: RetentionWarningConfig,
  nowMs: number = Date.now(),
): Array<{ sessionId: number; warning: string }> {
  const warnings: Array<{ sessionId: number; warning: string }> = [];
  for (const session of sessions) {
    if (session.endedAtMs !== null) continue;
    const warning = retentionEdgeWarning(session.startedAtMs, config, nowMs);
    if (warning !== undefined) warnings.push({ sessionId: session.id, warning });
  }
  return warnings;
}
