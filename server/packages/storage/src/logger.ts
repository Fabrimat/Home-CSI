/**
 * Minimal structural logger interface this package accepts, rather than
 * depending on `pino` directly. A real `pino.Logger` (as constructed by
 * `@homecsi/ingest`) satisfies this shape, and tests can pass a trivial
 * fake with no extra dependency.
 */
export interface BasicLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/** No-op logger used whenever a caller does not supply one. */
export const noopLogger: BasicLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Wraps a `BasicLogger` so `.error()` (the only level this package needs
 * rate-limited so far) logs at most once per `windowMs`, regardless of
 * how many times it is called. Used for ordinary, sustained production
 * failure modes (e.g. a DB outage causing every batch insert to fail) so
 * they cannot themselves flood the log/disk — mirrors the rate limiter
 * `@homecsi/ingest` already applies to hostile-input rejections.
 */
export function createRateLimitedLogger(logger: BasicLogger, windowMs = 5000): BasicLogger {
  let lastLoggedAtMs = 0;
  return {
    info: (obj, msg) => logger.info(obj, msg),
    warn: (obj, msg) => logger.warn(obj, msg),
    error: (obj, msg) => {
      const now = Date.now();
      if (now - lastLoggedAtMs >= windowMs) {
        lastLoggedAtMs = now;
        logger.error(obj, msg);
      }
    },
  };
}
