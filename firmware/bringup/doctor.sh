#!/usr/bin/env bash
#
# doctor.sh - check the Linux/WSL2 side of the Home CSI toolchain.
#
# Design rule: this script NEVER just fails. Every check that does not pass
# prints the specific next action, because the whole point is to shorten the
# gap between "something is wrong" and "here is what to type".
#
#   ./doctor.sh            check everything
#   ./doctor.sh --port /dev/ttyUSB0    also probe that serial port
#
# Exit code: 0 if nothing blocking was found, 1 otherwise. Warnings alone do
# not fail the run.

set -u

PORT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --port) PORT="${2:-}"; shift 2 ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1"; exit 2 ;;
    esac
done

PASS=0
WARN=0
FAIL=0

if [ -t 1 ]; then
    G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; B=$'\033[1m'; N=$'\033[0m'
else
    G=""; Y=""; R=""; B=""; N=""
fi

ok()   { printf "  %s[ ok ]%s %s\n" "$G" "$N" "$1"; PASS=$((PASS+1)); }
warn() { printf "  %s[warn]%s %s\n" "$Y" "$N" "$1"; WARN=$((WARN+1));
         [ $# -gt 1 ] && printf "         -> %s\n" "$2"; return 0; }
bad()  { printf "  %s[FAIL]%s %s\n" "$R" "$N" "$1"; FAIL=$((FAIL+1));
         [ $# -gt 1 ] && printf "         -> %s\n" "$2"; return 0; }
head_() { printf "\n%s%s%s\n" "$B" "$1" "$N"; }

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

printf "%sHome CSI toolchain doctor%s  (%s)\n" "$B" "$N" "$(uname -srm)"

# ---------------------------------------------------------------- environment
head_ "Environment"

if grep -qiE "(microsoft|wsl)" /proc/version 2>/dev/null; then
    ok "running under WSL2"
    if [ "${PWD#/mnt/}" != "$PWD" ]; then
        warn "working directory is on a Windows drive (/mnt/...)" \
             "Builds across the 9P mount are far slower. Clone into the Linux filesystem, e.g. ~/src/home-csi"
    else
        ok "working directory is on the Linux filesystem"
    fi
elif case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) true ;; *) false ;; esac; then
    warn "running under MSYS2/Git Bash, not Linux"          "ESP-IDF does not run here. Use WSL2 or Docker for the toolchain (bringup/README.md Step 1), and run doctor.ps1 for the Windows-side checks (drivers, COM ports, usbipd)"
else
    ok "running on native Linux (not WSL)"
fi

ARCH="$(uname -m)"
case "$ARCH" in
    aarch64|arm64) ok "architecture $ARCH (ESP-IDF ships native linux-arm64 toolchains)" ;;
    x86_64)        ok "architecture $ARCH" ;;
    *)             warn "unusual architecture $ARCH" "ESP-IDF may not ship a toolchain for this" ;;
esac

# ------------------------------------------------------------------- ESP-IDF
head_ "ESP-IDF"

if [ -n "${IDF_PATH:-}" ] && [ -d "$IDF_PATH" ]; then
    ok "IDF_PATH=$IDF_PATH"
else
    bad "IDF_PATH is not set" \
        "Run: . \$HOME/esp/esp-idf/export.sh   (see bringup/README.md Step 1)"
fi

if command -v idf.py >/dev/null 2>&1; then
    IDF_VER="$(idf.py --version 2>/dev/null | tail -1)"
    ok "idf.py present: $IDF_VER"
    case "$IDF_VER" in
        *v5.*) ok "ESP-IDF v5.x, which is what this firmware targets" ;;
        *v4.*) bad "ESP-IDF v4.x detected" \
                   "This firmware uses v5.x APIs (esp_netif_sntp, rmt_tx, esp_task_wdt_add). Install v5.x." ;;
        *)     warn "could not parse the IDF version" "Confirm manually with: idf.py --version" ;;
    esac
else
    bad "idf.py not on PATH" \
        "Run: . \$HOME/esp/esp-idf/export.sh   (must be re-run in every new shell)"
fi

for tool in cmake ninja; do
    if command -v "$tool" >/dev/null 2>&1; then
        ok "$tool: $($tool --version 2>/dev/null | head -1)"
    else
        warn "$tool not found" "It normally comes from ESP-IDF export.sh; if not: sudo apt-get install $tool"
    fi
done

if command -v xtensa-esp32-elf-gcc >/dev/null 2>&1; then
    ok "xtensa-esp32-elf-gcc: $(xtensa-esp32-elf-gcc -dumpversion 2>/dev/null)"
else
    warn "xtensa-esp32-elf-gcc not on PATH" \
         "Run ./install.sh esp32 inside \$IDF_PATH, then re-run export.sh"
fi

# ------------------------------------------------------------------- esptool
head_ "Flashing tools"

if command -v esptool.py >/dev/null 2>&1; then
    ok "esptool.py: $(esptool.py version 2>/dev/null | head -1)"
elif python3 -c "import esptool" >/dev/null 2>&1; then
    ok "esptool importable as a Python module (use: python3 -m esptool)"
else
    warn "esptool.py not found" \
         "It ships with ESP-IDF; standalone: pip install esptool"
fi

if command -v nvs_partition_gen.py >/dev/null 2>&1; then
    ok "nvs_partition_gen.py on PATH"
elif [ -n "${IDF_PATH:-}" ] && \
     [ -f "$IDF_PATH/components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py" ]; then
    ok "nvs_partition_gen.py found inside IDF_PATH (provision.py locates it there)"
else
    warn "nvs_partition_gen.py not found" \
         "Needed by tools/provision.py build. Source export.sh, or pass --idf-path"
fi

# --------------------------------------------------------------- serial ports
head_ "Serial ports"

FOUND_PORTS="$(ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null)"
if [ -n "$FOUND_PORTS" ]; then
    for p in $FOUND_PORTS; do ok "found $p"; done
    if id -nG 2>/dev/null | tr ' ' '\n' | grep -qx dialout; then
        ok "user is in the 'dialout' group"
    else
        bad "user is NOT in the 'dialout' group" \
            "Run: sudo usermod -aG dialout \$USER   then close and reopen this shell"
    fi
else
    if grep -qiE "(microsoft|wsl)" /proc/version 2>/dev/null; then
        warn "no /dev/ttyUSB* or /dev/ttyACM* device" \
             "From an elevated Windows PowerShell: usbipd list; usbipd bind --busid X-Y; usbipd attach --wsl --busid X-Y. If it still does not appear, the WSL kernel may lack the ch341/cp210x module -- flash from Windows instead (bringup/README.md Option C)"
    else
        warn "no /dev/ttyUSB* or /dev/ttyACM* device" \
             "Plug the board in, and check 'dmesg | tail' for the bridge driver"
    fi
fi

if [ -n "$PORT" ]; then
    if [ -e "$PORT" ]; then
        ok "requested port $PORT exists"
        if [ -r "$PORT" ] && [ -w "$PORT" ]; then
            ok "$PORT is readable and writable"
        else
            bad "$PORT is not read/write for this user" \
                "sudo usermod -aG dialout \$USER, then reopen the shell"
        fi
        if command -v esptool.py >/dev/null 2>&1; then
            printf "         probing %s with esptool chip_id ...\n" "$PORT"
            if esptool.py --port "$PORT" chip_id >/tmp/hcs_doctor_chipid 2>&1; then
                ok "esptool talked to the board:"
                grep -E "Chip is|Features|MAC:|Crystal" /tmp/hcs_doctor_chipid | sed 's/^/           /'
                printf "         %sRecord these in the bring-up table.%s\n" "$B" "$N"
            else
                bad "esptool could not connect on $PORT" \
                    "Hold BOOT/IO0, tap EN/RESET, release BOOT, retry. Try --baud 115200. Close any other program holding the port."
            fi
        fi
    else
        bad "requested port $PORT does not exist" "Check the port name, and see the passthrough note above"
    fi
fi

# ---------------------------------------------------------------- host tests
head_ "Host tests (no hardware needed)"

if command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1 || \
   command -v clang >/dev/null 2>&1; then
    ok "a host C compiler is available"
    printf "         run them with: cd %s/firmware/tests && python3 run_tests.py\n" "$REPO"
else
    warn "no host C compiler (cc/gcc/clang)" \
         "sudo apt-get install build-essential   -- these tests need no ESP32 and are the fastest way to check the wire format"
fi

if [ -f "$REPO/firmware/tests/run_tests.py" ]; then
    ok "firmware/tests/run_tests.py present"
else
    bad "firmware/tests/run_tests.py missing" "Are you running this from inside the repository?"
fi

# -------------------------------------------------------------------- summary
head_ "Summary"
printf "  %d ok, %d warnings, %d failures\n" "$PASS" "$WARN" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
    printf "\n  %sBlocking problems above.%s Fix the [FAIL] lines, then re-run.\n" "$R" "$N"
    exit 1
fi
if [ "$WARN" -gt 0 ]; then
    printf "\n  %sUsable, with caveats.%s The [warn] lines will bite you later.\n" "$Y" "$N"
else
    printf "\n  %sToolchain looks good.%s Next: bringup/README.md Step 3 (chip_id / flash_id).\n" "$G" "$N"
fi
exit 0
