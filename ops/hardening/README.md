# VPS hardening

`harden.sh` sets up a fresh Debian/Ubuntu VPS for running Home CSI. It is
**Linux-only** and meant to run on the VPS itself over SSH — it will not run
on the Windows-on-ARM dev machine used for this repo.

Read `harden.sh` itself before running it; the comments inline are the
primary documentation for *why* each step exists. This file is a short index
plus the operational sequencing that isn't obvious from the script alone.

## Before you run it

1. Confirm you can SSH into the VPS **with an SSH key**, not a password.
   `--harden-ssh` (see below) disables password authentication entirely.
2. Have your VPS provider's out-of-band console/rescue access path noted
   down, in case something goes wrong and SSH becomes unreachable.
3. Know the UDP port your nodes will send to (`HOMECSI_UDP_PORT`, default
   `5566`, must match `ops/.env`).

## Running it

```sh
# Copy the script to the VPS (scp, git clone, etc.), then:
chmod +x harden.sh
sudo HOMECSI_UDP_PORT=5566 ./harden.sh
```

Or, to reuse the same `ops/.env` values (including the UDP rate-limit
variables below) instead of retyping them:

```sh
set -a; source ops/.env; set +a
sudo -E ./harden.sh
```

This first pass:
- Installs and enables `ufw`, `fail2ban`, `unattended-upgrades`, `chrony`.
- Sets a default-deny-inbound firewall, allowing only SSH (22/tcp), HTTP
  (80/tcp), HTTPS (443/tcp), and the ingest UDP port.
- Adds a per-source-IP rate limit on the UDP ingest port, sized against the
  full 9-node design envelope with explicit arithmetic in the script's
  comments (section 3) — configurable via `HOMECSI_UDP_RATE_LIMIT_PER_SEC`
  (default 1000 pps) and `HOMECSI_UDP_RATE_LIMIT_BURST` (default 2000),
  documented in `ops/.env.example`. Re-running the script after changing
  either value updates the live rule in place. A throttled-log line
  (`journalctl -k | grep homecsi-udp-limit`) fires when the limit engages,
  so throttling is observable instead of looking like silent packet loss —
  see the script's comments for exactly what this mechanism does and does
  not protect against, and `docs/deployment.md` "Troubleshooting" for the
  operator-facing symptom.
- Installs Docker and adds `DOCKER-USER` iptables guard rules to prevent the
  classic Docker-bypasses-ufw footgun (see script comments — this is the
  part most guides skip and it directly matters here because
  `ops/docker-compose.yml` deliberately never publishes Postgres).
- Does **not** touch `sshd_config`.

Once you've confirmed the VPS is still reachable and stable, and you've
verified key-based SSH login works, run the second, opt-in pass:

```sh
sudo ./harden.sh --harden-ssh
```

This disables SSH password authentication and root login. **Immediately
after it runs, open a second, separate SSH session and confirm you can still
log in before closing your first session.** The script validates the new
`sshd_config` with `sshd -t` and rolls back automatically if that check
fails, but it cannot detect a lockout that only manifests on a *new*
connection attempt (e.g. a key that works for reload-validation purposes but
isn't actually the key your client will present).

## Idempotency

The script checks existing state before changing it (firewall rules, Docker
install, fail2ban config, rate-limit rules) and is safe to re-run. Config
files it modifies in place (`/etc/ssh/sshd_config`,
`/etc/ufw/before.rules`) are backed up once, on first modification, to
`<file>.bak-homecsi`.

## What this script deliberately does not do

- **Create a swap file.** Sizing depends on the VPS's RAM/disk headroom;
  see the comment in `harden.sh` for a manual recipe if you want one.
- **Configure Docker's daemon-level log limits.** Those are set per-service
  in `ops/docker-compose.yml` (`logging:` blocks) — see `docs/deployment.md`
  "Log management".
- **Configure application-level retention/compression.** That's TimescaleDB
  policy + raw capture rotation, owned by the ingest/prune CLI subcommands
  (sibling brief B3) — see `docs/deployment.md` "Disk management" for the
  operator-facing side.
- **Set up the WireGuard VPN.** Out of scope for v1; see
  `docs/deployment.md` "future: WireGuard VPN".
