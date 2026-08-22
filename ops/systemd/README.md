# Running Home CSI under systemd (non-Docker path)

This is an alternative to `ops/docker-compose.yml` for operators who do not
want Docker on the VPS. It runs the built server directly with Node under
systemd. **Linux-only.** You still need Postgres/TimescaleDB running
somewhere reachable (either installed natively via the distro's
`timescaledb-2-postgresql-*` packages, or in its own standalone Docker
container if you want Docker for just that piece) — these unit files only
cover the `ingest` and `api` (serve) processes, matching the `ingest` and
`api` services in the Docker compose path.

Migrations (`node packages/cli/dist/cli.js migrate`) are a one-shot command
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

3. **`EnvironmentFile`.** Both unit files load
   `/etc/homecsi/homecsi.env` — a plain `KEY=value` file, not sourced by a
   shell, so no quoting/expansion. Create it from the same variables as
   `ops/.env.example` (the `HOMECSI_*` ones; skip the Docker/Compose-only
   ones like `HOMECSI_IMAGE_TAG`), plus the Postgres connection details
   pointing at wherever Postgres actually runs in this setup:

   ```sh
   sudo mkdir -p /etc/homecsi
   sudo tee /etc/homecsi/homecsi.env > /dev/null <<'EOF'
   NODE_ENV=production
   HOMECSI_DB_HOST=127.0.0.1
   HOMECSI_DB_PORT=5432
   HOMECSI_DB_NAME=homecsi
   HOMECSI_DB_USER=homecsi
   HOMECSI_DB_PASSWORD=changeme-generate-a-real-secret
   HOMECSI_UDP_PORT=5566
   HOMECSI_HTTP_PORT=8080
   HOMECSI_API_TOKEN=changeme-generate-a-real-secret
   HOMECSI_DATA_DIR=/srv/homecsi/data
   HOMECSI_LOG_LEVEL=info
   EOF
   sudo chown root:homecsi /etc/homecsi/homecsi.env
   sudo chmod 640 /etc/homecsi/homecsi.env
   ```

   Keep this file out of git — it holds the same secrets as `ops/.env`.

4. **Install and enable the units:**

   ```sh
   sudo cp ops/systemd/homecsi-ingest.service ops/systemd/homecsi-api.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now homecsi-ingest homecsi-api
   ```

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
whatever `HOMECSI_HTTP_PORT` you set above), since there's no Docker network
DNS to resolve the `api` service name in this path.

## Firewall / hardening

`ops/hardening/harden.sh` applies regardless of whether you run Docker or
systemd — its firewall rules, fail2ban, NTP, and UDP rate-limiting sections
are process-manager-agnostic. Skip only the Docker-specific
`DOCKER-USER` mitigation section if you have no Docker installed at all on
this host.
