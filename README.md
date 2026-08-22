# Home CSI

A home Wi-Fi CSI (Channel State Information) people-counting experiment.
Several ESP32-based boards (Makeblock Halocode, reflashed with custom
firmware) are placed around a house, associate to a dedicated spare
consumer router, and continuously capture CSI to estimate how many people
are home on a coarse **0 / 1 / 2+** scale.

**Current status: greenfield, v1 in progress.** Nothing described below is
deployed yet; this repo currently contains the wire protocol, the
foundational TypeScript workspace and its contracts/schemas/migrations,
and the design documents that the firmware, ingest, features/occupancy,
and API/UI work build against.

## Honest capability statement

- The ESP32 radios are **802.11n, 2.4 GHz only**. Most modern devices
  prefer 5 GHz/WiFi 6, so **passively sniffing a household's existing
  traffic is best-effort garnish, not the primary signal**. The system's
  real signal is a dedicated-AP **broadcast-sounding mesh**: every node
  both sounds and listens on one fixed channel, so N nodes yield N·(N−1)
  directional node-to-node links plus N node-to-AP links, independent of
  what phones and laptops happen to be doing.
- CSI senses **motion, not people**. A still or sleeping occupant looks
  identical to an empty house on any single window of features. Occupancy
  is therefore a **latched state machine that integrates motion
  transitions over time**, not a per-window classifier — v1's success
  criterion is a reliable 0-vs-1+ estimate; 2+ (distinct simultaneous
  motion on separated links) is a stretch goal.
- The pipeline is **amplitude-first**. ESP32 CSI phase has no hardware
  phase lock and is not corrected for CFO/SFO, so nothing downstream may
  depend on phase being meaningful.
- CSI record size and layout are format-dependent (`csi_format` in the
  wire protocol) — **no component may assume a fixed subcarrier count.**

See `docs/architecture.md` for the full reasoning behind each of these.

## Repo map

```
docs/                    Design docs — start here
  protocol.md             The byte-exact node <-> server wire protocol (the contract)
  architecture.md          System overview, radio design, data lifecycle, security posture
  roadmap.md               Explicitly future work: OTA, channel hopping, VPN, trained models
  hardware-halocode.md    What's known vs. what must be verified on the Halocode bench
  deployment.md           Ops/deployment (VPS, containers, systemd) — see ops/

firmware/                 ESP32 (Halocode) firmware, ESP-IDF project

server/                   Node.js/TypeScript npm-workspaces monorepo (Node 20+, strict, ESM)
  packages/protocol/       Executable twin of docs/protocol.md: codec, AEAD, replay window
  packages/config/         Whole-system config schema (zod) + config.example.yaml
  packages/db/             Postgres/TimescaleDB migrations + connection pool
  packages/cli/            Single `homecsi` CLI entry point; see CONTRACTS.md for command contracts
  packages/ingest/         UDP ingest server (stub)
  packages/storage/        Raw capture lifecycle: rotation/retention/compression (stub)
  packages/features/       Windowed amplitude feature extraction (stub)
  packages/occupancy/      Latched occupancy state machine (stub)
  packages/labeling/       Ground-truth label sessions + training-data export (stub)
  packages/api/            Token-authenticated HTTP API (stub)
  packages/web/            Web UI (stub)

ops/                       Deployment: containers, systemd units, reverse proxy, hardening
data/                      Gitignored: raw captures, DB volumes, logs (structure kept via .gitkeep)
```

## Quickstart

1. Read `docs/architecture.md` for the system design, then
   `docs/protocol.md` if you're touching firmware or ingest.
2. For hardware bring-up, see `docs/hardware-halocode.md` — it separates
   what's actually known about the Halocode from what you must verify on
   your own units before trusting it.
3. For running the server-side stack:
   ```sh
   cd server
   npm install
   npm run build
   npm test
   cp packages/config/config.example.yaml config.yaml   # then edit secrets
   npm run migrate                                        # apply DB schema
   node packages/cli/dist/index.js doctor --config ../config.yaml
   ```
   `packages/cli/CONTRACTS.md` documents every `homecsi` subcommand and
   which package implements it.
4. For deployment (VPS, Docker Compose, systemd, reverse proxy), see
   `docs/deployment.md` and `ops/`.

## Development conventions

See `CLAUDE.md` for the full set of conventions, hard rules, and how to
run tests/lint/build in `server/`.
