# Hardware: ESP32-C6 (primary target)

This document separates **what is actually known** about the ESP32-C6 board
from **what must be verified on the bench** before firmware work (brief B2)
can rely on it, in the same register as `docs/hardware-halocode.md` for the
project's original (now legacy/secondary) board. Do not treat anything in
the "to be verified" table as fact until it has been measured on real
hardware and the table has been filled in.

The operator is replacing the fleet's Makeblock Halocode (ESP32) nodes with
five ESP32-C6 boards; `firmware/esp32-csi-node/sdkconfig.defaults.esp32c6`
makes `esp32c6` the default `idf.py set-target` for this firmware, with
`esp32` (the Halocode) kept buildable for whatever legacy units remain in
service. See `firmware/README.md` and `firmware/bringup/README.md` for the
build/bring-up procedure; this document is only the hardware facts.

## What is known

These are drawn from Espressif's own published documentation for the
ESP32-C6 silicon and its CSI support, not measured by this project - they
are a materially stronger starting point than the Halocode's third-party,
undocumented hardware, but they are still not a substitute for running
`firmware/bringup/csi-hello` against the actual units in hand (see below).

- **2.4 GHz only.** The ESP32-C6 is a Wi-Fi 6 (802.11ax) chip, but its radio
  is 2.4 GHz only - it has no 5 GHz capability at all. This does not change
  anything about the project's capability claims already stated in
  `docs/architecture.md` (the dedicated broadcast-sounding mesh already runs
  entirely on 2.4 GHz); it just means there is no 5 GHz passive-sniffing
  "garnish" possible from this board either, unlike some other Wi-Fi 6
  designs that carry a 5 GHz radio too.
- **SISO per link.** The ESP32-C6 has a single antenna path (one RF chain).
  A single node therefore gets one channel estimate per captured frame, the
  same as the classic ESP32 - there is no multi-antenna diversity and no
  angle-of-arrival information obtainable from one node's CSI alone. The
  project's existing design already does not depend on this (see
  `docs/architecture.md`'s "motion, not people" framing and the
  broadcast-sounding mesh, which gets its spatial resolution from *multiple
  nodes' links*, not from antenna arrays on any one node).
- **`first_word_invalid`.** Like other ESP32-family CSI implementations, the
  C6's Wi-Fi driver can report a CSI buffer whose first 4 bytes (one I/Q
  sample "word") are not valid channel data, flagged via
  `wifi_csi_info_t.first_word_invalid`. `firmware/esp32-csi-node/main/csi_capture.c`
  trims exactly those bytes off the record it queues, rather than either
  passing them through as fabricated data or letting a wrong assumption
  desynchronise anything downstream - see the comment on `csi_rx_cb()` for
  why this is safe given the project's "always parse by `csi_len`, never a
  fixed length" invariant (`docs/protocol.md` S9.2/S14).
- **Typically ~53 usable subcarriers in HT20; HT40 is often unstable on this
  chip.** Per Espressif's own CSI documentation and community reporting
  around the ESP32-C6, a 20 MHz (HT20) capture on this chip typically yields
  on the order of ~53 usable subcarriers - notably fewer than the classic
  ESP32's commonly-cited ~384-byte (LLTF+HT-LTF) record. 40 MHz (HT40)
  capture is reported as frequently unstable on this silicon. Neither of
  these is a problem for this deployment: `docs/architecture.md` and
  `wifi_link.c` already pin the mesh to 20 MHz for the classic ESP32's own
  reasons (subcarrier layout consistency across the fleet), and that same
  pin applies unchanged to the C6.
- **Espressif's own CSI-quality ranking: C5 > C6 > C3 ≈ S3 > ESP32.**
  Espressif's own CSI-focused documentation and tooling (the `esp-csi`
  project) rank current Wi-Fi-capable ESP32 variants by CSI quality/
  reliability in roughly this order: ESP32-C5 best, ESP32-C6 next, ESP32-C3
  and ESP32-S3 roughly tied below that, and the original ESP32 last. This is
  Espressif's own characterization, not a measurement made by this project -
  it is included here because it is directly relevant to "why C6 and not
  some other current chip", but it should not be read as a guarantee about
  any specific unit's behavior; see the bench procedure below for that.
- **CSI config API.** Espressif's own `esp-csi` project configures CSI
  identically (the same `wifi_csi_config_t` fields: `lltf_en`, `htltf_en`,
  `stbc_htltf2_en`, `ltf_merge_en`, `channel_filter_en`, `manu_scale`,
  `shift`) across ESP32, ESP32-C3, ESP32-S3 and ESP32-C6. `csi_capture.c`
  therefore uses the same config code for both targets this firmware builds
  for; see the `CONFIG_IDF_TARGET_ESP32C6` notice logged at
  `csi_capture_start()` for exactly what is and is not build-verified about
  that equivalence (no ESP-IDF toolchain or C6 hardware was available while
  writing this).

## What must be verified on the bench (do not assume)

Do **not** assert the exact flash size, module variant/revision, USB-serial
bridge chip, real CSI record lengths, or the LED GPIO as fact anywhere in
firmware or docs until it has been checked on the actual units in hand -
"ESP32-C6" covers many board/module variants (Espressif's own
DevKitC/DevKitM reference boards, third-party carrier boards, bare modules
on a custom PCB), and guessing wrong causes the same class of silent
partition-table/flashing/LED failures the Halocode bring-up already warned
about.

Run `firmware/bringup/csi-hello` against each unit (`idf.py set-target
esp32c6`) and follow "Step 6 (ESP32-C6 addendum)" in
`firmware/bringup/README.md` - that procedure is what turns each row below
from assumed into measured, and states exactly what to read off the
console and where to copy it.

| Field | How you find it | Value (fill in) |
|---|---|---|
| Chip type / revision | `esptool.py chip_id` | |
| Flash size | `esptool.py flash_id` | |
| Flash manufacturer/device ID | `esptool.py flash_id` | |
| USB-serial bridge chip | check `lsusb` / Device Manager VID:PID | |
| MAC address (Wi-Fi station) | `esptool.py read_mac`, or csi-hello's `STA MAC:` line | |
| CSI `len` values observed | csi-hello, `firmware/bringup/csi-hello` | |
| `sig_mode`/`stbc`/`rate` values observed (any surprises vs. the classic ESP32?) | csi-hello | |
| `first_word_invalid` observed at all? | csi-hello (`fwi=` field) | |
| LED GPIO (if you determine it; Espressif's DevKitC-1 reference design documents GPIO8, unverified for any other C6 board/module) | Step 8 of bring-up (optional) | |

Two of these matter beyond curiosity, for exactly the same reasons the
Halocode's table calls out:

- **Flash size** decides whether `partitions.csv` (the shared A/B OTA
  layout) is right for this board. Common ESP32-C6 dev boards ship with 4 MB
  or 8 MB flash depending on the variant; `esptool.py flash_id` gives the
  truth.
- **CSI `len` values** decide `CONFIG_HCS_CSI_MAX_LEN`. Espressif's own
  figures suggest this will typically be *smaller* on the C6 than on the
  classic ESP32 (see "~53 usable subcarriers" above), so the shared 384-byte
  default should be a safe ceiling either way - but "should" is not
  "measured" here either. Records longer than the configured maximum are
  dropped and counted, never truncated.

## Toolchain

Same toolchain guidance as the Halocode - see
`docs/hardware-halocode.md`'s "Toolchain on Windows-on-ARM" section and
`firmware/bringup/README.md`'s Step 1. ESP32-C6 support requires ESP-IDF
v5.1 or later (it did not exist as a target before that); nothing about the
Windows-on-ARM64/WSL2/`usbipd`/Docker guidance changes for this chip.
