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
# ASSUMPTION about server/ layout (server/ did not exist yet at the time this
# Dockerfile was written - it is being built in parallel by another brief):
#   - server/package.json + server/package-lock.json define an npm
#     workspaces root, with member packages under server/packages/*.
#   - A root `npm run build` script builds every workspace (e.g. via
#     `--workspaces` or TS project references) into each package's dist/.
#   - The CLI entry point is server/packages/cli/dist/index.js. It is baked
#     into the exec-form ENTRYPOINT below, so a per-service `command:` in
#     ops/docker-compose.yml (and any `docker compose run` argument) must be
#     the BARE SUBCOMMAND only - e.g. `["serve"]`, not
#     `["node", "packages/cli/dist/index.js", "serve"]`. A compose `command:`
#     is appended to an exec-form ENTRYPOINT, never substituted for it, so
#     repeating the interpreter yields a doubled argv the CLI rejects.
# If the real layout differs, update the COPY paths and the ENTRYPOINT below
# accordingly - the surrounding stage structure (deps -> build -> prod-deps
# -> runtime) should still apply.

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
RUN groupadd --system homecsi \
    && useradd --system --gid homecsi --home-dir /app --shell /usr/sbin/nologin homecsi

# Production node_modules from prod-deps, then the compiled packages tree
# (source + dist) from the build stage layered on top. This is slightly
# larger than copying only dist/ would be, but is layout-agnostic - safe
# given the ASSUMPTION above may not exactly match the final server/
# structure. Revisit once server/packages/*/dist paths are finalized.
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
