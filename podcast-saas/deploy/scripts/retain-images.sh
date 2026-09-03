#!/usr/bin/env bash
# Keep the current release and the rollback release; remove older app images.
# Safe to run at any time on the VM: it never touches a running container's image, volumes,
# nginx, certbot, .env or .deploy-state. The deploy runs the same policy after every healthy
# deploy; this is the by-hand version (the 2026-09-03 disk incident was cleaned by hand).
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

require_env_file
CURRENT="$(env_get APP_VERSION)"
[ -n "${CURRENT}" ] || die "APP_VERSION is not set in deploy/.env — nothing is deployed?"
PREVIOUS="$(state_get PREVIOUS_VERSION)"
[ -n "${PREVIOUS}" ] || PREVIOUS="none"

log "Keeping ${CURRENT} (current) and ${PREVIOUS} (rollback)."
retain_app_images "${CURRENT}" "${PREVIOUS}"
docker image prune -f >/dev/null 2>&1 || true
docker system df 2>/dev/null || true
