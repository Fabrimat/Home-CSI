# Running Home CSI under systemd (non-Docker path)

This is an alternative to `ops/docker-compose.yml` for operators who do not
want Docker on the VPS. It runs the built server directly with Node under
systemd. **Linux-only.** You still need Postgres/TimescaleDB running
somewhere reachable (either installed natively via the distro's
`timescaledb-2-postgresql-*` packages, or in its own standalone Docker
container if you want Docker for just that piece) — these unit files only
cover the `ingest` and `api` (serve) processes, matching the `ingest` and
`api` services in the Docker compose path.

Migrations (`node packages/cli/dist/index.js migrate`) are a one-shot command
in this path too — run it manually (or from a deploy script) after each
build/upgrade, before (re)starting the `homecsi-ingest`/`homecsi-api`
services. There is no unit file for it because "run once, then exit
successfully" doesn't map cleanly onto a long-running service without extra
`Type=oneshot` orchestration that would need to be sequenced against the two
long-running units anyway — simplest to run it as an explicit step in your
deploy procedure (see `docs/deployment.md`).

## One-time setup

1. **Dedicated non-login user.** Never run the server as root or as your
   personal login user:

   ```sh
   sudo useradd --system --create-home --home-dir /opt/homecsi \
     --shell /usr/sbin/nologin homecsi
   sudo mkdir -p /srv/homecsi/data/{captures,logs,db}
   sudo chown -R homecsi:homecsi /opt/homecsi /srv/homecsi/data
   ```

2. **Deploy the built server** to `/opt/homecsi/server` (adjust
   `WorkingDirectory` in the unit files if you use a different path):

   ```sh
   sudo -u homecsi git clone <repo-url> /opt/homecsi/repo   # or rsync a release
   cd /opt/homecsi/repo/server
   sudo -u homecsi npm ci
   sudo -u homecsi npm run build
   sudo ln -s /opt/homecsi/repo/server /opt/homecsi/server
   ```

3. **`config.yaml`.** Just like the Docker path (see
   `ops/config.production.example.yaml`), there is no environment-variable
   override for the per-node PSK registry or the application log file
   path (see `server/packages/config/src/env.ts`) — a real config file is
   mandatory regardless of what you put in step 4's env file. Copy the
   same template used by the Docker path (its `server.udp/http` bind
   addresses and `storage/logging` paths are container-specific, but the
   `nodes:` PSK registry section is identical either way) and point it at
   a real path outside `/opt/homecsi/server` — that directory gets
   replaced wholesale on every deploy (`git pull` / rsync), so keeping
   secrets inside it risks either losing them on redeploy or accidentally
   including them in a release artifact:

   ```sh
   sudo mkdir -p /etc/homecsi
   sudo cp /opt/homecsi/repo/ops/config.production.example.yaml /etc/homecsi/config.yaml
   sudo "$EDITOR" /etc/homecsi/config.yaml   # fill in real per-node PSKs;
     # also change server.udp/http.host if 0.0.0.0 isn't right for this
     # host, storage.captureDir/logging.file.path to real filesystem paths
     # under /srv/homecsi/data (there is no /data mount here - that path
     # is Docker-path-specific), and database.host to wherever Postgres
     # actually runs (127.0.0.1 if it's a native/local install, or its
     # own address if it's a standalone Docker container per this file's
     # intro paragraph).
   sudo chown homecsi:homecsi /etc/homecsi/config.yaml
   sudo chmod 600 /etc/homecsi/config.yaml
   ```

4. **`EnvironmentFile`.** All unit files load
   `/etc/homecsi/homecsi.env` — a plain `KEY=value` file, not sourced by a
   shell, so no quoting/expansion. Names below are exactly the HOMECSI_*
   overrides `server/packages/config/src/env.ts` (`ENV_VAR_PATHS`) reads,
   plus `HOMECSI_CONFIG_PATH` (read by the CLI itself, pointing at the
   file from step 3, not by `applyEnvOverrides`) — this file's env block
   is checked against `ENV_VAR_PATHS` by the same drift test that checks
   `ops/docker-compose.yml`
   (`server/packages/config/src/opsEnvDrift.test.ts`), so a wrong name
   here fails `npm test` before it ever reaches a real VPS:

   ```sh
   sudo tee /etc/homecsi/homecsi.env > /dev/null <<'EOF'
   NODE_ENV=production
   HOMECSI_CONFIG_PATH=/etc/homecsi/config.yaml
   HOMECSI_DATABASE_HOST=127.0.0.1
   HOMECSI_DATABASE_PORT=5432
   HOMECSI_DATABASE_NAME=homecsi
   HOMECSI_DATABASE_USER=homecsi
   HOMECSI_DATABASE_PASSWORD=changeme-generate-a-real-secret
   HOMECSI_SERVER_UDP_PORT=5566
   HOMECSI_SERVER_HTTP_PORT=8080
   HOMECSI_SERVER_API_TOKEN=changeme-generate-a-real-secret
   HOMECSI_LOGGING_LEVEL=info
   EOF
   sudo chown root:homecsi /etc/homecsi/homecsi.env
   sudo chmod 640 /etc/homecsi/homecsi.env
   ```

   Keep this file out of git — it holds the same secrets as `ops/.env`.
   Unlike the Docker path, there is no separate `HOMECSI_DATA_DIR`
   variable here: `storage.captureDir` and `logging.file.path` in
   `config.yaml` (step 3) are already real filesystem paths on this host,
   not a `/data`-mount indirection, so nothing needs to translate one into
   the other.

5. **Install and enable the units:**

   ```sh
   sudo cp ops/systemd/homecsi-ingest.service ops/systemd/homecsi-api.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now homecsi-ingest homecsi-api
   ```

6. **Install and enable the training-set preservation timer.** Unlike
   `ingest`/`api`, this one is a one-shot (`Type=oneshot`) unit driven by a
   companion `.timer`, not a long-running service — enable the `.timer`,
   not the `.service`, so it runs on the schedule instead of once at boot.
   See `docs/deployment.md` "Scheduling the training-set preservation
   sweep" for why this needs to be scheduled at all:

   ```sh
   sudo cp ops/systemd/homecsi-label-preserve.service ops/systemd/homecsi-label-preserve.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now homecsi-label-preserve.timer
   # Verify it's scheduled, and run it once by hand to confirm it exits clean:
   systemctl list-timers homecsi-label-preserve.timer
   sudo systemctl start homecsi-label-preserve.service
   journalctl -u homecsi-label-preserve.service -n 50
   ```

7. **Install and enable the feature/occupancy pipeline timer.** Same
   one-shot-plus-`.timer` shape as step 6 — enable the `.timer`, not the
   `.service`. Without it `csi_records` accumulate and nothing ever computes
   `features` or `occupancy_states`, and because features are dropped by the
   7-day retention window (migration 007), every day the timer is not running
   becomes a permanent hole in the occupancy log:

   ```sh
   sudo cp ops/systemd/homecsi-pipeline.service ops/systemd/homecsi-pipeline.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now homecsi-pipeline.timer
   # Verify it's scheduled, and run it once by hand to confirm it exits clean:
   systemctl list-timers homecsi-pipeline.timer
   sudo systemctl start homecsi-pipeline.service
   journalctl -u homecsi-pipeline.service -n 50
   ```

   The unit runs `features` and then `occupancy` as two ordered `ExecStart=`
   lines, so a failing `features` aborts the run before `occupancy` sees a
   half-written window. Both resume from their own checkpoints, so a skipped
   or failed tick costs nothing beyond the delay.

## Restart policy

Both units use `Restart=on-failure` with `RestartSec=5` — they restart
automatically on a crash or non-zero exit, but not on a clean/intentional
stop (`systemctl stop`). This mirrors `restart: unless-stopped` in the
Docker compose path.

## journald log limits

Unlike the Docker path (where per-container `logging:` limits are set
directly in `ops/docker-compose.yml`), journald's storage limits are
configured globally, not per-unit. Set a global cap so a crash-looping or
chatty service can't fill `/var/log/journal`:

```sh
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/homecsi-limits.conf > /dev/null <<'EOF'
[Journal]
SystemMaxUse=500M
SystemMaxFileSize=50M
EOF
sudo systemctl restart systemd-journald
```

Adjust `SystemMaxUse` against your VPS's total disk budget — see
`docs/deployment.md` "Disk management" for how this fits into the overall
disk budget alongside Postgres and raw captures.

## Reverse proxy / TLS

This systemd path does not include Caddy. If you're avoiding Docker
entirely, install Caddy natively (`apt-get install caddy` from Caddy's own
apt repo, or download the binary) and point it at `ops/Caddyfile`'s
`reverse_proxy` target — replace `api:8080` with `127.0.0.1:8080` (or
whatever `HOMECSI_SERVER_HTTP_PORT` you set above), since there's no Docker
network DNS to resolve the `api` service name in this path.

## Backups

`ops/backup.sh` assumes the Docker compose path (it shells out to `docker
compose exec timescaledb pg_dump`) and does not apply here. On this path,
back up Postgres directly with `pg_dump` against wherever it runs (see step
3's `database.host`) and schedule it with a plain systemd timer of your
own, or your distro's native Postgres backup tooling if it has one. See
docs/deployment.md "Backup and restore" for the underlying `pg_dump`
command and what's/isn't worth backing up — only the `docker compose exec`
wrapping differs.

## Firewall / hardening

`ops/hardening/harden.sh` applies regardless of whether you run Docker or
systemd — its firewall rules, fail2ban, NTP, and UDP rate-limiting sections
are process-manager-agnostic. Skip only the Docker-specific
`DOCKER-USER` mitigation section if you have no Docker installed at all on
this host.
