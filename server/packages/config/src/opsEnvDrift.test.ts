import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV_VAR_PATHS } from './env.js';

/**
 * Drift test for the four-way contract between:
 *   - server/packages/config/src/env.ts (`ENV_VAR_PATHS`) — the actual,
 *     authoritative list of HOMECSI_* variables the app reads.
 *   - ops/docker-compose.yml — the primary deployment's env wiring.
 *   - ops/systemd/README.md — the non-Docker deployment's env wiring.
 *   - ops/.env.example — the Docker path's operator-facing env template.
 *
 * Same philosophy as docs-example.test.ts: this repo has a documented
 * history of ops/ drifting from the code it configures because nothing
 * mechanically checked the two against each other. This test is that
 * check for one specific, previously-real class of drift (env var
 * *names*): every HOMECSI_* identifier that appears anywhere in any of
 * these three ops files must be a name `env.ts` actually reads, or must be
 * explicitly justified in the allowlist below. An unexplained addition to
 * the allowlist is exactly how this test would rot the same way the code
 * it replaces did — so every entry requires a one-line "who reads this"
 * comment, and the list is intentionally short.
 *
 * `ops/.env.example` matters in its own right, not just as one more file
 * to sweep: this repo's actual historical drift (`HOMECSI_API_TOKEN` vs.
 * `env.ts`'s `HOMECSI_SERVER_API_TOKEN`) lived precisely there, and the
 * first version of this test did not scan it.
 *
 * Does not require live infrastructure — pure text/regex over files
 * already in the repo. Safe to run in `npm test` on a clean checkout.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/packages/config/src -> repo root is four levels up.
const repoRoot = path.resolve(__dirname, '../../../..');

const composePath = path.join(repoRoot, 'ops', 'docker-compose.yml');
const systemdReadmePath = path.join(repoRoot, 'ops', 'systemd', 'README.md');
const envExamplePath = path.join(repoRoot, 'ops', '.env.example');

/**
 * Names that are real, deliberately not read by `env.ts`'s
 * `applyEnvOverrides`, and therefore would never legitimately appear in
 * `ENV_VAR_PATHS` — each with a one-line justification for *why* it's
 * real but exempt, and *who* actually reads it.
 */
const JUSTIFIED_ALLOWLIST: ReadonlyArray<{ name: string; justification: string }> = [
  {
    name: 'HOMECSI_CONFIG_PATH',
    justification:
      "packages/cli/src/resolveConfigPath.ts — selects which config *file* to load; it is not one of the config *value* overrides applyEnvOverrides applies on top of an already-loaded file.",
  },
  {
    name: 'HOMECSI_IMAGE_TAG',
    justification:
      'ops/docker-compose.yml only — tags the locally-built image (`homecsi-server:${HOMECSI_IMAGE_TAG:-local}`); never passed into a container as an app-level env var.',
  },
  {
    name: 'HOMECSI_DOMAIN',
    justification:
      "ops/docker-compose.yml's `caddy` service and ops/Caddyfile only — the public domain Caddy requests a TLS cert for; @homecsi/api never sees it.",
  },
  {
    name: 'HOMECSI_ACME_EMAIL',
    justification:
      "ops/docker-compose.yml's `caddy` service and ops/Caddyfile only — Let's Encrypt account contact email; @homecsi/api never sees it.",
  },
  {
    name: 'HOMECSI_DATA_DIR',
    justification:
      'ops/docker-compose.yml and ops/.env.example only — the *host* path bind-mounted to the fixed in-container path /data; no server code reads a HOMECSI_DATA_DIR variable (the container always sees the literal path /data).',
  },
  {
    name: 'HOMECSI_UDP_RATE_LIMIT_PER_SEC',
    justification:
      'ops/hardening/harden.sh only — firewall rate-limit rule input, evaluated entirely outside the Node process.',
  },
  {
    name: 'HOMECSI_UDP_RATE_LIMIT_BURST',
    justification:
      'ops/hardening/harden.sh only — firewall rate-limit rule input, evaluated entirely outside the Node process.',
  },
  {
    name: 'HOMECSI_UDP_PORT',
    justification:
      "ops/.env.example / ops/hardening/harden.sh's outer name — deliberately NOT renamed to match env.ts's HOMECSI_SERVER_UDP_PORT because harden.sh's firewall rule also reads this exact name; the compose anchor maps it inward (`HOMECSI_SERVER_UDP_PORT: ${HOMECSI_UDP_PORT:-5566}`).",
  },
  {
    name: 'HOMECSI_BACKUP_RETENTION_DAYS',
    justification:
      'ops/backup.sh only (sourced from ops/.env) — how many days of local dump files to keep; not part of the application config the server process itself loads.',
  },
];

const ALLOWED_NAMES = new Set<string>(JUSTIFIED_ALLOWLIST.map((entry) => entry.name));
const ENV_VAR_NAMES = new Set<string>(ENV_VAR_PATHS.map((entry) => entry.envVar));

/** Every HOMECSI_* identifier appearing anywhere in `text` (dedup'd). */
function extractHomecsiNames(text: string): string[] {
  const matches = text.match(/\bHOMECSI_[A-Z0-9_]+\b/g) ?? [];
  return [...new Set(matches)];
}

function assertNoDrift(names: readonly string[], sourceLabel: string): void {
  const unexplained = names.filter((name) => !ENV_VAR_NAMES.has(name) && !ALLOWED_NAMES.has(name));
  expect(
    unexplained,
    `${sourceLabel} references HOMECSI_* name(s) that are neither read by ` +
      `env.ts's ENV_VAR_PATHS nor in opsEnvDrift.test.ts's JUSTIFIED_ALLOWLIST: ` +
      `${unexplained.join(', ')}. Either the ops file has a wrong/stale name ` +
      `(fix it to match env.ts), or env.ts is missing an override that ops ` +
      `now depends on, or this genuinely is a new infra-only name that needs ` +
      `an allowlist entry with a "who reads this" justification.`,
  ).toEqual([]);
}

/**
 * Every `${NAME}` interpolation referenced in `text`, for names matching
 * `prefixPattern`. Covers all of Compose's modifier forms - `${NAME-x}`,
 * `${NAME:-x}`, `${NAME+x}`, `${NAME:+x}`, `${NAME?x}`, `${NAME:?x}` - not
 * just `:-`, so a reference written with a different modifier cannot slip
 * past the declared-in-.env.example check.
 */
function extractInterpolatedRefs(text: string, prefixPattern: RegExp): string[] {
  const refs: string[] = [];
  const re = /\$\{([A-Z0-9_]+)(:?[-+?][^}]*)?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[1] as string;
    if (prefixPattern.test(name)) refs.push(name);
  }
  return [...new Set(refs)];
}

/** Every `KEY=` declared at the start of a line in a `.env`-style file. */
function extractDeclaredNames(text: string): Set<string> {
  const declared = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    if (m) declared.add(m[1] as string);
  }
  return declared;
}

describe('ops/ HOMECSI_* env var names match env.ts (no drift)', () => {
  it('every HOMECSI_* name in ops/docker-compose.yml is known', () => {
    const text = readFileSync(composePath, 'utf8');
    assertNoDrift(extractHomecsiNames(text), 'ops/docker-compose.yml');
  });

  it('every HOMECSI_* name in ops/systemd/README.md is known', () => {
    const text = readFileSync(systemdReadmePath, 'utf8');
    assertNoDrift(extractHomecsiNames(text), 'ops/systemd/README.md');
  });

  it('every HOMECSI_* name in ops/.env.example is known', () => {
    // This is the file where this repo's actual historical drift lived
    // (HOMECSI_API_TOKEN vs. env.ts's HOMECSI_SERVER_API_TOKEN) - see the
    // module doc comment. Never skip scanning this file again.
    const text = readFileSync(envExamplePath, 'utf8');
    assertNoDrift(extractHomecsiNames(text), 'ops/.env.example');
  });

  it('every ${HOMECSI_*}/${POSTGRES_*} the compose file reads from .env is declared in ops/.env.example', () => {
    // The previous three checks only catch a wrong *name* appearing
    // somewhere. This catches the other half of the same class of bug:
    // ops/docker-compose.yml referencing an outer (.env-facing) variable
    // that ops/.env.example never declares at all, which `docker compose
    // up` would silently treat as empty-string rather than erroring.
    const composeText = readFileSync(composePath, 'utf8');
    const envExampleText = readFileSync(envExamplePath, 'utf8');
    const referenced = extractInterpolatedRefs(composeText, /^(HOMECSI|POSTGRES)_/);
    const declared = extractDeclaredNames(envExampleText);
    const undeclared = referenced.filter((name) => !declared.has(name));
    expect(
      undeclared,
      `ops/docker-compose.yml references \${...} for variable(s) ops/.env.example ` +
        `never declares: ${undeclared.join(', ')}. Add a KEY=value line for each to ` +
        `ops/.env.example, or fix the compose file's reference.`,
    ).toEqual([]);
  });

  it('ENV_VAR_PATHS and the allowlist do not overlap', () => {
    // If a name is in both, the allowlist entry is dead weight (and
    // possibly hiding a real override that should just be used).
    const overlap = [...ALLOWED_NAMES].filter((name) => ENV_VAR_NAMES.has(name));
    expect(overlap).toEqual([]);
  });
});
