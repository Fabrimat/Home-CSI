import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig, ConfigError, type Config } from '@homecsi/config';
import { createPool, healthCheck } from '@homecsi/db';
import { configFileExists } from '../resolveConfigPath.js';

type CheckStatus = 'pass' | 'warn' | 'fail';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

function printResult(r: CheckResult): void {
  const label = r.status === 'pass' ? 'PASS' : r.status === 'warn' ? 'WARN' : 'FAIL';
  console.log(`[${label}] ${r.name}: ${r.detail}`);
}

async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(full);
    } else if (entry.isFile()) {
      const stat = await fs.stat(full);
      total += stat.size;
    }
  }
  return total;
}

/**
 * Runs Home CSI's diagnostic checks: config validity, database
 * reachability, and the raw-capture disk budget. Prints a PASS/WARN/FAIL
 * line per check and sets `process.exitCode = 1` if anything failed.
 * This is the one command `packages/cli` implements itself (see
 * CONTRACTS.md) rather than delegating to a sibling package.
 */
export async function runDoctor(configPath: string): Promise<void> {
  let anyFailed = false;

  if (!configFileExists(configPath)) {
    printResult({
      name: 'config file',
      status: 'fail',
      detail: `not found at ${configPath}`,
    });
    process.exitCode = 1;
    return;
  }
  printResult({ name: 'config file', status: 'pass', detail: `found at ${configPath}` });

  let config: Config;
  try {
    config = loadConfig(configPath);
    printResult({ name: 'config validity', status: 'pass', detail: 'parses and validates' });
  } catch (err) {
    const detail = err instanceof ConfigError ? err.message : String(err);
    printResult({ name: 'config validity', status: 'fail', detail });
    process.exitCode = 1;
    return;
  }

  // Database reachability.
  const pool = createPool(config.database);
  try {
    const ok = await healthCheck(pool);
    if (ok) {
      printResult({
        name: 'database reachability',
        status: 'pass',
        detail: `connected to ${config.database.host}:${config.database.port}/${config.database.database}`,
      });
    } else {
      printResult({
        name: 'database reachability',
        status: 'fail',
        detail: `could not reach ${config.database.host}:${config.database.port}/${config.database.database}`,
      });
      anyFailed = true;
    }
  } finally {
    await pool.end().catch(() => undefined);
  }

  // Raw-capture disk budget.
  const captureDir = path.resolve(path.dirname(configPath), config.storage.captureDir);
  const usedBytes = await directorySizeBytes(captureDir);
  const budgetBytes = config.storage.retention.maxTotalBytes;
  const pct = budgetBytes > 0 ? (usedBytes / budgetBytes) * 100 : 0;
  const detail = `${usedBytes} bytes used of ${budgetBytes} byte budget (${pct.toFixed(1)}%) at ${captureDir}`;
  if (usedBytes > budgetBytes) {
    printResult({ name: 'disk budget', status: 'fail', detail });
    anyFailed = true;
  } else if (pct > 80) {
    printResult({ name: 'disk budget', status: 'warn', detail });
  } else {
    printResult({ name: 'disk budget', status: 'pass', detail });
  }

  if (anyFailed) {
    process.exitCode = 1;
  }
}
