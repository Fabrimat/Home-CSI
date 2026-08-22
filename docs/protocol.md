# Home CSI wire protocol — v1

This document is the **normative** specification of the UDP datagram format
that every node (firmware, brief B2) sends to the server (ingest, brief B3).
It must be precise enough that a C implementation and a TypeScript
implementation, written independently from this document alone, interoperate
without further questions.

The executable twin of this document is `server/packages/protocol`. If the
two ever disagree, **this document is not automatically right** — but drift
is a bug in one of them and must be fixed so they match exactly. The tests in
`packages/protocol` assert the byte layout described here field-by-field.

All multi-byte integers are **little-endian**. All offsets are byte offsets
from the start of the UDP payload (offset 0 = first byte of the datagram).
There is no padding beyond what is explicitly specified as reserved bytes.

## 1. Transport

- Protocol: **UDP**, one datagram per message.
- Direction: **node → server only**. Nodes never accept inbound connections;
  a node opens a UDP socket, connects (in the BSD-socket sense, to fix the
  destination and let the kernel filter unrelated replies) to a single
  configured `host:port`, and sends. This is NAT/firewall-friendly: the home
  router needs no port forwarding, and the VPS only needs one open UDP port.
- There is no server → node channel in v1 (no ack, no command/control). A
  node that cannot reach the server simply drops or queues-and-drops
  according to its local buffering policy (see `docs/architecture.md`); the
  server never blocks a node's boot or operation.
- One datagram carries exactly one message (one `CSI_BATCH` or one
  `HEARTBEAT`); messages are never split across datagrams and a datagram
  never carries more than one message.

## 2. Datagram framing

Every datagram has three parts, in order:

```
+-------------------------+---------------------------+--------------+
| cleartext header (28 B) | AEAD ciphertext (N bytes) | auth tag (16B)|
+-------------------------+---------------------------+--------------+
```

- **Cleartext header** (28 bytes, fixed size, described in §3) is sent
  unencrypted. It is also passed as the **AAD** (additional authenticated
  data) to the AEAD cipher, so although it is readable by anyone on the
  path, it cannot be tampered with without the tag failing to verify.
- **Ciphertext** is the AEAD-sealed plaintext payload (§8–§10). Because
  ChaCha20 is a stream cipher, ciphertext length always equals plaintext
  length — there is no padding.
- **Auth tag** is the 16-byte Poly1305 tag produced by the AEAD seal
  operation.

A decoder therefore computes:

```
ciphertext_len = udp_payload_len - 28 (header) - 16 (tag)
```

and rejects the datagram outright (before attempting any crypto) if
`udp_payload_len < 28 + 16` (truncated) or if `ciphertext_len` would be
negative, or if the datagram exceeds the maximum size in §11 (oversized).

## 3. Cleartext header (28 bytes) — also the AAD

| Offset | Width | Field         | Type      | Meaning                                                                 |
|-------:|------:|---------------|-----------|--------------------------------------------------------------------------|
| 0      | 4     | `magic`       | `u8[4]`   | ASCII bytes `48 43 53 31` (`"HCS1"`). Identifies this as a Home CSI datagram. Never changes across protocol versions. |
| 4      | 1     | `version`     | `u8`      | Protocol version. Current value: `1`. See §13.                          |
| 5      | 1     | `msg_type`    | `u8`      | Message type enum, see §8.                                              |
| 6      | 2     | `node_id`     | `u16`     | Operator-assigned node identifier (1–65535; 0 is reserved/invalid). Matches the node's entry in the server's node registry (`packages/config`). |
| 8      | 4     | `boot_epoch`  | `u32`     | Boot counter, persisted in NVS, incremented by firmware on every boot. Never reset except by re-provisioning (erasing NVS). |
| 12     | 4     | `seq`         | `u32`     | Datagram sequence number, **one shared counter for all message types**, starting at `0` on the first datagram sent after boot and incrementing by 1 for every subsequent datagram (batch or heartbeat) sent during that boot. Never reset except by reboot (which also bumps `boot_epoch`). MUST NOT wrap — see §4.1 for the mandatory hard stop at `0xFFFFFFFF`. |
| 16     | 12    | `nonce`       | `u8[12]`  | The 96-bit AEAD nonce actually used to seal this datagram. See §4 for its required construction. |

Total header size: **28 bytes**.

The identity of a datagram — used for deduplication and replay rejection —
is the tuple **`(node_id, boot_epoch, seq)`**.

## 4. Nonce construction

The 12-byte `nonce` field is **not** independently random; it is a
deterministic packing of the three identity fields already in the header,
which guarantees it can never repeat for a given key as long as `seq`
strictly increases within a `boot_epoch` and `boot_epoch` strictly increases
across reboots (both of which are firmware invariants, and both of which the
server independently enforces — §5). See §4.1 immediately below for the
mandatory hard-stop behavior as `seq` (and, vanishingly rarely, `boot_epoch`)
approaches the top of its range — without it, this uniqueness guarantee
silently breaks.

```
nonce[0..2)  = node_id     (u16, little-endian)
nonce[2..6)  = boot_epoch  (u32, little-endian)
nonce[6..10) = seq         (u32, little-endian)
nonce[10..12)= 0x00 0x00   (reserved, MUST be zero)
```

That is exactly 2 + 4 + 4 + 2 = 12 bytes.

The nonce is fully derivable from `node_id`/`boot_epoch`/`seq`, which are
already present as separate header fields. It is included as an explicit
field anyway so that both implementations pass a single ready-made 12-byte
buffer straight into their AEAD call with no repacking logic duplicated at
the call site. **Decoders MUST recompute the expected nonce from
`node_id`/`boot_epoch`/`seq` and reject the datagram if it does not match
byte-for-byte** (including the two reserved bytes being zero). This is a
cheap corruption/tampering check performed before the AEAD call.

Per-node keys are unique (§5), so nonce uniqueness only needs to hold within
one node's key, which the construction above guarantees.

### 4.1 Sequence and boot_epoch exhaustion (hard stop, not wraparound)

`seq` is a `u32`: its full range, `0` through `0xFFFFFFFF` inclusive, is
usable within a `boot_epoch`. A node with long continuous uptime *will*
eventually approach that ceiling — at a sustained 100 messages/second that
is roughly 1.4 years, well inside plausible device lifetime for this
project — so this document specifies exactly what must happen, rather than
leaving it to be discovered as a bug:

- **`seq` MUST NOT wrap.** Once a node has sent a datagram with
  `seq == 0xFFFFFFFF`, it has exhausted the sequence space for the current
  `boot_epoch` and **MUST NOT send any further datagram** (of any message
  type) under that `boot_epoch`. Wrapping back to `seq = 0` would reuse a
  `(node_id, boot_epoch, seq)` tuple already used with the same key,
  which repeats an AEAD nonce — catastrophic for ChaCha20-Poly1305 (it
  discloses a keystream XOR between the two messages and breaks Poly1305's
  forgery resistance). This is a hard stop, not best-effort throttling.
- **The only way to resume sending is to reboot.** A reboot advances
  `boot_epoch` (see §6's boot-epoch-advance rule below) and resets `seq` to
  `0`, opening a fresh sequence space under the new epoch.
- **`boot_epoch` MUST NOT wrap either**, by the same logic one level up. An
  implementation advancing its persisted boot counter on startup MUST
  refuse to advance (and MUST NOT send) if the stored value is already
  `0xFFFFFFFF` — leave it pinned rather than wrapping to `0`. A node that
  reaches this state has no valid identity left to use under its current
  `node_id` and requires re-provisioning (assignment of a new `node_id`, or
  an operator-driven reset of the server's replay state for the old one —
  see the operational note at the end of §6). In practice this requires
  roughly 4 billion reboots and is not expected to occur; it is specified
  here only so no implementation silently wraps it.
- **Server-side, no special case is needed.** `seq == 0xFFFFFFFF` is a
  perfectly ordinary, valid sequence number right up until it's the last
  one usable in its epoch — the §6 acceptance rule (epoch monotonicity +
  sliding window) already handles it with no additional logic. Consumers
  MUST NOT treat `0xFFFFFFFF` as a sentinel or invalid value.

## 5. Crypto (AEAD)

- Algorithm: **ChaCha20-Poly1305**, IETF variant (96-bit nonce, 128-bit tag).
- Key: **32 bytes, unique per node**, provisioned out-of-band (flashed into
  the node's NVS at provisioning time; configured server-side in the node
  registry, `packages/config`, as base64). Keys are never transmitted.
- AAD: the full 28-byte cleartext header (§3), exactly as it appears on the
  wire, including the `nonce` field itself.
- Reference implementation: Node's built-in `node:crypto`
  `chacha20-poly1305` cipher in `packages/protocol`; firmware uses
  mbedTLS's ChaCha20-Poly1305 (bundled with ESP-IDF).

**Why AEAD and not just a MAC:** this system ships a continuous record of
motion timing inside a home, over the open Internet, without a VPN in v1.
That is a home-surveillance-grade signal. Confidentiality is therefore a
hard requirement, not just integrity/authenticity — anyone who can observe
the path (ISP, transit, a compromised router) must not be able to infer
occupancy timing from the traffic. Encryption is not optional hardening
here; it is the reason a PSK exists at all.

Decode/seal failure (bad tag) MUST result in the datagram being silently
dropped and counted in server metrics; it must never crash the ingest
process or be treated as a partially-trusted message.

## 6. Anti-replay

A plain monotonic counter is insufficient because it resets to zero on every
power cycle, and this project's nodes *will* lose power (Wi-Fi USB adapters,
household breakers, Halocode reflash cycles). The identity tuple
`(node_id, boot_epoch, seq)` combined with the rules below is what makes
replay detection survive reboots.

The server keeps, per `node_id`, this state:

```
highest_epoch : u32       // highest boot_epoch ever accepted for this node
highest_seq   : u32       // highest seq accepted within highest_epoch
window        : bitmap of W bits   // W = 1024
```

`window` bit `k` (for `0 <= k < W`) means "the datagram with
`seq == highest_seq - k` has been accepted", using the RFC 6479-style
sliding bitmap (`W = 1024` bits = 128 bytes; generous enough to absorb UDP
reordering/bursts from up to 9 nodes without being large enough to matter for
memory).

**Acceptance rule**, evaluated in order, after AEAD verification succeeds:

1. If this is the first datagram ever seen for `node_id`: accept, set
   `highest_epoch = boot_epoch`, `highest_seq = seq`, clear the window
   except bit `0` (the just-accepted `seq`).
2. Else if `boot_epoch < highest_epoch`: **reject** ("stale epoch" / boot
   rollback). This also covers a naive replay-and-resend of an old
   captured datagram from a previous boot.
3. Else if `boot_epoch > highest_epoch`: the node has rebooted. **Accept**,
   set `highest_epoch = boot_epoch`, `highest_seq = seq`, and **reset the
   window** (a new epoch starts its own sequence space; do not compare
   `seq` across epochs).
4. Else (`boot_epoch == highest_epoch`, same epoch as before) apply the
   sliding-window check against `seq`:
   - If `seq > highest_seq`: accept. Shift the window left by
     `seq - highest_seq` bits (dropping the oldest bits off the top),
     set bit `0`, and update `highest_seq = seq`.
   - If `seq <= highest_seq`: let `age = highest_seq - seq`.
     - If `age >= W`: **reject** ("too old", outside the replay window).
     - Else if bit `age` is already set: **reject** ("duplicate").
     - Else: accept (a legitimately reordered, not-yet-seen older
       datagram) and set bit `age`.

Rejections at any of these steps are counted in server metrics per node and
per reason; they do not raise exceptions or halt ingest of other datagrams.

Operational note: a **legitimate** `boot_epoch` decrease can only happen if
a node's NVS is erased (re-provisioned) while reusing the same `node_id`.
That is treated identically to a rollback attack by design — the operator
must either assign the re-provisioned unit a new `node_id`, or explicitly
clear that node's server-side replay state as part of the re-provisioning
runbook (see `docs/architecture.md`).

## 7. Time

Every `CSI_BATCH` payload (§9) carries:

- `wall_clock_us` (`u64`): UTC microseconds since the Unix epoch, taken from
  the node's SNTP-disciplined system clock at the moment the batch is
  finalized for send.
- `mono_us` (`u64`): microseconds from `esp_timer_get_time()`, i.e. free-
  running since boot, monotonic, never adjusted.
- `sntp_synced` (`u8`, `0`/`1`): whether the node's SNTP client has
  completed at least one successful sync since boot.

**Why both:** `esp_timer` never jumps or steps, so deltas computed from it
*within a single node* are trustworthy even before SNTP has converged (or if
it later drifts/steps). `wall_clock_us` is what makes timestamps from
*different* nodes comparable at all, but consumers MUST treat it as
untrustworthy — and should down-weight or exclude the record from
cross-node alignment — whenever `sntp_synced == 0`, and should still budget
for residual SNTP error even when `sntp_synced == 1`.

Rule for consumers (features/occupancy, brief B4): use `mono_us` deltas for
anything computed from a single node's stream (e.g. inter-frame timing,
windowing); use `wall_clock_us` only to align records *across* nodes, and
never assume sub-millisecond cross-node accuracy from it.

`HEARTBEAT` payloads do not repeat these fields; they carry a single
`sntp_synced` flag (§10) as a coarse health indicator.

## 8. Message types

| `msg_type` | Name          | Status                        |
|-----------:|---------------|--------------------------------|
| 0          | —             | Reserved / invalid, MUST be rejected |
| 1          | `CSI_BATCH`   | Implemented in v1 (§9)         |
| 2          | `HEARTBEAT`   | Implemented in v1 (§10)        |
| 3          | `LOG`         | Reserved for future use (see `docs/roadmap.md`); MUST currently be rejected by the server as unknown if received |
| 4          | `OTA_STATUS`  | Reserved for future OTA rollout reporting (see `docs/roadmap.md`); MUST currently be rejected by the server as unknown if received |
| 5–255      | —             | Unassigned                     |

A decoder that receives a `msg_type` it does not implement MUST drop the
datagram and count it in metrics; it must not crash and must not attempt to
interpret the ciphertext.

## 9. `CSI_BATCH` payload (plaintext, after AEAD open)

### 9.1 Batch header (22 bytes, at the start of the plaintext)

| Offset | Width | Field           | Type    | Meaning |
|-------:|------:|-----------------|---------|---------|
| 0      | 8     | `wall_clock_us` | `u64`   | See §7. |
| 8      | 8     | `mono_us`       | `u64`   | See §7. |
| 16     | 1     | `sntp_synced`   | `u8`    | See §7. |
| 17     | 3     | `reserved`      | `u8[3]` | MUST be zero. Reserved for future flags; kept for 2-byte alignment of the following field. |
| 20     | 2     | `record_count`  | `u16`   | Number `N` of CSI records that follow. |

### 9.2 CSI record (31-byte fixed part + variable raw CSI bytes), repeated `record_count` times

| Offset (from record start) | Width | Field                | Type     | Meaning |
|----------------------------:|------:|----------------------|----------|---------|
| 0                            | 6     | `src_mac`            | `u8[6]`  | Source MAC of the captured frame (the sounding transmitter). |
| 6                            | 6     | `dst_mac`            | `u8[6]`  | Destination MAC of the captured frame. |
| 12                           | 1     | `rssi`               | `i8`     | Received signal strength, dBm. |
| 13                           | 1     | `rate`               | `u8`     | Raw PHY rate index as reported by the ESP32 Wi-Fi driver (`wifi_pkt_rx_ctrl_t.rate`). |
| 14                           | 1     | `sig_mode`           | `u8`     | `0` = non-HT (802.11b/g), `1` = HT (802.11n). |
| 15                           | 1     | `mcs`                | `u8`     | MCS index, valid when `sig_mode == 1`; `0xFF` when not applicable. |
| 16                           | 1     | `bandwidth`          | `u8`     | `0` = 20 MHz (`HT20`), `1` = 40 MHz (`HT40`). This deployment is fixed to 20 MHz (see `docs/architecture.md`); the field exists for completeness and future-proofing. |
| 17                           | 1     | `channel`             | `u8`     | Primary channel number (1–14) at capture time. |
| 18                           | 1     | `secondary_channel`  | `u8`     | `0` = none, `1` = above, `2` = below (mirrors `wifi_second_chan_t`). |
| 19                           | 1     | `noise_floor`        | `i8`     | Noise floor, dBm. |
| 20                           | 8     | `rx_timestamp_us`    | `u64`    | `esp_timer` microseconds at the moment this frame's CSI callback fired. Monotonic, node-local; comparable to a batch's `mono_us` but not across nodes. |
| 28                           | 1     | `csi_format`         | `u8`     | Tag describing which parts of the channel estimate are present, see §9.3. **Consumers must dispatch subcarrier interpretation on this tag, never assume a fixed layout.** |
| 29                           | 2     | `csi_len`             | `u16`   | Length in bytes of the raw CSI byte array that immediately follows this record's fixed part. |
| 31                           | `csi_len` | `csi_data`       | `u8[csi_len]` | Raw CSI bytes exactly as returned by the ESP32 Wi-Fi driver's CSI callback for this `csi_format` (signed 8-bit interleaved I/Q pairs). **Never assume a subcarrier count from `csi_format` alone** — derive it from `csi_len` and the known per-subcarrier byte width for that format. Record length is variable and MUST be parsed by `csi_len`, not by any assumed constant. |

Fixed part size: **31 bytes**, plus `csi_len` bytes of raw data. The next
record (if any) starts immediately after this record's raw data — there is
no inter-record padding or alignment.

### 9.3 `csi_format` values

| Value | Name             | Notes |
|------:|------------------|-------|
| 0     | `LLTF`           | Legacy Long Training Field only. Smallest, most portable across non-HT and HT senders alike. Typical size ≈128 bytes, but this is descriptive, not normative — always read `csi_len`. |
| 1     | `HT_LTF`         | HT Long Training Field only (802.11n). |
| 2     | `LLTF_HT_LTF`    | Both LLTF and HT-LTF concatenated. Typical size ≈384 bytes — again, descriptive only. |
| 3     | `STBC_HT_LTF`    | HT-LTF captured with STBC (space-time block coding) enabled on the sender. |
| 4–255 | —                | Unassigned; a decoder encountering an unknown tag MUST still parse the record using `csi_len` (to stay in sync for subsequent records in the batch) but should treat `csi_data` as opaque/unusable for feature extraction. |

This system is **amplitude-first**: CSI phase from the ESP32 is not usable
without heavy sanitization (no hardware TX/RX phase lock, uncorrected
CFO/SFO). Every downstream consumer of `csi_data` (brief B4) computes
amplitude from the I/Q pairs and must not depend on phase being meaningful.

## 10. `HEARTBEAT` payload (plaintext, after AEAD open, 36 bytes total)

| Offset | Width | Field                  | Type   | Meaning |
|-------:|------:|------------------------|--------|---------|
| 0      | 4     | `uptime_s`             | `u32`  | Seconds since boot. |
| 4      | 4     | `free_heap_bytes`      | `u32`  | Current free heap, bytes. |
| 8      | 4     | `min_free_heap_bytes`  | `u32`  | Minimum free heap observed since boot, bytes. |
| 12     | 4     | `frames_captured`      | `u32`  | Cumulative CSI frames captured since boot. |
| 16     | 4     | `frames_dropped`       | `u32`  | Cumulative CSI frames dropped (buffer full, capture error, etc.) since boot. |
| 20     | 4     | `batches_sent`         | `u32`  | Cumulative `CSI_BATCH` datagrams sent since boot. |
| 24     | 4     | `send_failures`        | `u32`  | Cumulative send failures (e.g. `sendto()` errors) since boot. |
| 28     | 1     | `rssi_to_ap`           | `i8`   | Current RSSI to the associated AP, dBm. |
| 29     | 1     | `channel`              | `u8`   | Current operating channel. |
| 30     | 1     | `sntp_synced`          | `u8`   | `0`/`1`, same meaning as §7. |
| 31     | 1     | `fw_version_major`     | `u8`   | Firmware semantic version, major. |
| 32     | 1     | `fw_version_minor`     | `u8`   | Firmware semantic version, minor. |
| 33     | 1     | `fw_version_patch`     | `u8`   | Firmware semantic version, patch. |
| 34     | 2     | `reserved`             | `u8[2]`| MUST be zero. |

Total: **36 bytes**, fixed size (no variable-length parts).

Heartbeats are sent on a fixed interval independent of CSI activity (see
`docs/architecture.md` for the configured interval) so the server can detect
a silently-dead node even when there is no motion to report.

## 11. Sizing and limits

- **Maximum datagram size: 1200 bytes** (the full UDP payload: header +
  ciphertext + tag). This is chosen well under the common 1500-byte Ethernet
  MTU *and* under the IPv6 minimum-MTU floor of 1280 bytes, so a single
  datagram survives typical home-router/PPPoE/VPN-hop overhead on the path
  to a public VPS without IP fragmentation — the same reasoning QUIC uses
  for its default safe UDP size. A decoder MUST reject any datagram larger
  than this as oversized/malformed before attempting to parse it.
- With the 28-byte header and 16-byte tag fixed, the maximum plaintext
  payload is **1156 bytes**.
- **`max_records_per_batch`**: a firmware-side soft cap (default `16`,
  configurable) on the number of CSI records accumulated before a flush is
  forced, independent of the byte budget below — this bounds worst-case
  per-batch CPU/latency even for very small `csi_len` values.
- **Flush policy**: firmware accumulates CSI records into an in-progress
  batch and flushes (seals and sends) it as soon as **any one** of these is
  true, whichever comes first:
  1. **Size**: appending the next record would make the plaintext exceed
     1156 bytes.
  2. **Count**: the batch has reached `max_records_per_batch` records.
  3. **Time budget**: `flush_time_budget_ms` (default `200`, configurable)
     has elapsed since the first record currently in the batch was
     captured — this bounds latency during low-traffic periods so the
     server doesn't wait indefinitely for a batch to fill.
- A batch is never split across multiple datagrams; if a single CSI record's
  `csi_len` is itself so large it cannot fit in an otherwise-empty batch
  (bigger than 1156 − 22 − 31 = 1103 bytes of raw CSI), the firmware must
  drop that record and count it under `frames_dropped` — this should not
  happen for any currently defined `csi_format`, but the rule exists so
  behavior is defined if a future format is larger.

## 12. Versioning

- `version` (offset 4, §3) starts at `1`.
- Within a version's minor evolution, payload structures may only be
  **extended by appending new fields at the end** of a payload or record
  (never reordering, removing, or resizing existing fields); old decoders
  simply ignore trailing bytes they don't know about **only if** they were
  built to tolerate it — v1 decoders in this repo are strict and do not
  do this automatically, so any such extension must itself bump `version`.
- A structural change that is not a pure append (reordering fields,
  changing a field's width, changing the header layout, changing the AAD
  contents) MUST bump `version`.
- On receipt of a `version` the server does not support (currently: any
  value other than `1`), the server MUST drop the datagram, must not
  attempt to parse anything past the `version` byte, and must count the
  drop in metrics keyed by `(node_id, version)` so an operator can see a
  node running mismatched firmware.

## 13. Worked example

The following is one complete, real `CSI_BATCH` datagram containing a
single CSI record with 4 bytes of raw CSI data, produced by
`packages/protocol`'s encoder and decodable by it. It is included so a
from-scratch (e.g. C) implementation can self-check byte-for-byte against a
known-good datagram.

Fixed inputs used to produce it:

```
node_id      = 7
boot_epoch   = 3
seq          = 42
psk (32 B)   = 00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f
               10 11 12 13 14 15 16 17 18 19 1a 1b 1c 1d 1e 1f
wall_clock_us= 1700000000000000
mono_us      = 123456789
sntp_synced  = 1
1 CSI record:
  src_mac      = aa:bb:cc:dd:ee:01
  dst_mac      = aa:bb:cc:dd:ee:ff
  rssi         = -42
  rate         = 11
  sig_mode     = 1
  mcs          = 7
  bandwidth    = 0
  channel      = 6
  secondary_ch = 0
  noise_floor  = -95
  rx_timestamp_us = 123456700
  csi_format   = 0 (LLTF)
  csi_data     = 01 02 03 04
```

> **Regenerate this section's prose from code, do not hand-edit the hex
> dump.** `packages/protocol` includes a script,
> `npm run --workspace @homecsi/protocol print-example`, that encodes the
> inputs above with the package's own encoder and prints the annotated hex
> dump below — use it to keep the offsets/decoded values here in sync after
> an intentional change to the example inputs.
>
> **That alone would not prove the bytes below are correct**, since the
> script uses the same encoder it's supposedly checking — a bug shared
> between the two call sites would reproduce identically in both and pass
> silently. The actual correctness check lives in
> `packages/protocol/src/docs-example.test.ts`: a hardcoded golden byte
> vector, laid out by hand from this document's own field tables and sealed
> with a direct `node:crypto` `chacha20-poly1305` call (not via
> `encodeCsiBatchDatagram` or any other function in this package), and
> cross-checked byte-for-byte against firmware's own independent derivation
> in `firmware/tests/test_docs_example.c`. That test asserts **both**
> `encodeCsiBatchDatagram`'s real output **and** this document's raw
> datagram bytes equal that fixed vector — never each other.

<!-- BEGIN GENERATED EXAMPLE -->
```
Full datagram, 101 bytes total:

0000  48 43 53 31 01 01 07 00 03 00 00 00 2a 00 00 00
0010  07 00 03 00 00 00 2a 00 00 00 00 00 38 a6 9a fd
0020  b4 bd 55 3b 48 03 44 03 22 35 8a cc 96 d9 5d b1
0030  be af 3c 17 55 3b 44 67 cd 72 be 2e 5c d9 fa e3
0040  d4 3a 01 80 64 96 55 db 8d 83 eb 4c 9c dd 04 cf
0050  c4 e5 8c ed 10 fd d6 aa a6 28 a5 60 1e 5f 50 4f
0060  85 05 58 fc 49

Cleartext header (28 bytes, also the AEAD AAD):
  magic       (offset  0, 4B): 48 43 53 31  ("HCS1")
  version     (offset  4, 1B): 01  (1)
  msg_type    (offset  5, 1B): 01  (1 = CSI_BATCH)
  node_id     (offset  6, 2B): 07 00  (7)
  boot_epoch  (offset  8, 4B): 03 00 00 00  (3)
  seq         (offset 12, 4B): 2a 00 00 00  (42)
  nonce       (offset 16, 12B): 07 00 03 00 00 00 2a 00 00 00 00 00

Ciphertext (57 bytes, offset 28):
  0000  38 a6 9a fd b4 bd 55 3b 48 03 44 03 22 35 8a cc
  0010  96 d9 5d b1 be af 3c 17 55 3b 44 67 cd 72 be 2e
  0020  5c d9 fa e3 d4 3a 01 80 64 96 55 db 8d 83 eb 4c
  0030  9c dd 04 cf c4 e5 8c ed 10

Auth tag (16 bytes, offset 85):
  fd d6 aa a6 28 a5 60 1e 5f 50 4f 85 05 58 fc 49

Decrypted plaintext (CSI_BATCH payload) for reference:
  batch header (22 bytes):
    wall_clock_us (offset 0, 8B) = 1700000000000000
    mono_us       (offset 8, 8B) = 123456789
    sntp_synced   (offset 16, 1B) = 1
    reserved      (offset 17, 3B) = 00 00 00
    record_count  (offset 20, 2B) = 1
  record[0] (31-byte fixed part + 4 bytes csi_data):
    src_mac            = aa:bb:cc:dd:ee:01
    dst_mac            = aa:bb:cc:dd:ee:ff
    rssi               = -42
    rate               = 11
    sig_mode           = 1
    mcs                = 7
    bandwidth          = 0
    channel            = 6
    secondary_channel  = 0
    noise_floor        = -95
    rx_timestamp_us    = 123456700
    csi_format         = 0 (LLTF)
    csi_len            = 4
    csi_data           = 01 02 03 04
```
<!-- END GENERATED EXAMPLE -->

## 14. Summary of hard rules (for quick reference)

- All integers little-endian. All sizes explicit; never assume a fixed
  subcarrier count from `csi_format` — always use `csi_len`.
- Cleartext header is exactly 28 bytes and is the AEAD's AAD, unencrypted.
- Nonce is `node_id || boot_epoch || seq || 00 00`, and is also verified,
  not just trusted, by the decoder.
- One shared `seq` counter across all message types, per boot. `seq` and
  `boot_epoch` MUST NOT wrap (§4.1) — exhaustion is a hard stop, resumed
  only by a reboot that advances `boot_epoch`.
- Replay identity is `(node_id, boot_epoch, seq)`; server enforces
  epoch-monotonicity plus a 1024-bit sliding window within an epoch.
- Max datagram size 1200 bytes; batches flush on size, count, or time
  budget, whichever comes first.
- Amplitude-first: phase is not to be trusted anywhere downstream.
