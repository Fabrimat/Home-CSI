import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbPool } from '@homecsi/db';
import type { BasicLogger } from '@homecsi/storage';
import {
  DEFAULT_MAX_BOX_SESSION_AGE_MS,
  PersistedRateLimiter,
  createBoxSessionGate,
} from './persistedRateLimiter.js';

function makeFakeLogger(): BasicLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * Fake pool standing in for a real Postgres connection. Actually applies
 * `started_at > $1` against a single simulated `box_sessions` row (or none),
 * mirroring what the real SQL's own predicate does -- not a fixture toggle
 * keyed on anything the caller passes in besides the bound cutoff, so this
 * test genuinely exercises the age-cutoff logic, not just a canned answer.
 */
function makeBoxSessionsPool(session: { startedAt: Date; endedAt?: Date } | null): {
  pool: DbPool;
  queries: Array<{ sql: string; values: readonly unknown[] }>;
} {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const pool = {
    async query(sql: string, values: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
      queries.push({ sql, values });
      if (!session || session.endedAt !== undefined) return { rows: [] };
      const cutoff = values[0] as Date;
      return { rows: session.startedAt > cutoff ? [{ '?column?': 1 }] : [] };
    },
  };
  return { pool: pool as unknown as DbPool, queries };
}

describe('createBoxSessionGate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports open once a poll finds a fresh (recently started) open row', async () => {
    vi.useFakeTimers();
    const { pool, queries } = makeBoxSessionsPool({ startedAt: new Date() });
    const gate = createBoxSessionGate(pool, makeFakeLogger(), { intervalMs: 1000, maxOpenAgeMs: 3_600_000 });

    expect(gate.isOpen()).toBe(false); // before the first poll has even run
    await vi.advanceTimersByTimeAsync(1000);
    expect(gate.isOpen()).toBe(true);

    // Regression guard on the query shape: a join-free age filter against
    // the row's own started_at, bound as a parameter (not string-baked).
    expect(queries[0]?.sql).toContain('started_at > $1');
    expect(queries[0]?.values[0]).toBeInstanceOf(Date);

    gate.stop();
  });

  it('self-heals to closed once an open row is older than maxOpenAgeMs, even though ended_at is still NULL', async () => {
    vi.useFakeTimers();
    const staleStartedAt = new Date(Date.now() - 2 * 3_600_000); // 2 hours ago
    const { pool } = makeBoxSessionsPool({ startedAt: staleStartedAt });
    const gate = createBoxSessionGate(pool, makeFakeLogger(), {
      intervalMs: 1000,
      maxOpenAgeMs: 3_600_000, // 1 hour cap -- the abandoned session is well past it
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(gate.isOpen()).toBe(false);

    gate.stop();
  });

  it('uses DEFAULT_MAX_BOX_SESSION_AGE_MS (1 hour) when maxOpenAgeMs is omitted', async () => {
    vi.useFakeTimers();
    const justInsideDefault = new Date(Date.now() - (DEFAULT_MAX_BOX_SESSION_AGE_MS - 60_000));
    const { pool } = makeBoxSessionsPool({ startedAt: justInsideDefault });
    const gate = createBoxSessionGate(pool, makeFakeLogger(), { intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(gate.isOpen()).toBe(true);

    gate.stop();
  });

  it('keeps the last known answer (does not flip to closed) on a poll failure', async () => {
    vi.useFakeTimers();
    let shouldFail = false;
    const pool = {
      query: vi.fn(async () => {
        if (shouldFail) throw new Error('connection refused');
        return { rows: [{ '?column?': 1 }] };
      }),
    } as unknown as DbPool;
    const logger = makeFakeLogger();
    const gate = createBoxSessionGate(pool, logger, { intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(gate.isOpen()).toBe(true);

    shouldFail = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(gate.isOpen()).toBe(true); // unchanged despite the failed poll
    expect(logger.warn).toHaveBeenCalled();

    gate.stop();
  });
});

// Unrelated to the box-session gate above -- exercised here only because
// this file is where PersistedRateLimiter already lives; kept minimal since
// engine.test.ts already covers its behaviour end-to-end via the ingest
// engine.
describe('PersistedRateLimiter', () => {
  it('admits up to the configured burst, then denies until tokens refill', () => {
    const limiter = new PersistedRateLimiter({ recordsPerSec: 10, burstRecords: 2 });
    expect(limiter.admit(1, 'aa:bb:cc:dd:ee:01', 0)).toBe(true);
    expect(limiter.admit(1, 'aa:bb:cc:dd:ee:01', 0)).toBe(true);
    expect(limiter.admit(1, 'aa:bb:cc:dd:ee:01', 0)).toBe(false);
  });
});
