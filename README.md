# Home CSI

A home Wi-Fi CSI (Channel State Information) people-counting experiment.
Several ESP32-based boards -- **ESP32-C6, the fleet's primary target**, with
the project's original Makeblock Halocode boards kept buildable as a
legacy/secondary target -- are placed around a house, associate to a
dedicated spare consumer router, and continuously capture CSI to estimate
how many people are home on a coarse **0 / 1 / 2+** scale.

A separate, structurally fenced-off side experiment (five more ESP32-C6
nodes around a closed box) records hand-gesture "takes" and trains an
offline k-NN classifier for fun; it never feeds, and is never fed by, the
house occupancy pipeline. See `docs/box-experiment.md`.

**Current status: implemented, not yet validated on the new hardware.** The
server-side pipeline -- wire protocol, ingest, storage, features,
occupancy, labeling/training-set preservation, the box experiment, and the
API/web dashboard -- is fully implemented and covered by tests (`cd server
&& npm run build && npm test`); this is not a skeleton of contracts and
schemas waiting to be filled in. What is **not yet true**: the fleet's new
primary hardware, the ESP32-C6, has not been brought up on a physical
board. `docs/hardware-esp32c6.md`'s own "what must be verified on the
bench" table is still blank -- chip revision, flash size, real CSI `len`
values, and more remain Espressif's published figures, not this project's
own measurements. (The legacy Halocode board has had real bench time --
see `firmware/bringup/README.md` -- but it is no longer where new
deployment effort goes.) Nothing here should be read as a system already
running against real ESP32-C6 units in a house.

## Honest capability statement

- The ESP32 radios -- 802.11n on the legacy Halocode boards, 802.11ax
  (Wi-Fi 6) on the now-primary ESP32-C6 -- are, either way, **2.4 GHz
  only**. Most modern devices prefer 5 GHz/WiFi 6, so **passively sniffing
  a household's existing traffic is best-effort garnish, not the primary
  signal**. The system's
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
  hardware-esp32c6.md     What's known vs. what must be verified — the fleet's primary board
  hardware-halocode.md    Same, for the legacy/secondary Halocode board
  box-experiment.md       The fenced-off box gesture-classification side experiment
  deployment.md           Ops/deployment (VPS, containers, systemd) — see ops/

firmware/                 ESP32 firmware, ESP-IDF project (ESP32-C6 primary, Halocode legacy)

server/                   Node.js/TypeScript npm-workspaces monorepo (Node 20+, strict, ESM)
  packages/protocol/       Executable twin of docs/protocol.md: codec, AEAD, replay window
  packages/config/         Whole-system config schema (zod) + config.example.yaml
  packages/db/             Postgres/TimescaleDB migrations + connection pool
  packages/cli/            Single `homecsi` CLI entry point; see CONTRACTS.md for command contracts
  packages/ingest/         UDP ingest server
  packages/storage/        Raw capture lifecycle: rotation/retention/compression
  packages/features/       Windowed amplitude feature extraction
  packages/occupancy/      Latched occupancy state machine
  packages/labeling/       Ground-truth label sessions + training-data export
  packages/box/            Box-experiment sessions/takes + offline k-NN classifier
  packages/api/            Token-authenticated HTTP API
  packages/web/            Web UI

ops/                       Deployment: containers, systemd units, reverse proxy, hardening
data/                      Gitignored: raw captures, DB volumes, logs (structure kept via .gitkeep)
```

## Quickstart

1. Read `docs/architecture.md` for the system design, then
   `docs/protocol.md` if you're touching firmware or ingest.
2. For hardware bring-up, see `docs/hardware-esp32c6.md` (the fleet's
   primary target) or `docs/hardware-halocode.md` (the legacy board) — each
   separates what's actually known from what you must verify on your own
   units before trusting it.
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
   which package implements it, including `homecsi box list|train|export|
   preserve` for the box experiment. The dashboard (`homecsi serve`) also
   exposes a **realtime mode** toggle (`GET`/`POST /api/realtime`, see
   `docs/device-api.md`) and, under a new **Experiment** nav group, a
   **Box experiment** view for recording and reviewing takes.
4. For deployment (VPS, Docker Compose, systemd, reverse proxy), see
   `docs/deployment.md` and `ops/`.

## Development conventions

See `CLAUDE.md` for the full set of conventions, hard rules, and how to
run tests/lint/build in `server/`.
