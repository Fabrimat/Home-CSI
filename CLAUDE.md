# CLAUDE.md

Guidance for AI agents (and humans) working in this repo.

## What this is

Home Wi-Fi CSI people-counting experiment: ESP32 nodes (Makeblock
Halocode) capture Channel State Information from a dedicated broadcast-
sounding mesh, ship it to a server over UDP, and the server estimates
house occupancy (0/1/2+) via a latched motion-integration state machine.
Read `docs/architecture.md` before making any design decision that isn't
purely local to one file — it explains *why* the system is shaped this
way (single fixed channel, broadcast soundings, amplitude-first,
motion-not-people).

## Repo layout

- `docs/` — design docs. `docs/protocol.md` is the normative wire format;
  `server/packages/protocol` is its executable twin and must never drift
  from it (there's a test that enforces this — see below).
- `firmware/` — ESP-IDF (C) project for the ESP32 nodes.
- `server/` — npm-workspaces monorepo, Node 20+, TypeScript strict, ESM,
  `NodeNext` module resolution. All server-side code lives here.
- `ops/` — deployment: containers, systemd units, reverse proxy config.
- `data/` — gitignored: raw captures, DB volumes, logs. Directory
  structure is kept via `.gitkeep`; contents are never committed.

## Stack (server/)

Fastify (HTTP/WS), `pg` (Postgres/TimescaleDB), zod (schemas/validation),
pino (logging), commander (CLI), vitest (tests), ESLint + typescript-eslint
+ Prettier. The full dependency set for the whole system is already
declared in the root `server/package.json` — packages should not need to
add new external dependencies for planned v1 work; if one is genuinely
missing, add it there, not as a one-off in a leaf package.

## Running things

From `server/`:

```sh
npm install
npm run build       # tsc -b across all packages (project references)
npm run typecheck   # tsc -b --force (full re-check, no incremental cache)
npm run lint        # eslint .
npm test            # vitest run
npm run migrate     # apply pending DB migrations (packages/db + packages/cli)
```

All four of `build`, `typecheck`, `lint`, `test` are expected to pass at
all times on `main`. If your change breaks one, fix it before moving on —
don't leave a broken script for the next arm/person.

The CLI itself: `node packages/cli/dist/index.js <command> --config <path>`
(or `npx tsx packages/cli/src/index.ts <command>` in dev without
building first). Every subcommand and which package implements it is
documented in `server/packages/cli/CONTRACTS.md` — that file is the
interface contract between the CLI and the packages that implement each
command; don't change a command's exported function signature without
updating both sides.

## Conventions

- TypeScript strict mode, ESM only, `NodeNext` resolution — relative
  imports need an explicit `.js` extension even though the source file is
  `.ts` (e.g. `import { foo } from './bar.js'`), because that's what
  `NodeNext` resolves against at runtime.
- No `any` in exported surfaces (enforced by
  `@typescript-eslint/no-explicit-any` in `server/eslint.config.js`).
- Every package: `package.json` (`"type": "module"`, `@homecsi/<name>`),
  `tsconfig.json` extending `../../tsconfig.base.json` with
  `"composite": true` (inherited) and explicit `references` to any
  workspace package it imports, so `tsc -b` builds in the right order.
- Tests live next to the code they test (`foo.ts` / `foo.test.ts`), run by
  the root `vitest.config.ts` (`packages/*/src/**/*.test.ts`). Tests that
  need a live database must be guarded behind an env var and skip cleanly
  when it's unset (see `packages/db/src/migrationRunner.test.ts` for the
  pattern) — `npm test` must never require live infrastructure.
- Stub packages (owned by sibling briefs not yet implemented) export their
  contracted function and throw `new Error('not implemented yet — owned by
  brief BX')`. The CLI's command wrapper turns that specific message into
  a clean one-liner instead of a stack trace — see
  `server/packages/cli/CONTRACTS.md` for the exact convention. Delete the
  stub body when you implement the real thing; don't leave that message in
  a working command.

## Public-repo hygiene

This repo is currently private but may go public. Real secrets already
can't land here — `.gitignore` excludes `ops/config.yaml` (per-node PSKs),
`ops/.env`, and `data/**`. The remaining risk is narrower but still real:
**real infrastructure identifiers pasted into docs while writing up a
"VERIFIED against a live host" finding** — an actual Tailscale MagicDNS
name, a real hostname/UUID, a real public IP. These aren't secrets (they
don't grant access on their own) but they fingerprint the operator's real
deployment and don't belong in a doc meant to read generically. Found and
scrubbed once already (a real `*.ts.net` hostname in
`docs/deployment.md`'s Tailscale section, both from the working tree and
from the commit that introduced it — see git history around 2026-08-24 if
you need the precedent).

When writing up a verification result in `docs/`, use a placeholder in the
same shape as the real thing (`host.example-tailnet.ts.net`,
`10.x.x.x`/`<public-ip>`, `db-uuid-placeholder`) — never the value actually
used to verify it. This is not something linting catches; it's a
review-time judgment call the next `docs/deployment.md` edit needs to make
for itself.

## Hard rules (do not violate these anywhere in the pipeline)

- **Amplitude-first.** ESP32 CSI phase has no hardware TX/RX phase lock and
  is not corrected for CFO/SFO — nothing downstream may depend on phase
  being meaningful. Phase bytes are stored, not used.
- **Never assume a fixed subcarrier count.** CSI record layout depends on
  `csi_format` (`docs/protocol.md` section 9.3); every consumer of raw CSI
  bytes must parse by the record's own `csi_len`, never a hardcoded size.
- **Motion, not people.** CSI cannot distinguish "still occupant" from
  "empty house" on a single window. Occupancy is a latched state machine
  integrating motion transitions over time (`docs/architecture.md`), not a
  per-window classifier. Don't reintroduce a per-window "occupancy"
  prediction without that framing.
- **2.4 GHz honesty.** Passive sniffing of a home's existing (mostly 5
  GHz/WiFi 6) devices is best-effort garnish. The dedicated-AP broadcast-
  sounding mesh is the primary signal. Don't write anything that implies
  otherwise.
- **The wire contract lives in exactly two places:** `docs/protocol.md`
  (normative spec) and `server/packages/protocol` (executable twin). If you
  touch one, check the other. `docs-example.test.ts` checks both sides
  against a third, independent thing — a hardcoded golden byte vector
  hand-laid-out from the doc's own field tables and sealed with a direct
  `node:crypto` call (not via this package's own encoder), cross-checked
  against firmware's independent derivation in
  `firmware/tests/test_docs_example.c`. It does **not** compare the doc to
  the encoder's output directly — that would only prove neither was
  hand-edited after the last `print-example` run, not that either is
  correct.
- **`seq`/`boot_epoch` must never wrap** (`docs/protocol.md` §4.1) — nonce
  reuse under ChaCha20-Poly1305 is catastrophic. Exhaustion at
  `0xFFFFFFFF` is a hard stop; only a reboot (which advances `boot_epoch`)
  may resume sending.
- **No retention/compression policy in `packages/db` migrations 001-002.**
  That's brief B3's job (migration 003+); the base schema created here
  must stay policy-free.
