# Roadmap (explicitly future, not v1)

Everything in this document is deliberately **out of scope for v1**. It is
recorded here so decisions that shaped v1 (e.g. the reserved `OTA_STATUS`
message type in `docs/protocol.md`) have a documented reason, and so future
work doesn't have to be re-derived from scratch.

## OTA auto-update of the ESP32 nodes

Manually reflashing 4-9 physically distributed nodes every time firmware
changes does not scale, especially once nodes are mounted in places that
are inconvenient to reach. The planned design:

- **Signed images.** Firmware images are signed (e.g. with ESP-IDF's
  `esp_secure_boot`/`esp_ota` signing support); nodes verify the signature
  before accepting an image. An attacker who can reach a node's OTA update
  path must not be able to push arbitrary code — this matters more here
  than on a typical IoT gadget because these nodes sit on the same network
  segment as a device with promiscuous Wi-Fi capture.
- **`esp_https_ota`.** Nodes pull images over HTTPS from a server-hosted
  manifest + binary, rather than the server pushing to nodes — consistent
  with the "no inbound connections to nodes" posture in
  `docs/architecture.md`. The node initiates the check-and-fetch on its own
  schedule (or in response to an `OTA_STATUS`-adjacent signal — see below).
- **A/B partitions with rollback.** ESP-IDF's OTA partition scheme
  (`ota_0`/`ota_1` + an OTA data partition) means a node boots into the new
  image only after it fetches successfully; the bootloader's rollback
  mechanism (`esp_ota_mark_app_valid_cancel_rollback` or app-level health
  self-check) reverts to the previous known-good image automatically if the
  new image fails to reach a "healthy" checkpoint (e.g. fails to associate
  to the AP, fails to send a heartbeat within N seconds of boot). A node
  bricked mid-house is a real operational cost, so rollback safety is not
  optional for this feature.
- **Staged rollout.** New images are pushed to one node first, observed
  (via heartbeats and CSI flow resuming normally) for a soak period, then
  rolled out to the rest — rather than flashing all nodes simultaneously
  and discovering a bug on every unit at once.
- **`OTA_STATUS` protocol type.** `docs/protocol.md` §8 reserves
  `msg_type = 4` for this: once implemented, a node reports its current
  firmware version, the outcome of its last update attempt (success,
  rollback, fetch failure), and update-eligibility state, so the server can
  drive and observe a staged rollout without an inbound channel to nodes.

## Channel hopping (deferred)

Passive sniffing of a home's existing devices (see the 2.4 GHz honesty
statement in `docs/architecture.md`) is inherently limited to whatever
channel the dedicated AP happens to be pinned to. Hopping the mesh across
multiple channels would, in principle, widen passive coverage. It is
deferred because:

- **Temporal gaps.** A node can only capture CSI on the channel it is
  currently tuned to; hopping introduces per-hop settling time and periods
  where the node captures nothing from the primary sounding mesh, directly
  hurting the core signal to chase a secondary one.
- **Link instability.** The broadcast-sounding mesh's value (see
  `docs/architecture.md`) depends on all nodes being reliably reachable on
  one shared channel at all times; a node mid-hop is a node the rest of the
  mesh can't currently sound against, which fragments the very links the
  system is built around.
- Net effect: channel hopping would trade a small, uncertain improvement in
  best-effort passive coverage for a real degradation of the primary,
  reliable signal. Not worth it until v1's single-channel mesh is proven
  and there is a clear case that broadening passive coverage is the
  limiting factor.

## WireGuard VPN between home and VPS

v1 exposes the ingest UDP port directly on the public VPS (see
`docs/architecture.md` Security posture) and relies on AEAD + anti-replay
rather than network isolation. A WireGuard tunnel between the home network
(or an aggregation point within it) and the VPS would let v1's posture be
relaxed:

- Ingest could bind only to the WireGuard-internal address, closing the
  public UDP port entirely.
- The AEAD requirement would become defense-in-depth rather than the sole
  confidentiality boundary, simplifying key-rotation urgency.
- Still not free: it adds a second thing that must stay up (the tunnel
  itself) between the home and the VPS, and a way for the whole mesh to go
  dark at once if it drops — worth doing once the pipeline is proven
  stable enough that this new failure mode is the dominant remaining risk.

## Optional home-side relay

A small always-on device inside the home (e.g. a Raspberry Pi or similar)
that batches/relays node traffic to the VPS, rather than every node talking
to the public Internet directly. Candidate benefits: a single egress point
to wrap in the WireGuard tunnel above instead of per-node tunneling, local
buffering during an Internet outage so short blips don't lose data, and a
place to run the OTA manifest/staging logic close to the nodes. Not started;
would be evaluated once the node count grows toward 9 and per-node direct
Internet egress becomes operationally annoying rather than merely non-ideal.

## Trained-model inference

Once enough labelled recordings exist (via `packages/labeling`, brief B4),
a trained model (rather than the v1 latched heuristic state machine) could
improve the 0/1/2+ estimate — particularly for the 2+ stretch goal. Planned
shape:

- Training happens **outside Node** — a Python sidecar/notebook environment
  using labelled recordings replayed from `data/captures/` (see
  `docs/architecture.md` Data lifecycle) and/or the `features` hypertable.
  Node/TypeScript is a fine, deliberate choice for v1's feature extraction
  and state-machine pipeline (no heavy numerical/ML ecosystem needed for a
  rule-based latch), but it is not a serious environment for model
  training — scikit-learn, PyTorch, and the broader Python ML tooling
  ecosystem are not being reimplemented in Node.
- The trained artifact is exported to a portable inference format (e.g.
  **ONNX**) and either loaded by a small inference step alongside the
  existing Node pipeline, or served by a narrow Python sidecar process that
  the Node occupancy pipeline calls into — decision deferred until there is
  an actual model to integrate.
- This does not replace the latched state machine's role as the safety net
  for the 0-vs-1+ v1 success criterion; a trained model would primarily
  target the 2+ stretch goal and refine confidence, not replace the
  motion-integration logic wholesale.
