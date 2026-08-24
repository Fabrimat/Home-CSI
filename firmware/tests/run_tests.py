#!/usr/bin/env python3
"""Build and run the Home CSI firmware host tests.

Why this exists alongside the Makefile: the primary dev machine for this
project is Windows on ARM64, where `make` is frequently not installed. This
script does exactly what the Makefile does (compile each test_*.c together
with the shared protocol sources, run it, aggregate exit codes) using nothing
but Python 3 and a C compiler.

Usage:
    python run_tests.py                 # uses $CC, else 'cc', else 'gcc'/'clang'
    CC="zig cc" python run_tests.py     # any C11 compiler works
    python run_tests.py --cc "zig cc"

Exit code is 0 only if every test binary compiled and returned 0.
"""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
PROTO = HERE.parent / "esp32-csi-node" / "components" / "csi_protocol"
BUILD = HERE / "build"

# Shared, host-compilable sources. These are the *same* files the ESP-IDF
# build compiles into the firmware - the wire layout is never duplicated.
SHARED_SOURCES = [
    PROTO / "csi_codec.c",
    PROTO / "csi_ring.c",
    PROTO / "csi_batcher.c",
    PROTO / "bw_budget.c",
    PROTO / "seq_epoch.c",
    PROTO / "device_token.c",
]

# Host-only helpers (reference crypto, doc parsing). Never built into firmware.
SUPPORT_SOURCES = sorted((HERE / "support").glob("*.c"))

CFLAGS = [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Wno-unused-function",
    "-O1",
    "-g",
    "-DHCS_HOST_BUILD=1",
]

INCLUDES = ["-I", str(HERE), "-I", str(PROTO / "include"), "-I", str(HERE / "support")]


def detect_cc() -> list[str]:
    env = os.environ.get("CC")
    if env:
        return shlex.split(env)
    for candidate in ("cc", "gcc", "clang"):
        if shutil.which(candidate):
            return [candidate]
    sys.stderr.write(
        "error: no C compiler found. Set CC, e.g.:\n"
        '  CC="gcc" python run_tests.py\n'
        '  CC="zig cc" python run_tests.py\n'
    )
    raise SystemExit(2)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cc", help="C compiler command (overrides $CC)")
    ap.add_argument("--filter", default="", help="only run tests matching this substring")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    cc = shlex.split(args.cc) if args.cc else detect_cc()
    BUILD.mkdir(exist_ok=True)

    missing = [str(s) for s in SHARED_SOURCES if not s.exists()]
    if missing:
        sys.stderr.write("error: missing shared sources:\n  " + "\n  ".join(missing) + "\n")
        return 2

    tests = sorted(HERE.glob("test_*.c"))
    if args.filter:
        tests = [t for t in tests if args.filter in t.name]
    if not tests:
        sys.stderr.write("error: no tests found\n")
        return 2

    print(f"cc: {' '.join(cc)}")
    print(f"tests: {len(tests)}\n")

    failed: list[str] = []
    for test in tests:
        exe = BUILD / (test.stem + (".exe" if os.name == "nt" else ""))
        cmd = (
            cc
            + CFLAGS
            + INCLUDES
            + ["-o", str(exe), str(test)]
            + [str(s) for s in SHARED_SOURCES]
            + [str(s) for s in SUPPORT_SOURCES]
        )
        if args.verbose:
            print(" ".join(cmd), flush=True)
        build = subprocess.run(cmd, capture_output=True, text=True)
        if build.returncode != 0:
            print(f"BUILD-FAIL {test.name}", flush=True)
            print(build.stdout)
            print(build.stderr)
            failed.append(test.name)
            continue
        # docs-example test needs the repo root to locate docs/protocol.md
        run = subprocess.run([str(exe), str(REPO)], text=True)
        if run.returncode != 0:
            failed.append(test.name)

    print()
    if failed:
        print(f"{len(failed)} of {len(tests)} test binaries FAILED: {', '.join(failed)}")
        return 1
    print(f"All {len(tests)} test binaries passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
