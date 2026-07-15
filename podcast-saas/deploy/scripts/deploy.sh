#!/usr/bin/env bash
#
# deploy.sh — versioned, health-gated deployment with automatic rollback.
#
# Flow:
#   1. Pull the requested git ref (default: current branch) into the VM checkout.
#   2. Record the currently-running version as the rollback target.
#   3. Build images tagged with the NEW git short SHA (only changed layers rebuild;
#      compose only recreates services whose image actually changed).
#   4. Run DB migrations against external Supabase.
#   5. Recreate app + proxy containers, then poll health.
#   6. If health fails -> automatically roll back to the previous version.
#
# The previous version's images are retained on the host, so rollback needs no rebuild.
#
# Usage:
#   ./deploy.sh                 # deploy latest of the current branch
#   ./deploy.sh main            # deploy a branch
#   ./deploy.sh v1.4.0          # deploy a tag
#   ./deploy.sh 9f3a1c2         # deploy a specific commit
#   HEALTH_TIMEOUT=240 ./deploy.sh
#   NO_ROLLBACK=1 ./deploy.sh   # do not auto-rollback on failure (debugging)

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

REF="${1:-}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-240}"
APP_SERVICES=(backend worker client-web admin-web nginx)

require_env_file

# --- 0. Never run as root/sudo ----------------------------------------------
# Running via sudo makes the git checkout, deploy/.env and .deploy-state root-owned,
# which breaks every later non-root run ("git: dubious ownership"). provision.sh puts
# the ubuntu user in the docker group precisely so deploys run WITHOUT sudo.
if [ "$(id -u)" -eq 0 ]; then
  die "Do NOT run deploy.sh with sudo. Run it as the normal user. If docker needs sudo, your
shell hasn't picked up the docker group yet: run 'newgrp docker' (or log out/in) and retry.
If a previous sudo run left root-owned files: sudo chown -R \"\$(logname)\":\"\$(logname)\" \"${REPO_DIR}\""
fi
if ! docker info >/dev/null 2>&1; then
  die "Cannot reach the Docker daemon. If you just ran provision.sh, activate the docker group:
run 'newgrp docker' (or re-login) and retry — do NOT use sudo (it corrupts repo ownership)."
fi

# --- 1. Update source -------------------------------------------------------
cd "${REPO_DIR}"
command -v git >/dev/null || die "git not found on the VM."

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
TARGET_REF="${REF:-${CURRENT_BRANCH}}"

log "Fetching latest from origin…"
git fetch --all --tags --prune

log "Checking out '${TARGET_REF}'…"
git checkout "${TARGET_REF}"
# Fast-forward if we're on a branch (a detached tag/sha checkout has no upstream).
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  git pull --ff-only
fi

NEW_VERSION="$(git rev-parse --short HEAD)"
OLD_VERSION="$(env_get APP_VERSION)"
[ -n "${OLD_VERSION}" ] || OLD_VERSION="none"

log "Target ref : ${TARGET_REF}"
log "New version: ${NEW_VERSION}"
log "Prev version: ${OLD_VERSION}"

if [ "${NEW_VERSION}" = "${OLD_VERSION}" ] && [ "${FORCE:-0}" != "1" ]; then
  warn "Version ${NEW_VERSION} is already deployed. Set FORCE=1 to redeploy anyway."
fi

# --- 2. Record rollback target ---------------------------------------------
# Only overwrite PREVIOUS when we're actually moving to a different version, so a
# repeated/failed deploy never loses the last-known-good pointer.
if [ "${OLD_VERSION}" != "none" ] && [ "${OLD_VERSION}" != "${NEW_VERSION}" ]; then
  state_set PREVIOUS_VERSION "${OLD_VERSION}"
fi
state_set CURRENT_VERSION "${NEW_VERSION}"
state_set LAST_DEPLOY_REF "${TARGET_REF}"

# --- 2b. TLS certs must exist BEFORE we spend minutes building ----------------
# nginx references /etc/letsencrypt/live/<domain>/fullchain.pem and crash-loops without
# it, which would fail the health gate after a full build. Fail fast instead.
DOMAIN_ROOT="$(env_get DOMAIN_ROOT)"
if [ "${SKIP_CERT_CHECK:-0}" != "1" ]; then
  if compose run --rm --no-deps --entrypoint sh nginx \
        -c "test -s /etc/letsencrypt/live/${DOMAIN_ROOT}/fullchain.pem" >/dev/null 2>&1; then
    ok "TLS certificate present for ${DOMAIN_ROOT}."
  else
    die "No TLS certificate for ${DOMAIN_ROOT} — nginx would crash-loop after the build.
Run ./deploy/scripts/init-ssl.sh first. (Bypass this check with SKIP_CERT_CHECK=1.)"
  fi
fi

# --- 3. Build new images ----------------------------------------------------
env_set APP_VERSION "${NEW_VERSION}"
export APP_VERSION="${NEW_VERSION}"

# Memory guard — the Next.js builds are the OOM culprit. The earlier failure was
# "failed to execute bake: signal: killed" (kernel OOM). Ensure enough RAM+swap and
# size Node's build heap to fit. Swap itself is provisioned by provision.sh.
RAM_MB="$(free -m 2>/dev/null | awk '/^Mem:/{print $2}' || true)";  RAM_MB="${RAM_MB:-0}"
SWAP_MB="$(free -m 2>/dev/null | awk '/^Swap:/{print $2}' || true)"; SWAP_MB="${SWAP_MB:-0}"
BUDGET_MB=$(( RAM_MB + SWAP_MB ))
log "Build memory: RAM=${RAM_MB}MB, swap=${SWAP_MB}MB (budget ${BUDGET_MB}MB)"

if [ "${SWAP_MB}" -lt 512 ] && [ "${RAM_MB}" -lt 3000 ] && [ "${FORCE_LOWMEM:-0}" != "1" ]; then
  die "Low memory (${RAM_MB}MB RAM, ${SWAP_MB}MB swap) will OOM the build.
Run ./deploy/scripts/provision.sh to add swap (or add a 4G swapfile manually), then retry.
Override at your own risk with FORCE_LOWMEM=1."
fi

# Node heap ceiling for `next build`. next build forks ~1 worker/vCPU that each inherit
# NODE_OPTIONS, so keep the per-process ceiling comfortably under the budget: ~45% of
# budget, clamped to [1536, 4096] MB. Override with NODE_BUILD_MEMORY.
if [ -z "${NODE_BUILD_MEMORY:-}" ]; then
  NODE_BUILD_MEMORY=$(( BUDGET_MB * 45 / 100 ))
  [ "${NODE_BUILD_MEMORY}" -lt 1536 ] && NODE_BUILD_MEMORY=1536
  [ "${NODE_BUILD_MEMORY}" -gt 4096 ] && NODE_BUILD_MEMORY=4096
fi
export NODE_BUILD_MEMORY
log "next build heap ceiling: ${NODE_BUILD_MEMORY}MB"

# Warn (don't block) if the Docker data disk is tight — retained rollback images + build
# cache can exhaust a small root volume (ENOSPC mid-build).
DOCKER_FREE_GB="$(df -PBG /var/lib/docker 2>/dev/null | awk 'NR==2{gsub(/G/,"",$4); print $4}' || true)"
[ -n "${DOCKER_FREE_GB:-}" ] && [ "${DOCKER_FREE_GB}" -lt 5 ] && \
  warn "Only ${DOCKER_FREE_GB}G free for Docker — build may fail with 'no space left'. Use a >=30G root volume."

# Build SERIALLY by default so only one heavy pnpm-install / next-build runs at a time.
# Set BUILD_PARALLEL=1 on a large host to build all three concurrently via bake.
BUILD_TARGETS=(backend client-web admin-web)
if [ "${BUILD_PARALLEL:-0}" = "1" ]; then
  unset COMPOSE_BAKE   # let compose bake parallelize on a big host
  log "Building images for ${NEW_VERSION} in parallel (BUILD_PARALLEL=1)…"
  compose build "${BUILD_TARGETS[@]}"
else
  export COMPOSE_BAKE=false   # keep each `compose build <svc>` on the classic builder
  for svc in "${BUILD_TARGETS[@]}"; do
    log "Building ${svc} for ${NEW_VERSION} (serial; unchanged layers are cached)…"
    compose build "${svc}"
  done
fi

# --- 4. Database migrations (against external Supabase) --------------------
# DATABASE_URL comes from the root .env. Migrations are idempotent; running them
# before swapping app containers means a bad migration aborts the deploy with the
# old version still serving.
log "Running database migrations against Supabase…"
if ! compose run --rm --no-deps backend node dist/db/migrate.js; then
  die "Migrations failed — aborting BEFORE swapping app containers (old version still serving)."
fi
ok "Migrations applied."

# --- 5. Recreate app + proxy, then health-gate ------------------------------
log "Recreating application services…"
compose up -d "${APP_SERVICES[@]}" certbot

# nginx resolves upstreams per-request via Docker DNS, but nudge a reload so any
# cached upstream IPs from recreated containers are refreshed immediately.
compose exec -T nginx nginx -s reload 2>/dev/null || true

if wait_healthy "${HEALTH_TIMEOUT}" backend client-web admin-web nginx; then
  ok "Deployment ${NEW_VERSION} is healthy."
  # Free disk from dangling layers of prior builds (keeps tagged prev images).
  docker image prune -f >/dev/null 2>&1 || true
  log "Previous version ${OLD_VERSION} images retained for rollback."
  echo
  compose ps
  exit 0
fi

# --- 6. Failure handling ----------------------------------------------------
warn "Deployment ${NEW_VERSION} FAILED health checks."
if [ "${NO_ROLLBACK:-0}" = "1" ]; then
  warn "NO_ROLLBACK=1 set — leaving the failed deployment up for inspection."
  warn "Inspect with:  ./scripts/logs.sh backend   |   compose ps"
  exit 1
fi

PREV="$(state_get PREVIOUS_VERSION)"
if [ -z "${PREV}" ] || [ "${PREV}" = "none" ]; then
  die "No previous version to roll back to. Fix forward or investigate: ./scripts/logs.sh backend"
fi

warn "Auto-rolling back to ${PREV}…"
exec "${SCRIPT_DIR}/rollback.sh" "${PREV}"
