# Roadmap (explicitly future, not v1)

Everything in this document is deliberately **out of scope for v1**. It is
recorded here so decisions that shaped v1 (e.g. the reserved `OTA_STATUS`
message type in `docs/protocol.md`) have a documented reason, and so future
work doesn't have to be re-derived from scratch.

## OTA auto-update of the ESP32 nodes

Manually reflashing 4-9 physically distributed nodes every time firmware
changes does not scale, especially once nodes are mounted in places that
are inconvenient to reach. **This is no longer entirely future work**: the
server-side half (manifest staging, authenticated firmware serving, the
device HTTP surface) ships now (brief B1, see `docs/device-api.md` for the
full contract), and the node-side OTA client ships alongside it (brief
B3). What genuinely remains future is image signing — see below.

- **`esp_https_ota`.** Nodes pull images over HTTPS from a server-hosted
  manifest + binary, rather than the server pushing to nodes — consistent
  with the "no inbound connections to nodes" posture in
  `docs/architecture.md`. The node initiates the check-and-fetch on its own
  schedule, using `GET /device/ota/manifest` / `GET /device/ota/firmware`
  (`docs/device-api.md`) rather than an inbound signal from the server.
- **A/B partitions with rollback.** ESP-IDF's OTA partition scheme
  (`ota_0`/`ota_1` + an OTA data partition) means a node boots into the new
  image only after it fetches successfully; the bootloader's rollback
  mechanism (`esp_ota_mark_app_valid_cancel_rollback` or app-level health
  self-check) reverts to the previous known-good image automatically if the
  new image fails to reach a "healthy" checkpoint (e.g. fails to associate
  to the AP, fails to send a heartbeat within N seconds of boot). A node
  bricked mid-house is a real operational cost, so rollback safety is not
  optional for this feature.
- **Staged rollout.** The server-side mechanism ships now: `manifest.json`'s
  `rollout` field (`"all"` or a specific list of node ids — see
  `docs/device-api.md`) controls which nodes are even offered the staged
  image at all, and `GET /api/devices` lets an operator watch each node's
  self-reported status (via `POST /device/hello`) to confirm a rollout is
  landing cleanly before widening it. The *practice* of pushing to one node
  first, observing it for a soak period (heartbeats and CSI flow resuming
  normally), then rolling out to the rest is an operational discipline
  layered on top of that mechanism, not additional code to write.
- **`OTA_STATUS` protocol type — stays reserved, not implemented.**
  `docs/protocol.md` §8 reserves `msg_type = 4` for this. It is **not**
  being built: node status (firmware version, boot epoch, uptime, OTA
  state) ships instead over the authenticated device HTTP surface via
  `POST /device/hello` (`docs/device-api.md`), not over UDP. This is a
  deliberate fork, not an oversight — putting status on UDP would mean
  touching `docs/protocol.md`, its golden byte vector
  (`server/packages/protocol/src/docs-example.test.ts`), and codecs on
  both the server and firmware sides, which `CLAUDE.md`'s "wire contract
  lives in exactly two places" rule makes the expensive option for what is
  fundamentally a telemetry ping. `msg_type = 4` remains reserved (never
  reused for anything else) in case a genuine future need for UDP-carried
  status justifies that cost; nothing currently sends it.
- **Signed images — the one piece still genuinely deferred.** v1's OTA
  path does not verify image signatures; images are trusted once fetched
  and hash-checked against the manifest's `sha256` (`docs/device-api.md`).
  The accurate follow-up path, when this is picked up: post-build signing
  at publish time via ESP-IDF's `espsecure.py sign_data` against the built
  `.bin`, plus enabling `CONFIG_SECURE_SIGNED_APPS_NO_SECURE_BOOT` in the
  node's build so the running app verifies that signature before accepting
  an OTA image. Two things this does **not** mean, worth stating precisely
  because they're easy to get wrong: it does **not** require every
  developer to hold the signing key (only whoever runs the publish/signing
  step at release time needs it; an ordinary build has no signing
  involved and is unaffected), and it does **not** touch serial flashing
  at all (`CONFIG_SECURE_SIGNED_APPS_NO_SECURE_BOOT` gates OTA image
  *acceptance* by the running app; without secure boot enabled, the
  bootloader itself verifies nothing, so flashing over serial during
  development is unaffected either way). The honest trade-off, deferred
  until this is picked up: one person manages a signing key, versus a
  compromised server being able to push arbitrary code to a device with
  promiscuous Wi-Fi capture privileges sitting inside the home network.

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

## Web dashboard

The primary purpose of a production dashboard is to close the feedback loop
that trains the future model described in "Trained-model inference" above.
v1 ships a **debug UI** (`server/packages/web` + `server/packages/api`,
owned by brief B5) accessible over HTTPS with bearer-token auth. This debug
UI is the seed of a full dashboard; its occupancy timeline and labelling
session controls form the core of human-in-the-loop correction and training
ground truth collection.

**What the debug UI does today (the foundation):**

Real-time occupancy state (latch state machine output), node liveness
tracking, live CSI waterfall visualization, per-node and per-link health
status, extracted CSI features, application log tail. For occupancy history,
it renders the latched state machine's transitions over a user-selectable
time window (1h/6h/24h/7d) with optional ground-truth label overlay from
labeling sessions. It includes session start/stop controls and per-moment
annotation (occupancy count + free-text notes), allowing the operator to
mark the system's output as correct or incorrect, confirm stretches it got
right, and attach context notes. **This no longer lacks per-room or
per-link drill-down**: the **House map** view (`views/houseMap.ts`, backed
by `GET /api/topology`, `packages/api/src/routes/topology.ts`) draws a
per-floor plan with links that glow by recent motion and per-room "zones"
aggregating the resolved links touching that room — see "Node placement
and the House map" below for exactly what that view is, and is not,
allowed to claim. The guided, live cold-start flow and the one-tap manual
annotation controls this section used to describe as two deliberately
separate tools (`views/training.ts` and `views/recording.ts`, "the two are
not merged") have in fact been merged, into a single **Ground truth** view
(`views/groundTruth.ts`) with three modes — see "Ground truth view: Live,
Annotate, and Missions modes" below.

**The feedback loop: correction as the primary interaction.**

An operator reviewing the occupancy timeline, or using the Ground truth
view's Annotate mode, does four things:
1. **Mark stretches the system got wrong** — "it said empty, but we were
   home" or "it said 2+, but it was just me" — by selecting a time range,
   recording the true occupancy count (0, 1, or 2+), and optionally a
   note describing the context. Each correction is a `labels` row
   (time, occupancy_count, notes) within a `label_sessions` session
   (brief B4's schema, migration 002).
2. **Confirm stretches it got right** — equally valuable training signal,
   preventing the model from learning that any default guess is safe. A
   confirmation is the same `labels` row: "at this time, occupancy was
   indeed 1", with no implication that it was wrong.
3. **Add context notes** — "guests just arrived", "still asleep", "all in
   one room" — attached to individual labels or the session as a whole,
   captured in the free-text `notes` column for later inspection and
   model conditioning.
4. **Annotate a non-occupancy event** — "that spike at 19:42 is the
   microwave" — a categorised, point-or-interval marker
   (`event_annotations`, migration 009; `POST /api/annotations`,
   `packages/api/src/routes/annotations.ts`) that carries **no occupancy
   count at all**. This is deliberately *not* a fourth kind of label:
   `labels` and `event_annotations` are separate tables, not one table with
   a `kind` discriminator, because `packages/labeling/src/datasetExport.ts`'s
   `resolveTickConflicts` resolves overlapping rows at the same tick by
   "highest `labelId` wins" across every row `labels` hands it — it has no
   notion of "this row isn't really ground truth, skip it". If a microwave
   annotation lived in `labels`, one export call that forgot to filter it
   out would let that annotation *outrank and silently displace* a real
   correction's rows at any tick they share — quietly deleting ground truth
   from the dataset, not merely diluting it with noise. Living in a
   structurally separate table the dataset exporter never reads makes that
   entire class of bug impossible by construction. See migration 009's
   comment header for the full reasoning, and `docs/architecture.md` "Data
   lifecycle" for why an annotation also deliberately preserves no raw
   features.

The debug UI today already ships these controls, split across the
Occupancy timeline's correction/confirmation panel (items 1-3,
`views/occupancy.ts`) and Ground truth's Annotate mode (item 4,
`views/groundTruth.ts`); a fuller production dashboard would still extend
them with better UX (multi-select ranges, bulk operations) and persistence
across sessions (historical comparison, previous corrections). The
"richer context (room-by-room drill-down)" this paragraph used to name as
future work now exists, but in a different shape than originally imagined:
not context attached to a label, but the House map's motion-attribution
zones (see "Node placement and the House map" below) — read that section's
honesty constraint before assuming it means the dashboard can say which
room a correction's occupant was actually in.

**Ground truth view: Live, Annotate, and Missions modes.**

Before any trained model exists, the system needs a labelled corpus to
train on, a way to record non-occupant RF confounders without lying about
occupancy to do it, and a way to see what is worth reviewing before it ages
out. Earlier revisions of this document described the first of those as a
standalone **training mode** view (`views/training.ts`, brief B14) and
called it "a deliberately separate tool from the point-in-time manual
annotation controls in `views/recording.ts` — the two are not merged".
**That is no longer accurate.** Both were merged into a single **Ground
truth** view (`views/groundTruth.ts`), switched between three modes via one
`<fieldset>` radio group rather than three separate pages — **Live**,
**Annotate**, and **Missions** — that share one underlying job: telling the
system what actually happened.

**Live mode — the cold-start walk.** This absorbs the guided,
live-walkthrough flow the standalone training-mode view used to provide
wholesale (every ordering guarantee below is unchanged), and it subsumes
the job the old `views/recording.ts` did too: tapping a state below is at
once "start declaring ground truth on a walk through the house" and
"manually record a single moment's true occupancy", the same
`label_sessions`/`labels` write serving both use cases that used to need
two separate UIs.

- **Starts a training session** with no prior data, just a clear
  declaration of "house empty" / "just me" / "two or more of us" (the
  0/1/2+ scale; see `docs/architecture.md` "Motion, not people" — this is
  not a per-window people-counter, it is a state for coarse occupancy).
  The session's notes are marked with a distinct `[training]` prefix so
  reloading the view (e.g. after a phone lock mid-walk) finds and offers to
  resume an already-open training session, rebuilt from the server, rather
  than orphaning it.
- **Declares occupancy state transitions in real time** as the operator
  moves through the house: tapping the current state first closes the
  previously open declaration (`PATCH /api/labels/:id`, end_time only) and
  then opens the next one (`POST /api/labels`) at the same instant, so
  declared intervals abut with no gap and no overlap. If closing the
  previous declaration fails, the new one is not opened. Tapping the
  already-declared state is a no-op, not a zero-length interval.
- **A free-text context note, plus an optional one-tap still/moving
  toggle,** is carried onto the next declaration, to help a future model
  separate "person present but motionless" from "person moving" — the
  hardest distinction in this system (`docs/architecture.md` "Motion, not
  people").
- **Stopping** the session closes any open declaration and then stops the
  session (`POST /api/labels/sessions/:id/stop`). A `preservationWarning`
  in that response — meaning the labels were recorded but the underlying
  raw per-link features could not be archived into `training_features` —
  is rendered as a distinct warning, never silently dropped.

This produces a first labelled corpus in a single guided walk, dense and
low-ambiguity by construction, enough to bootstrap training once replayable
features exist for the labelled window (see `docs/architecture.md` Data
lifecycle, captures stay 7 days). Later, continuous operator feedback
(corrections of prediction mistakes, via the correction/confirmation panel
on the occupancy timeline, `views/occupancy.ts`) refines the model
incrementally. The **trained model itself** remains future work (see
"Trained-model inference" above): Live mode builds the labelled corpus, it
does not train anything.

**Annotate mode — one-tap confounder markers.** Already described in full
as the fourth item of "The feedback loop" above: a categorised,
point-or-interval marker (`event_annotations`, migration 009;
`POST /api/annotations`) that carries no occupancy count, because a
microwave or a door is not an occupant and forcing a count onto one would
poison the training corpus with a false ground-truth row. Unlike `labels`,
which is append-only (`docs/architecture.md`), annotations can be deleted
(`DELETE /api/annotations/:id`, `packages/api/src/routes/annotations.ts`)
— a fast one-tap UI guarantees mis-taps, and annotations play no part in
dataset export, so leaving a mis-tap permanently on the record would be
strictly worse than allowing the delete.

**Missions mode — what expires next, never a score.** Backed by
`GET /api/coverage` (`packages/api/src/routes/coverage.ts`):
`reviewedFraction` (how much of the retention window has a human judgement
attached), `expiringSoon` (a short, capped list of unreviewed stretches
near the window's oldest edge — the ones about to fall off the 7-day cliff
described under "The 7-day deadline" below), `confirmations` and
`corrections` (counts by `labels.source`), and `annotations`/
`categoriesUsed` (how much and how varied the confounder-marking has
been). It deliberately exposes **no total-label count and no streak**, and
the Missions UI does not compute one client-side to fill that gap either.
This is a load-bearing design constraint, not an unfinished feature: a
volume incentive on a training corpus — points for labelling, a streak to
keep alive — rewards *producing* labels, not producing *true* ones, and
junk labels are the one thing that can ruin the corpus this whole mode
exists to build. What Missions rewards instead is coverage (fraction of
the window reviewed), diversity (how many of the six annotation categories
are represented), and deadline saves (the `expiringSoon` list — work that
becomes permanently unrecoverable, not merely stale, if ignored). This is
recorded here deliberately: a future contributor asked to make Missions
"more motivating" will reach for a score or a streak as the obvious lever —
that is exactly the lever this paragraph rules out.

**Node placement and the House map.**

`packages/config/src/schema.ts`'s `nodeSchema` gained two optional fields
per node: `floor` (a signed integer, default `0` — a basement or garage
below the operator's own "ground floor" can be `-1`, `-2`, etc.) and
`position: {x, y}` in **metres**, relative to an origin the operator picks
**per floor** (a corner of that floor's own plan, or one particular node on
it — there is no single origin shared across the whole house). Migration
010 adds the matching storage: `nodes.floor` (`smallint NOT NULL DEFAULT
0`) and nullable `nodes.pos_x`/`nodes.pos_y`. Both position columns are
nullable on purpose: an operator who hasn't measured anything yet must
still be able to run the system, and `NULL` means "not placed", never
`(0, 0)`, which would silently draw a node in the wrong spot instead of
honestly rendering nothing for it.

`GET /api/topology` (`packages/api/src/routes/topology.ts`) turns that
placement, plus the per-link motion signal `@homecsi/features` already
computes (`features` is keyed `(time, node_id, link_mac)`, and
`packages/features/src/baseline.ts` computes a per-link baseline-relative
deviation that is comparable across links), into a floor-plan-ready view:
`nodes` (with position), `links` (endpoints, midpoint, length, and which
two rooms a link spans, whenever both endpoints are placed and the peer
resolves — `geometry: null` otherwise, never guessed), and `zones`
(per-room/floor aggregates of the resolved links touching that room). The
**House map** view (`views/houseMap.ts`) draws it: links glow by recent
motion, and each node's halo reflects its room's zone.

**What this legitimately buys, and what it must never be read as.**
Per-link motion attribution is real and data-backed — "the link between the
kitchen and hallway nodes shows motion" is a defensible statement about a
region, derived entirely from amplitude. Aggregating that per room gives
zone-level motion attribution. `GET /api/topology` says so plainly in its
own response: "Per-room/floor aggregate of link-path motion deviation
(`feature_vector.baselineDeviation`) from links whose geometry resolved.
This is NOT a person count or position estimate -- CSI senses motion on a
link, not where a person is" (`ZONE_SEMANTICS`, `routes/topology.ts`), and
the House map view says the same thing to an operator in its own words:
"This shows which paths through the house are disturbed, not where anyone
is" (`HONESTY_SENTENCE`, `views/houseMap.ts`). What it is **not**, under
any phrasing: this system does not localise a person, does not estimate
anyone's position, does not count people per room, and does not track
anyone. ESP32 CSI phase has no hardware TX/RX lock and is not corrected
for CFO/SFO (`docs/architecture.md` "Amplitude-first"), so nothing here may
depend on phase, angle-of-arrival, time-of-flight, or trilateration — the
coordinates exist for **geometry and drawing only** (deriving a link's
endpoints/midpoint/length and letting the dashboard draw a floor plan),
never for inferring where anyone is.

**`config.yaml` is the single source of truth for placement — there is
deliberately no dashboard write-back.** Ingest re-projects `config.nodes`
into the `nodes` table's placement columns on every start (`upsertNode`,
`packages/storage/src/dbWriter.ts`), so those columns are a projection, not
independently editable state. The House map's "level editor" panel lets an
operator drag a node (or type x/y for one) to preview a position and emits
a `config.yaml` snippet to paste by hand — it never calls a write endpoint,
because there is no `POST`/`PATCH` route for placement at all. A save
button that wrote positions straight into the database (or through some
future API route) would create silent split-brain state: the database
would show one placement and `config.yaml` another, and the very next
ingest restart would overwrite the database's copy with no sign that
anything had changed. That is a worse failure mode than not offering the
write path at all — it looks like it worked, right up until the next
restart quietly undoes it.

**Integration constraint: manual sessions only, no weak labels.**

Dashboard-created labelling sessions — the correction/confirmation panel on
the occupancy timeline (`views/occupancy.ts`) and Ground truth's Live mode
(`views/groundTruth.ts`, the merged successor to the standalone training
mode and point-in-time annotation views this document used to describe as
separate) — are never weak-flagged.
`packages/labeling/src/trainingPreservation.ts` preserves raw per-link
feature rows to `training_features` (the permanent training archive) **only
for non-weak sessions**, not weak/automatic ones. Weak labels (like the
`label presence probe` cron for passive phone presence) are deliberately
excluded — an always-on weak cron would otherwise cause
`training_features` to balloon unbounded, defeating the retention policy
(`features` is 7-day ephemeral; only human-validated windows get promoted
to permanent training storage). If the dashboard created weak-flagged
sessions, their underlying features would silently evaporate after 7 days,
poisoning the training set. Sessions created via the dashboard have their
`notes` field checked against the weak-label prefix
`[weak:phone-presence]` and never start with it — the existence of any
other note at all (or `null`) marks them as non-weak. Ground truth's
Annotate mode sits outside this whole mechanism, not as a special case of
it: `event_annotations` rows are not `label_sessions`/`labels` rows at all
(migration 009), so there is no session to weak-flag and no preservation
attempt to make for them in the first place — see "Ground truth view:
Live, Annotate, and Missions modes" above for why annotations preserve no
features by design.

Labels also carry an explicit `source` column (migration 008) recording how
each one was produced: the correction/confirmation UI writes
`'manual'`/`'confirmed'`, Ground truth's Live mode writes `'training'`, and
the phone-presence cron writes `'weak:phone-presence'`. A future training
run can weight or filter examples by this provenance, not just by which
session they happened to land in.

**The 7-day deadline: a real UX constraint.**

Raw per-link CSI features have a 7-day retention policy (migration 007). A
window's raw features survive longer only if preserved to `training_features`
before they age out. The dashboard must surface this deadline explicitly:

- Show which stretches of the occupancy timeline are still **correctable**
  (features present, can be preserved) vs. **past deadline** (features
  likely gone, correction possible but no underlying data to attach to
  training — correction is recorded in the labels table but the model will
  have less signal from that window).
- The occupancy prediction itself lasts indefinitely (separate `occupancy_states`
  table, kept forever), but the features needed to improve model performance
  from that window evaporate in 7 days. This is honest: a user might mark a
  prediction as wrong weeks later, but the raw training material is gone.
- Operationally: feedback delays longer than ~7 days have diminishing value.
  A deployment should aim to review corrections weekly, at minimum.

**Occupancy data is a sparse event log.**

v1's occupancy output is not a dense 2 Hz sample stream — it is transitions
(state changes) plus periodic keepalive records written at rest. A dashboard
must render it **step-wise / last-value-carried-forward** (the step line
connects one transition to the next, with the estimate held constant in
between) and must **never assume evenly-spaced samples** — this will break
any line-chart code that assumes density and tries to interpolate or smooth.

**Auth is bearer-token-only.**

`server.apiToken` from `config.yaml` gates all API routes; there is no
anonymous read access in v1. Dashboard feedback/training data is not
intended to be exposed publicly (it is the system's learning surface). A
production dashboard would live at the same origin as the API and inherit
this auth model. If a future multi-tenant shape emerges (multiple homes in a
single deployment), auth would need to layer on per-home tokens or
per-home-per-user RBAC, but that is out of scope for single-home v1.

**Architecture and scope.**

The UI is deliberately owned by the same brief (B5, api/web) and both
operate in-process under the same HTTP server. A dashboard could stay there
(adding more views and drill-down endpoints to the API) or migrate to a
separate frontend on the same-origin, making the API more general-purpose
for client-side consumption — deferred until the UX and query patterns are
clearer. The labeling and training infrastructure (`@homecsi/labeling`, brief
B4) already handles persistence to the database and feature preservation; the
dashboard is the human interface atop that.
