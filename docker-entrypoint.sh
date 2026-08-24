#!/bin/sh
# Container entrypoint for the Home CSI server image.
#
# WHY THIS EXISTS instead of a plain `ENTRYPOINT [...node cli] / CMD ["serve"]`:
# Coolify's dockerfile build pack cannot set a container's command at all - its
# API rejects `custom_start_command` with HTTP 422 ("This field is not
# allowed.", verified against a live 4.3.10 instance) and its UI has no such
# field. But this deployment needs TWO long-running roles from one image:
#
#   serve   HTTP dashboard + device API, behind Coolify's reverse proxy
#   ingest  UDP sounding receiver (docs/protocol.md), published directly on
#           the host - UDP does not traverse an HTTP reverse proxy
#
# so the role has to be selectable by something Coolify CAN set per resource:
# an environment variable. Hence:
#
#   no arguments     -> ${HOMECSI_COMMAND:-serve}, migrations first for serve
#   arguments given  -> run exactly those, untouched
#
# Compose is unaffected: every service in ops/docker-compose*.yml passes an
# explicit `command:` (migrate / ingest / serve), which arrives here as "$@"
# and wins over HOMECSI_COMMAND. Those files also keep their own one-shot
# `migrate` service, which is why the auto-migrate below is deliberately
# limited to the no-arguments path: running it from two containers at once
# would race, because packages/db's migration runner takes no advisory lock.
set -e

cli="packages/cli/dist/index.js"

if [ "$#" -eq 0 ]; then
  set -- "${HOMECSI_COMMAND:-serve}"

  if [ "$1" = serve ]; then
    # The database is a separate Coolify resource, so there is no `depends_on`
    # to order this after it - on a cold start of the whole stack Postgres may
    # not be accepting connections yet. Retry instead of exiting: every hard
    # failure here burns one of the container's ten Coolify restarts, and ten
    # lost cold-start races would leave the application stopped, needing a
    # manual redeploy to recover.
    attempt=1
    until node "$cli" migrate; do
      if [ "$attempt" -ge 30 ]; then
        echo "entrypoint: migrations still failing after $attempt attempts, giving up" >&2
        exit 1
      fi
      echo "entrypoint: migrate attempt $attempt failed, retrying in 2s" >&2
      attempt=$((attempt + 1))
      sleep 2
    done
  fi
fi

exec node "$cli" "$@"
