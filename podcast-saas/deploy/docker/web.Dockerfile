# syntax=docker/dockerfile:1
#
# Shared Next.js image for the two frontends. Pick which app to build with:
#   --build-arg APP=client-web   (or admin-web)
#
# NEXT_PUBLIC_* values are baked in at BUILD TIME (Next.js inlines them into the
# client bundle), so they must be passed as build args — changing them requires a rebuild.
#
# Build context is the REPO ROOT (pnpm monorepo; frontends depend on `shared`).

# ---------- builder ----------
FROM node:22-bookworm-slim AS builder
ARG APP
WORKDIR /app
RUN corepack enable

# Manifests first for cached installs.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY shared/package.json        shared/package.json
COPY backend-api/package.json   backend-api/package.json
COPY client-web/package.json    client-web/package.json
COPY admin-web/package.json     admin-web/package.json

RUN pnpm install --frozen-lockfile --filter "${APP}..."

# Public (build-time) config — inlined into the browser bundle.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
ARG NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
ARG NEXT_PUBLIC_FIREBASE_APP_ID
ARG PUBLIC_BRAND_NAME
ARG PUBLIC_SITE_URL
# Give `next build` explicit heap headroom so it isn't JS-heap-OOM'd on small VMs
# (backed by swap from provision.sh). deploy.sh sizes this to RAM+swap and passes it via
# the compose build arg; the 2048 default is safe on a bare 2 GB VM. next build forks
# ~1 worker/vCPU that each inherit this, so keep it modest relative to RAM+swap.
ARG NODE_BUILD_MEMORY=2048
ENV NODE_OPTIONS=--max-old-space-size=${NODE_BUILD_MEMORY} \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID \
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=$NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET \
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=$NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID \
    NEXT_PUBLIC_FIREBASE_APP_ID=$NEXT_PUBLIC_FIREBASE_APP_ID \
    PUBLIC_BRAND_NAME=$PUBLIC_BRAND_NAME \
    PUBLIC_SITE_URL=$PUBLIC_SITE_URL \
    NEXT_TELEMETRY_DISABLED=1

COPY shared/  shared/
COPY ${APP}/  ${APP}/
RUN pnpm --filter shared build \
 && pnpm --filter "${APP}" build

# ---------- runner ----------
FROM node:22-bookworm-slim AS runner
ARG APP
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    APP_DIR=/app/${APP}
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

COPY --from=builder --chown=node:node /app /app
USER node

WORKDIR /app/${APP}
EXPOSE 3000

# `next start` honours the PORT env var. WORKDIR is fixed at build time via APP.
CMD ["pnpm", "start"]
