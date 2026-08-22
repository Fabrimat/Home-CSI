#!/usr/bin/env python3
"""
provision.py - per-node NVS provisioning for Home CSI nodes.

WHY THIS EXISTS
    No per-node secret, id, SSID or hostname is compiled into the firmware
    image. Every board runs the identical binary and differs only in the
    contents of its `nvs` partition, which this script builds.

WHAT IT GUARANTEES
    * Keys are 32 bytes from `secrets.token_bytes` (the OS CSPRNG).
    * A key is NEVER reused across nodes. docs/protocol.md section 4 derives
      the AEAD nonce from (node_id, boot_epoch, seq); that construction is
      only safe because each node has its OWN key. Two nodes sharing a key
      would produce colliding (key, nonce) pairs the moment their sequence
      numbers overlapped, which for ChaCha20-Poly1305 is a catastrophic,
      plaintext-recovering failure - not a theoretical one. The script
      refuses to continue if it ever sees a duplicate.
    * The generated CSV and .bin files contain the key in the clear and are
      written to a directory this script also drops a .gitignore into.

TYPICAL FLOW
    1. cp nodes.example.json nodes.json     # edit: ids, names, AP, server
    2. python provision.py keygen           # creates/extends secrets/keys.json
    3. python provision.py build            # -> secrets/out/nvs_<id>.bin
    4. python provision.py registry         # -> the server-side node list
    5. python provision.py flashcmd --node 7 --port COM5
       (or:  esptool.py --port COM5 write_flash 0x9000 secrets/out/nvs_7.bin)

REQUIREMENTS
    ESP-IDF on PATH (for nvs_partition_gen.py). Run inside the IDF
    environment, or pass --idf-path.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_NODES = HERE / "nodes.json"
DEFAULT_SECRETS_DIR = HERE / "secrets"
DEFAULT_KEYS = DEFAULT_SECRETS_DIR / "keys.json"
DEFAULT_OUT = DEFAULT_SECRETS_DIR / "out"

# Must match partitions.csv (`nvs, data, nvs, 0x9000, 0x6000`).
NVS_OFFSET = 0x9000
NVS_SIZE = 0x6000

# Must match the K_* macros in main/node_config.c.
NS = "homecsi"

SECRET_WARNING = """
  ############################################################
  #  THESE FILES CONTAIN PER-NODE SECRET KEYS.               #
  #  Do not commit them. Do not paste them into a chat.      #
  #  Anyone holding a node's key can decrypt that node's     #
  #  entire occupancy-timing stream off the wire.            #
  #  A .gitignore has been written next to them, but that    #
  #  is a safety net, not a substitute for care.             #
  ############################################################
"""


def die(msg: str) -> "None":
    sys.stderr.write(f"error: {msg}\n")
    raise SystemExit(1)


# --------------------------------------------------------------------------
# nodes definition
# --------------------------------------------------------------------------


def load_nodes(path: Path) -> dict:
    if not path.exists():
        die(
            f"{path} not found. Copy nodes.example.json to nodes.json and edit it."
        )
    with path.open("r", encoding="utf-8") as f:
        doc = json.load(f)

    if "nodes" not in doc or not isinstance(doc["nodes"], list):
        die(f"{path}: expected a top-level 'nodes' array")

    seen_ids: set[int] = set()
    for n in doc["nodes"]:
        nid = n.get("node_id")
        if not isinstance(nid, int) or not (1 <= nid <= 65535):
            die(f"{path}: node_id must be an integer 1..65535 (0 is reserved)")
        if nid in seen_ids:
            die(f"{path}: node_id {nid} appears twice")
        seen_ids.add(nid)
    return doc


def merged(doc: dict, node: dict, key: str, default=None):
    """Node-level value, else the file's `defaults`, else `default`."""
    if key in node:
        return node[key]
    return doc.get("defaults", {}).get(key, default)


# --------------------------------------------------------------------------
# keys
# --------------------------------------------------------------------------


def load_keys(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_secret_file(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    gitignore = path.parent / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text("# Secrets. Never commit anything in here.\n*\n",
                             encoding="utf-8")
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)
        f.write("\n")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass  # best effort; Windows ACLs are a different story


def assert_keys_unique(keys: dict[str, str]) -> None:
    """The single most important check in this file. See the module docstring."""
    seen: dict[str, str] = {}
    for node_id, b64 in keys.items():
        try:
            raw = base64.b64decode(b64, validate=True)
        except Exception:
            die(f"key for node {node_id} is not valid base64")
        if len(raw) != 32:
            die(f"key for node {node_id} is {len(raw)} bytes, must be 32")
        if raw == bytes(32):
            die(f"key for node {node_id} is all zeros - refusing")
        if b64 in seen:
            die(
                f"nodes {seen[b64]} and {node_id} share a key. "
                "Per-node keys are what makes the nonce construction in "
                "docs/protocol.md section 4 safe; reusing one across nodes "
                "can expose plaintext. Delete the duplicate and re-run keygen."
            )
        seen[b64] = node_id


def cmd_keygen(args) -> int:
    doc = load_nodes(Path(args.nodes))
    keys_path = Path(args.keys)
    keys = load_keys(keys_path)

    created, kept = [], []
    for node in doc["nodes"]:
        nid = str(node["node_id"])
        if nid in keys and not args.rotate:
            kept.append(nid)
            continue
        if nid in keys and args.rotate:
            print(
                f"  ROTATING node {nid}: the server registry MUST be updated "
                "at the same time or this node's traffic will be dropped."
            )
        keys[nid] = base64.b64encode(secrets.token_bytes(32)).decode("ascii")
        created.append(nid)

    assert_keys_unique(keys)
    write_secret_file(keys_path, keys)

    print(f"keys file: {keys_path}")
    print(f"  generated: {', '.join(created) if created else '(none)'}")
    print(f"  unchanged: {', '.join(kept) if kept else '(none)'}")
    print(SECRET_WARNING)
    return 0


# --------------------------------------------------------------------------
# NVS CSV / binary
# --------------------------------------------------------------------------


def mac_to_hex(mac: str) -> str:
    cleaned = mac.replace(":", "").replace("-", "").strip().lower()
    if len(cleaned) != 12 or any(c not in "0123456789abcdef" for c in cleaned):
        die(f"bad MAC address '{mac}'")
    return cleaned


def build_csv(doc: dict, node: dict, key_b64: str) -> str:
    """Rows for nvs_partition_gen.py. Key names must match main/node_config.c."""
    psk_hex = base64.b64decode(key_b64).hex()

    allow = [mac_to_hex(m) for m in merged(doc, node, "allowlist", [])]
    if len(allow) > 16:
        die("allowlist is capped at 16 entries (NODE_CFG_MAX_ALLOWLIST)")

    rows: list[tuple[str, str, str, str]] = [
        (NS, "namespace", "", ""),
        ("node_id", "data", "u16", str(node["node_id"])),
        ("psk", "data", "hex2bin", psk_hex),
        ("srv_host", "data", "string", str(merged(doc, node, "server_host", ""))),
        ("srv_port", "data", "u16", str(merged(doc, node, "server_port", 5566))),
        ("ap_ssid", "data", "string", str(merged(doc, node, "ap_ssid", ""))),
        ("ap_pass", "data", "string", str(merged(doc, node, "ap_password", ""))),
        ("channel", "data", "u8", str(merged(doc, node, "channel", 6))),
        ("sntp_srv", "data", "string",
         str(merged(doc, node, "sntp_server", "pool.ntp.org"))),
        ("snd_ms", "data", "u32", str(merged(doc, node, "sounding_interval_ms", 100))),
        ("snd_jit", "data", "u8", str(merged(doc, node, "sounding_jitter_pct", 25))),
        ("rssi_floor", "data", "i8", str(merged(doc, node, "rssi_floor_dbm", -85))),
        ("allow_enf", "data", "u8",
         "1" if merged(doc, node, "allowlist_enforced", False) else "0"),
        ("batch_max", "data", "u16",
         str(merged(doc, node, "max_records_per_batch", 16))),
        ("flush_ms", "data", "u32", str(merged(doc, node, "flush_budget_ms", 200))),
        ("hb_ms", "data", "u32",
         str(merged(doc, node, "heartbeat_interval_ms", 15000))),
        ("recon_s", "data", "u32",
         str(merged(doc, node, "reconnect_reboot_s", 900))),
        ("bw_snd_rps", "data", "u32", str(merged(doc, node, "bw_sounding_rps", 50))),
        ("bw_frn_rps", "data", "u32", str(merged(doc, node, "bw_foreign_rps", 5))),
        ("bw_bps", "data", "u32", str(merged(doc, node, "bw_bytes_per_sec", 32768))),
        ("dec_frn", "data", "u8",
         str(merged(doc, node, "decimate_foreign_start_pct", 40))),
        ("dec_snd", "data", "u8",
         str(merged(doc, node, "decimate_sounding_start_pct", 70))),
        ("dec_full", "data", "u8", str(merged(doc, node, "decimate_full_pct", 95))),
        ("dec_div", "data", "u8", str(merged(doc, node, "decimate_max_divisor", 8))),
        ("dbg_uart", "data", "u8",
         "1" if merged(doc, node, "debug_uart", False) else "0"),
        ("dbg_udp", "data", "u8",
         "1" if merged(doc, node, "debug_udp", False) else "0"),
        ("dbg_host", "data", "string", str(merged(doc, node, "debug_udp_host", ""))),
        ("dbg_port", "data", "u16", str(merged(doc, node, "debug_udp_port", 5556))),
    ]
    if allow:
        rows.append(("allowlist", "data", "hex2bin", "".join(allow)))

    # nvs_partition_gen rejects an empty string value, and an ABSENT key is
    # exactly what node_config.c already treats as "not configured" (it keeps
    # its own default). So drop empty strings rather than emit empty rows.
    # This is also how a legitimately open AP ends up with no ap_pass entry.
    rows = [r for r in rows
            if not (r[1] == "data" and r[2] == "string" and r[3] == "")]

    out = ["key,type,encoding,value"]
    out += [",".join(r) for r in rows]
    return "\n".join(out) + "\n"


def find_nvs_gen(idf_path: str | None) -> Path:
    candidates = []
    root = idf_path or os.environ.get("IDF_PATH")
    if root:
        candidates.append(Path(root) / "components" / "nvs_flash"
                          / "nvs_partition_generator" / "nvs_partition_gen.py")
    found = shutil.which("nvs_partition_gen.py")
    if found:
        candidates.append(Path(found))
    for c in candidates:
        if c.exists():
            return c
    die(
        "cannot find nvs_partition_gen.py. Run this inside the ESP-IDF "
        "environment (export.sh / export.ps1) or pass --idf-path."
    )
    raise AssertionError  # unreachable, keeps type checkers quiet


def cmd_build(args) -> int:
    doc = load_nodes(Path(args.nodes))
    keys = load_keys(Path(args.keys))
    if not keys:
        die(f"{args.keys} is empty - run `provision.py keygen` first")
    assert_keys_unique(keys)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    gitignore = out_dir.parent / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text("# Secrets. Never commit anything in here.\n*\n",
                             encoding="utf-8")

    gen = None if args.csv_only else find_nvs_gen(args.idf_path)

    for node in doc["nodes"]:
        nid = node["node_id"]
        key_b64 = keys.get(str(nid))
        if key_b64 is None:
            die(f"no key for node {nid} - run `provision.py keygen`")

        csv_path = out_dir / f"nvs_{nid}.csv"
        csv_path.write_text(build_csv(doc, node, key_b64), encoding="utf-8")
        try:
            os.chmod(csv_path, 0o600)
        except OSError:
            pass

        if args.csv_only:
            print(f"  node {nid}: {csv_path}")
            continue

        bin_path = out_dir / f"nvs_{nid}.bin"
        cmd = [
            sys.executable, str(gen), "generate", str(csv_path), str(bin_path),
            hex(NVS_SIZE),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            sys.stderr.write(res.stdout + res.stderr)
            die(f"nvs_partition_gen failed for node {nid}")
        print(f"  node {nid} ({node.get('name', '?')}): {bin_path}")

    print(f"\nFlash each with:  esptool.py --port <PORT> write_flash "
          f"{hex(NVS_OFFSET)} {out_dir}/nvs_<id>.bin")
    print(SECRET_WARNING)
    return 0


# --------------------------------------------------------------------------
# server registry
# --------------------------------------------------------------------------


def cmd_registry(args) -> int:
    doc = load_nodes(Path(args.nodes))
    keys = load_keys(Path(args.keys))
    assert_keys_unique(keys)

    entries = []
    for node in doc["nodes"]:
        nid = node["node_id"]
        if str(nid) not in keys:
            die(f"no key for node {nid}")
        entry = {
            # Field names below match server/packages/config's nodeSchema
            # exactly (id / name / room / psk / expectedMac). Verified against
            # packages/config/src/schema.ts during integration - do not rename
            # without changing the schema too.
            "id": nid,
            "name": node.get("name", f"node{nid}"),
            "room": node.get("room") or node.get("location") or f"node{nid}",
            "psk": keys[str(nid)],
        }
        # expectedMac is optional in the schema; only emit it once the real STA
        # MAC is known (read it from the node's boot log after first flash).
        mac = node.get("expected_mac") or node.get("expectedMac")
        if mac:
            entry["expectedMac"] = mac
        entries.append(entry)

    payload = {"nodes": entries}
    text = json.dumps(payload, indent=2) + "\n"

    if args.out:
        out = Path(args.out)
        write_secret_file(out, payload)
        print(f"wrote {out}")
    else:
        print(text)

    print(
        "\nThese field names (id / name / room / psk / expectedMac) match the\n"
        "server nodeSchema in server/packages/config/src/schema.ts. Paste the\n"
        "entries under the nodes: key of your server config, keeping the psk\n"
        "values byte for byte. room is required and must be non-empty;\n"
        "expectedMac is optional - add it once you have read each node real\n"
        "STA MAC from its boot log." + "\n"
    )
    print(SECRET_WARNING)
    return 0


# --------------------------------------------------------------------------
# flash helper
# --------------------------------------------------------------------------


def cmd_flashcmd(args) -> int:
    bin_path = Path(args.out) / f"nvs_{args.node}.bin"
    if not bin_path.exists():
        die(f"{bin_path} not found - run `provision.py build` first")
    cmd = ["esptool.py", "--port", args.port, "write_flash", hex(NVS_OFFSET),
           str(bin_path)]
    print(" ".join(cmd))
    if args.run:
        return subprocess.run(cmd).returncode
    print("\n(re-run with --run to execute it)")
    return 0


# --------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--nodes", default=str(DEFAULT_NODES))
    ap.add_argument("--keys", default=str(DEFAULT_KEYS))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("keygen", help="create a 32-byte key for every node")
    p.add_argument("--rotate", action="store_true",
                   help="replace keys that already exist (breaks the server "
                        "registry until it is updated too)")
    p.set_defaults(func=cmd_keygen)

    p = sub.add_parser("build", help="build a per-node NVS partition image")
    p.add_argument("--idf-path", default=None)
    p.add_argument("--csv-only", action="store_true",
                   help="write the CSVs but do not invoke nvs_partition_gen")
    p.set_defaults(func=cmd_build)

    p = sub.add_parser("registry", help="print the server-side node registry")
    p.add_argument("--out", dest="out", default=None,
                   help="write to this file instead of stdout")
    p.set_defaults(func=cmd_registry)

    p = sub.add_parser("flashcmd", help="show/run the esptool command")
    p.add_argument("--node", required=True, type=int)
    p.add_argument("--port", required=True)
    p.add_argument("--run", action="store_true")
    p.set_defaults(func=cmd_flashcmd)

    args = ap.parse_args()
    # `registry --out` shadows the global --out; put the global back for the
    # subcommands that need the build directory.
    if args.cmd == "registry" and getattr(args, "out", None) is None:
        args.out = None
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
