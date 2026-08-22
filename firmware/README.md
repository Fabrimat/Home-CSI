# Home CSI node firmware

ESP-IDF v5.x firmware for the Makeblock Halocode (ESP32) nodes that capture
Wi-Fi CSI and ship it, encrypted, to the ingest server.

```
firmware/
  bringup/            <- START HERE if you have never flashed one of these
    README.md           ordered bring-up procedure (toolchain, drivers, backup)
    doctor.sh /.ps1     toolchain checkers that tell you what to fix
    csi-hello/          standalone app that proves a board produces CSI
  esp32-csi-node/     <- the real firmware
    main/               node modules (one focused .c/.h pair each)
    components/
      csi_protocol/     wire format + pure logic, SHARED with the host tests
    tools/provision.py  per-node NVS images and server registry
  tests/              <- host-compilable tests, no ESP32 required
```

> **New board? Do not start here.** Go to
> [`bringup/README.md`](bringup/README.md) first. It covers the toolchain
> choice on Windows-on-ARM64, USB drivers, and — critically — **backing up the
> stock Makeblock firmware before you overwrite it**. Nothing below is worth
> doing until one board has been confirmed to produce CSI.

---

## Host tests (start here if you have no hardware yet)

The wire format and all the decision logic are pure C and compile natively.
This needs **no ESP32 and no ESP-IDF**:

```bash
cd firmware/tests
python run_tests.py              # uses $CC, else cc/gcc/clang
CC="zig cc" python run_tests.py  # any C11 compiler works
make                             # equivalent, where make exists
```

These are not a smoke test. They assert the byte layout of every structure in
`docs/protocol.md` field by field, reproduce the worked example of §13 byte
for byte (and re-read `docs/protocol.md` at runtime to check it has not
drifted), and cover nonce construction, ring wrap/overflow, batch flush
triggers, sequence and epoch exhaustion, and the bandwidth budget.

The sources under `components/csi_protocol/` are compiled **both** by the
ESP-IDF build and by these tests. The layout exists in exactly one place, so
the firmware cannot drift from what the tests assert.

---

## Configuration model: NVS first, Kconfig as a bench fallback

**No per-node secret, id, SSID or hostname is compiled into the image.** Every
board runs the identical binary and differs only in its NVS contents.

| Source | What it is for |
|---|---|
| **NVS** (namespace `homecsi`) | The real thing. Written by `tools/provision.py`, flashed at `0x9000`. |
| **Kconfig** (`idf.py menuconfig` -> "Home CSI node") | Behaviour defaults, plus *bench-only* fallbacks for identity when an NVS key is absent. |

At boot the node logs a resolved-configuration table marking each field
`[NVS]`, `[Kconfig]` or `[MISSING]`, so which source won is never a guess:

```
I node_cfg: ----- resolved node configuration -----
I node_cfg:   node_id        = 3        [NVS]
I node_cfg:   psk            = present (a4..91)  [NVS]
I node_cfg:   server         = ingest.example.com:5566    [NVS]
I node_cfg:   channel        = 6        [NVS]
```

The PSK is never printed — only that it is present, plus a two-byte
fingerprint that is enough to tell two provisioned boards apart in a log and
useless to anyone else.

If `node_id`, the PSK, the server or the SSID is missing, the node **boots,
says exactly what is missing, shows the error LED pattern, and does not
send**. It deliberately does not reboot-loop, because a reboot loop would
scroll the message away.

For production images, turn **off** `CONFIG_HCS_ALLOW_KCONFIG_FALLBACK`. The
node will then refuse to run on anything but real provisioned NVS, which
removes any chance of a fleet quietly coming up on a default key.

---

## Provisioning

```bash
cd firmware/esp32-csi-node/tools
cp nodes.example.json nodes.json     # edit ids, names, AP, server, allowlist
python provision.py keygen           # 32 bytes per node from the OS CSPRNG
python provision.py build            # -> secrets/out/nvs_<id>.bin
python provision.py registry         # -> the server-side node list
python provision.py flashcmd --node 3 --port COM5
```

`keygen` uses `secrets.token_bytes(32)` and **refuses to let two nodes share a
key**, including on every later `build` and `registry` run:

```
error: nodes 1 and 3 share a key. Per-node keys are what makes the nonce
construction in docs/protocol.md section 4 safe; reusing one across nodes can
expose plaintext. Delete the duplicate and re-run keygen.
```

That is not defensive paperwork. The AEAD nonce is derived from
`(node_id, boot_epoch, seq)`; if two nodes shared a key, their sequence
numbers would overlap immediately and the same `(key, nonce)` pair would
encrypt two different plaintexts — which for ChaCha20-Poly1305 discloses the
XOR of those plaintexts and breaks the authenticator. All-zero keys are
rejected for the same reason.

`nodes.json`, `secrets/keys.json` and `secrets/out/` all contain material that
must not be committed. `provision.py` writes a `.gitignore` next to the
secrets as it creates them, and `firmware/.gitignore` excludes them too — two
layers, because one is not enough for a key that decrypts a household
occupancy stream.

**The allowlist** is the other nodes' STA MACs. It is how a node tells a peer
sounding (the primary signal) from a neighbour's laptop (garnish), and it is
what the two bandwidth budgets key off. You will not know the MACs until each
board has booted once — both csi-hello and the main firmware print
`STA MAC:` on startup. Provision once with an empty allowlist, collect the
MACs, then re-provision.

---

## Build and flash

```bash
cd firmware/esp32-csi-node
idf.py set-target esp32
idf.py menuconfig        # "Home CSI node"; at minimum set the channel
idf.py build
idf.py -p /dev/ttyUSB0 flash monitor
```

Then flash that board's NVS image (this is the step that makes it *that*
node):

```bash
esptool.py --port COM5 write_flash 0x9000 tools/secrets/out/nvs_3.bin
```

Flashing the app does not erase NVS, so you can reflash firmware freely
without re-provisioning. `erase_flash` **does** erase it — and that also
resets the boot epoch, which the server treats as a rollback. See
[Re-provisioning](#re-provisioning-and-the-boot-epoch).

### Settings worth checking before the first real deployment

| Setting | Default | Why you might change it |
|---|---|---|
| `CONFIG_HCS_CSI_MAX_LEN` | 384 | **Set this from measurement.** csi-hello prints the real record lengths on your hardware. Longer records are dropped and counted, never truncated. |
| `CONFIG_HCS_DEFAULT_CHANNEL` | 6 | Must match the dedicated AP exactly. |
| `CONFIG_HCS_RING_SLOTS` | 64 | RAM is roughly `slots x (CSI_MAX_LEN + 32)`; 64 x 416 is about 26 kB, statically allocated. |
| `CONFIG_HCS_SOUNDING_INTERVAL_MS` | 100 | 10 Hz per node. See [the sounding mesh](#the-sounding-mesh). |
| `CONFIG_HCS_ALLOW_KCONFIG_FALLBACK` | y | Turn **off** for production images. |
| LED backend | `none` | The LED pin is unverified; see [Status LED](#status-led). |

---

## The sounding mesh

Each node broadcasts one tiny 802.11 vendor-specific action frame every
`sounding_interval_ms`, addressed to `ff:ff:ff:ff:ff:ff`. Because it is a
broadcast, **every other node on the channel captures CSI from it for free**:
with N nodes you get N node-to-AP links plus N x (N-1) directional
node-to-node links, at the airtime cost of N tiny frames. That is 16 vantage
points at 4 nodes and 81 at 9, with no increase in per-node transmission.

The schedule is jittered by +/- `sounding_jitter_pct` (default 25%), and each
node starts at a random offset. Without that, nodes flashed from one image
with one interval would transmit in lockstep, collide forever, and — worse —
stamp a fake periodicity onto the sensing signal itself.

Why a raw injected action frame rather than a UDP broadcast: a UDP broadcast
is addressed to the AP at layer 2, so it costs two transmissions (uplink plus
the AP rebroadcast), the copy peers hear best is the AP's rather than ours,
and it stops working when the node has no IP. The reasoning is written out in
full at the top of `main/sounding.c`.

---

## Status LED

**The Halocode LED hardware is unverified by this project.** The board is
documented as having a 12-LED RGB ring, but neither the driver chip nor its
GPIO has been confirmed here. So:

- the pin, LED count and brightness cap are all Kconfig values;
- three backends are selectable and **the default is `none`** (state changes
  are logged instead);
- every other subsystem is independent of this module. A wrong pin or a
  missing driver costs you an indicator, not a node.

Brightness is capped (default 24/255) because these live in bedrooms and
hallways, and a bright node at 03:00 is a node that gets unplugged.

| State | Pattern | Meaning | What to do |
|---|---|---|---|
| `BOOTING` | slow white breathe | Powered, starting up | Nothing; a few seconds |
| `CONNECTING` | 1 Hz blue pulse | Looking for the dedicated AP | If it persists: SSID, password, channel, or the AP is down |
| `CONNECTED-NO-SERVER` | amber, two short blinks then a gap | On Wi-Fi, but the uplink is not getting through | DNS, the VPS, the UDP port, or the server is down. The node **keeps capturing** |
| `STREAMING` | dim green, brief bright blip per batch | Normal operation | Nothing. Blips track batch rate |
| `ERROR` | fast red double-blink | Not deployable, or wedged | Serial console: it prints exactly what is missing |

---

## Reading the heartbeat

A `HEARTBEAT` goes out every `heartbeat_interval_ms` (default 15 s)
**independent of CSI activity**, so the server can tell "alive but the house
is still" from "dead". Every field is defined in `docs/protocol.md` §10.

| Field | Healthy | What a bad value means |
|---|---|---|
| `uptime_s` | Rises steadily | Resetting to small values = the node is rebooting. Check the recovery policy below |
| `free_heap_bytes` | Steady | A steady decline is a leak; the node will eventually reboot on allocation failure |
| `min_free_heap_bytes` | Well above zero, stops falling | Approaching zero = a burst nearly exhausted RAM. Reduce `HCS_RING_SLOTS` or the budgets |
| `frames_captured` | Rises continuously | Flat while associated = no decodable traffic, wrong channel, or CSI is not enabled |
| `frames_dropped` | Small and roughly flat | Rising fast = the node is shedding load. The console breakdown says which of the five reasons |
| `batches_sent` | Rises with traffic | Flat while `frames_captured` rises = the uplink is failing; check `send_failures` |
| `send_failures` | 0, or occasional | Rising = network path, DNS, or the server. The node backs off exponentially and keeps capturing |
| `rssi_to_ap` | About -40 to -75 dBm | Below about -80 = too far from the AP; links will be noisy |
| `channel` | Your pinned channel | **Anything else is an emergency**: an off-channel node is deaf to the whole mesh |
| `sntp_synced` | 1 | 0 means cross-node timestamps are not comparable yet. Data still flows and is flagged |
| `fw_version_*` | Same across the fleet | A mismatch means a node was missed during an update |

The 36-byte wire payload has room for a single `frames_dropped` total, but the
breakdown is what you actually need to tune a node, so it is logged to the
console on every heartbeat:

```
I heartbeat: up=3600s heap=142312/128044 rssi=-52 ch=6 sntp=1 | seen=48213 kept=41002 drop=7211 | batches=2561 sendfail=0 | fw=0.1.0
I heartbeat:   drops: rssi=1204 notallow=0 budget=6007 ring=0 (ring full=0 oversize=0, high water 41/64)
I heartbeat:   budget: admit snd=38911 frn=2091 | drop disabled=0 decimated=5980 recrate=27 byterate=0
I heartbeat:   sounding: sent=36000 failed=0
```

How to read the drop reasons:

- **`rssi`** — below the RSSI floor. Expected and healthy; it is noise you
  chose not to carry.
- **`notallow`** — source MAC not in the allowlist, and enforcement is on.
  Also expected. If it is huge and `kept` is tiny, your allowlist is wrong.
- **`budget` / `recrate` / `byterate`** — you hit a configured cap. Fine if
  intentional; raise the cap if you want more data and have the bandwidth.
- **`decimated`** — the ring was backing up, so the node deliberately thinned
  the stream to keep the surviving samples evenly spaced in time. Occasional
  is fine. Sustained means the uplink cannot keep up: lower the sounding rate
  or the record budgets.
- **`ring` (full)** — the ring genuinely overflowed. This should be near zero
  because decimation is supposed to engage first. Persistent non-zero means
  the uplink task is starved or the decimation thresholds are too lax.
- **`ring` (oversize)** — a CSI record was longer than `CONFIG_HCS_CSI_MAX_LEN`
  and was dropped whole. **Any non-zero value here means your
  `CONFIG_HCS_CSI_MAX_LEN` is wrong** — raise it to the largest `len`
  csi-hello reported.
- **`high water N/M`** — peak ring occupancy since boot. Comfortably below M
  is healthy; pinned at M explains the full-drops.
- **`sounding: failed`** — this node could not transmit. It shows up on the
  *other* nodes as missing links, so check it here rather than wondering there.

---

## Local debug mode

For field work without the VPS in the loop:

- `CONFIG_HCS_DEBUG_UART` — one line per captured record on the console
  (source MAC, RSSI, channel, sig mode, format, length, first bytes). Printed
  from the **uplink** task, never from the CSI callback.
- `CONFIG_HCS_DEBUG_UDP` — mirrors the **unencrypted** batch plaintext to a
  host on your LAN, so you can watch a node with `nc -ul 5556`.

Both are also settable per node from `nodes.json`, so you can enable them on
one board without rebuilding.

> The UDP mirror is a deliberate hole in the confidentiality guarantee of
> `docs/protocol.md` §5. The firmware logs a loud warning whenever it is
> active. Never leave it on for a deployed node.

---

## Recovery policy

Three failure classes, three responses (all in `main.c`):

- **Reconnect, no reboot** — AP gone, DNS failed, send failed. `wifi_link`
  retries with exponential backoff **and jitter** (nine nodes must not
  stampede one AP after a power cut); `net_uplink` re-resolves and re-opens
  its socket with its own backoff. **Capture continues throughout** — CSI does
  not need the internet.
- **Reboot** (`esp_restart`) — Wi-Fi down continuously for
  `reconnect_reboot_s` (default 900 s), or the sequence space is exhausted.
  The latter is the only way to get a fresh `boot_epoch`, and therefore fresh
  nonces.
- **Panic-reboot via the task watchdog** — the uplink task and the supervisor
  both subscribe. A task that stops turning reboots the chip, which is the
  right outcome for a headless sensor.

Separately, the supervisor re-checks the operating channel, bandwidth and
power-save setting every 10 seconds and logs an error if any has drifted. An
off-channel node silently kills every link in the mesh; it must be visible.

---

## Re-provisioning and the boot epoch

`boot_epoch` is a counter in NVS, incremented once per boot and persisted
*before* the first datagram. With `seq` it makes every datagram uniquely
identifiable across reboots, which is what makes replay detection work.

Erasing the NVS partition (`erase_flash`, or an NVS corruption the firmware
has to recover from) **resets the epoch to 1**. The server treats a decreased
epoch as a rollback attack and will reject that node's traffic. So when you
erase NVS, either:

- give the board a **new `node_id`**, or
- clear that node's replay state on the server as part of re-provisioning.

The firmware logs this explicitly when it happens rather than leaving you to
discover it as silent data loss.

Flash wear is not a concern: exactly one `u32` NVS write per boot, on a
wear-levelled 24 kB partition.

---

## Placement guide

Placement matters more than any firmware setting. The links have to *cross the
space people move through*.

**Spread nodes so their links cross the living area.** The sensed volume is
the set of straight lines between every pair of nodes and between each node
and the AP. Four nodes clustered in one room give you sixteen views of that
room and none of the house. Put them in different rooms, on different levels,
so the link lines pass through doorways, hallways and the middle of rooms —
the places people actually walk.

- **Mains-powered, permanently.** These stream continuously; there is no
  battery mode and no sleep (power save is disabled by design, because it
  destroys CSI regularity).
- **Avoid metal and mirrors.** Fridges, radiators, metal shelving, large
  mirrors and foil-backed insulation all reflect or block 2.4 GHz badly. A
  node on top of a fridge sees a very different world from one 30 cm away on
  a shelf.
- **Off the floor, out of enclosures.** Roughly waist-to-chest height, in free
  air. Not in a drawer, not behind a TV, not inside a metal box.
- **Not right next to the AP.** A node 20 cm from the AP has a link so strong
  and so short that nothing perturbs it. Spread them out.
- **Keep them away from microwave ovens** — a microwave in use will blanket
  2.4 GHz and produce a dramatic "motion" event every time someone reheats
  coffee.
- **Vary the geometry.** Nodes in a straight line give you nearly redundant
  links. A rough polygon around the living space gives crossing paths, which
  is what makes distinguishing *spatially separate* simultaneous motion (the
  2+ occupancy stretch goal) possible at all.

**Once recording starts, do not move a node.** Every feature downstream is
relative to a learned baseline of what "empty and still" looks like on each
link. Moving a node — even by half a metre, even rotating it — changes the
multipath and invalidates that baseline for every link that node
participates in. If you must move one:

1. note the time,
2. expect the occupancy estimate to be unreliable until the baseline
   re-converges,
3. record the new position in `nodes.json` (`location`) so the change is
   explicable months later.

The same applies to large furniture, and to moving the AP.

---

## What is NOT verified

Written without an ESP32 or an ESP-IDF toolchain available. **The host tests
pass and are real; nothing else has been executed.** Specifically:

| Not verified | Where it is parameterised / how it fails |
|---|---|
| The firmware compiles under ESP-IDF | No toolchain was available. Expect to fix symbol renames between IDF versions before it builds |
| Halocode flash size | `partitions.csv`, sized for the smallest plausible 2 MB part; `esptool.py flash_id` gives the truth |
| CSI record lengths | `CONFIG_HCS_CSI_MAX_LEN` (default 384). Wrong values show as the `oversize` counter, never as corruption |
| `csi_format` classification | `classify_format()` in `csi_capture.c`. A wrong tag degrades interpretation but never desynchronises a batch, because consumers parse by `csi_len` |
| LED chip and GPIO | Kconfig; backend defaults to `none` |
| Serial bridge chip | Nothing in the firmware depends on it; see `bringup/README.md` Step 2 |
| `esp_wifi_80211_tx` with an action frame while associated | `sounding.c`. Failures are counted and shown in the heartbeat, not silent |
| SNTP/mbedTLS/RMT API details across IDF v5.x point releases | Guarded and commented where version-sensitive |
| Real CSI sensitivity to human motion | Step 6 of the bring-up procedure is the first honest test of the project premise |

---

## Protocol conformance

`docs/protocol.md` §14 lists the hard rules. Where each is enforced:

| Hard rule | Enforced in |
|---|---|
| Little-endian everywhere; never assume subcarrier count, always use `csi_len` | `csi_codec.c` (the only place LE packing exists); `csi_batcher.c` sizes every record from `csi_len` |
| Cleartext header exactly 28 bytes, and it is the AEAD AAD | `hcs_header_encode()`; `hcs_datagram_seal()` passes the encoded header as AAD |
| Nonce is `node_id \|\| boot_epoch \|\| seq \|\| 00 00`, and is verified, not trusted | `hcs_nonce_build()`; `hcs_header_decode()` recomputes and rejects on mismatch |
| One shared `seq` across all message types, per boot | `hcs_seq_t`, owned solely by the uplink task, which emits both batches and heartbeats |
| No `seq` / `boot_epoch` wrap (§4.1) | `hcs_seq_next()` hard-stops after `0xFFFFFFFF`; `hcs_boot_epoch_advance()` refuses to wrap; `main.c` reboots to get a fresh epoch |
| Replay identity `(node_id, boot_epoch, seq)` | `boot_epoch.c` persists the epoch before the first send; `seq_epoch.c` guarantees monotonic `seq` |
| Max datagram 1200 bytes; flush on size, count or time | `HCS_MAX_DATAGRAM_LEN` checked in `hcs_datagram_seal()`; the three triggers are `csi_batcher_append()` and `csi_batcher_flush_due()` |
| Amplitude-first; phase not to be trusted | Firmware stores raw I/Q verbatim and interprets nothing; only csi-hello computes amplitude, for display |

All of these have host tests.
