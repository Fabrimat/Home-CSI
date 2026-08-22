import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { configSchema, type Config } from './schema.js';
import { applyEnvOverrides } from './env.js';

export class ConfigError extends Error {}

/**
 * Loads and validates the Home CSI config: reads a YAML file, applies
 * HOMECSI_* environment overrides (see env.ts), then validates the result
 * against the full system schema (schema.ts). Throws ConfigError with a
 * readable, field-by-field message on any validation failure.
 */
export function loadConfig(yamlPath: string, env: NodeJS.ProcessEnv = process.env): Config {
  let text: string;
  try {
    text = readFileSync(yamlPath, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `failed to read config file at ${yamlPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(
      `failed to parse YAML in ${yamlPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`config file ${yamlPath} must contain a YAML mapping at the top level`);
  }

  const merged = applyEnvOverrides(raw as Record<string, unknown>, env);

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`invalid configuration in ${yamlPath}:\n${details}`);
  }

  return result.data;
}
