import path from 'node:path';
import pino from 'pino';
import type { Config } from '@homecsi/config';

export type Logger = pino.Logger;

/**
 * Structured logger built from `config.logging`. Writes to stdout and to
 * a size-rotating log file at the configured level, enforcing
 * `config.logging.file.maxSizeMb`/`maxFiles` via the `pino-roll`
 * transport rather than leaving them validated-but-unenforced: an
 * ordinary, sustained production failure (a DB outage, a full disk) can
 * drive sustained error-rate logging even with the rate limiter in
 * `createRateLimiter`/`@homecsi/storage`'s `createRateLimitedLogger`
 * applied, so the file sink must bound its own disk usage independently.
 *
 * `maxFiles` maps to `pino-roll`'s `limit.count`, which is the number of
 * *rotated* files kept *in addition to* the active one — so
 * `limit.count = maxFiles - 1` keeps `maxFiles` files on disk in total
 * (never negative, in case `maxFiles` is configured as 1).
 *
 * `limit.removeOtherLogFiles: true` is required, not optional: per
 * `pino-roll`'s own docs, `limit.count` alone only prunes files created
 * by *the current process* — every restart (a deploy, a systemd restart,
 * or a crash) would otherwise start a fresh count and never clean up the
 * previous run's files, so `maxFiles` would only bound disk usage within
 * a single process lifetime, not overall. The user's requirement is that
 * the log directory cannot fill up regardless of how many times the
 * process restarts.
 */
export function createLogger(config: Config): Logger {
  const level = config.logging.level;
  const filePath = path.resolve(process.cwd(), config.logging.file.path);
  const fileStream = pino.transport({
    target: 'pino-roll',
    options: {
      file: filePath,
      size: `${config.logging.file.maxSizeMb}m`,
      mkdir: true,
      limit: { count: Math.max(0, config.logging.file.maxFiles - 1), removeOtherLogFiles: true },
    },
  });
  const streams = pino.multistream([
    { stream: process.stdout, level },
    { stream: fileStream, level },
  ]);
  return pino({ level }, streams);
}

/**
 * Logs at most once per `windowMs` for a given `key`, so a flood of
 * hostile/malformed datagrams (the UDP port is world-reachable, per
 * docs/architecture.md "Security posture") cannot itself fill the disk
 * with log lines. Rejections/mismatches are always counted in metrics
 * regardless of whether this particular occurrence was logged.
 */
export function createRateLimiter(logger: Logger, windowMs = 5000): {
  warn: (key: string, fields: Record<string, unknown>, msg: string) => void;
} {
  const last = new Map<string, number>();
  return {
    warn(key, fields, msg) {
      const now = Date.now();
      const prev = last.get(key) ?? 0;
      if (now - prev >= windowMs) {
        last.set(key, now);
        logger.warn(fields, msg);
      }
    },
  };
}
