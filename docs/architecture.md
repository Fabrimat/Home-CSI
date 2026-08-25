# Architecture

## Status

Greenfield, v1 in progress. This document describes the target v1 system.
Nothing here should be read as "already deployed" -- see the root
`README.md` for current status.

## System overview

```
Home                                                VPS (public IP)
+--------------------------------------------+     +-----------------------------------------------+
| Node A  Node B  Node C  Node D  (...9)      |     |                                                 |
|   |        |        |        |              |     |  UDP :XXXX (open to the Internet)              |
|   +--------+---+----+--------+              |     |       |                                         |
|             |   fixed channel, 20 MHz       |     |       v                                         |
|       +-----v-----+                         |     | +-----------+   raw capture (replay log)        |
|       | dedicated |   2.4 GHz, 802.11n      |     | |  ingest   |-------------> data/captures/       |
|       |  spare AP |<-------------------------------->|  (B3)     |                                  |
|       +-----------+     home internet        | UDP | +-----+-----+                                  |
|                                              |     |       | writes                                  |
+--------------------------------------------+     |       v                                         |
                                                     | +--------------------------+                     |
                                                     | | TimescaleDB (Postgres)    |                     |
                                                     | | csi_records / heartbeats  |                     |
                                                     | | hypertables, compression  |                     |
                                                     | | + retention (B3)          |                     |
                                                     | +-------------+------------+                     |
                                                     |               | reads                            |
                                                     |               v                                  |
                                                     | +--------------------+   +---------------------+ |
                                                     | | features (B4)      |-->| occupancy (B4)      | |
                                                     | | amplitude windows  |   | latched state        | |
                                                     | +--------------------+   +----------+-----------+ |
                                                     |                                     |             |
                                                     |                                     v             |
                                                     |                        +--------------------------+
                                                     |                        | API + web UI (B5)        |
                                                     |                        | token-authed              |
                                                     |                        +--------------------------+
                                                     +-----------------------------------------------+
```

Nodes are custom-firmware ESP32 boards (Makeblock Halocode, see
`docs/hardware-halocode.md`). They associate as Wi-Fi stations to a
**dedicated spare consumer router** running as an independent AP, separate
from the household's normal Wi-Fi. Traffic from nodes to the server crosses
the open Internet over UDP with no VPN in v1 (see Security posture below).

## Radio design

- **One fixed channel, 20 MHz, 2.4 GHz.** The dedicated AP is configured to
  a single channel and all nodes associate to it and stay there. This is a
  deliberate simplification, not an oversight: the ESP32 can only capture
  CSI for frames on the channel it is currently tuned to, and channel
  hopping introduces gaps and per-hop settling time that would fragment the
  motion signal. See `docs/roadmap.md` for why multi-channel hopping is
  deferred rather than attempted in v1.
- **STA-association + active sounding + promiscuous capture, simultaneously,
  on that one channel.** Each node is, at the same time: (a) a normal Wi-Fi
  station associated to the dedicated AP, (b) an active CSI *sounder* that
  periodically sends its own broadcast frames to generate CSI against, and
  (c) a promiscuous-mode sniffer that captures CSI from *any* frame it can
  decode on the channel, including other nodes' soundings and the AP's own
  traffic. This is the proven pattern from the ESP32-CSI-Tool project -- it
  is what makes a useful mesh possible with only single-radio,
  single-channel hardware.

## The broadcast-sounding mesh (why N nodes give you more than N links)

Each node's sounding frames are **broadcast**, not unicast. Every other node
that is awake and tuned to the same channel also captures CSI from that
sounding, "for free" (no extra airtime is consumed sending it to each node
individually). With `N` nodes on the mesh, that yields:

- `N` node-to-AP links (each node's own association traffic and its
  sounding as seen by the AP), and
- `N * (N - 1)` **directional** node-to-node links (node *i*'s sounding as
  captured by node *j*, for every ordered pair `i != j`).

At `N = 4` (v1 launch): 4 AP links + 12 directional node-to-node links = 16
distinct vantage points on the house. At `N = 9` (the planned near-term
expansion): 9 AP links + 72 directional node-to-node links = 81 vantage
points, from the same per-node airtime cost as at `N = 4` (each node still
only sounds once per interval; it is the number of *listeners*, not
*senders*, that scales). This is the core reason the design uses broadcast
soundings rather than unicast pings between fixed pairs of nodes.

## Honest capability statement: 2.4 GHz only

The ESP32 radios in this project are **802.11n, 2.4 GHz only** -- they
cannot decode 5 GHz or 6 GHz frames at all, and most modern smartphones,
laptops, TVs, and smart speakers negotiate 5 GHz or WiFi 6/6E whenever it's
available. That means **passive sniffing of a household's existing devices
is best-effort garnish, not a reliable signal** -- on any given day, most of
the home's normal Wi-Fi traffic is simply invisible to these nodes. The
system does not depend on it. The **primary signal is the dedicated-AP
broadcast sounding mesh** described above: a fixed, always-on,
2.4-GHz-native traffic pattern that exists purely to generate CSI and is
entirely under this project's control, independent of what phones and
laptops happen to be doing.

## Motion, not people: why occupancy is a latched state machine

CSI measures how radio-frequency multipath is being perturbed -- it senses
**motion**, not "person present". A person sitting still, reading, or
asleep looks the same to instantaneous CSI features as an empty room: there
is no reliable static signature of "a body is here" at this frequency and
antenna count. Consequently:

- **No per-window classifier can honestly answer "how many people are home
  right now"** from a single window of CSI features -- a still occupant and
  an empty house produce the same window.
- Occupancy in this system is therefore modeled downstream (brief B4) as a
  **latched state machine that integrates motion transitions over time**:
  motion events push the state toward "occupied", and the state decays back
  toward "unoccupied" only after a configured horizon of sustained *no*
  motion across *all* links, not on a single quiet window. This converts an
  instantaneous, ambiguous signal into a state estimate that tolerates
  normal periods of stillness (sleep, reading, working at a desk).
- **v1 success criterion is a reliable 0 vs 1+ estimate** (someone home or
  not) using this latched approach.
- **2+ is a stretch goal**, defined not by "counting bodies" but by
  detecting **spatially distinct simultaneous motion**: motion signatures
  appearing concurrently on node-to-node or node-to-AP links that are
  physically separated (e.g. one person moving in the kitchen while another
  moves upstairs), inferred from *which* links show motion at the same
  time, not from the amplitude of any single link.

## Amplitude-first

ESP32 CSI phase is not usable without heavy sanitization: there is no
hardware TX/RX phase lock between sender and receiver, and correcting for
carrier frequency offset (CFO) and sampling frequency offset (SFO) well
enough to make phase meaningful is a substantial signal-processing effort
this project is not undertaking in v1. **The entire pipeline -- from raw
CSI records through features to occupancy -- is amplitude-first.** Phase
bytes are stored (nothing is discarded at ingest) in case a future
iteration invests in sanitization, but no v1 component may depend on phase
being meaningful. See `docs/protocol.md` section 9.3 for where phase data
lives on the wire.

Similarly, CSI record size and layout depend on which parts of the channel
estimate were actually decoded (`csi_format` in the wire protocol) --
LLTF-only records are far smaller than LLTF+HT-LTF records. **No component
may assume a fixed subcarrier count**; every consumer of raw CSI bytes must
derive layout from the record's own `csi_format` and `csi_len` fields.

## Node placement and zone attribution

Nodes may optionally declare a `floor` and a `position: {x, y}` in metres
(`packages/config/src/schema.ts`'s `nodeSchema`; storage in `nodes.floor`/
`pos_x`/`pos_y`, migration 010) -- a relative 2D position on a plane whose
origin the operator picks **per floor** (a corner of that floor's own plan,
or one particular node on it), never one origin shared across the whole
house. `GET /api/topology` (`packages/api/src/routes/topology.ts`) uses
that placement, together with the per-link motion signal `@homecsi/features`
already computes (`features` is keyed `(time, node_id, link_mac)`, and
`packages/features/src/baseline.ts` computes a per-link baseline-relative
deviation that is comparable across links), to derive link geometry
(endpoints, midpoint, length, which two rooms a link spans -- `null`
whenever a peer is unresolved or either endpoint lacks a placed position,
never a fabricated coordinate) and a per-room/floor "zone" aggregate of the
resolved links touching that room. The **House map** view
(`server/packages/web/ui/src/views/houseMap.ts`) draws it: links glow by
recent motion, and each room gets a motion-coloured halo.

This is a real, defensible capability -- "the link between the kitchen and
hallway nodes shows motion" is a data-backed statement about a region,
derived entirely from amplitude and each node's own declared position --
and aggregating it per room gives legitimate **zone-level motion
attribution**: which paths through the house are disturbed. It is also,
deliberately, the full extent of what placement buys. Coordinates exist
for **geometry and drawing only**: the "Amplitude-first" constraint above
means ESP32 CSI phase has no hardware TX/RX lock and is not corrected for
CFO/SFO, so nothing in this system may depend on phase, angle-of-arrival,
time-of-flight, or trilateration. Consequently, no component may -- or does
-- use a node's position to localise a person, estimate anyone's position,
count people per room, or track anyone. `GET /api/topology`'s own
`zoneSemantics` response field and the House map's on-screen honesty banner
both say this to the operator directly, in the response and the UI, not
only in a source comment. Node placement is grounding for *drawing*, a
projection of `config.yaml` (the single source of truth -- ingest
re-projects it into `nodes` on every start; there is deliberately no
dashboard write-back, see `docs/roadmap.md` "Node placement and the House
map"), never an input to any inference about where a person is.

## Data lifecycle

The guiding rule (brief B8): keep raw data only for a **short debug
window**, keep the **occupancy event log forever**, and preserve a
**training set** for future model retraining *deliberately*, not as an
accidental side effect of however long raw data happens to survive.

1. **Raw replay capture**: ingest (B3) writes every accepted datagram's
   decoded contents to an on-disk, append-only capture format under
   `data/captures/` before (or independently of) any database write. This
   is the disaster-recovery and reprocessing path -- if a features or
   schema bug is found later, the raw signal can be replayed from disk
   rather than being lost forever. It is a **debug window, not long-term
   storage**: `config.storage.retention` (enforced by `packages/storage`'s
   `pruneStorage`) defaults to 7 days / ~30 GiB, matching the database-side
   window below so an operator has one clock to reason about, not several.
2. **Hypertables**: decoded CSI records, heartbeats, features, and
   occupancy states are written to TimescaleDB hypertables (see
   `packages/db` migrations 001-002 for the base schema, 003 for the first
   compression/retention pass, and 007 for the debug-window retightening
   and the `training_features` table below). Time is the hypertable
   partitioning dimension throughout.
3. **Compression + retention, split by what each table actually is**
   (migration 007):
   - `csi_records` and `features` are raw/near-raw, high-volume tables --
     both compress after a short hot window and are retained
     (`drop_chunks`) for only **7 days**, the same debug window as the raw
     capture tree above. Past that, the underlying signal is gone unless
     it was deliberately preserved (next point) or is still recoverable
     from a raw capture replay within *its* 7-day window.
   - `occupancy_states` -- the whole-house occupancy event log -- gets
     **no retention policy at all** and is expected to stay uncompressed.
     This is the one thing the project is actually trying to answer later
     ("was the house occupied on date X"), and at the volume a sparse,
     transitions-plus-keepalive write pattern produces, dropping it would
     save effectively no disk while permanently destroying the project's
     own output. It is kept forever, in plain, trivially-queryable rows.
   - `event_annotations` (migration 009) -- categorised, point-or-interval
     markers that explain *why* something in that forever `occupancy_states`
     log looks the way it does ("that 19:42 false-positive latch was the
     microwave") -- is, like `occupancy_states`, a plain relational table
     with **no retention or compression policy of its own**, and is
     expected to stay permanent and small: volume is bounded by how much an
     operator actually taps, not by an ingest rate. Unlike the
     training-set preservation machinery in the next point, annotations
     deliberately have **no feature-preservation path at all** -- considered
     and rejected, not merely unbuilt. A point annotation would preserve
     only about `config.features.windowMs` (roughly 2 seconds) of raw
     features around it, far too short a slice to ever function as a
     usable confounder signature. And when a confounder genuinely matters
     to training, it matters as a **hard negative on the occupancy
     target** ("the house was empty and this spike happened anyway"),
     which needs a real occupancy label, not a longer-lived annotation -- a
     path that already exists and is already fully plumbed:
     `POST /api/labels/corrections` with `occupancyCount: 0`. Annotations
     are also, unlike `labels`, deletable (`DELETE /api/annotations/:id`):
     they carry no occupancy assertion and play no part in dataset export,
     so a fast one-tap annotation UI's inevitable mis-taps can be undone
     without the append-only guarantee `labels` needs for training-corpus
     integrity.
4. **Training-set preservation**: `features` rows are chunk-granular under
   `drop_chunks`, which cannot selectively exempt individual rows -- so
   rows worth keeping past 7 days are **copied out**, not left in place.
   `packages/labeling` copies raw per-link feature rows overlapping a
   **manual** label session's window (`label_sessions`/`labels`, ±
   the same join tolerance dataset export already uses) into a plain,
   idempotently-keyed `training_features` table (`ON CONFLICT DO NOTHING`,
   so re-attempting an already-preserved window is a cheap no-op).
   Weak/presence-probe labels (an always-on cron by design) are
   deliberately excluded from this raw per-link preservation -- including
   them would make "labelled" cover practically all of `features`,
   defeating the retention policy above entirely; weak labels still get the
   reduced whole-house dataset row at export time. Preservation fails
   loudly (not silently) if a window's rows are missing from **both**
   `features` and `training_features` by the time it runs, since a
   silently under-preserved training set is worse than an obvious error; a
   window already safely preserved reads as found (not lost) even after its
   `features` rows age out, so a healthy sweep does not alarm forever on
   sessions it already handled.

   **Labels can describe an interval, not just a point** (migration 008):
   `labels.end_time` is nullable timestamptz, EXCLUSIVE, `NULL` meaning the
   original "point label" behaviour. This exists for the dashboard's
   feedback loop (`docs/roadmap.md` "Web dashboard") -- a point-only label
   means an operator correcting a 2-hour stretch of wrong occupancy
   produces exactly one training row; an interval label lets dataset export
   (brief B15) expand it into one row per feature window inside the
   interval instead. Every label also carries an explicit `source`
   (`'manual'`, `'weak:phone-presence'`, `'confirmed'`, or `'training'`,
   migration 008's CHECK constraint) -- the authoritative, queryable answer
   to "how was this label produced", alongside (not replacing) the
   `WEAK_LABEL_PREFIX` notes-string convention `packages/labeling` still
   writes for backward compatibility.

   **Three paths trigger preservation, independently:**
   - The CLI's `label session stop` (`packages/labeling/src/index.ts`) calls
     preservation synchronously and lets a failure propagate: the session
     row is still updated first, but the CLI command itself then exits
     non-zero with the fail-loud error naming expected-vs-found counts.
   - The web UI's stop button (`POST /api/labels/sessions/:sessionId/stop`,
     `packages/api/src/routes/labels.ts`) also calls preservation
     synchronously, but never turns a preservation failure into a failed
     HTTP request: the response is still `200` with the stopped session,
     plus a `preservationWarning` string field describing what went wrong
     when it did. Failing the whole stop request over a training-set
     concern would be a confusing UX for what is, from the operator's
     point of view, a successful "stop recording" action.
   - The dashboard's `POST /api/labels/corrections` (same file) is one
     composite server-side action -- create a `label_sessions` row starting
     at the correction's `from`, insert the interval label, stop that
     session at `to`, then attempt preservation. This does not run inside a
     single DB transaction, so a failure between the create and the stop can
     still leave a dangling open "dashboard correction" session -- what
     collapsing three client round-trips into one server call actually
     removes is the *client-abandonment* failure mode; a genuine mid-request
     DB failure still leaves an ordinary open session, which the `label
     preserve` sweep's open-session retention warning already surfaces, the
     same as any other session an operator forgot to stop.
     It creates a **fresh session per correction**, deliberately, rather
     than reusing one long-running "dashboard corrections" session: since
     preservation is keyed on a session's own window
     (`started_at..ended_at`), a per-correction session keeps that window
     exactly the corrected interval, while a single shared session's window
     would grow with every correction ever made anywhere in history --
     eventually converging on the entire `features` table, exactly the
     "labelled covers practically all of `features`" ballooning called out
     above for weak labels. It mirrors the web UI stop button's failure
     semantics exactly: `201` with the created session/label either way,
     plus `preservationWarning` on failure, never a `500` or a rollback.

   Either way, a session whose close-time preservation attempt failed (CLI
   non-zero exit, or a UI response carrying `preservationWarning`) is
   **not** yet safe to assume lost: the **`label preserve` CLI sweep** is
   the backstop for all three paths, and for sessions left open with no stop
   call at all. It is safe to run standing (e.g. on a timer) against a
   deployment's entire session history -- see `docs/deployment.md`
   "Scheduling the training-set preservation sweep" for the operator-facing
   scheduling guidance this requires.
5. **Features -> occupancy -> API/UI**: windowed amplitude features are
   computed from the hypertables (B4), fed into the latched occupancy state
   machine (B4), and served to the API and web UI (B5) for display and
   historical query. `homecsi train` reads both `features` and
   `training_features` so a session's export keeps working after its raw
   `features` rows have aged out, as long as it was preserved.

## Security posture

- **Per-node pre-shared key (PSK)**, 32 bytes, unique per node, used for
  ChaCha20-Poly1305 AEAD sealing of every datagram (see `docs/protocol.md`
  section 5). Confidentiality matters here because occupancy timing is a
  sensitive, home-surveillance-grade signal crossing the open Internet.
- **The UDP ingest port is directly exposed on a public VPS.** There is no
  VPN in v1 -- see the transport rationale in `docs/protocol.md` section 1
  (NAT traversal without port-forwarding) and the roadmap for WireGuard,
  which is deferred rather than required for v1. Exposure is mitigated by
  AEAD (unauthenticated/garbage UDP is simply dropped after a failed tag
  check) and by the anti-replay window, not by network-layer isolation.
- **Token-authenticated UI/API** (B5): the web UI and its backing API
  require a bearer token; there is no anonymous read access to occupancy
  history or live state in v1.
- **VPN is deferred, not rejected** -- seeded in `docs/roadmap.md` as a
  hardening step once the core pipeline is proven, at which point the
  exposed-UDP-port posture above can be relaxed (ingest could bind only to
  a WireGuard-internal address).
