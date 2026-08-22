# Deployment runbook

This is the end-to-end operator runbook for deploying Home CSI: a VPS, a
dedicated WiFi AP, and a handful of ESP32 nodes. It assumes the Docker path
(`ops/docker-compose.yml`) as primary; see `ops/systemd/README.md` for the
non-Docker alternative — the operational sections below (backup, disk
management, troubleshooting) apply to both.

Related documents: `docs/protocol.md` (wire format), `docs/architecture.md`
(system design), `ops/ap-checklist.md` (AP configuration),
`ops/hardening/README.md` (VPS hardening detail).

The VPS-side steps are **Linux-only**. If you're working from the
Windows-on-ARM dev machine, everything up to "clone the repo" happens over
SSH into the VPS; editing `.env` and writing docs can happen locally.

## 1. Provision the VPS

1. Rent a small VPS (a single 2 vCPU / 4 GB RAM instance is enough to start
   at 4 nodes / ~110 kbps; re-evaluate before scaling to 9 nodes / ~600
   kbps — see "Upgrades" below). Debian 12 or Ubuntu 22.04+ recommended.
2. Note its public IPv4 (and IPv6 if you have it) address.
3. Confirm you can SSH in with a key before doing anything else.

## 2. Harden the VPS

Follow `ops/hardening/README.md` and run `ops/hardening/harden.sh`. Do the
firewall/Docker/fail2ban pass first; do the `--harden-ssh` pass only after
confirming key-based login works in a second session. Do not skip this —
the ingest UDP port is about to become world-reachable.

## 3. Install Docker

`harden.sh` installs Docker Engine + the Compose plugin as part of its run.
If you're on the non-Docker path instead, skip to `ops/systemd/README.md`
and come back to this doc for the operational sections.

## 4. Clone the repo onto the VPS

```sh
git clone <repo-url> /opt/homecsi
cd /opt/homecsi
```

## 5. Fill in `.env`

```sh
cp ops/.env.example ops/.env
```

Edit `ops/.env` and set real values for `POSTGRES_PASSWORD`,
`HOMECSI_API_TOKEN`, `HOMECSI_DOMAIN`, `HOMECSI_ACME_EMAIL`, and
`HOMECSI_DATA_DIR` (create that directory on the host first, e.g.
`sudo mkdir -p /srv/homecsi/data/{captures,logs,db}`). See the comments in
`ops/.env.example` for how to generate strong secrets. **Never commit this
file** — it's git-ignored, keep it that way.

## 6. Generate per-node keys

See "Key management" below. Do this before first bringing nodes online;
each node needs its key flashed before it can send anything the server will
accept.

## 7. Configure DNS

Point an A record (and AAAA, if the VPS has IPv6) for `HOMECSI_DOMAIN` at
the VPS's public IP. Confirm it resolves (`dig +short your.domain`) before
starting Caddy — Let's Encrypt issuance will fail (and can trigger rate
limits on repeated failure) against a domain that doesn't resolve yet.

## 8. Bring the stack up

```sh
cd ops
docker compose up -d
```

This builds the server image (see `ops/Dockerfile`), starts `timescaledb`,
waits for it to report healthy, then runs `migrate` to completion before
`ingest` and `api` start, then starts `caddy` last (it depends on `api`).

## 9. Run migrations (if not already applied)

The `migrate` service already runs automatically as part of `up`. To
re-run migrations after a later upgrade without restarting everything:

```sh
docker compose run --rm migrate
```

## 10. Verify the stack

```sh
docker compose ps                       # everything should be Up / healthy
docker compose logs -f api              # should show it listening
curl -I https://your.domain             # should return a TLS-terminated response via Caddy
docker compose logs migrate             # should show a clean, successful exit
```

## 11. Configure the AP

Follow `ops/ap-checklist.md` in full before powering on any node — several
of its settings (channel, isolation) are much easier to get right before
nodes are already associated and generating "why is this node missing"
confusion.

## 12. Provision and place the nodes

Flash each node's firmware with its `node_id`, its per-node PSK (see "Key
management"), and the ingest UDP target (`HOMECSI_DOMAIN`:`HOMECSI_UDP_PORT`
— or the VPS's IP:port if you prefer not to depend on DNS at the firmware
level). Register the same `node_id` → PSK mapping server-side (see below).
Place nodes physically, noting each one's room label to match
`ops/ap-checklist.md`'s MAC/IP table.

## 13. Confirm data is arriving

```sh
docker compose logs -f ingest
```

You should see accepted datagrams/heartbeats per `node_id` shortly after
each node powers on and associates to the AP. If not, see
"Troubleshooting" below.

---

## Key management

- Each node has a **32-byte ChaCha20-Poly1305 pre-shared key**, unique per
  node (`docs/protocol.md` §5). Generate one per node:

  ```sh
  openssl rand -hex 32
  ```

- **Server side:** the key is registered in the node registry config
  (`packages/config`, per `docs/protocol.md` §3/§5), keyed by `node_id`,
  stored as base64. Wherever that config file lives on the VPS, treat it
  with the same care as `ops/.env` — it is not meant to be committed with
  real keys in it, only a template/example if one exists.
- **Node side:** the same raw 32 bytes are flashed into the node's NVS at
  provisioning time (firmware detail — see `docs/architecture.md` /
  firmware provisioning docs for the exact flashing step).
- **Never commit a real key** to git, in any form (hex, base64, or as part
  of a filled-in config). Treat a leaked node key as you would a leaked
  password: rotate it (generate a new one, reflash the node, update the
  server registry) as soon as practical.
- **Never reuse one key across multiple nodes.** The protocol's
  nonce-uniqueness guarantee (`docs/protocol.md` §4) is `nonce = node_id ||
  boot_epoch || seq || 0x0000`, which is only guaranteed unique **per key**
  because it's scoped by construction to one node's identity space combined
  with that node's own strictly-increasing counters. Two nodes sharing a
  key would each independently produce nonces that collide with the other
  node's `(boot_epoch, seq)` sequence under the same key — a textbook
  nonce-reuse break of the AEAD's confidentiality/integrity guarantees, not
  just a mild misconfiguration.

## Backup and restore

**Worth backing up:**
- The **TimescaleDB volume** (`timescaledb_data`) — this holds every
  feature/occupancy record and (per the retention policy — see "Disk
  management") a recent window of raw CSI history. This is the system's
  primary asset and is not regenerable if lost.
- **Config and keys** — the node registry (server-side PSKs, `node_id`
  mapping) and `ops/.env`. Losing this means every currently-deployed node
  is unusable until you re-provision it with a fresh key on both ends.

**Not worth backing up (or only loosely worth it):**
- **Raw capture files** on disk (`HOMECSI_DATA_DIR/captures`) — these are
  large, append-heavy, and "regenerable-ish": if a node is still deployed
  and running, it will simply keep producing new raw captures; only the
  historical window is lost, not the capability. Weigh the storage cost of
  backing these up against how much you'd actually replay them (see
  `replay` in the CLI) versus just accepting the gap.

**Backing up TimescaleDB** (logical dump, portable across Postgres/Timescale
minor versions — safer for occasional backups than a raw volume copy):

```sh
docker compose exec timescaledb pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > homecsi-$(date +%F).dump
```

Store the resulting `.dump` file off the VPS (e.g. synced to another
machine or object storage) — a backup that lives only on the same disk as
the thing it backs up doesn't survive a disk failure.

**Restoring:**

```sh
docker compose up -d timescaledb
# wait for it to be healthy, then:
cat homecsi-2026-01-01.dump | docker compose exec -T timescaledb \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists
docker compose up -d migrate ingest api caddy
```

Run `migrate` after a restore in case the dump predates a schema migration
that has since landed.

**Volume-level backup** (faster, but ties you to matching Postgres/Timescale
versions on restore — only use if you understand that constraint):

```sh
docker compose stop timescaledb
docker run --rm -v ops_timescaledb_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/timescaledb_data-$(date +%F).tar.gz -C /data .
docker compose start timescaledb
```

## Disk management

Three layers keep the disk from filling, in order of what enforces them:

1. **TimescaleDB compression + retention policies** (enforcement code owned
   by sibling brief B3, likely exposed via the `prune` CLI subcommand and/or
   Timescale's native compression/retention jobs). This is the primary,
   automatic mechanism for the database itself: older, compressible chunks
   get compressed in place, and data past the retention window is dropped.
   **This document covers the operator-facing side only** — configuring
   *what* the retention window and compression policy actually are is
   sibling brief B3's territory; check `docs/architecture.md` or the
   server's config schema for the actual policy knobs once defined.
2. **Raw capture rotation** — `HOMECSI_DATA_DIR/captures` is written
   continuously by `ingest`; it needs its own rotation/pruning independent
   of the database (raw captures are files on disk, not DB rows). Whatever
   the `prune` subcommand's scope is, confirm it also covers this directory
   — if it only prunes DB rows, you need a separate rotation (e.g. a cron
   job deleting capture files older than N days) until that's covered.
3. **A total disk budget** — decide up front how much of the VPS's disk
   Home CSI is allowed to use (e.g. "80% of the volume, leaving headroom for
   OS/Docker/logs"), and size the retention window and capture rotation
   policy to fit under it given your node count's write rate (~110 kbps at
   4 nodes, ~600 kbps at 9 — multiply by seconds-per-day and your retention
   window in days to estimate raw ingest volume before compression).

**Checking current usage:**

```sh
df -h /srv/homecsi/data                 # or wherever HOMECSI_DATA_DIR is
docker system df -v                     # Docker volumes, including timescaledb_data
docker compose exec timescaledb \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT hypertable_name, pg_size_pretty(hypertable_size(format('%I.%I', hypertable_schema, hypertable_name)::regclass)) FROM timescaledb_information.hypertables;"
```

**Tuning the budget:** once B3's compression/retention config knobs are
documented, tighten or loosen the retention window based on the `df -h`
trend over the first few weeks of real traffic rather than guessing up
front — actual CSI record size in practice will vary by how much motion
(and therefore how many `CSI_BATCH` records) the deployment actually sees.

## Log management

Two independent log surfaces, both need limits:

1. **Docker container logs** (stdout/stderr captured by the `json-file`
   driver) — configured directly in `ops/docker-compose.yml` via the
   `x-logging` anchor applied to every service:
   ```yaml
   logging:
     driver: json-file
     options:
       max-size: "10m"
       max-file: "5"
   ```
   This caps each service to 50 MB of retained log (5 files × 10 MB,
   rotated). This is a commonly missed leak — without it, a chatty or
   crash-looping container's logs grow unbounded on the host disk.
2. **Application logs** written into `HOMECSI_DATA_DIR/logs` (if/when the
   server writes files there in addition to stdout) — subject to the same
   disk-budget reasoning as "Disk management" above; check the server's
   logging config for its own rotation settings once documented, and fold
   its retained size into your total disk budget estimate.

For the non-Docker/systemd path, the equivalent limit is journald's global
`SystemMaxUse`/`SystemMaxFileSize` — see `ops/systemd/README.md`.

## Upgrades and rollback

```sh
git pull
cd ops
docker compose build                    # rebuild the server image
docker compose run --rm migrate         # apply any new migrations
docker compose up -d                    # recreate ingest/api/caddy with the new image
```

**Rollback:** `git checkout <previous-tag-or-commit>` and repeat the same
sequence. Migrations are the risk here — if the previous version's schema
is incompatible with migrations already applied by the new version, a
straight rollback of the *code* won't undo a forward migration. Prefer
migrations that are additive/backward-compatible (a schema convention to
confirm with sibling brief B1/B3's migration tooling) and take a DB backup
(see above) immediately before any upgrade that includes a new migration,
so a bad migration can be restored from rather than reasoned about live.

## Monitoring and health checks

- `docker compose ps` — container-level health (the `timescaledb` service
  has a real `pg_isready` healthcheck; `ingest`/`api`/`caddy` rely on
  process liveness via `restart: unless-stopped`).
- `docker compose logs -f <service>` — tail logs per service.
- Node liveness: watch for `HEARTBEAT` messages per `node_id` in the
  ingest logs/metrics (`docs/protocol.md` §10) — a node that stops sending
  heartbeats has gone dark even if it's not sending CSI (e.g. an empty
  room), which is the intended way to detect a dead node versus an
  unoccupied one.
- The debug API/WebSocket (via `https://your.domain`, bearer-token
  protected) is the primary human-facing view — see `docs/architecture.md`
  for what it exposes.

## Troubleshooting

| Symptom | Likely cause(s) | Where to look |
|---|---|---|
| No data from a node at all | Node didn't associate to the AP; wrong `node_id`/PSK flashed; node can't reach the VPS (uplink/DNS/firewall) | `ops/ap-checklist.md` §9 (associated? reserved IP?); confirm the node's configured target host:port matches `HOMECSI_DOMAIN`/`HOMECSI_UDP_PORT`; `docker compose logs ingest` for any rejects logged against that `node_id` |
| Data from some nodes only | The missing nodes specifically failed AP association/isolation/channel settings, or have a bad PSK registered server-side | Re-check `ops/ap-checklist.md` for just the missing nodes' entries in the client list; confirm their `node_id` → key mapping server-side matches what was flashed |
| UDP arriving but AEAD failures (auth tag rejects) | Wrong/mismatched PSK for that `node_id`; a node re-provisioned without updating the server-side key; corrupted transit (rare, AEAD would still just reject) | `docker compose logs ingest` — should count AEAD failures per `node_id` (`docs/protocol.md` §5); compare the key flashed on the node against the server's node registry entry for that `node_id` |
| Clock skew | VPS clock not synced (see hardening's chrony step); node's SNTP not converged (`sntp_synced == 0`, `docs/protocol.md` §7) | `chronyc tracking` on the VPS; check `sntp_synced` in heartbeats/batches for the affected node — a node stuck at `sntp_synced == 0` has never completed an SNTP sync, which is a node-side network/DNS issue, not a server issue |
| Disk filling | Retention/compression not aggressive enough for current write rate; raw capture rotation not covering its directory | `df -h` and `docker system df -v` per "Disk management"; check whether `HOMECSI_DATA_DIR/captures` specifically is the growing part vs. the DB volume |
| TLS / certificate failures | DNS doesn't resolve to the VPS yet; ports 80/443 not reachable (firewall or Docker port publish issue); Let's Encrypt rate-limited from repeated failed attempts against the same domain | `docker compose logs caddy`; `dig +short $HOMECSI_DOMAIN`; confirm `ufw status` allows 80/tcp and 443/tcp; wait out Let's Encrypt's rate limit window if you see rate-limit errors in Caddy's log |
| WebSocket not upgrading | Something between the browser and `api` is stripping `Connection`/`Upgrade` headers — check nothing was added in front of the `Caddyfile`'s `reverse_proxy` block that would do this; confirm you're hitting the `https://` origin (not `http://`, and not the internal `api:8080` directly) | Browser dev tools network tab (expect `101 Switching Protocols`); `docker compose logs caddy`; re-check `ops/Caddyfile` hasn't been edited to add a proxy directive that drops upgrade headers |
| Firewall rate limit is eating ingest traffic (data arrives, then stalls or gets patchy under load, especially after adding nodes or during simultaneous reconnects) | The VPS's UDP rate limiter (`ops/hardening/harden.sh` section 3) is engaging — its ceiling is sized for the 9-node design envelope with headroom, but a busier-than-assumed deployment, a burst of simultaneous node reconnects, or a wrong (too-low) `HOMECSI_UDP_RATE_LIMIT_PER_SEC`/`_BURST` override can still trip it | On the VPS: `journalctl -k \| grep homecsi-udp-limit` or `dmesg \| grep homecsi-udp-limit` (fires when the limit engages, throttled to 1/min so it won't itself flood the log); `cat /proc/net/ipt_hashlimit/homecsi_udp` for live bucket state; `iptables -L ufw-before-input -v -n \| grep "$HOMECSI_UDP_PORT"` for cumulative drop counts. If it's genuinely engaging on legitimate traffic, raise `HOMECSI_UDP_RATE_LIMIT_PER_SEC`/`_BURST` in `ops/.env` and re-run `ops/hardening/harden.sh` (it updates the live rule in place) — see the arithmetic in the script's section 3 comments for how the defaults were derived and what headroom you're adjusting |

## Future: WireGuard VPN

v1 deliberately has no VPN — the UDP ingest port is exposed to the world and
relies on the protocol's own AEAD authentication (see
`ops/hardening/harden.sh`'s comments and `docs/protocol.md` §5 for why this
is an accepted trade-off, not an oversight). When WireGuard lands:

- **The UDP ingest port stops being world-exposed.** `ops/docker-compose.yml`
  would no longer publish `HOMECSI_UDP_PORT` to `0.0.0.0`; nodes would reach
  the VPS over the WireGuard tunnel's private address space instead, and
  the firewall rule allowing that port from the Internet
  (`ops/hardening/harden.sh`) would be removed or narrowed to the WireGuard
  interface only.
- **Per-node PSKs still matter and do not go away.** WireGuard secures the
  *transport* (node ↔ VPS network path); the ChaCha20-Poly1305 PSK secures
  the *application-layer* datagram itself and its replay-protection
  identity tuple. Removing the VPN's need doesn't remove the protocol's own
  AEAD requirement — the two are layered, not substitutes for each other.
- **Config keys that move:** each node gains a WireGuard keypair/peer
  config (in addition to its existing `node_id` + PSK); the server gains a
  WireGuard interface config and a peer entry per node. `HOMECSI_UDP_PORT`
  likely becomes an internal-only value (still used for the application
  protocol) rather than a publicly-dialed one; the public-facing port
  exposed by the firewall becomes WireGuard's own UDP port instead.

See `docs/roadmap.md` for when this is planned, if that document specifies
a timeline.
