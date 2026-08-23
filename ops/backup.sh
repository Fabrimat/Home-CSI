#!/usr/bin/env bash
#
# Home CSI — TimescaleDB logical backup for the Docker compose deployment.
#
# What this does (see docs/deployment.md "Backup and restore" for the full
# reasoning behind what's/isn't worth backing up):
#   - Runs `pg_dump` (custom format, `-Fc`) INSIDE the running `timescaledb`
#     container via `docker compose exec`, writing the dump to a host
#     directory under HOMECSI_DATA_DIR.
#   - Deletes dumps older than HOMECSI_BACKUP_RETENTION_DAYS (default 14)
#     from that same directory, so this script's own output doesn't
#     silently become the next disk-fill problem.
#
# What this does NOT do: copy the resulting dump off the VPS. A backup that
# lives only on the same disk as the thing it backs up doesn't survive a
# disk failure - sync the backup directory to another machine or object
# storage yourself (rclone/rsync/etc - deliberately not picking one here,
# since "where else" is an operator decision this script can't make for
# you). See docs/deployment.md for that caveat spelled out in full.
#
# Assumes the Docker compose path specifically (shells out to `docker
# compose exec`) - see ops/systemd/README.md "Backups" for the non-Docker
# equivalent, which is a plain `pg_dump` with no compose wrapping.
#
# Usage:
#   ops/backup.sh
#   # or, scheduled (see docs/deployment.md "Backup and restore"):
#   0 2 * * * /opt/homecsi/ops/backup.sh >> /var/log/homecsi-backup.log 2>&1
#
# Exit non-zero on any failure (pg_dump failure, missing .env, etc) - a
# cron/systemd wrapper should treat that as an actionable alert, the same
# way docs/deployment.md already asks for `label preserve`'s sweep.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -f .env ]; then
  echo "[backup] ops/.env not found - copy ops/.env.example to ops/.env and fill it in first." >&2
  exit 1
fi

# Load POSTGRES_USER / POSTGRES_DB / HOMECSI_DATA_DIR from .env without
# executing it as a shell script (same "plain KEY=value" caution as the
# systemd EnvironmentFile convention) - `set -a`/`source` is fine here
# specifically because ops/.env is a file this repo's own tooling controls
# the format of (see ops/.env.example), not untrusted input.
set -a
# shellcheck disable=SC1091
source .env
set +a

: "${POSTGRES_USER:?POSTGRES_USER not set in ops/.env}"
: "${POSTGRES_DB:?POSTGRES_DB not set in ops/.env}"
: "${HOMECSI_DATA_DIR:?HOMECSI_DATA_DIR not set in ops/.env}"

RETENTION_DAYS="${HOMECSI_BACKUP_RETENTION_DAYS:-14}"
BACKUP_DIR="${HOMECSI_DATA_DIR}/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/homecsi-${STAMP}.dump"

log() { echo "[backup] $*"; }

mkdir -p "$BACKUP_DIR"

log "starting: ${POSTGRES_DB} -> ${OUT}"

# Write to a .tmp path first and `mv` into place atomically, so a crash or
# a `docker compose exec` failure mid-dump can never leave a
# truncated-but-plausible-looking .dump file for a later restore to trust.
if ! docker compose exec -T timescaledb pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > "${OUT}.tmp"; then
  echo "[backup] FAILED: pg_dump exited non-zero" >&2
  rm -f "${OUT}.tmp"
  exit 1
fi

mv "${OUT}.tmp" "$OUT"
chmod 600 "$OUT"
log "wrote $(du -h "$OUT" | cut -f1) to $OUT"

# Retention: delete our own dumps older than RETENTION_DAYS. Only ever
# touches files matching our own naming pattern, never a bare `rm -rf` of
# the whole directory, so an operator's own manually-placed files in the
# same directory are untouched.
DELETED=0
while IFS= read -r -d '' old; do
  rm -f "$old"
  log "pruned old backup: $old"
  DELETED=$((DELETED + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -name 'homecsi-*.dump' -mtime "+${RETENTION_DAYS}" -print0)

log "done (pruned ${DELETED} backup(s) older than ${RETENTION_DAYS} days)"
