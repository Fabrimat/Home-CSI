# `packages/cli` contracts

`packages/cli` is the single entry point for the whole system
(`homecsi <command> [...args]`). It registers every subcommand listed
below now, up front, and lazily `await import(...)`s the owning sibling
package only when that command actually runs. **Sibling briefs implement
the functions documented here; they must never edit `packages/cli`
itself.** If a contracted signature needs to change, that's a
cross-cutting change and should go back through the coordinating brief,
not be done unilaterally in a sibling package.

## How "not implemented yet" works

Every stub package's exported command function currently does exactly
this:

```ts
export async function someCommand(...): Promise<...> {
  throw new Error('not implemented yet — owned by brief BX');
}
```

`packages/cli`'s command wrapper (`src/lazyCommand.ts`) catches any thrown
`Error` whose `message` starts with `"not implemented yet"` and prints
just that message (no stack trace), setting a non-zero exit code. **Once
you implement a command for real, delete the stub body — do not throw
that message anymore.** Any other error you throw (or that a real bug
produces) prints its full stack, as normal.

## Global option

Every command accepts `-c, --config <path>`. Resolution order (see
`src/resolveConfigPath.ts`): explicit `--config` flag, then
`HOMECSI_CONFIG_PATH` env var, then `./config.yaml` relative to the
current working directory. Commands that need config call
`loadConfig(configPath)` from `@homecsi/config` themselves (or, for the
lazy commands, `packages/cli` calls it before importing your package —
see below); you always receive an already-validated `Config`, never a raw
path or raw YAML.

## Commands implemented directly in `packages/cli` (not delegated)

### `migrate`

Implemented in `src/commands/migrate.ts` using `@homecsi/db` +
`@homecsi/config` directly. No sibling brief needs to touch this.

### `doctor`

Implemented in `src/commands/doctor.ts`. Checks config validity, database
reachability, and the raw-capture disk budget (`storage.captureDir` size
vs. `storage.retention.maxTotalBytes`). No sibling brief needs to touch
this, but B3 should be aware `doctor` reads `config.storage.captureDir`
directly (resolved relative to the config file's directory) to compute
disk usage — if B3 changes how/where captures are laid out on disk in a
way that breaks a plain recursive directory-size sum, please flag it back
rather than silently making `doctor` wrong.

## Commands delegated to sibling packages

For each, `packages/cli` does the equivalent of:

```ts
const config = loadConfig(getConfigPath());
const mod = await import('@homecsi/<package>');
await mod.<exportName>(<args>);
```

| CLI command      | Package             | Export name           | Signature                                                      | Notes |
|-------------------|----------------------|------------------------|------------------------------------------------------------------|-------|
| `ingest`           | `@homecsi/ingest`    | `runIngest`            | `(config: Config) => Promise<void>`                              | Long-running; resolves on graceful shutdown (SIGINT/SIGTERM), rejects if it fails to bind the UDP socket. Owned by **B3**. |
| `replay <path>`    | `@homecsi/storage`   | `replayCaptures`       | `(inputPath: string, config: Config) => Promise<void>`            | `inputPath` is the CLI's positional argument, a raw capture file or directory, passed through unresolved (relative to CWD) — resolve it yourself. Owned by **B3**. |
| `prune`            | `@homecsi/storage`   | `pruneStorage`         | `(config: Config) => Promise<void>`                               | Enforces `config.storage.retention` (max age + max total disk budget) and rotation. Owned by **B3**. |
| `serve`            | `@homecsi/api`       | `startServer`          | `(config: Config) => Promise<void>`                               | Long-running HTTP server; resolves on graceful shutdown, rejects if it fails to bind. Owned by **B5**. |
| `features`         | `@homecsi/features`  | `runFeaturePipeline`   | `(config: Config) => Promise<void>`                               | Owned by **B4**. |
| `occupancy`        | `@homecsi/occupancy` | `runOccupancyPipeline` | `(config: Config) => Promise<void>`                               | Owned by **B4**. |
| `label [args...]`  | `@homecsi/labeling`  | `runLabelCli`          | `(args: string[], config: Config) => Promise<void>`               | `args` is every token after `label` on the command line, unparsed (`packages/cli` uses `allowUnknownOption()` so your own sub-flags like `--count` pass through untouched). You own all further sub-command parsing. Owned by **B4**. |
| `train [args...]`  | `@homecsi/labeling`  | `runTrain`             | `(args: string[], config: Config) => Promise<void>`               | Same `args` convention as `label`. Per `docs/roadmap.md`, this should export data / drive an external (Python) training step, not train a model in-process. Owned by **B4**. |

`Config` in every signature above is `import type { Config } from '@homecsi/config'`
(the fully validated config object — see `packages/config/src/schema.ts`
for its shape).

## Non-CLI contract: `@homecsi/web`

Not wired into `packages/cli` — `@homecsi/api`'s `startServer` is expected
to call it directly:

| Package         | Export name        | Signature         | Notes |
|-------------------|----------------------|--------------------|-------|
| `@homecsi/web`    | `getWebAssetsDir`   | `() => string`     | Returns the absolute path to built static assets (index.html, JS/CSS) for `@homecsi/api` to serve via `@fastify/static`. Owned by **B5**, which also owns the frontend build tooling choice. |

## If you need a new dependency

`packages/cli`'s `package.json` lists every sibling package it imports
(`@homecsi/ingest`, `@homecsi/storage`, `@homecsi/features`,
`@homecsi/occupancy`, `@homecsi/labeling`, `@homecsi/api`) as a
dependency, and its `tsconfig.json` lists each as a project reference —
both already present so `tsc -b` builds in the right order and dynamic
`import()` type-checks. You should not need to touch either file. If your
package needs a *new* external npm dependency, add it to your own
package's `dependencies`/`devDependencies` — the root `server/package.json`
already declares the full dependency set every brief is expected to need
(fastify, pg, zod, pino, etc.); if something is genuinely missing, flag it
back rather than adding a one-off dependency your package.json doesn't
otherwise share with the rest of the workspace.
