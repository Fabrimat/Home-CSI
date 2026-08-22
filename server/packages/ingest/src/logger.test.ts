import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, createRateLimiter, type Logger } from './logger.js';
import { makeTestConfig } from './testHelpers.js';

const tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'homecsi-logger-test-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

describe('createLogger', () => {
  it('honours config.logging.file.maxSizeMb/maxFiles by writing through a rolling file transport (not silently ignoring them)', async () => {
    const dir = await makeTmpDir();
    const config = makeTestConfig([]);
    config.logging.level = 'info';
    config.logging.file.path = path.join(dir, 'homecsi.log');
    config.logging.file.maxSizeMb = 1;
    config.logging.file.maxFiles = 2;

    const logger = createLogger(config);
    logger.info({ hello: 'world' }, 'log rotation smoke test');

    // pino-roll's worker-thread transport is asynchronous; give it a
    // moment to actually create the rolling log file on disk.
    await waitFor(async () => {
      const entries = await fs.readdir(dir).catch(() => []);
      return entries.length > 0;
    });

    const entries = await fs.readdir(dir);
    expect(entries.length).toBeGreaterThan(0);
  }, 10000);

  it('prunes log files left behind by a previous process run, not just files from the current one (removeOtherLogFiles)', async () => {
    const dir = await makeTmpDir();
    const config = makeTestConfig([]);
    config.logging.level = 'info';
    config.logging.file.path = path.join(dir, 'homecsi.log');
    config.logging.file.maxSizeMb = 1;
    config.logging.file.maxFiles = 2; // limit.count = 1 -> at most 2 files on disk in total

    // Simulate leftover rotated files from a PREVIOUS process run (a
    // restart/deploy/crash) that pino-roll's own numbering convention
    // would pick up (`<base>.<count>.log`) but did not itself create in
    // this process. Without `limit.removeOtherLogFiles: true`, pino-roll
    // only prunes files it created in the *current* process, so these
    // would never be cleaned up and the directory would grow unbounded
    // across restarts.
    await fs.writeFile(path.join(dir, 'homecsi.1.log'), 'stale-from-a-previous-run\n'.repeat(20));
    await fs.writeFile(path.join(dir, 'homecsi.2.log'), 'stale-from-a-previous-run\n'.repeat(20));

    const logger = createLogger(config);
    // Write enough volume to force at least one rotation past the 1 MB
    // threshold, which is when pino-roll's own file-management/cleanup
    // (including removeOtherLogFiles) actually runs. `createLogger`
    // always also writes to `process.stdout` (by design, so a
    // foreground/systemd-journaled process still shows logs); silence it
    // for the duration of this loop purely to keep this test's own
    // output readable — the assertions below are entirely about the file
    // sink on disk, not stdout.
    const realStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const pad = 'x'.repeat(20_000);
      for (let i = 0; i < 100; i++) {
        logger.info({ i, pad }, 'restart-pruning test line');
      }
    } finally {
      process.stdout.write = realStdoutWrite;
    }

    // IMPORTANT: do not simply poll for `entries.length <= maxFiles`. The two
    // pre-seeded stale files alone already satisfy that bound, so such a
    // predicate is satisfied on the very first poll, before pino-roll's worker
    // thread has rotated anything at all — the test would then pass even with
    // `removeOtherLogFiles` disabled, proving nothing. Instead, wait for
    // positive evidence that a rotation actually happened (a file appearing
    // that is NOT one of the ones we seeded), and only then assert the bound.
    const seeded = new Set(['homecsi.1.log', 'homecsi.2.log']);
    await waitFor(async () => {
      const entries = await fs.readdir(dir).catch(() => []);
      return entries.some((e) => !seeded.has(e));
    }, 10000);

    // Rotation has occurred. Give pino-roll's cleanup a moment to settle, then
    // assert the total is bounded — this is the assertion that fails if
    // `removeOtherLogFiles: true` regresses, because the stale files from the
    // simulated previous run would survive alongside the current run's files.
    await waitFor(async () => {
      const entries = await fs.readdir(dir).catch(() => []);
      return entries.length > 0 && entries.length <= config.logging.file.maxFiles;
    }, 10000);

    const entries = await fs.readdir(dir);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(config.logging.file.maxFiles);
  }, 15000);
});

describe('createRateLimiter', () => {
  it('logs at most once per window for a given key', () => {
    const calls: unknown[][] = [];
    const fakeLogger = {
      warn: (...args: unknown[]) => calls.push(args),
    } as unknown as Logger;
    const limiter = createRateLimiter(fakeLogger, 10_000);

    limiter.warn('same-key', { a: 1 }, 'first');
    limiter.warn('same-key', { a: 2 }, 'second');
    limiter.warn('different-key', { a: 3 }, 'third');

    expect(calls).toHaveLength(2); // 'same-key' logged once, 'different-key' logged once
  });
});
