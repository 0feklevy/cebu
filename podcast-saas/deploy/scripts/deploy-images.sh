#!/usr/bin/env bash
#
# deploy-images.sh — image-based deployment for the release autopilot.
#
# Pulls EXACT image digests from GHCR, verifies them, retags them locally as
# podcast-saas/<svc>:<version> (so docker-compose.yml, rollback.sh and .deploy-state
# keep working unchanged), runs migrations, recreates services, health-gates, and
# auto-rolls-back on failure. This script NEVER builds from source — the emergency
# local-build fallback remains ./deploy.sh.
#
# Input: a single JSON envelope on STDIN (never argv/env — the registry token must not
# appear in `ps`, shell history, or logs):
#   {
#     "ghcrUser":  "github-username",
#     "ghcrToken": "read:packages token",
#     "manifest":  { "schema":"flowvid.image-manifest/v1", "version":"vX.Y.Z",
#                    "gitSha":"…", "images":[{service,repository,tag,digest}, …] },
#     "skipMigrations": false
#   }
#
# Usage (invoked over SSH by the release workflow):
#   deploy-images.sh --stdin-envelope            # deploy (default path)
#   NO_ROLLBACK=1 deploy-images.sh --stdin-envelope   # leave a failed deploy up for debugging
#
# NOTE: the caller is responsible for `git fetch && git checkout <sha>` of the repo
# BEFORE invoking this script (a bash script must not rewrite itself mid-run).

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

[ "${1:-}" = "--stdin-envelope" ] || die "Usage: deploy-images.sh --stdin-envelope  (JSON envelope on stdin)"

HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-240}"
APP_SERVICES=(backend worker client-web admin-web nginx)
GHCR_REGISTRY="ghcr.io"
TRUSTED_PREFIX="ghcr.io/0feklevy/cebu/"

require_env_file

# --- 0. Guards (same invariants as deploy.sh) ---------------------------------
if [ "$(id -u)" -eq 0 ]; then
  die "Do NOT run deploy-images.sh as root/sudo (breaks repo + state ownership)."
fi
docker info >/dev/null 2>&1 || die "Cannot reach the Docker daemon."
command -v python3 >/dev/null || die "python3 is required to parse the deployment envelope."

# --- 1. Read + validate the envelope (stdin only) -----------------------------
ENVELOPE="$(cat)"
[ -n "${ENVELOPE}" ] || die "Empty envelope on stdin."

# Scalars (one per line): version, gitSha, skipMigrations, ghcrUser, imageCount.
SCALARS="$(printf '%s' "${ENVELOPE}" | python3 -c '
import json, sys
e = json.load(sys.stdin)
m = e["manifest"]
assert m.get("schema") == "flowvid.image-manifest/v1", "unknown manifest schema"
print(m["version"]); print(m["gitSha"])
print("1" if e.get("skipMigrations") else "0")
print(e.get("ghcrUser", "")); print(len(m["images"]))
')" || die "Envelope JSON is invalid."
VERSION="$(sed -n 1p <<<"${SCALARS}")"
GIT_SHA="$(sed -n 2p <<<"${SCALARS}")"
SKIP_MIGRATIONS="$(sed -n 3p <<<"${SCALARS}")"
GHCR_USER="$(sed -n 4p <<<"${SCALARS}")"
IMAGE_COUNT="$(sed -n 5p <<<"${SCALARS}")"

[[ "${VERSION}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Bad version '${VERSION}' (expected vX.Y.Z)."
[[ "${GIT_SHA}" =~ ^[0-9a-f]{7,40}$ ]] || die "Bad gitSha '${GIT_SHA}'."
[ "${IMAGE_COUNT}" -ge 3 ] || die "Manifest must contain backend, client-web and admin-web images."

# Image lines: "service<TAB>repository<TAB>digest".
IMAGES="$(printf '%s' "${ENVELOPE}" | python3 -c '
import json, sys
for i in json.load(sys.stdin)["manifest"]["images"]:
    print(f"{i[\"service\"]}\t{i[\"repository\"]}\t{i[\"digest\"]}")
')"

# The registry token never touches disk or argv; keep it in this function only.
ghcr_login() {
  printf '%s' "${ENVELOPE}" | python3 -c 'import json,sys; sys.stdout.write(json.load(sys.stdin).get("ghcrToken",""))' \
    | docker login "${GHCR_REGISTRY}" -u "${GHCR_USER}" --password-stdin >/dev/null \
    || die "GHCR login failed."
}
trap 'docker logout "${GHCR_REGISTRY}" >/dev/null 2>&1 || true' EXIT

# --- 2. TLS certs must exist BEFORE touching services --------------------------
DOMAIN_ROOT="$(env_get DOMAIN_ROOT)"
if [ "${SKIP_CERT_CHECK:-0}" != "1" ]; then
  if compose run --rm --no-deps --entrypoint sh nginx \
        -c "test -s /etc/letsencrypt/live/${DOMAIN_ROOT}/fullchain.pem" >/dev/null 2>&1; then
    ok "TLS certificate present for ${DOMAIN_ROOT}."
  else
    die "No TLS certificate for ${DOMAIN_ROOT}. Run ./deploy/scripts/init-ssl.sh first."
  fi
fi

# --- 3. Pull exact digests + verify + retag ------------------------------------
[ -n "${GHCR_USER}" ] && ghcr_login

while IFS=$'\t' read -r svc repo digest; do
  [ -n "${svc}" ] || continue
  [[ "${digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || die "${svc}: malformed digest '${digest}'."
  case "${repo}/" in
    "${TRUSTED_PREFIX}"*) : ;;
    *) die "${svc}: repository ${repo} is outside the trusted namespace ${TRUSTED_PREFIX%/}." ;;
  esac
  case "${svc}" in backend|client-web|admin-web) : ;; *) die "Unknown service '${svc}' in manifest." ;; esac

  pinned="${repo}@${digest}"
  log "Pulling ${svc}: ${pinned}"
  docker pull --quiet "${pinned}" >/dev/null || die "Pull failed for ${pinned}."

  # Verify: the image's RepoDigests must contain exactly the pinned reference.
  if ! docker image inspect --format '{{join .RepoDigests "\n"}}' "${pinned}" | grep -qxF "${pinned}"; then
    die "${svc}: digest verification FAILED for ${pinned} — refusing to deploy."
  fi
  docker tag "${pinned}" "podcast-saas/${svc}:${VERSION}" || die "Retag failed for ${svc}."
  ok "${svc}: verified ${digest:0:19}… and tagged podcast-saas/${svc}:${VERSION}"
done <<<"${IMAGES}"

docker logout "${GHCR_REGISTRY}" >/dev/null 2>&1 || true

# --- 4. Record rollback target (same semantics as deploy.sh) -------------------
OLD_VERSION="$(env_get APP_VERSION)"; [ -n "${OLD_VERSION}" ] || OLD_VERSION="none"
log "Deploying ${VERSION} (git ${GIT_SHA}); previous version: ${OLD_VERSION}"
if [ "${OLD_VERSION}" != "none" ] && [ "${OLD_VERSION}" != "${VERSION}" ]; then
  state_set PREVIOUS_VERSION "${OLD_VERSION}"
fi
state_set CURRENT_VERSION "${VERSION}"
state_set LAST_DEPLOY_REF "${GIT_SHA}"
state_set LAST_DEPLOY_MODE "images"

env_set APP_VERSION "${VERSION}"
export APP_VERSION="${VERSION}"

# --- 5. Migrations (old images still serving; a failure aborts cleanly) --------
if [ "${SKIP_MIGRATIONS}" = "1" ]; then
  warn "skipMigrations set — schema migrations NOT run (rollback re-verification mode)."
else
  log "Running database migrations against Supabase…"
  if ! compose run --rm --no-deps backend node dist/db/migrate.js; then
    die "Migrations failed — aborting BEFORE swapping app containers (old version still serving)."
  fi
  ok "Migrations applied."
fi

# --- 6. Recreate services (NO build), then health-gate --------------------------
log "Recreating application services from pre-built images…"
compose up -d --no-build "${APP_SERVICES[@]}" certbot
compose exec -T nginx nginx -s reload 2>/dev/null || true

if wait_healthy "${HEALTH_TIMEOUT}" backend client-web admin-web nginx; then
  ok "Deployment ${VERSION} is healthy."
  docker image prune -f >/dev/null 2>&1 || true
  log "Previous version ${OLD_VERSION} images retained for rollback."
  compose ps
  exit 0
fi

# --- 7. Failure handling: automatic rollback ------------------------------------
warn "Deployment ${VERSION} FAILED health checks."
if [ "${NO_ROLLBACK:-0}" = "1" ]; then
  warn "NO_ROLLBACK=1 — leaving the failed deployment up for inspection."
  exit 1
fi
PREV="$(state_get PREVIOUS_VERSION)"
if [ -z "${PREV}" ] || [ "${PREV}" = "none" ]; then
  die "No previous version recorded — cannot auto-roll-back. Investigate: ./scripts/logs.sh backend"
fi
warn "Auto-rolling back to ${PREV}…"
if "${SCRIPT_DIR}/rollback.sh" "${PREV}"; then
  warn "Rolled back to ${PREV}. The ${VERSION} deployment FAILED."
  exit 1
fi
die "Rollback to ${PREV} ALSO failed — manual intervention required."
