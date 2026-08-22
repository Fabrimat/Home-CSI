import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolves the config YAML path for a CLI invocation: an explicit
 * `--config` flag wins, then `HOMECSI_CONFIG_PATH`, then `./config.yaml`
 * relative to the current working directory. Does not check existence —
 * callers that need a friendly "file not found" message do that
 * themselves (see doctor.ts for the diagnostic version).
 */
export function resolveConfigPath(explicit: string | undefined): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.HOMECSI_CONFIG_PATH) return path.resolve(process.env.HOMECSI_CONFIG_PATH);
  return path.resolve(process.cwd(), 'config.yaml');
}

export function configFileExists(configPath: string): boolean {
  return existsSync(configPath);
}
