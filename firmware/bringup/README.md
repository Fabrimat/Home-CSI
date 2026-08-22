# Node bring-up — do this first

Nothing else in this repository can be trusted until **one** Makeblock
Halocode has been confirmed to produce CSI. This document is the ordered
procedure to get there, written for the machine this project is actually
developed on: **Windows 11 on ARM64**.

Work through it in order. Every step either produces a fact you write into
the [board facts table](#board-facts-record-what-you-measure) or unblocks the
next step.

---

## Read this before you flash anything

**Reflashing replaces the Makeblock firmware.** Once you write ESP-IDF
firmware over it, the board stops being a Halocode: mBlock will no longer
recognise it, the built-in demo programs are gone, and the block-based
tooling will not talk to it.

Makeblock provides a firmware-restore feature inside mBlock. In practice that
path is fiddly — it depends on mBlock recognising a board that no longer
speaks its protocol, and reports of it working on a fully-reflashed unit are
mixed. **Assume you cannot rely on it.**

The realistic way back is a **full flash image you take yourself, before you
overwrite anything** (Step 4). It is one command and it takes about a minute.
Do not skip it, and do not skip it "just for the first board" — the first
board is the one you are most likely to want to undo.

> This project has **not** verified the mBlock restore procedure, and has not
> verified that a stock image restored with `write_flash` brings mBlock
> compatibility back either. The backup is the best available insurance, not a
> guarantee. Treat every board you flash as potentially one-way.

---

## Board facts: record what you measure

Everything in the table below is **unknown to this project**. No file in this
repository asserts any of it as fact; the firmware parameterises all of it.
Fill this in per board as you go, then copy the results into
`firmware/esp32-csi-node/tools/nodes.json` and `menuconfig`.

| Fact | How you find it | Node 1 | Node 2 | Node 3 | Node 4 |
|---|---|---|---|---|---|
| Serial bridge chip (VID:PID) | Step 2 | | | | |
| Driver installed (name/version) | Step 2 | | | | |
| COM port | Device Manager | | | | |
| Chip type + revision | `esptool.py chip_id` | | | | |
| Module variant (WROOM-32 / WROVER / ...) | markings + `chip_id` features | | | | |
| Base MAC | `esptool.py chip_id` | | | | |
| STA MAC (for the allowlist) | csi-hello prints it | | | | |
| Flash size (real) | `esptool.py flash_id` | | | | |
| Flash manufacturer / device id | `esptool.py flash_id` | | | | |
| PSRAM present? | `chip_id` features line | | | | |
| Stock backup file + SHA-256 | Step 4 | | | | |
| CSI `len` values observed | Step 6 | | | | |
| CSI callbacks/sec observed | Step 6 | | | | |
| LED GPIO (if you determine it) | Step 8 (optional) | | | | |

Two of these matter beyond curiosity:

- **Flash size** decides whether `partitions.csv` is right. That file is
  deliberately sized for a 2 MB part so it works on the smallest plausible
  module; if your part is bigger you are merely under-using it, which is
  fine, but you should know which it is before adding OTA later.
- **CSI `len` values** decide `CONFIG_HCS_CSI_MAX_LEN`. The firmware default
  is 384, which is a documented-typical value, **not a measured one**.
  Records longer than the configured maximum are dropped and counted, never
  truncated — so a wrong value shows up as a rising `oversize` counter rather
  than as corrupt data, but it still costs you every large record.

---

## Step 0 — What you need

- A Makeblock Halocode and its USB cable (**a data cable** — many USB cables
  are charge-only, and this is a genuinely common hour-waster).
- Windows 11 on ARM64, administrator access.
- Python 3 for Windows (ARM64 build). Check with `python --version`.
- Roughly 10 GB of disk for a toolchain.

---

## Step 1 — Choose a toolchain path

**ESP-IDF has no native Windows-on-ARM64 support.** There is no arm64 Windows
installer and no arm64 Windows toolchain from Espressif. The x64 Windows
installer will run under Windows x64 emulation, but you are then emulating a
large native toolchain: it is slow, and when something breaks you cannot tell
whether it is your code or the emulation layer. Do not start there.

Two paths actually work. **They differ mainly in whether the board is visible
to the build environment**, which turns out to matter more than build speed.

### Option A — WSL2 with the linux-arm64 ESP-IDF (recommended)

ESP-IDF ships native **linux-arm64** toolchains, so inside an arm64 WSL2
distribution everything runs at full native speed with no emulation.

```powershell
wsl --install -d Ubuntu          # reboot if prompted
wsl --set-default-version 2
```

Then inside Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y git wget flex bison gperf python3 python3-pip \
    python3-venv cmake ninja-build ccache libffi-dev libssl-dev dfu-util \
    libusb-1.0-0
mkdir -p ~/esp && cd ~/esp
git clone -b v5.2.2 --recursive https://github.com/espressif/esp-idf.git
cd esp-idf && ./install.sh esp32
. ./export.sh                    # run this in every new shell
idf.py --version                 # confirm v5.2.x
```

> Any ESP-IDF **v5.x** release should work; this firmware is written against
> v5.x APIs. Pin one version across all your machines so you are never
> debugging two toolchains at once.

**Pros:** native arm64 speed; the full `idf.py flash monitor` workflow; a real
Linux filesystem, so no CRLF or path-length surprises.
**Cons:** USB passthrough is a separate moving part (below), and it is the
part most likely to fight you.

**Keep the repo inside the WSL filesystem** (`~/src/...`), not under
`/mnt/c/...`. Building across the 9P mount is dramatically slower and causes
file-watching and permission oddities.

### Option B — the `espressif/idf` Docker image

```powershell
docker run --rm -it -v "${PWD}:/project" -w /project espressif/idf:release-v5.2 `
  idf.py set-target esp32 build
```

**Pros:** no toolchain install; exactly reproducible; trivially disposable.

**Cons — and this is the decisive one: Docker Desktop on Windows cannot pass a
USB serial device into a Linux container.** There is no working `--device
/dev/ttyUSB0` equivalent when the container runs inside the Windows-hosted
Linux VM. So with Docker you can **build, but not flash and not monitor**,
from inside the container.

### Option C — the hybrid (also recommended, and the most robust)

Build in WSL2 **or** Docker, then flash from **native Windows** with esptool:

```powershell
pip install esptool
esptool.py --port COM5 write_flash 0x10000 build\csi-hello.bin
```

`esptool` is pure Python and installs and runs fine on Windows ARM64. This
sidesteps USB passthrough entirely, which is why it is worth knowing even if
you intend to use Option A: **when `usbipd` misbehaves, this is the fallback,
and it always works.** The only thing you give up is `idf.py monitor`, and any
serial terminal replaces that (see Step 6).

### USB passthrough into WSL2 with `usbipd-win`

```powershell
winget install --interactive --exact dorssel.usbipd-win
```

Then, with the board plugged in:

```powershell
usbipd list
# BUSID  VID:PID    DEVICE                                   STATE
# 2-3    1a86:7523  USB-SERIAL CH340 (COM5)                  Not shared

usbipd bind   --busid 2-3          # once per device, Administrator required
usbipd attach --wsl --busid 2-3    # every time you replug
```

Inside WSL:

```bash
lsusb                             # the bridge should appear
ls -l /dev/ttyUSB* /dev/ttyACM*
sudo usermod -aG dialout $USER    # then close and reopen the WSL shell
```

**When passthrough does not work** — and it frequently does not, for reasons
that are not your fault:

| Symptom | Cause | What to do |
|---|---|---|
| `usbipd attach` succeeds, no `/dev/ttyUSB*` appears | The WSL2 kernel lacks the bridge driver module (`ch341`, `cp210x`, `ftdi_sio`) | Run `dmesg \| tail -20` right after attaching. If the device enumerates but no tty appears, the module is missing — see below |
| `usbipd: error: ... not shared` | `bind` was not run, or not as Administrator | Re-run `usbipd bind` from an elevated PowerShell |
| Device detaches on every reboot or replug | Expected: `attach` is not persistent | Re-run `usbipd attach`, or use `usbipd attach --wsl --auto-attach` |
| Board resets or disconnects mid-flash | USB-over-IP adds latency and the ROM loader is timing-sensitive | Lower the baud (`--baud 115200`), or **switch to Option C** |
| Everything looks right, flashing still fails | Accumulated USB/IP flakiness | **Switch to Option C.** Do not spend an afternoon on this |

If the kernel module is missing you can rebuild the WSL2 kernel with
`CONFIG_USB_SERIAL_CH341` / `CONFIG_USB_SERIAL_CP210X` enabled — Microsoft
documents the procedure — but that is a substantial detour. **Option C costs
five minutes and has no failure mode.** Take Option C.

---

## Step 2 — Identify the serial bridge and install its ARM64 driver

The ESP32 has no native USB, so the Halocode must have a USB-to-UART bridge
between the USB connector and the chip. **Which one it uses is not known to
this project — measure it.**

Plug the board in and ask Windows:

```powershell
Get-PnpDevice -Class Ports,USB | Where-Object { $_.Present } |
    Select-Object Status, Class, FriendlyName, InstanceId
```

Or: Device Manager, find the device, Properties, Details, **Hardware Ids**,
which gives `USB\VID_xxxx&PID_xxxx`. Match it:

| VID:PID | Bridge | Driver source |
|---|---|---|
| `1A86:7523` / `1A86:5523` | WCH CH340 / CH341 | The WCH `CH341SER` package — **use the variant that lists ARM64** |
| `1A86:55D4` | WCH CH9102 | WCH `CH343SER` |
| `10C4:EA60` | Silicon Labs CP2102 / CP2104 | Silicon Labs "CP210x Universal Windows Driver" (includes ARM64) |
| `0403:6001` / `0403:6015` | FTDI FT232R / FT231X | FTDI VCP driver (includes ARM64) |

**The ARM64 part is not optional.** An x64-only driver package will appear to
install and then fail to load, leaving a device with a yellow warning triangle
and Code 10 or Code 52 in Device Manager. If you see that, you have the wrong
architecture of driver: uninstall it (tick *Attempt to remove the driver*),
reboot, and install an ARM64-capable one.

Success looks like a **COM port number** in Device Manager under *Ports (COM &
LPT)*. Write it in the table.

---

## Step 3 — Identify the actual chip and flash

Neither command below writes to the board. Run them before you decide
anything.

```powershell
esptool.py --port COM5 chip_id
esptool.py --port COM5 flash_id
```

`chip_id` reports the chip type, revision, feature flags (WiFi / BT / PSRAM)
and the base MAC. `flash_id` reports the flash manufacturer, the device ID
and, most importantly, the **detected flash size**.

Record every line of both in the table. In particular:

- If the chip is **not** a plain ESP32 (Xtensa), stop. This firmware targets
  `esp32`, and the CSI API differs across targets.
- The flash size you see here is what `partitions.csv` must fit inside. That
  table is sized for 2 MB precisely so this step cannot surprise you, but you
  still want the number written down.

If `esptool` cannot connect, see [Troubleshooting](#troubleshooting).

---

## Step 4 — Back up the stock Makeblock firmware BEFORE overwriting it

**Do this now, before the first `write_flash`.** This is the only realistic
route back to a working Halocode.

Use the flash size you measured in Step 3. For a 4 MB part:

```powershell
esptool.py --port COM5 --baud 460800 read_flash 0x0 0x400000 halocode-stock-node1-4MB.bin
```

Size argument for other parts: 2 MB is `0x200000`, 8 MB is `0x800000`, 16 MB
is `0x1000000`. **Read the whole flash, starting at `0x0`** — a partial dump
of just the app partition is not restorable.

Then verify and record it:

```powershell
# The file must be exactly the flash size. A short file means a failed read.
(Get-Item halocode-stock-node1-4MB.bin).Length
Get-FileHash halocode-stock-node1-4MB.bin -Algorithm SHA256
```

Also capture the eFuse and MAC state, which `read_flash` does not cover:

```powershell
espefuse.py --port COM5 summary > halocode-stock-node1-efuse.txt
```

**Store these off the machine** — another drive, a NAS, anywhere that is not
the laptop you are about to experiment from. `firmware/.gitignore` excludes
`bringup/backups/` and `*.stock.bin` so a stray backup cannot be committed,
but "not committed" is not "backed up".

To restore later:

```powershell
esptool.py --port COM5 --baud 460800 write_flash 0x0 halocode-stock-node1-4MB.bin
```

> Restoring the flash image restores the bytes. Whether mBlock then treats the
> board as a factory-fresh Halocode has **not been verified by this project**.
> Keep the eFuse summary too: eFuses are one-way and are not part of the flash
> image.

**Back up every board individually.** Images may differ per unit, and the MAC
certainly does.

---

## Step 5 — Build and flash `csi-hello`

`csi-hello` is a standalone ESP-IDF app in this directory whose only job is to
prove CSI works. It shares nothing with the main firmware — no components, no
sdkconfig, no NVS provisioning — so it stays buildable even when the main app
does not.

```bash
cd firmware/bringup/csi-hello
idf.py set-target esp32
idf.py menuconfig          # "csi-hello" -> SSID and password of any 2.4 GHz AP
idf.py build
```

Any 2.4 GHz AP works for this test; it does not have to be the dedicated
sensing AP yet.

Flash, Option A (WSL2, board passed through):

```bash
idf.py -p /dev/ttyUSB0 flash monitor
```

Flash, Option C (build anywhere, flash from Windows):

```powershell
esptool.py --port COM5 --baud 460800 write_flash `
  0x1000 build\bootloader\bootloader.bin `
  0x8000 build\partition_table\partition-table.bin `
  0x10000 build\csi-hello.bin
```

`idf.py build` prints the exact offsets for your configuration at the end of
the build. If they differ from the above, trust the build output.

---

## Step 6 — Confirm CSI actually arrives

Open a serial monitor at **115200 baud** (`idf.py monitor`, or any terminal on
Windows). You are looking for lines like:

```
STA MAC: 24:6f:28:xx:xx:xx   <-- record this in the bring-up table
Joining SSID 'myssid'. Waiting for CSI callbacks...

[  12345678 us] src=aa:bb:cc:dd:ee:01 rssi= -47 ch= 6 sig=1 mcs= 7 bw=0 sec=0
                stbc=0 noise= -95 len= 384 amp[0..5]=12 14 13 15 11 12
                (cb=1 printed=1)
```

**This is the moment the project becomes real.** Check three things:

1. **Lines appear at all.** The radio, the driver and CSI all work.
2. **Note the `len` values.** These are the real CSI record sizes on *this*
   hardware. Put the largest one into `CONFIG_HCS_CSI_MAX_LEN` in the main
   firmware instead of trusting the 384 default. If you see values above 384,
   that default would have been silently costing you every large record.
3. **Wave your hand in front of the board.** The printed amplitudes must
   visibly change. If they do not move, you are receiving packets but not
   sensing the room, and the entire premise of the project is unverified.

Every 5 seconds the app also prints the callback rate, or a warning with a
checklist if nothing arrived.

Record the observed `len` values, the callback rate and the STA MAC.

**Repeat Steps 2 to 6 for every board** before going further. Four boards that
each individually produce CSI is the precondition for everything else; four
boards where one is quietly dead will waste far more time later.

---

## Step 7 — Move on to the real firmware

Once at least two boards produce CSI, go to
[`firmware/README.md`](../README.md) for configuration, provisioning, flashing
and placement. Carry forward:

- the **STA MACs** into the `allowlist` in `tools/nodes.json`;
- the **CSI `len` values** into `CONFIG_HCS_CSI_MAX_LEN`;
- the **flash size**, to confirm `partitions.csv` still fits;
- the **COM ports**, for `provision.py flashcmd --port ...`.

---

## Step 8 (optional) — The LED ring

The Halocode is documented as having a 12-LED RGB ring. **This project has not
verified the driver chip or the GPIO it is wired to**, so the firmware ships
with the LED backend set to `none` (it logs state changes instead) and
everything else works identically.

If you want the indicator, determine the pin — from the stock firmware, from a
scope, or by careful trial — and set `CONFIG_HCS_LED_GPIO`,
`CONFIG_HCS_LED_COUNT` and a backend in `menuconfig`. A wrong pin costs you an
indicator, not a node. Record what you find in the table.

---

## Troubleshooting

### The board does not enumerate at all

- **Try a different USB cable first.** Charge-only cables are extremely common
  and produce exactly this symptom.
- Try a different port, and avoid unpowered hubs.
- Run `Get-PnpDevice -Class USB | Where-Object Present` — does *anything*
  appear when you plug it in? If Windows makes no sound and shows no device,
  it is the cable, the port, or power.
- An unknown device that shows a VID:PID but no COM port is a driver problem:
  go back to Step 2.
- A yellow triangle with Code 10 or 52 means a wrong-architecture or unsigned
  driver. Uninstall it *with* "remove the driver", reboot, install ARM64.

### `esptool` cannot connect ("Failed to connect ... Wrong boot mode?")

The ESP32 must be in serial bootloader mode. Normally the bridge arranges this
automatically via DTR/RTS; when it does not, force it manually:

1. Hold **BOOT / IO0** low. On a Halocode this is whichever button is wired to
   GPIO0 — **unverified here**, so try each button.
2. Tap **EN / RESET**, or unplug and replug while holding BOOT.
3. Release BOOT.
4. Re-run the command within a few seconds.

Other fixes, in the order they usually help:

- Lower the baud: `--baud 115200`.
- Close everything else holding the port (serial monitor, mBlock, Arduino
  IDE). Only one process can own a COM port.
- Add `--before default_reset --after hard_reset`.
- Through `usbipd`, timing gets marginal — **use Option C**.

### The flash write fails partway through

- Lower the baud rate. USB-over-IP especially cannot sustain 921600.
- Use a shorter or better cable, and a direct port rather than a hub.
- Run `esptool.py --port COM5 erase_flash`, then write again. **You did take
  the Step 4 backup first, did you not?**
- If writes fail at a consistent offset, suspect the flash size: writing past
  the end of a smaller-than-assumed part fails deterministically. Re-check
  `flash_id`.

### The app boots but the CSI callback never fires

In the order worth checking:

1. **Not associated.** CSI needs decodable frames. Look for
   `associated; operating on channel N` in the monitor.
2. **`CONFIG_ESP_WIFI_CSI_ENABLED` is not set.** Without it
   `esp_wifi_set_csi()` fails. csi-hello wraps that call in
   `ESP_ERROR_CHECK`, so this shows up as a panic naming that line rather
   than as silence.
3. **The call order was disturbed.** `esp_wifi_set_ps`,
   `esp_wifi_set_promiscuous` and the CSI calls must all come *after*
   `esp_wifi_start()`. This is the classic silent failure: everything returns
   `ESP_OK` and no CSI ever arrives. The required order is documented in the
   header comment of `firmware/esp32-csi-node/main/wifi_link.c`.
4. **No traffic on the channel.** A quiet AP with one idle station generates
   almost nothing. Ping the AP from a phone, or start a download; callbacks
   should begin immediately.
5. **5 GHz.** These radios are 2.4 GHz only. If your AP put the board on a
   5 GHz SSID it will not associate, and if the traffic you are generating is
   on 5 GHz the board cannot see it. Confirm the SSID is 2.4 GHz.

### Association fails

- Is the SSID 2.4 GHz? (See above.)
- WPA3-only APs can be awkward. WPA2, or WPA2/WPA3 mixed, is the safe setting
  for the dedicated AP.
- Hidden SSIDs need extra configuration. Do not use one here.
- Check the password for typos: the failure looks identical to a radio
  problem. The disconnect **reason code** in the log distinguishes them
  (auth failure versus no AP found).
- MAC filtering on the AP will silently reject the new STA MAC. If you filter,
  add the MAC from Step 6 first.

### CSI arrives but the amplitudes never change

Receiving works, sensing does not. Check that the board is not sitting against
a large metal object or inside an enclosure, and that you are moving *between*
the board and the AP — motion along the link perturbs the multipath far more
than motion perpendicular to it. If several boards behave this way, revisit
placement before suspecting the firmware; see the placement guide in
[`firmware/README.md`](../README.md).
