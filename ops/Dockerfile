# Home CSI — multi-stage image for the Node/TypeScript server monorepo
# (server/, an npm workspaces monorepo per docs/architecture.md).
#
# Build context MUST be the repository root, not ops/ - see
# `build.context: ..` in ops/docker-compose.yml. This is required because npm
# workspaces need every workspace package.json visible under a common root
# to resolve internal (server/packages/*) dependencies during `npm ci`.
#
# IMPORTANT — .dockerignore location:
# Because the build context is the repo root, Docker's classic behavior would
# look for a file literally named `.dockerignore` at the *root* of that
# context (i.e. the repository root), not next to this Dockerfile. This repo
# does not have (and this brief does not own/create) a root-level
# .dockerignore. Instead, this build relies on BuildKit's per-Dockerfile
# ignore-file convention: a file named `<dockerfile-filename>.dockerignore`
# placed next to the Dockerfile - i.e. `ops/Dockerfile.dockerignore` - takes
# precedence over any root .dockerignore for builds using this Dockerfile.
# This requires BuildKit, which is the default for `docker build` / `docker
# compose build` on any reasonably current Docker Engine/Desktop (18.09+,
# enabled by default since ~2021 releases; force it with
# `DOCKER_BUILDKIT=1` on an older install if needed).
# See ops/Dockerfile.dockerignore for the actual excludes and why `server/`
# is never among them.
#
# server/ layout (verified against the actual monorepo, not assumed):
#   - server/package.json + server/package-lock.json define an npm
#     workspaces root (`"workspaces": ["packages/*"]`), with every member
#     package under server/packages/*.
#   - The root `npm run build` script is `tsc -b tsconfig.json && npm run
#     build --workspace=@homecsi/web` - it type-checks/compiles every
#     workspace via TS project references AND (the second half) runs
#     `@homecsi/web`'s own `tsc -b && vite build`, which is what actually
#     produces server/packages/web/ui-dist (the built debug UI static
#     assets @homecsi/api serves - see @homecsi/web's `getWebAssetsDir()`).
#     A plain `tsc -b` alone does NOT invoke Vite; if this `npm run build`
#     script is ever changed back to a bare `tsc -b`, the image will build
#     successfully but silently ship an API with no UI - see
#     server/packages/api/src/server.ts's "web assets directory does not
#     exist" fallback branch.
#   - The CLI entry point is server/packages/cli/dist/index.js. It is baked
#     into the exec-form ENTRYPOINT below, so a per-service `command:` in
#     ops/docker-compose.yml (and any `docker compose run` argument) must be
#     the BARE SUBCOMMAND only - e.g. `["serve"]`, not
#     `["node", "packages/cli/dist/index.js", "serve"]`. A compose `command:`
#     is appended to an exec-form ENTRYPOINT, never substituted for it, so
#     repeating the interpreter yields a doubled argv the CLI rejects.
#   - No config.yaml is baked into this image anywhere, deliberately - see
#     ops/docker-compose.yml's `x-config-volume` anchor and
#     ops/config.production.example.yaml. Config (including per-node PSKs)
#     is a runtime, host-provided, read-only bind mount, never an image
#     layer.
# If server/'s layout changes in a way that breaks one of the assumptions
# above, update the COPY paths / build invocation / ENTRYPOINT accordingly -
# the surrounding stage structure (deps -> build -> prod-deps -> runtime)
# should still apply.

# ---- deps: install full workspace dependencies (incl. dev, needed to build) ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./
COPY server/packages ./packages
RUN npm ci

# ---- build: compile TypeScript across all workspaces ----
FROM deps AS build
COPY server/. .
RUN npm run build

# ---- prod-deps: install production-only dependencies for the final image ----
FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./
COPY server/packages ./packages
RUN npm ci --omit=dev

# ---- runtime: slim final image ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Non-root user - defense in depth in case the process is ever compromised
# (this image handles Internet-facing UDP input per docs/protocol.md).
# UID/GID are pinned (rather than left to `useradd --system`'s
# next-available allocation) so operators can `chown` a bind-mounted
# host secret (ops/config.yaml) to a UID that is guaranteed to match this
# image's runtime user across rebuilds - see docs/deployment.md step 7 and
# ops/config.production.example.yaml, which both reference this exact
# UID/GID for the `chmod 600`/`chown` step. 10001 is arbitrary but fixed;
# picked comfortably above typical host-system UID ranges to avoid
# colliding with a real host account.
RUN groupadd --system --gid 10001 homecsi \
    && useradd --system --uid 10001 --gid homecsi --home-dir /app --shell /usr/sbin/nologin homecsi

# Production node_modules from prod-deps, then the compiled packages tree
# (source + dist) from the build stage layered on top. This is slightly
# larger than copying only dist/ would be, but is robust to any one
# package's dist/ layout changing without needing a Dockerfile edit -
# every package's dist/ is wherever its own tsconfig.json's `outDir` says,
# and copying the whole tree sidesteps needing to enumerate them here.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=build /app/packages ./packages

RUN mkdir -p /data && chown -R homecsi:homecsi /app /data
USER homecsi

VOLUME ["/data"]

# No EXPOSE here: ingest binds UDP, api binds HTTP, both are configured via
# HOMECSI_* env vars and actually published per-service in
# ops/docker-compose.yml, not baked into the image.

ENTRYPOINT ["node", "packages/cli/dist/index.js"]
# Default subcommand if none given; every service in docker-compose.yml
# overrides this via `command:`.
CMD ["doctor"]
