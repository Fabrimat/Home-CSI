import path from 'node:path';
import type { Config } from '@homecsi/config';

/**
 * Resolves `config.storage.captureDir` to an absolute path.
 *
 * IMPORTANT: this resolves relative to `process.cwd()`, NOT relative to
 * the config *file's* directory. This is the only resolution basis
 * available to this package: `runIngest`, `replayCaptures`, and
 * `pruneStorage` all receive an already-parsed `Config` object, never the
 * original config file path (see `packages/cli/CONTRACTS.md`, which
 * explicitly documents `replayCaptures`'s `inputPath` argument as
 * "relative to CWD" for the same reason).
 *
 * NOTE FOR OPERATORS / OTHER BRIEFS: `packages/cli`'s `doctor` command
 * resolves this same config value relative to the *config file's*
 * directory instead (see `packages/cli/src/commands/doctor.ts`,
 * `path.resolve(path.dirname(configPath), config.storage.captureDir)`).
 * In the common case config.yaml lives in `server/` and every command is
 * run with `server/` as the working directory, so both resolve to the
 * same absolute path — but an operator running with a different CWD than
 * the config file's directory (e.g. a systemd unit with
 * `WorkingDirectory=` unset, or `--config /etc/homecsi/config.yaml` from
 * an arbitrary shell) will see `doctor`'s disk-usage figure and this
 * package's actual capture location diverge. This is flagged back to the
 * coordinating brief rather than fixed here, since it is not fixable
 * within this package's contracted function signatures alone.
 */
export function resolveCaptureDir(config: Config): string {
  return path.resolve(process.cwd(), config.storage.captureDir);
}
