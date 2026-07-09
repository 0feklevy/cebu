# syntax=docker/dockerfile:1
#
# Backend image — used by BOTH the `backend` (web tier) and `worker` services.
# The only difference between them at runtime is the start command (see docker-compose.yml),
# so we build one image and share it.
#
# Build context is the REPO ROOT (see docker-compose.yml `context: ..`), because this is a
# pnpm monorepo and the backend depends on the `shared` workspace via `file:../shared`.

# ---------- builder ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Enable pnpm via corepack (version pinned by packageManager/lockfile).
RUN corepack enable

# Copy only manifests first so `pnpm install` is cached until a dependency changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY shared/package.json        shared/package.json
COPY backend-api/package.json   backend-api/package.json
COPY client-web/package.json    client-web/package.json
COPY admin-web/package.json     admin-web/package.json

# Install only the backend subgraph (backend-api + its workspace dep `shared`).
# `--frozen-lockfile` guarantees reproducible builds from pnpm-lock.yaml.
RUN pnpm install --frozen-lockfile --filter "backend-api..."

# Copy sources needed to build the backend and compile TypeScript -> dist/.
COPY shared/      shared/
COPY backend-api/ backend-api/
RUN pnpm --filter shared build \
 && pnpm --filter backend-api build \
 # tsc doesn't emit non-TS assets — copy raw SQL migrations next to the compiled runner.
 && mkdir -p backend-api/dist/db/migrations \
 && cp backend-api/src/db/migrations/*.sql backend-api/dist/db/migrations/

# ---------- runner ----------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# ffmpeg/ffprobe are required by the transcoding + captions pipeline.
# curl is used by the container HEALTHCHECK.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable

# Run as the built-in non-root `node` user.
COPY --from=builder --chown=node:node /app /app
USER node

WORKDIR /app/backend-api
EXPOSE 8080

# Default command runs the web tier. The worker service overrides this in compose.
CMD ["node", "dist/server.js"]
