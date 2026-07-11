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

# --- 3. Build new images ----------------------------------------------------
env_set APP_VERSION "${NEW_VERSION}"
export APP_VERSION="${NEW_VERSION}"

log "Building images for ${NEW_VERSION} (unchanged layers are cached)…"
compose build backend client-web admin-web

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
