# syntax=docker/dockerfile:1
#
# Export-capture worker image (Linear Video Export — Phase 2, plan §0.2).
#
# This image runs UNTRUSTED code: the simulation HTML/JS is generated from user prompts and there is
# a ZIP-upload path, i.e. arbitrary JavaScript. Its entire security model is in
# md-files/EXPORT-CAPTURE-ISOLATION.md and enforced at `docker run` time by
# backend-api/src/services/export/capture/isolation/containerRunArgs.ts — NOT here. The Dockerfile's
# job is only to be a minimal, pinned, non-root, sandbox-capable base. The hardening flags
# (--network none, --read-only, --cap-drop ALL, quotas, no --no-sandbox) are applied by the caller,
# because a Dockerfile cannot express them and a compose file can be edited past them.
#
# NEW image — this does not modify backend.Dockerfile/web.Dockerfile. Build context is the REPO ROOT
# (pnpm monorepo; the worker depends on the `shared` workspace), same as backend.Dockerfile.
#
#   docker build -f deploy/docker/export-worker.Dockerfile \
#     --build-arg CHROME_HEADLESS_SHELL_VERSION=<a REAL published Chrome-for-Testing build ≥151> \
#     -t podcast-saas/export-worker:<tag> ..
#
# Pin CHROME_HEADLESS_SHELL_VERSION to a real build id from the Chrome-for-Testing known-good list
# (https://googlechromelabs.github.io/chrome-for-testing/). @puppeteer/browsers verifies the download
# against that channel's published hash, so the pin + the resulting image DIGEST are the reproducible
# renderer identity recorded in the export plan (RendererIdentity.imageDigest / headlessShellVersion).

# ---------- builder: compile the backend (incl. the isolation entrypoint) ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY shared/package.json        shared/package.json
COPY backend-api/package.json   backend-api/package.json
COPY client-web/package.json    client-web/package.json
COPY admin-web/package.json     admin-web/package.json

RUN pnpm install --frozen-lockfile --filter "backend-api..."

COPY shared/      shared/
COPY backend-api/ backend-api/
ARG NODE_BUILD_MEMORY=2048
ENV NODE_OPTIONS=--max-old-space-size=${NODE_BUILD_MEMORY}
RUN pnpm --filter shared build \
 && pnpm --filter backend-api build

# ---------- chrome: fetch a PINNED chrome-headless-shell, checksum-verified ----------
FROM node:22-bookworm-slim AS chrome
ARG CHROME_HEADLESS_SHELL_VERSION
RUN test -n "${CHROME_HEADLESS_SHELL_VERSION}" || (echo "ERROR: pin CHROME_HEADLESS_SHELL_VERSION to a real CfT build ≥151" && false)
# @puppeteer/browsers resolves the exact build and verifies it against the Chrome-for-Testing hash.
RUN npx --yes @puppeteer/browsers install "chrome-headless-shell@${CHROME_HEADLESS_SHELL_VERSION}" --path /opt/chrome \
 # Normalise the versioned install path to a stable location the runner references.
 && ln -s "$(find /opt/chrome -type f -name chrome-headless-shell | head -n1)" /opt/chrome-headless-shell

# ---------- runner ----------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Chrome's runtime shared libraries (headless still needs the graphics/ipc/font stack) + fonts so
# generated sims render text/emoji deterministically. NO chrome-sandbox setuid binary is installed:
# headless-shell uses the unprivileged USER-NAMESPACE sandbox, which needs no setuid helper — see the
# runbook's "Chrome's own sandbox, kept" section.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      libnss3 libnspr4 \
      libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
      libcups2 libdrm2 libgbm1 \
      libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxkbcommon0 \
      libpango-1.0-0 libcairo2 libasound2 \
      fonts-liberation fonts-noto-core fonts-noto-color-emoji fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

# The pinned browser + the compiled backend.
COPY --from=chrome /opt/chrome        /opt/chrome
COPY --from=chrome /opt/chrome-headless-shell /opt/chrome-headless-shell
COPY --from=builder /app              /app

ARG CHROME_HEADLESS_SHELL_VERSION
# Recorded into every capture result so "why do these two exports differ?" stays answerable.
ENV CHROME_HEADLESS_SHELL_VERSION=${CHROME_HEADLESS_SHELL_VERSION}
ENV CHROME_HEADLESS_SHELL_PATH=/opt/chrome-headless-shell
# The isolation entrypoint dynamically imports the browser backend named here (kept out of the image
# build so the two halves stay decoupled). The sibling ships the begin-frame backend at this path.
ENV EXPORT_CAPTURE_BACKEND_MODULE=/app/backend-api/dist/services/export/capture/beginFrameBackend.js
ENV EXPORT_CAPTURE_DPR=1

# A non-root, no-login user. The container is ALSO launched with `--user` (belt and braces); running
# non-root in the image means an operator who forgets the flag still does not get root.
RUN groupadd --system --gid 10001 capture \
 && useradd  --system --uid 10001 --gid 10001 --home-dir /home/capture --create-home capture
USER 10001:10001

WORKDIR /app/backend-api
# No EXPOSE, no ports: the ONLY server is the in-container loopback package server on 127.0.0.1, which
# is reachable only from inside the network namespace and is not published.
#
# Runtime contract (enforced by the caller's `docker run` args — see the runbook):
#   --network none  --read-only  --cap-drop ALL  (+ userns sandbox)  --security-opt no-new-privileges:true
#   --tmpfs /tmp:...  --mount /input:ro  --mount /output  --user 10001:10001
#   --cpus/--memory/--memory-swap/--pids-limit  --init  --stop-timeout
#   NEVER --no-sandbox, --privileged, --disable-gpu, --in-process-gpu, or any -e credential.
CMD ["node", "dist/services/export/capture/isolation/main.js"]
