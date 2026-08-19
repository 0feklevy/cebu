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
# `unzip` MUST be installed before the @puppeteer/browsers step: CfT ships linux64
# chrome-headless-shell as a .zip, and the extractor shells out to `unzip` (yauzl is not a
# dependency here). bookworm-slim carries neither, which fails the build with
# "Extraction failed: no zip archiver is available" — the v0.1.20 production incident.
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# @puppeteer/browsers resolves the exact build and verifies it against the Chrome-for-Testing hash.
# The binary is asserted IN PLACE inside its CfT distribution directory — never symlinked or copied
# out of it in this stage. The distribution siblings (icudtl.dat, *.pak, v8_context_snapshot.bin,
# locales/, libEGL/libGLESv2) are load-bearing: Chrome resolves them relative to the executable, and
# a standalone copy of the binary dies at startup with "Invalid file descriptor to ICU data
# received." (exit 133) — the v0.1.21 production incident.
RUN npx --yes @puppeteer/browsers install "chrome-headless-shell@${CHROME_HEADLESS_SHELL_VERSION}" --path /opt/chrome \
 && BIN="$(find /opt/chrome -type f -name chrome-headless-shell | head -n1)" \
 && test -x "$BIN" \
 && test -f "$(dirname "$BIN")/icudtl.dat"

# ---------- runner ----------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Chrome's runtime shared libraries (headless still needs the graphics/ipc/font stack) + fonts so
# generated sims render text/emoji deterministically.
#
# The three glvnd packages (libglvnd0/libegl1/libglx0) exist for HARDWARE capture: the NVIDIA
# driver's Vulkan ICD (libGLX_nvidia, injected by the container toolkit when a GPU is granted)
# fails its internal init without the glvnd dispatch libraries, and the failure is maximally
# quiet — the Vulkan loader reports "no drivers" and Chrome falls to NO WebGL context at all.
# Bisected on the real Tesla T4 host: with these three, the full cage reports
# "ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA Tesla T4))"; without them, nothing does. They are inert
# in SwiftShader mode (a few hundred KB, no daemon, no setuid), so one image serves both profiles. NO chrome-sandbox setuid binary is installed:
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
      libglvnd0 libegl1 libglx0 \
      fonts-liberation fonts-noto-core fonts-noto-color-emoji fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

# The pinned browser + the compiled backend. ONLY the complete /opt/chrome tree is copied: a COPY
# of the convenience symlink dereferences it into a standalone 188 MB binary stripped of its CfT
# distribution siblings (icudtl.dat, .pak resources, v8 snapshot, locales/, libEGL/libGLESv2), and
# that binary dies with "Invalid file descriptor to ICU data received." / exit 133 (v0.1.21).
COPY --from=chrome /opt/chrome        /opt/chrome
COPY --from=builder /app              /app

# Recreate the stable path IN THIS stage as a symlink INTO the distribution directory, and assert
# the runtime files it depends on travelled with it. `test -x` follows the link, so a dangling
# link (extraction drift, renamed layout) fails the build here, not at first capture.
RUN BIN="$(find /opt/chrome -type f -name chrome-headless-shell | head -n1)" \
 && test -x "$BIN" \
 && test -f "$(dirname "$BIN")/icudtl.dat" \
 && ln -s "$BIN" /opt/chrome-headless-shell \
 && test -x /opt/chrome-headless-shell

ARG CHROME_HEADLESS_SHELL_VERSION
# Recorded into every capture result so "why do these two exports differ?" stays answerable.
ENV CHROME_HEADLESS_SHELL_VERSION=${CHROME_HEADLESS_SHELL_VERSION}
ENV CHROME_HEADLESS_SHELL_PATH=/opt/chrome-headless-shell
# The isolation entrypoint dynamically imports the browser backend named here (kept out of the image
# build so the two halves stay decoupled). The sibling ships the begin-frame backend at this path.
ENV EXPORT_CAPTURE_BACKEND_MODULE=/app/backend-api/dist/services/export/capture/beginFrameBackend.js
ENV EXPORT_CAPTURE_DPR=1
# Point HOME/XDG caches below /tmp — the ONE writable surface (the runtime tmpfs). With a read-only
# rootfs, fontconfig otherwise probes /var/cache/fontconfig and $HOME/.cache and logs "No writable
# cache directories" on every launch (non-fatal, but noise that buries real failures). No extra
# mount is added; fontconfig creates these under the tmpfs on demand.
ENV HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config

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
