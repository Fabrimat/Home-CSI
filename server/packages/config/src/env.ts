/**
 * HOMECSI_* environment variable overrides, applied on top of the parsed
 * YAML config before zod validation. Only the operationally relevant
 * leaves are overridable this way (secrets, network binding, log level) —
 * structural config (node registry, feature windows, etc.) is expected to
 * live in the YAML file. Values are always strings here; zod's `coerce`
 * schemas (see schema.ts) turn them into numbers/booleans as needed.
 */
export const ENV_VAR_PATHS: ReadonlyArray<{ envVar: string; path: readonly string[] }> = [
  { envVar: 'HOMECSI_SERVER_UDP_HOST', path: ['server', 'udp', 'host'] },
  { envVar: 'HOMECSI_SERVER_UDP_PORT', path: ['server', 'udp', 'port'] },
  { envVar: 'HOMECSI_SERVER_HTTP_HOST', path: ['server', 'http', 'host'] },
  { envVar: 'HOMECSI_SERVER_HTTP_PORT', path: ['server', 'http', 'port'] },
  { envVar: 'HOMECSI_SERVER_API_TOKEN', path: ['server', 'apiToken'] },
  { envVar: 'HOMECSI_DATABASE_HOST', path: ['database', 'host'] },
  { envVar: 'HOMECSI_DATABASE_PORT', path: ['database', 'port'] },
  { envVar: 'HOMECSI_DATABASE_NAME', path: ['database', 'database'] },
  { envVar: 'HOMECSI_DATABASE_USER', path: ['database', 'user'] },
  { envVar: 'HOMECSI_DATABASE_PASSWORD', path: ['database', 'password'] },
  { envVar: 'HOMECSI_DATABASE_SSL', path: ['database', 'ssl'] },
  { envVar: 'HOMECSI_STORAGE_CAPTURE_DIR', path: ['storage', 'captureDir'] },
  { envVar: 'HOMECSI_LOGGING_LEVEL', path: ['logging', 'level'] },
];

function setPath(obj: Record<string, unknown>, path: readonly string[], value: string): void {
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] as string;
    const next = cursor[key];
    if (typeof next !== 'object' || next === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  const lastKey = path[path.length - 1] as string;
  cursor[lastKey] = value;
}

/**
 * Applies any HOMECSI_* overrides present in `env` on top of a (structured
 * clone of) `raw`. Does not mutate `raw`.
 */
export function applyEnvOverrides(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const merged = structuredClone(raw);
  for (const { envVar, path } of ENV_VAR_PATHS) {
    const value = env[envVar];
    if (value !== undefined) {
      setPath(merged, path, value);
    }
  }
  return merged;
}
