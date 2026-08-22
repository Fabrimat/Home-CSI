# Hardware: Makeblock Halocode

This document separates **what is actually known** about the Halocode board
from **what must be verified on the bench** before firmware work (brief B2)
can rely on it. Do not treat anything in the "to be verified" table as fact
until it has been measured on real hardware and the table has been filled
in.

## What is known

- The Halocode is built around an **ESP32** module, which is why it is
  usable for this project at all: it has the same Wi-Fi/CSI capability as
  any other ESP32 board once reflashed with custom firmware.
- It ships from Makeblock with its own firmware (a MicroPython-based
  environment driven from the mBlock IDE) and a **12-LED RGB ring** on the
  board as a built-in visual status indicator.
- The ESP32 is **802.11n, 2.4 GHz only** — see `docs/architecture.md` for
  what this means for the project's capability claims. This is an ESP32
  silicon fact, not Halocode-specific, and is not something to re-verify
  per unit.

## What must be verified on the bench (do not assume)

Do **not** assert the exact flash size, ESP32 module variant/revision, or
USB-serial bridge chip as fact anywhere in firmware or docs until it has
been checked on the actual units in hand — Makeblock has shipped variants
of this board over its production life, and guessing wrong causes silent
partition-table or flashing failures that are painful to debug.

Run these against a Halocode connected over USB, with the bootloader in
download mode (hold the reset sequence per Makeblock's docs, or use
`esptool.py`'s auto-reset if the serial bridge supports it):

```sh
# Identify the flash chip (size, manufacturer)
esptool.py --port <PORT> flash_id

# Identify the exact chip variant/revision
esptool.py --port <PORT> chip_id
```

Fill in the table below per unit (or per batch, if units are consistent):

| Field                          | Command                    | Value (fill in) |
|--------------------------------|-----------------------------|------------------|
| Chip type / revision           | `esptool.py chip_id`        |                  |
| Flash size                     | `esptool.py flash_id`       |                  |
| Flash manufacturer/device ID   | `esptool.py flash_id`       |                  |
| USB-serial bridge chip         | check `lsusb` / Device Manager VID:PID | |
| MAC address (Wi-Fi station)    | `esptool.py read_mac`       |                  |

## Reflashing warning

Reflashing a Halocode with custom ESP-IDF firmware **replaces the Makeblock
firmware entirely**. Restoring the original mBlock-compatible firmware
afterward is fiddly — it typically requires Makeblock's own
firmware-recovery tooling/images (not a generic `esptool.py` command) and is
not guaranteed to be smooth. **Treat reflashing as one-way** for planning
purposes: assume a unit dedicated to this project stays dedicated to this
project, and don't reflash a Halocode you might need to give back in
original condition.

## Toolchain on Windows-on-ARM

**ESP-IDF has no native Windows-on-ARM support.** The standard ESP-IDF
Windows installer and toolchain target x86_64 Windows; there is no
supported arm64-native path. On a Windows-on-ARM development machine (as
used for this repo), firmware work must run in one of:

- **WSL2 running a linux-arm64 distro**, with ESP-IDF installed inside WSL2
  per Espressif's Linux instructions (the ESP-IDF Linux toolchain does
  support arm64), with the ESP32 connected via USB and passed through to
  WSL2 (`usbipd-win` or similar), or
- The **`espressif/idf` Docker image**, run through Docker Desktop's
  WSL2 backend, with the same USB-passthrough consideration for flashing
  from inside the container.

Either path works for building and flashing; the practical difference is
mainly how USB device passthrough is set up. Document the specific
passthrough steps that work once B2 has gone through this on the actual
dev machine — this file intentionally does not prescribe one exact recipe
yet, since it depends on the WSL2/usbipd/Docker Desktop versions in use at
setup time.

**USB serial bridge drivers on Windows ARM64 are a known friction point.**
Some USB-serial bridge chips used on ESP32 dev boards (CP210x, CH340, etc.)
have spotty or missing native arm64 Windows driver support. If flashing
fails with the port not enumerating, or enumerating but not accepting data,
suspect the driver before suspecting the board or cabling — check Device
Manager for an unrecognized or generic-driver device first, and prefer
doing the actual flashing from within WSL2 (where the Linux kernel's
generic USB-serial drivers are more consistently available) if the native
Windows driver is unreliable.
