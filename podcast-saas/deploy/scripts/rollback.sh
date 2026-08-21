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

# --- Move the TREE, not just the tag ----------------------------------------
#
# The images are versioned; docker-compose.yml is not. `compose up` reads the file from the
# working tree, so re-pointing APP_VERSION alone hands the OLD image the NEW file's environment —
# most dangerously WORKER_QUEUES, which grows a name every time a queue is added.
#
# That is not theoretical: an old worker given a queue name it has never heard of used to exit 1,
# and `restart: unless-stopped` turned that into a crash-loop of the only container that runs
# background work — during a rollback, which is to say during an incident. The code side of that
# is fixed too (resolveWorkerQueues now skips an unknown name), but the general problem is wider
# than one variable: any compose change since the target version is being applied to an image that
# predates it. Checking out the matching tree is the actual fix; the queue tolerance is the net.
#
# Best-effort ON PURPOSE. If the commit is not on this host, or the tree is dirty, we warn loudly
# and roll back anyway: a rollback that REFUSES TO RUN is worse than one applying a slightly newer
# compose file, and refusing here would mean an incident with no way back.
if git -C "${REPO_DIR}" rev-parse --verify --quiet "${TARGET}^{commit}" >/dev/null; then
  if git -C "${REPO_DIR}" checkout --detach "${TARGET}" >/dev/null 2>&1; then
    ok "Checked out tree ${TARGET} — compose file and image now come from the same commit."
  else
    warn "Could not check out ${TARGET} (dirty tree?). Rolling back with the CURRENT compose file."
    warn "Run 'git -C ${REPO_DIR} status --porcelain=v2' afterwards and reconcile."
  fi
else
  warn "Commit ${TARGET} is not present on this host. Rolling back with the CURRENT compose file."
fi

env_set APP_VERSION "${TARGET}"
export APP_VERSION="${TARGET}"

# NOTE ON MIGRATIONS: rollback restores CODE, not schema. Migrations are written to
# be additive/idempotent; a schema rollback (if ever needed) must be handled manually.
log "Recreating services on ${TARGET}…"
compose up -d "${APP_SERVICES[@]}"
compose exec -T nginx nginx -s reload 2>/dev/null || true

# `worker` BELONGS IN THIS LIST. It was omitted, and it is the service most likely to fail a
# rollback: it is the one whose configuration is version-coupled (WORKER_QUEUES), and it has no
# healthcheck, so a crash-looping worker shows as "restarting" — which wait_healthy correctly
# refuses. Without it here, a rollback that had killed all background processing reported success.
if wait_healthy "${HEALTH_TIMEOUT}" backend worker client-web admin-web nginx; then
  state_set CURRENT_VERSION "${TARGET}"
  ok "Rollback to ${TARGET} complete and healthy."
  echo
  compose ps
  exit 0
fi

die "Rollback to ${TARGET} did NOT become healthy. Manual intervention required: ./scripts/logs.sh backend"
