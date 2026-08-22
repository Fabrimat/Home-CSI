export interface LogEntry {
  time: string;
  level: string;
  msg: string;
  [extra: string]: unknown;
}

/**
 * Bounded in-memory tail of this process's own structured log output, for
 * the "Log tail" debug view. Genuinely emitted log lines only — nothing
 * here is fabricated. Bounded by `capacity` so a noisy process cannot grow
 * this without limit.
 */
export class RingLogBuffer {
  private readonly entries: LogEntry[] = [];

  constructor(private readonly capacity: number) {}

  push(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.shift();
    }
  }

  /** Most recent entries first, optionally filtered by level, bounded by `limit`. */
  list(options: { level?: string; limit: number }): LogEntry[] {
    const filtered = options.level
      ? this.entries.filter((e) => e.level === options.level)
      : this.entries;
    return filtered.slice(Math.max(0, filtered.length - options.limit)).reverse();
  }
}
