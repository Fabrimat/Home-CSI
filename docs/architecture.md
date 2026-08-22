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

## Data lifecycle

1. **Raw replay capture**: ingest (B3) writes every accepted datagram's
   decoded contents to an on-disk, append-only capture format under
   `data/captures/` before (or independently of) any database write. This
   is the disaster-recovery and reprocessing path -- if a features or
   schema bug is found later, the raw signal can be replayed from disk
   rather than being lost forever. Rotation, retention, and disk-budget
   enforcement for this tree are B3's responsibility (`packages/storage`).
2. **Hypertables**: decoded CSI records, heartbeats, features, and
   occupancy states are written to TimescaleDB hypertables (see
   `packages/db` migrations 001-002 for the base schema; B3 owns
   compression and retention policies added in migration 003+). Time is the
   hypertable partitioning dimension throughout.
3. **Compression + retention**: raw high-volume tables (`csi_records`
   especially) are expected to be compressed after a short hot window and
   eventually aged out under a retention policy bounded by both a max age
   and a max total disk budget (both configurable, see `packages/config`'s
   `storage` section) -- implemented by B3, not this brief.
4. **Features -> occupancy -> API/UI**: windowed amplitude features are
   computed from the hypertables (B4), fed into the latched occupancy state
   machine (B4), and served to the API and web UI (B5) for display and
   historical query.

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
