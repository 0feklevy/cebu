#!/usr/bin/env bash
#
# rollback.sh — re-launch a previously built version WITHOUT rebuilding.
#
# Because deploy.sh tags images with the git short SHA and keeps the previous
# version's images on the host, rollback just re-points APP_VERSION at that tag
# and recreates the app containers.
#
# Usage:
#   ./rollback.sh            # roll back to PREVIOUS_VERSION recorded in .deploy-state
#   ./rollback.sh 9f3a1c2    # roll back to a specific version tag (must exist locally)

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

require_env_file

TARGET="${1:-$(state_get PREVIOUS_VERSION)}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
APP_SERVICES=(backend worker client-web admin-web nginx)

[ -n "${TARGET}" ] && [ "${TARGET}" != "none" ] || \
  die "No rollback target. Pass a version explicitly: ./rollback.sh <version>"

# Verify the images for that version actually exist on the host.
missing=0
for img in backend client-web admin-web; do
  if ! docker image inspect "podcast-saas/${img}:${TARGET}" >/dev/null 2>&1; then
    warn "Image podcast-saas/${img}:${TARGET} not found on host."
    missing=1
  fi
done
if [ "${missing}" -eq 1 ]; then
  die "Cannot roll back to ${TARGET}: images missing. List builds with: docker images 'podcast-saas/*'"
fi

CURRENT="$(env_get APP_VERSION)"
log "Rolling back: ${CURRENT} -> ${TARGET}"

env_set APP_VERSION "${TARGET}"
export APP_VERSION="${TARGET}"

# NOTE ON MIGRATIONS: rollback restores CODE, not schema. Migrations are written to
# be additive/idempotent; a schema rollback (if ever needed) must be handled manually.
log "Recreating services on ${TARGET}…"
compose up -d "${APP_SERVICES[@]}"
compose exec -T nginx nginx -s reload 2>/dev/null || true

if wait_healthy "${HEALTH_TIMEOUT}" backend client-web admin-web nginx; then
  state_set CURRENT_VERSION "${TARGET}"
  ok "Rollback to ${TARGET} complete and healthy."
  echo
  compose ps
  exit 0
fi

die "Rollback to ${TARGET} did NOT become healthy. Manual intervention required: ./scripts/logs.sh backend"
