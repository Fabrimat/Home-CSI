# Deployment runbook

This is the end-to-end operator runbook for deploying Home CSI: a VPS, a
dedicated WiFi AP, and a handful of ESP32 nodes. It assumes the Docker path
(`ops/docker-compose.yml`) as primary; see `ops/systemd/README.md` for the
non-Docker alternative, and "Coolify (self-hosted PaaS)" below for a third
alternative if you already run Coolify — the operational *concepts*
throughout this doc (backup, disk management, key management,
troubleshooting) apply to all three, though some commands are
Docker-path-specific (`ops/backup.sh` in particular; the systemd README's
own "Backups" section has the non-Docker equivalent, and the Coolify
section below has that path's equivalents).

Related documents: `docs/protocol.md` (wire format), `docs/architecture.md`
(system design), `ops/ap-checklist.md` (AP configuration),
`ops/hardening/README.md` (VPS hardening detail).

The VPS-side steps are **Linux-only**. If you're working from the
Windows-on-ARM dev machine, everything up to "clone the repo" happens over
SSH into the VPS; editing `.env` and writing docs can happen locally.

## 1. Provision the VPS

1. Rent a small VPS. Debian 12 or Ubuntu 22.04+ recommended. See "VPS
   Sizing" below for recommendations based on your node count.
2. Note its public IPv4 (and IPv6 if you have it) address.
3. Confirm you can SSH in with a key before doing anything else.

### VPS Sizing

The ingest capacity (CSI records and heartbeats written per second) scales
with node count. Here are the measured per-node rates and derived disk
requirements:

**Ingest rates** (based on `csi_format = LLTF` ~128 B CSI per record; 7
records per UDP datagram; 10 Hz sounding rate per node):

| | 4 nodes | 9 nodes |
|---|---|---|
| Records/s per node | 30 (3 peers × 10 Hz) | 50 (capped; peers would give 80) |
| Records/s total | 120 | 450 |
| Rows/day (`csi_records` table) | 10.4 M | 38.9 M |
| Inbound bandwidth | 166 kbps | 621 kbps |
| Monthly transfer | 54 GB | 201 GB |

**Disk requirements** (with a 7-day debug/development retention window for
raw CSI, capture files, and extracted features):

- **4 nodes:** 11.1 GB `csi_records` + 9.1 GB captures + 1.6 GB `features` =
  21.8 GB data; +~15 GB for OS/Docker/logs; stay under 70% disk fill →
  **60 GB disk**.
- **9 nodes:** 41.8 GB `csi_records` + 34.0 GB captures + 9.3 GB `features`
  = 85.1 GB data; +~15 GB → **160 GB disk**.
- **Reference for other retention windows:** 3-day window (4 nodes → 40 GB
  disk, 9 nodes → 100 GB disk); 14-day window (4 nodes → 80 GB disk, 9
  nodes → 260 GB disk).

**Recommendation: Start with 80 GB disk.** This covers 4 nodes at a 14-day
debug window, or 9 nodes at 3-4 days. The retention window is a config
parameter (not a migration), so it can be traded against disk later.

**Other hardware requirements:**

- **Storage:** NVMe/SSD, not spinning disk. The workload is continuous
  inserts across three indexes plus TimescaleDB compression jobs. CPU is
  nearly idle by comparison (ingest does only ~17-64 AEAD opens/s); disk
  I/O is the limiting factor.
- **RAM:** At 9 nodes, **8 GB RAM is a requirement, not headroom.** The
  `chunk_time_interval` on `csi_records` is 1 hour (migration 002), so each
  hot chunk is ~570 MB. TimescaleDB works best when the active chunk fits
  within ~25% of RAM; with only 4 GB you exceed that and compression
  performance degrades. The only way to stay at 4 GB is to reduce
  `chunk_time_interval` to 30 minutes, which increases compression overhead
  and competes with ingest for I/O. Not recommended for 9 nodes — 8 GB is
  the practical minimum.
- **Swap:** 2 GB, even with ample RAM. Compression jobs are bursty and
  OOM-killing Postgres mid-compression is unpleasant; swap is cheap
  insurance.
- **Bandwidth quota:** ≥ 1 TB/month. At 9 nodes, 201 GB/month is 24×
  typical, but quota should comfortably cover peaks.
- **Disk fill:** Never plan above 70% full. Postgres needs free space for
  compression jobs, VACUUM, and `pg_dump`; filling beyond that risks
  operational incidents.

**One operational consequence worth noting:** occupancy state machine
output is kept indefinitely (costs ~3 MB/year at ~30 transitions/day), but
the raw CSI features that feed it have a 7-day retention window. If the
occupancy pipeline (brief B4) is down for more than 7 days, those features
age out unprocessed and leave a **permanent gap in the occupancy log** — a
span of time where no occupancy state was computed. Recovery after a long
outage requires manual backfill or re-running the pipeline against
replayed captures (if they're still on disk).

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
# /opt is root-owned on a fresh VPS - create the target directory and
# hand it to your own (non-root) user before cloning into it, or the
# clone itself fails with a permission error.
sudo mkdir -p /opt/homecsi
sudo chown "$(id -u):$(id -g)" /opt/homecsi
git clone <repo-url> /opt/homecsi
cd /opt/homecsi
```

## 5. Fill in `.env`

```sh
cp ops/.env.example ops/.env
```

Edit `ops/.env` and set real values for `POSTGRES_PASSWORD`,
`HOMECSI_SERVER_API_TOKEN`, `HOMECSI_DOMAIN`, `HOMECSI_ACME_EMAIL`, and
`HOMECSI_DATA_DIR`. See the comments in `ops/.env.example` for how to
generate strong secrets. **Never commit this file** — it's git-ignored,
keep it that way.

Then create and own that directory on the host:

```sh
sudo mkdir -p /srv/homecsi/data/{captures,logs,backups}
sudo chown -R 10001:10001 /srv/homecsi/data/captures /srv/homecsi/data/logs
```

(No `db` subdirectory — `timescaledb` stores its data in the named Docker
volume `timescaledb_data`, not a bind mount under `HOMECSI_DATA_DIR`; a
`db/` directory here would just sit empty.)

The `chown` matters, not just `mkdir`: `ingest`/`api`/`label-preserve`
all run as the fixed non-root UID `10001` (see `Dockerfile`), and
both `captures/` (`ingest` writes raw CSI shards there —
`server/packages/storage/src/captureWriter.ts`) and `logs/` (the
application log file — `server/packages/ingest/src/logger.ts`) need to
actually be writable by that UID. A root-owned, default-mode directory
from a plain `mkdir` looks fine until the container tries to create its
first file in it and gets `EACCES` — `ingest` then crash-loops at step 9.
`backups/` is intentionally left root-owned: `ops/backup.sh` (and its
systemd/cron scheduling) runs as root, not as the container's UID `10001`
— see "Backup and restore" below.

## 6. Generate per-node keys

See "Key management" below. Do this before the next step; you'll paste
these keys straight into `config.yaml`.

## 7. Fill in `config.yaml`

`.env` alone is not a complete deployment: the per-node PSK registry and
the application log file path have no environment-variable override (see
`server/packages/config/src/env.ts`), so a real config file is mandatory
regardless of anything set in `.env`.

```sh
cp ops/config.production.example.yaml ops/config.yaml
```

Edit `ops/config.yaml` and fill in the `nodes:` list with the keys from
step 6 — one entry per physical node, each with its own `id`, `name`,
`room`, and `psk` (base64), **never reusing a PSK across nodes** (see that
file's own header comment, and "Key management" below, for why reuse
breaks the wire protocol's nonce-uniqueness guarantee outright, not just
mildly). Leave `server.apiToken` and `database.password` as the
placeholders already in the template — those two come from `ops/.env`
instead (see the template's header for exactly which env vars). Then:

```sh
chmod 600 ops/config.yaml
sudo chown 10001:10001 ops/config.yaml
```

`600` because it now holds real key material; `10001:10001` because that
is the fixed, non-root UID/GID the root `Dockerfile` assigns its runtime user
(pinned specifically so this `chown` target is stable across image
rebuilds) — without it, the container cannot read a mode-600 file owned
by a different host UID. `chown` to a UID that isn't your own login user
requires `sudo` - a plain `chown` here fails with `EPERM` for a normal
operator, which would otherwise look like nothing happened (still your
own UID, still mode 600) right up until every CLI container fails to
read the file. `ops/config.yaml` is git-ignored (see repo-root
`.gitignore`); **never commit a filled-in copy, in any form.** One
consequence of the `chown`: editing this file again later (e.g. to add a
node) needs `sudo` too, since it is no longer owned by your login user.

`ops/docker-compose.yml` bind-mounts this file read-only into every
service that runs the CLI, at `/etc/homecsi/config.yaml`, and sets
`HOMECSI_CONFIG_PATH` accordingly — you do not need to do anything further
for the containers to find it.

## 8. Configure DNS

Point an A record (and AAAA, if the VPS has IPv6) for `HOMECSI_DOMAIN` at
the VPS's public IP. Confirm it resolves (`dig +short your.domain`) before
starting Caddy — Let's Encrypt issuance will fail (and can trigger rate
limits on repeated failure) against a domain that doesn't resolve yet.

## 9. Bring the stack up

```sh
cd ops
docker compose up -d
```

This builds the server image (see `Dockerfile`), starts `timescaledb`,
waits for it to report healthy, then runs `migrate` to completion before
`ingest`, `api`, and `label-preserve` start, then starts `caddy` last (it
waits for `api`'s own healthcheck, not merely for `api` to have started —
see "Monitoring and health checks" below).

## 10. Run migrations (if not already applied)

The `migrate` service already runs automatically as part of `up`. To
re-run migrations after a later upgrade without restarting everything:

```sh
docker compose run --rm migrate
```

(Not `docker compose exec migrate ...` — `migrate` is one-shot and exits
immediately after running; there is no running container left to `exec`
into. `run --rm` starts a fresh, disposable one.)

## 11. Verify the stack

```sh
docker compose ps                       # everything should be Up / healthy
docker compose logs -f api              # should show it listening
curl -I https://your.domain             # should return a TLS-terminated response via Caddy
docker compose logs migrate             # should show a clean, successful exit
```

## 12. Configure the AP

Follow `ops/ap-checklist.md` in full before powering on any node — several
of its settings (channel, isolation) are much easier to get right before
nodes are already associated and generating "why is this node missing"
confusion.

## 13. Provision and place the nodes

Flash each node's firmware with its `node_id`, its per-node PSK (see "Key
management"), and the ingest UDP target (`HOMECSI_DOMAIN`:`HOMECSI_UDP_PORT`
— or the VPS's IP:port if you prefer not to depend on DNS at the firmware
level). Register the same `node_id` → PSK mapping server-side (already
done in step 7's `config.yaml`, if you're following in order). Place nodes
physically, noting each one's room label to match `ops/ap-checklist.md`'s
MAC/IP table.

## 14. Confirm data is arriving

```sh
docker compose logs -f ingest
```

You should see accepted datagrams/heartbeats per `node_id` shortly after
each node powers on and associates to the AP. If not, see
"Troubleshooting" below.

---

## Coolify (self-hosted PaaS)

An alternative to steps 1–11 above for operators who already run
[Coolify](https://coolify.io/) and would rather deploy through it than run
`docker compose` by hand. This replaces the VPS-provisioning-through-DNS
steps (1–8) and "bring the stack up" (9–11); steps 12–14 (AP checklist,
node provisioning, confirming data arrives) are identical regardless of
how the server side is hosted, and everything from "Key management"
onward applies unchanged too. `ops/Caddyfile` and the vanilla compose file
are untouched by any of this and keep working exactly as documented above,
for anyone not using Coolify.

**Primary path: five separate Coolify resources** — two Applications
(`api`, `ingest`), a Database (TimescaleDB), and a scheduled task
(`label-preserve`). This is the path actually confirmed against a real
Coolify dashboard, on the Application/Dockerfile resource type
specifically — see the per-item labelling below. A one-resource
alternative using `ops/docker-compose.coolify.yml` also exists; see the
end of this section.

A labelling note before the detail: every **VERIFIED** claim below was
confirmed on a Coolify **Application** resource. Facts that are true about
this repo's own Dockerfile/CLI regardless of which Coolify resource type
reads them are called out as such, not mislabelled as Coolify facts.
Anything about a *different* Coolify feature (pre-deployment commands,
scheduled tasks, file mounts, shared volumes between two Applications) is
marked **ASSUMED** — plausible, not independently confirmed.

### 1. Application: `api`

Create a Coolify **Application** resource pointed at this repository:

- **Build Pack:** `Dockerfile`. **VERIFIED.**
- **Base Directory:** `/` (the repository root). **VERIFIED** — and
  confirmed alongside it: Coolify's Dockerfile build pack has **no
  separate "Dockerfile Location" field**; it looks for a Dockerfile at the
  root of Base Directory, full stop. That absence is exactly why the head
  moved the Dockerfile from `ops/Dockerfile` to the repository root — Base
  Directory has to be `/` for `npm ci` to see every `server/packages/*`
  workspace member, and there is no second field to separately point at a
  Dockerfile living somewhere else.
- **Ports Exposes:** `8080`. **VERIFIED** as a real, working field.
  Matches `HOMECSI_SERVER_HTTP_PORT` and the `/healthz` healthcheck
  (`server/packages/api/src/routes/health.ts`) — that specific value is a
  fact about this repo, not about Coolify.
- **Healthcheck: leave Coolify's defaults (path `/healthz`, port from Ports
  Exposes).** But know how it works, because its failure mode is badly
  misleading: Coolify runs the healthcheck as a shell command *inside* the
  container, shelling out to `curl` or `wget`. `node:20-bookworm-slim` ships
  neither, so on a stock Node image every deployment ends in

  ```
  Healthcheck logs: /bin/sh: 1: curl: not found
                    /bin/sh: 1: wget: not found | Return code: 1
  New container is not healthy, rolling back to the old container.
  ```

  with the application up and serving the entire time. From the outside it is
  indistinguishable from a crash-loop. This repo's `Dockerfile` therefore
  installs `curl` in the runtime stage for this one consumer, and CI asserts
  it is still there. Coolify does warn about it — several lines above the
  error it causes.

  Leave **Start Period** low - `20` seconds is enough. Raising it is a trap:
  Coolify does nothing at all until it expires, so if the container exits
  before then the healthcheck has nothing left to inspect and the deployment
  fails with `docker inspect ... Error: no such object` instead of the real
  reason. `docker-entrypoint.sh` keeps its own migrate retry window (20 s)
  deliberately shorter than this, for the same reason.
- **Start Command: there is no such field, and you do not need one.**
  **VERIFIED** the hard way: `PATCH /api/v1/applications/{uuid}` with
  `custom_start_command` is rejected outright by Coolify 4.3.10 —
  `{"custom_start_command":["This field is not allowed."]}`, HTTP 422 — and
  the dockerfile build pack's UI offers no equivalent. Coolify runs the built
  image as-is.

  That is what `docker-entrypoint.sh` is for. The image has **no `CMD`**; its
  entrypoint, given no arguments, runs `${HOMECSI_COMMAND:-serve}`. So the role
  is selected by an environment variable — which Coolify *can* set — and the
  default is the one an Application with a domain wants anyway. Leave
  `HOMECSI_COMMAND` unset here and this Application serves the dashboard and
  the device API. Set it to `ingest` on a second Application (section 3) and
  the same image becomes the UDP receiver.

  This matters more than it looks: it used to be `CMD ["doctor"]`, and the
  first real Coolify deploy of this project did exactly what that implies —
  built fine, ran diagnostics, exited 0, and crash-looped ten times until
  Coolify gave up at `max_restart_count`.
- **Environment variables:** set on this Application's own Environment
  Variables tab — see "Environment variables" below for the full list.
  Include `HOMECSI_CONFIG_PATH=/etc/homecsi/config.yaml` explicitly: the
  container's `WORKDIR` is `/app`, not wherever a config file mount lands,
  so the CLI needs the absolute path regardless of the mount destination.
- **Config file mount:** add a persistent file/storage entry — **ASSUMED**
  available under some "Storage"/"File Mount" name; the exact label was
  not independently confirmed — destination path
  `/etc/homecsi/config.yaml`, content = your filled-in copy of
  `ops/config.production.example.yaml` (same template, same instructions
  as step 7 of the runbook above; the `nodes:` PSK registry section is
  identical either way). This is deliberate, not a gap: the per-node PSK
  registry has no environment-variable override by design (see
  `server/packages/config/src/env.ts`), and encoding the whole file into
  one env var was rejected — it would mean re-encoding and re-pasting the
  entire YAML to rotate a single node's PSK, and it would put every node's
  raw key material into Coolify's own environment variable list in
  plaintext. A read-only file mount at this exact path is the same end
  state as the vanilla path's `x-config-volume` bind mount, needing zero
  new server-side code.
- **Pre-deployment command: leave it EMPTY.** Migrations run themselves, and a
  non-empty value here is actively harmful: Coolify runs it as
  `docker exec <container> sh -c '<your command>'`, which bypasses the image's
  ENTRYPOINT entirely. A bare subcommand therefore fails with
  `sh: 1: migrate: not found` - and it fails *silently* until the application
  first deploys successfully, because Coolify skips the step with "No running
  containers found" while there is no container to exec into. An earlier
  revision of this document told you to put `migrate` here; that was wrong. If
  you ever do need a pre-deployment command, spell out the full argv
  (`node packages/cli/dist/index.js migrate`).
  `docker-entrypoint.sh` runs `migrate` to completion before starting `serve`,
  but *only* on the no-arguments path — i.e. exactly the Coolify Application
  case, never the compose case, which keeps its own one-shot `migrate` service
  (`packages/db`'s migration runner takes no advisory lock, so two concurrent
  runs would race). It retries for up to 60 s, because the database is a
  separate Coolify resource with no `depends_on` to order this after it, and a
  hard failure on a cold start would burn one of the container's ten allowed
  restarts.

  This replaces what the compose file gets from `service_completed_successfully`
  on its `migrate` service: the property that has to hold is migrations
  completing before anything serves traffic against an unmigrated schema.
  Note that `ingest` does **not** auto-migrate — see section 3.
- **Domain/FQDN:** set it to your domain on this Application; Coolify
  terminates TLS itself. **VERIFIED** against a live 4.3.10 instance
  (`https://csi.larosa.work`): the field is the Application's own `fqdn`, the
  reverse proxy routes it to Ports Exposes (`8080`) with no extra config, and
  there is no ACME/Let's Encrypt step to run yourself.
  `HOMECSI_DOMAIN`/`HOMECSI_ACME_EMAIL` (the vanilla path's Caddy inputs) do
  not apply. Point the DNS record at the Coolify host *before* saving, or the
  certificate issuance fails and quietly retries.

### 2. Database: TimescaleDB, not plain Postgres

Create a separate database resource. **Use TimescaleDB, not Coolify's
stock Postgres** — this is a fact about this repo, not a Coolify setting:
the migrations in `server/packages/db` create hypertables, which plain
Postgres cannot run.

**VERIFIED** against a live 4.3.10 instance: Coolify's own "PostgreSQL"
resource type *does* accept an overridden image, so a standalone PostgreSQL
resource running `timescale/timescaledb:2.17.2-pg17` is all you need — no
generic/custom Docker-image resource, no compose file.

Pin the tag. `latest-pg17` is a moving target, and changing the major
Postgres version under an existing data directory does not fail gracefully:
Postgres refuses to start at all (*"database files are incompatible with
server"*) and the only way out is deleting the volume. Note this is
`pg17`, one major ahead of the `pg16` the compose path pins — pick one
per deployment and stay there.

What actually matters: the image, and the credentials
(`POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`, referenced by `api`'s
and `ingest`'s `HOMECSI_DATABASE_*` env vars — see "Environment variables"
below). Coolify's default user/database are both `postgres`; set
`HOMECSI_DATABASE_USER`/`HOMECSI_DATABASE_NAME` to match whatever you
actually created. Do not publish this resource's port to the Internet —
the two Applications reach it over Coolify's internal Docker network, where
the hostname is the database resource's UUID.

### 3. `ingest` cannot be a Coolify Application at all

**VERIFIED, and it is a hard stop:** Coolify's `ports_mappings` field cannot
express a UDP port. Its validation accepts `5566:5566` and rejects
`5566:5566/udp` outright:

```
PATCH /api/v1/applications/{uuid}  {"ports_mappings":"5566:5566/udp"}
-> 422  {"ports_mappings":["The ports mappings field format is invalid."]}
```

Coolify's HTTP reverse proxy is no help either - it only understands HTTP(S) -
so an Application can publish TCP or nothing. `ingest` receives UDP datagrams
(`docs/protocol.md`) and nothing else, which means an Application built from
this repo can never receive a single sounding no matter how it is configured.
The `HOMECSI_COMMAND=ingest` role selector in `docker-entrypoint.sh` works
fine; the port does not.

So `ingest` has to run somewhere that can express a UDP publish:

1. **A Coolify Docker Compose resource** - compose `ports:` supports `/udp`
   normally. `ops/docker-compose.coolify.yml` already declares the service.
   Keeps ingest inside Coolify's deploy-on-push model. Recommended.
2. **A host-level unit** (systemd + `docker run --network coolify -p
   5566:5566/udp ...`) reusing the image Coolify already built. Fewest
   Coolify unknowns, but ingest then falls outside Coolify's management and
   its image has to be updated by hand.

Whichever it is: **without a UDP publish every node transmits into a void.**
Datagrams arrive at a port nothing is listening on, ingest sees nothing, and
there is no error on either side pointing at why. Confirm the host firewall
allows inbound UDP on the port too - on the reference host that means a
`DOCKER-USER` rule, see "Restricting the dashboard to a Tailscale tailnet"
below for how that chain is used there.

`ingest` needs the same node PSK registry as `api`, to authenticate the
datagrams it receives. Rather than a second copy of that key material, the
compose file bind-mounts a neutral literal path that is a host-side symlink
to the file Coolify already manages for the `api` Application:

```sh
sudo mkdir -p /data/homecsi
sudo ln -sfn \
  /data/coolify/applications/<api-app-uuid>/etc/homecsi/config.yaml \
  /data/homecsi/config.yaml
```

The path has to be a literal: Coolify's compose parser rejects variable
substitution anywhere in a volume source (`Invalid volume source: contains
forbidden character '${'`, VERIFIED), and hardcoding one instance's
Application UUID into a repository file is worse than a symlink. One file,
one editor (the `api` resource's Storage tab), so the two roles cannot drift
onto different keys.

Two things to know about it. Docker bind-mounts the *file*, so the container
keeps the inode it started with - and Coolify replaces that file rather than
editing it on every `api` deploy, so **restart ingest after rotating a PSK**
or it keeps checking against the old registry silently. And if `api` is ever
recreated, repoint the symlink.

`ingest` deliberately does **not** auto-migrate - only the `serve` role does,
so the two never race.

That same compose resource also carries the **`pipeline`** service — the
feature/occupancy runner described under "Scheduling the feature/occupancy
pipeline" below. It is there for convenience, not for the UDP reason above:
this deployment path already has exactly one Coolify resource that runs a
compose file, and a shell-loop service needs one. It shares the resource's
environment variables and the same read-only `config.yaml` symlink, which
also means a restart of the `ingest` resource (after a PSK change, say)
restarts the pipeline too — harmless, since both commands resume from their
checkpoints.

### 4. `label-preserve` as a scheduled task, not a third Application

`label preserve` needs to run once a day; it is **not optional** — without
it, a label session left open (or whose own stop-path preservation attempt
failed) silently loses its raw per-link features once the 7-day `features`
retention window passes (migration 007; see `docs/architecture.md` "Data
lifecycle" and `ops/docker-compose.yml`'s own `label-preserve` service
comment, which makes the identical point for the compose path).

**ASSUMED, not independently confirmed:** that Coolify's scheduled-tasks
feature exists under that name and supports running a one-off command
inside an existing Application's container on a cron-like schedule. If it
does, point it at the `api` Application (or `ingest` — either has the
same image and the same DB credentials), running:

```sh
node packages/cli/dist/index.js label preserve
```

daily. If your Coolify version's scheduled-tasks feature does not fit this
shape, `ops/docker-compose.coolify.yml`'s `label-preserve` service (a
long-lived shell loop) is the fallback.

**Verify it ran** the same way as the compose/systemd paths: check for a
successful `label preserve` exit in whatever Coolify surfaces as that
task's run log/history.

### 5. Environment variables

Set these on each Application's own Environment Variables tab (not a
committed `.env` file — Coolify does not read `ops/.env.example`
directly). The names, defaults, and secret-generation guidance in
`ops/.env.example` apply unchanged; a few entries there (`HOMECSI_DOMAIN`,
`HOMECSI_ACME_EMAIL`, `HOMECSI_DATA_DIR`) are marked inline as vanilla-path
-only and have no Coolify equivalent — skip those three. Everything else
(`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`,
`HOMECSI_SERVER_API_TOKEN`, `HOMECSI_LOGGING_LEVEL`, and the new
`HOMECSI_OTA_FIRMWARE_DIR` — see "Publishing firmware images" below)
carries over directly onto both `api` and `ingest`. `HOMECSI_UDP_PORT`
from `ops/.env.example` is the compose path's own outer variable name for
`ops/hardening/harden.sh`'s firewall rule; here it is just the literal
`5566` in `ingest`'s port mapping above and its `HOMECSI_SERVER_UDP_PORT`
env var — there is no separate host-level firewall script on this path,
so the outer/inner name split does not apply.

One variable exists only on this path: **`HOMECSI_COMMAND`**, which picks the
CLI subcommand the container runs (`docker-entrypoint.sh`, section 1). Leave it
unset on `api`; set it to `ingest` on `ingest`. It has no compose equivalent —
there, each service's `command:` says the same thing more directly.

### 6. `/data`: shared between two Applications — the most fragile part of this topology

Both `api` and `ingest` need to read/write the same `/data` (captures,
logs, and the OTA firmware directory — `config.ota.firmwareDir`, default
`/data/firmware`). On a Docker Compose deployment this is one volume
mounted into multiple services *of the same compose project*, which
Docker handles natively. Here, `api` and `ingest` are two **separate
Coolify Applications**, each normally getting its own isolated storage —
sharing one volume between them means attaching the *same*
Coolify-managed volume to both.

**ASSUMED possible, not independently confirmed.** This is the single
weakest point in this whole topology: if your Coolify version does not
support attaching one volume to two different Applications, `ingest` and
`api` end up with two different, unsynchronized `/data` directories, and
OTA firmware staged via one is invisible to the other. If you hit this
limitation, the Docker Compose alternative at the end of this section (one
resource, one named volume, multiple services) sidesteps it entirely by
construction.

### Restricting the dashboard to a Tailscale tailnet

Goal: the dashboard and `/api/*` reachable only over a tailnet, while the UDP
ingest port and the ESP32s' `/device/*` endpoints stay open to the Internet.
The nodes cannot join a tailnet - they are ESP32s - so "all HTTP on the
tailnet" would also disable over-the-air updates. What follows splits the two.

**The finding that shapes everything else:** on a Coolify host the property
"tailnet only" cannot come from Traefik. `coolify-proxy` binds `0.0.0.0:80`
and `0.0.0.0:443`, so every hostname Traefik routes is reachable from the
public IP by anyone who sends the right `Host` header - including a name that
only resolves inside the tailnet. VERIFIED by adding a `*.ts.net` name as a
second FQDN and then reaching it from off-tailnet over cleartext HTTP:

```
curl -H 'Host: host.example-tailnet.ts.net' http://<public-ip>/healthz   -> 200
```

That binding is also why `tailscale serve --https=443` does nothing useful
here: traffic to the tailnet IP on :443 is answered by Traefik (with its
default self-signed certificate), not by tailscaled.

So the dashboard needs a port of its own that the kernel filters:

1. **Publish the container's HTTP port on a dedicated host port.** Ports
   Mappings `8082:8080`. Note Coolify cannot bind it to a single interface -
   `127.0.0.1:8082:8080` is rejected (422, "The ports mappings field format is
   invalid."), so it lands on `0.0.0.0` and step 2 is not optional.
2. **Drop it on the public interface.** The reference host already uses this
   idiom for Coolify's own port 8000, so follow it:

   ```sh
   sudo iptables -I DOCKER-USER -i ens160 -p tcp \
     -m conntrack --ctorigdstport 8082 --ctdir ORIGINAL -j DROP
   sudo netfilter-persistent save
   ```

   `--ctorigdstport` is load-bearing: DNAT runs before the filter table, so by
   the time a packet reaches `DOCKER-USER` its destination port is the
   *container's* (8080), not the published one. Matching `--dport 8082` there
   silently never fires; matching `--dport 8080` would also kill Traefik's own
   traffic to the container and break `/device/*`.
3. **Terminate TLS with Tailscale, on a port Traefik does not hold.**

   ```sh
   sudo tailscale serve --bg --https=8443 http://127.0.0.1:8082
   ```

   Tailscale supplies the certificate; there is nothing to renew. Not
   `tailscale funnel` - that publishes to the Internet, the opposite of this.
4. **Scope the public route to the devices.** Set the Application's FQDN to
   `https://csi.larosa.work/device` and turn Strip Prefix off
   (`{"is_stripprefix_enabled":false}`), or `/device/hello` arrives at the
   server as `/hello`. Coolify then generates exactly one rule pair:

   ```
   rule=Host(`csi.larosa.work`) && PathPrefix(`/device`)
   middlewares=gzip          # no stripprefix
   ```

Verified end state:

| request | public `csi.larosa.work` | tailnet `:8443` |
| --- | --- | --- |
| `/` (dashboard) | 503 | 200 |
| `/api/nodes` | 503 | 401 |
| `/device/hello` | 401 | 401 |
| `/device/ota/manifest` | 401 | 401 |
| host port 8082 | connection times out | n/a |

The 503s are Coolify's own catch-all (`/data/coolify/proxy/dynamic/`
`default_redirect_503.yaml`) for requests matching no router - not a stale
route, and not the application answering.

### 7. Publishing firmware images

`GET /device/ota/firmware` serves from `config.ota.firmwareDir` (default
`/data/firmware`, overridable via `HOMECSI_OTA_FIRMWARE_DIR` — see
`docs/device-api.md` for the full manifest/route contract; not repeated
here). There is no host bind mount to drop a file into under Coolify —
`/data` is a Coolify-managed volume, not an operator-chosen host path.

**The deliberate v1 answer:** copy the files into the running container's
volume directly, using `docker cp` against whichever container currently
has `/data` mounted (`api` or `ingest`):

```sh
docker cp manifest.json <api-container-name-or-id>:/data/firmware/manifest.json
docker cp homecsi-node-0.2.0.bin <api-container-name-or-id>:/data/firmware/homecsi-node-0.2.0.bin
```

No server restart is required — both device OTA routes read
`manifest.json` from disk on every request rather than caching it (see
`docs/device-api.md`), so the new rollout takes effect immediately. Find
the running container name/id via `docker ps` on the Coolify host, or
through Coolify's own UI/terminal-into-container feature if it exposes
one.

**This has a real limitation, stated plainly:** it requires direct
`docker`/shell access to the Coolify host, which is a step outside
Coolify's own deploy/redeploy workflow — there is no "upload a firmware
build" button anywhere in this v1. A future iteration could add a small
authenticated upload endpoint or wire firmware publishing into the deploy
pipeline itself; neither exists yet. For now, treat staging a new OTA
rollout under Coolify as a manual, `docker cp`-based operational step, not
something the dashboard or CLI does for you.

### Alternative: one Docker Compose resource

If you'd rather not manage five separate Coolify resources,
`ops/docker-compose.coolify.yml` runs the whole stack (`timescaledb`,
`migrate`, `ingest`, `api`, `label-preserve`) as a single Coolify "Docker
Compose" resource instead — one named volume shared cleanly across
services (sidestepping the `/data`-sharing concern in step 6 above), and
`migrate` gates the rest via `service_completed_successfully` rather than
a Coolify pre-deployment command.

**Read that file's own header comment before using it.** It is written to
be explicit about exactly this distinction: every genuinely **VERIFIED**
fact in this document (Build Pack, Base Directory, Ports Exposes, the
absence of a "Dockerfile Location" field) was confirmed on the Application
resource type described above, not on a Docker Compose resource — a
different part of Coolify's UI. Whether a Docker Compose resource exposes
the same per-service settings, and behaves identically to a plain
`docker compose up -d` for `depends_on`/healthchecks/one-shot jobs, is
**ASSUMED** and labelled as such throughout that file, not independently
confirmed. Everything else in this section (config file mount, UDP port
exposure, firmware publishing, environment variables) applies to this
alternative the same way, adjusted for one resource instead of five — the
file's header spells out the handful of genuine mechanical differences
(e.g. `/data` as a plain named volume instead of a host bind mount).

---

## Key management

- Each node has a **32-byte ChaCha20-Poly1305 pre-shared key**, unique per
  node (`docs/protocol.md` §5). Generate one per node:

  ```sh
  openssl rand -hex 32
  ```

- **Server side:** the key is registered in `ops/config.yaml`'s `nodes:`
  list (see step 7 above and `ops/config.production.example.yaml`), keyed
  by `node_id`, stored as base64. Treat that file with at least the same
  care as `ops/.env` — mode `600`, never committed, only the
  `.example.yaml` template is meant to be tracked.
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
- **Config and keys** — `ops/config.yaml` (server-side PSKs, `node_id`
  mapping) and `ops/.env`. Losing this means every currently-deployed node
  is unusable until you re-provision it with a fresh key on both ends.
  Neither is a database concern, so `ops/backup.sh` below does not cover
  them — back these two files up yourself the same way you'd back up any
  other secret (e.g. into whatever password manager/secrets store you
  already use off-VPS).

**Not worth backing up (or only loosely worth it):**
- **Raw capture files** on disk (`HOMECSI_DATA_DIR/captures`) — these are
  large, append-heavy, and "regenerable-ish": if a node is still deployed
  and running, it will simply keep producing new raw captures; only the
  historical window is lost, not the capability. Weigh the storage cost of
  backing these up against how much you'd actually replay them (see
  `replay` in the CLI) versus just accepting the gap.

**Backing up TimescaleDB:** run `ops/backup.sh` — it wraps the logical-dump
command below (portable across Postgres/Timescale minor versions, safer
for routine backups than a raw volume copy) with atomic-write and
retention-pruning behavior so you don't have to reproduce that yourself:

```sh
ops/backup.sh
```

Equivalent to (this is what the script actually runs):

```sh
docker compose exec -T timescaledb pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > homecsi-$(date +%F).dump
```

**Schedule it** so backups happen without anyone remembering to run the
command by hand — either a host crontab entry:

```sh
# sudo crontab -e  (root's crontab, NOT your own):
0 2 * * * /opt/homecsi/ops/backup.sh >> /var/log/homecsi-backup.log 2>&1
```

It has to be root's crontab, for the same ownership reason as step 5:
`/srv/homecsi/data/backups` is root-owned, so the same entry in an
unprivileged user's crontab fails to write the dump. That failure is at
least loud — a non-zero exit and an `EACCES` in the log above — but it
happens nightly and unattended, so it is worth getting right the first
time. The systemd timer below runs as root already.

or the equivalent systemd timer, if you'd rather manage scheduling that
way even on the Docker path:

```sh
sudo cp ops/systemd/homecsi-backup.service ops/systemd/homecsi-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now homecsi-backup.timer
```

**Verifying it ran:** `ls -lh /srv/homecsi/data/backups` (or wherever
`HOMECSI_DATA_DIR` points) should show a `homecsi-<timestamp>.dump` file
from the expected run, growing roughly with the database over time. A
failure looks like: the script exits non-zero (cron mails the output, or
`journalctl -u homecsi-backup.service` shows a non-zero exit and a
`pg_dump` error on the systemd path); no new `.dump` file appears for a
scheduled run; or a `.dump.tmp` file is left behind (the script only
`mv`s it into place on success, so a leftover `.tmp` means a run was
interrupted mid-dump). Treat any of these as an actionable alert, not
routine noise — same posture as the `label preserve` sweep below.

Store the resulting `.dump` files off the VPS too (e.g. synced to another
machine or object storage) — a backup that lives only on the same disk as
the thing it backs up doesn't survive a disk failure; `ops/backup.sh`
prunes its own local retention window but does not do this for you.

**Restoring:**

```sh
docker compose up -d timescaledb
# wait for it to be healthy, then:
cat homecsi-2026-01-01.dump | docker compose exec -T timescaledb \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists
docker compose up -d migrate ingest api caddy label-preserve
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
   policy to fit under it. See "VPS Sizing" above for your node count's
   measured ingest bandwidth and computed disk requirements; use those figures
   to estimate raw ingest volume before compression.

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

## Scheduling the feature/occupancy pipeline

`homecsi features` and `homecsi occupancy` are **one-shot commands, not
daemons**. Each resumes from a checkpoint it persisted on its last run
(`features` from the newest row per link, `occupancy` from
`occupancy_checkpoint`), processes whatever is new, and exits. Neither one
schedules itself, so a deployment that starts only `ingest` and `serve`
will happily fill `csi_records` while `features` and `occupancy_states`
stay permanently empty — with no error anywhere to suggest anything is
wrong.

That failure mode is not recoverable later. `features` and `csi_records`
live under the same 7-day retention window as everything else in the debug
tier (migration 007), so a day the pipeline did not run is a day whose raw
input is gone before anyone notices: it leaves a **permanent hole in the
occupancy log**, not a backlog to catch up on.

Every deployment path therefore ships a runner, and it is not optional:

| Path | What runs it |
|---|---|
| `ops/docker-compose.yml` | the `pipeline` service (long-lived shell loop, 60s) |
| `ops/docker-compose.coolify.yml` | the `pipeline` service, identical |
| `ops/docker-compose.ingest.yml` | the `pipeline` service, alongside `ingest` in the same Coolify resource |
| `ops/systemd/**` | `homecsi-pipeline.timer` → `homecsi-pipeline.service` |

**The two commands always run in this order, sequentially:** `occupancy`
consumes exactly what `features` just wrote. If `features` fails, that
tick's `occupancy` is skipped rather than fed a half-written window — the
shell loop does this with an `if`, the systemd unit with two ordered
`ExecStart=` lines (`Type=oneshot` stops at the first failure). Because
both are checkpointed and idempotent, a skipped tick costs only the delay.

**Why 60 seconds.** `features.hopMs` defaults to 500 ms and
`occupancy.hysteresisMs` to 30 s, so a one-minute cadence is fine enough
that the schedule is never what delays a state transition, and coarse
enough that each run has real work to do rather than paying connection
setup to find nothing.

**Verify it is actually running** — the honest check is row growth, not a
green checkmark, because the runner is deliberately silent on success:

```sh
# both counts must keep climbing while nodes are streaming
psql -c "select count(*) from features;  select count(*) from occupancy_states;"
# and the most recent state, with the links that drove it
psql -c "select time, estimate, state from occupancy_states order by time desc limit 5;"
```

If `csi_records` is growing and `features` is not, the runner is down —
check the `pipeline` container (`docker compose logs pipeline`) or
`systemctl list-timers homecsi-pipeline.timer`.

## Scheduling the training-set preservation sweep

`features` (and `csi_records`) are retained for only a **7-day debug
window** (migration 007, see `docs/architecture.md` "Data lifecycle").
Labelled sessions' raw per-link feature rows are copied out into
`training_features` before that happens — but that copy only runs when a
label session is actually stopped (from either the CLI or the web UI stop
button), so something also needs to run `homecsi label preserve`
periodically as a backstop for: sessions left open with no stop call at
all, a stop whose preservation attempt failed (CLI non-zero exit, or a web
UI response carrying `preservationWarning`), and simply as defense in
depth (see `docs/architecture.md`'s "Both stop paths trigger
preservation, independently" for what each path does and does not
guarantee on failure). Re-running it against sessions it already
preserved is a safe, cheap no-op — including for sessions old enough that
their `features` rows have since legitimately aged out (see
`docs/architecture.md`'s data-lifecycle note on why the sweep does not
alarm forever on those).

- **Docker path:** `ops/docker-compose.yml`'s `label-preserve` service
  runs this on a schedule automatically, as part of `docker compose up
  -d` — no separate cron/timer setup needed. It's a long-lived container
  using the same image as `ingest`/`api`, looping `label preserve` once a
  day (see the service's own comments for why a loop instead of `docker
  compose run` from a host cron job: the schedule lives in the stack
  itself, not in something an operator could forget to also set up).

  **Verify it ran:**
  ```sh
  docker compose logs label-preserve
  ```
  A healthy run logs `[label-preserve] running at <timestamp>` followed
  by `[label-preserve] ok at <timestamp>`. **A failure looks like:**
  `[label-preserve] FAILED (exit <n>) at <timestamp>` on stderr — grep for
  it directly:
  ```sh
  docker compose logs label-preserve | grep FAILED
  ```
  Any match is a non-zero `label preserve` exit and should be treated as
  an actionable alert, not routine noise — the CLI's own error output
  appears in the surrounding log lines.

  There is also no per-run timeout around the `label preserve` CLI call
  itself, so a hung database connection stalls the loop silently - it
  never reaches `sleep`, and no `FAILED` line is logged either, since the
  command never returns to report one. **The absence of a `running at`
  line for more than ~25h (the daily schedule plus margin) is itself the
  alert** for that case: `docker compose logs label-preserve --since 25h
  | grep 'running at'` coming back empty means the loop is stuck, not
  quiet.

- **systemd path:** install `ops/systemd/homecsi-label-preserve.service`
  and `.timer` (daily by default — see the timer file's `OnCalendar`) the
  same way as the other units in `ops/systemd/README.md`:

  ```sh
  sudo cp ops/systemd/homecsi-label-preserve.service ops/systemd/homecsi-label-preserve.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now homecsi-label-preserve.timer
  ```

  **Verify it ran:** `systemctl list-timers homecsi-label-preserve.timer`
  shows the last/next run; `journalctl -u homecsi-label-preserve.service
  -n 50` shows its output. **A failure looks like:** a non-zero exit
  status in `systemctl status homecsi-label-preserve.service` (`journalctl`
  shows the CLI's own error text) — `Restart=` does not apply to oneshot
  units triggered by a timer, so a failed run stays failed until the next
  scheduled attempt; check on it if you don't see a clean run in a while.

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

- `docker compose ps` — container-level health. `timescaledb` has a real
  `pg_isready` healthcheck; `api` has a real `/healthz`-based healthcheck
  (`server/packages/api/src/routes/health.ts` — reports both process
  liveness and DB reachability; `caddy`'s `depends_on: api` waits for this
  to report healthy, not merely for the container to have started, before
  it begins proxying/issuing TLS). `ingest` and `label-preserve` have no
  healthcheck by design: `ingest` is UDP-only with no request/response
  surface to honestly probe (see the comment on its compose service for
  why a fake one would be worse than none), and `label-preserve` is a
  scheduling loop, not a request-serving process — both rely on
  `restart: unless-stopped` for the "crashed, bring it back" case a
  healthcheck would otherwise cover.
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
