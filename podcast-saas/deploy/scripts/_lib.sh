#!/usr/bin/env bash
# Shared helpers for the deployment scripts. Sourced, not executed directly.

set -euo pipefail

# Resolve important paths regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${DEPLOY_DIR}/.." && pwd)"

ENV_FILE="${DEPLOY_DIR}/.env"
STATE_FILE="${DEPLOY_DIR}/.deploy-state"

# docker compose invocation, pinned to our compose file + env file.
compose() {
  docker compose \
    --project-directory "${DEPLOY_DIR}" \
    -f "${DEPLOY_DIR}/docker-compose.yml" \
    --env-file "${ENV_FILE}" \
    "$@"
}

# ---- logging ----------------------------------------------------------------
c_reset=$'\033[0m'; c_blue=$'\033[34m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'
log()   { printf '%s[deploy]%s %s\n'  "$c_blue"   "$c_reset" "$*"; }
ok()    { printf '%s[ ok  ]%s %s\n'   "$c_green"  "$c_reset" "$*"; }
warn()  { printf '%s[warn ]%s %s\n'   "$c_yellow" "$c_reset" "$*" >&2; }
die()   { printf '%s[fail ]%s %s\n'   "$c_red"    "$c_reset" "$*" >&2; exit 1; }

require_env_file() {
  [ -f "${ENV_FILE}" ] || die "Missing ${ENV_FILE}. Copy deploy/.env.example -> deploy/.env and fill it in."
  [ -f "${REPO_DIR}/.env" ] || die "Missing ${REPO_DIR}/.env (app secrets). Copy .env.example -> .env and fill it in."
}

# Read a KEY=value from deploy/.env (no shell eval). Tolerant of surrounding
# whitespace, quotes, and inline ` # comment` after an unquoted value.
env_get() {
  local key="$1" line val
  line="$(grep -E "^[[:space:]]*${key}=" "${ENV_FILE}" 2>/dev/null | tail -n1)"
  [ -n "${line}" ] || { printf ''; return 0; }
  val="${line#*=}"
  # Strip an inline comment introduced by whitespace + '#' (matches compose-go dotenv).
  val="${val%% #*}"
  val="${val%%$'\t'#*}"
  # Trim leading/trailing whitespace.
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  # Strip one layer of matching surrounding quotes.
  case "${val}" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  printf '%s' "${val}"
}

# Set/replace a KEY=value in deploy/.env in place (portable sed).
env_set() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "${ENV_FILE}"; then
    # Use a temp file for portability between GNU/BSD sed.
    grep -vE "^${key}=" "${ENV_FILE}" > "${ENV_FILE}.tmp"
    printf '%s=%s\n' "${key}" "${val}" >> "${ENV_FILE}.tmp"
    mv "${ENV_FILE}.tmp" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${val}" >> "${ENV_FILE}"
  fi
}

# ---- deploy state (for rollback) --------------------------------------------
state_get() { grep -E "^$1=" "${STATE_FILE}" 2>/dev/null | tail -n1 | cut -d= -f2- || true; }
state_set() {
  local key="$1" val="$2"
  touch "${STATE_FILE}"
  grep -vE "^${key}=" "${STATE_FILE}" > "${STATE_FILE}.tmp" 2>/dev/null || true
  printf '%s=%s\n' "${key}" "${val}" >> "${STATE_FILE}.tmp"
  mv "${STATE_FILE}.tmp" "${STATE_FILE}"
}

# ---- health polling ---------------------------------------------------------
# Wait until every named service reports a healthy (or running, if no healthcheck)
# container. Returns non-zero on timeout.
wait_healthy() {
  local timeout="${1:-180}"; shift
  local services=("$@")
  local deadline=$(( $(date +%s) + timeout ))
  log "Waiting up to ${timeout}s for services to become healthy: ${services[*]}"

  while :; do
    local all_ok=1
    for svc in "${services[@]}"; do
      local cid; cid="$(compose ps -q "${svc}" 2>/dev/null || true)"
      if [ -z "${cid}" ]; then all_ok=0; break; fi
      local status; status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${cid}" 2>/dev/null || echo "unknown")"
      case "${status}" in
        healthy|running) : ;;
        starting|unknown|created) all_ok=0; break ;;
        *) all_ok=0; break ;;
      esac
    done
    if [ "${all_ok}" -eq 1 ]; then ok "All services healthy."; return 0; fi
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      warn "Timed out waiting for health. Current status:"
      compose ps || true
      return 1
    fi
    sleep 5
  done
}

# ── Release retention + disk guard ────────────────────────────────────────────────────────────
# Owner incident 2026-09-03: the VM reached 94% because every historical release image was kept
# (`docker image prune -f` removes only dangling layers, never a tagged release). The policy is
# now in the deploy itself: keep the release just deployed and the one before it (the rollback
# target), remove the rest of the app namespace, and refuse to deploy onto a nearly-full disk.

APP_IMAGE_NAMES=(backend client-web admin-web)

# retain_app_images KEEP_A [KEEP_B ...]
#   Removes every podcast-saas/{backend,client-web,admin-web}:<tag> whose tag is not in the keep
#   set. `docker image rm` WITHOUT -f: an image a container still uses refuses, and that refusal
#   is correct. Other namespaces (nginx, certbot), volumes, .env and .deploy-state are never
#   touched; untagged (<none>) layers are left to `docker image prune`.
retain_app_images() {
  local keep=("$@") removed=0 kept=0 ref tag
  while IFS= read -r ref; do
    [ -n "${ref}" ] || continue
    tag="${ref##*:}"
    case " ${keep[*]} " in *" ${tag} "*) kept=$((kept + 1)); continue ;; esac
    if docker image rm "${ref}" >/dev/null 2>&1; then
      log "retention: removed ${ref}"
      removed=$((removed + 1))
    else
      warn "retention: kept ${ref} (in use, or already gone)"
    fi
  done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' 'podcast-saas/*' 2>/dev/null \
             | grep -E '^podcast-saas/(backend|client-web|admin-web):' | grep -v ':<none>$' || true)
  log "retention: kept ${kept} tag(s) for {${keep[*]}}, removed ${removed}."
}

# require_free_disk_gb PATH MIN_GB
#   Refuses (die) when the filesystem holding PATH has fewer than MIN_GB free. df is the only
#   source. DEPLOY_ALLOW_LOW_DISK=1 turns the refusal into a warning for one emergency the
#   operator has looked at. An unreadable df is a warning, never a refusal.
require_free_disk_gb() {
  local path="$1" min="$2" free
  free="$(df -PBG "${path}" 2>/dev/null | awk 'NR==2{gsub(/G/,"",$4); print $4}' || true)"
  case "${free}" in
    ''|*[!0-9]*) warn "disk guard: could not read free space for ${path}; continuing."; return 0 ;;
  esac
  if [ "${free}" -lt "${min}" ]; then
    if [ "${DEPLOY_ALLOW_LOW_DISK:-0}" = "1" ]; then
      warn "disk guard: only ${free}G free on ${path} (minimum ${min}G) — continuing because DEPLOY_ALLOW_LOW_DISK=1."
      return 0
    fi
    die "disk guard: only ${free}G free on ${path}; ${min}G is the minimum to deploy. Free space (docker image ls 'podcast-saas/*'; ./deploy/scripts/retain-images.sh) or set DEPLOY_ALLOW_LOW_DISK=1 to override once."
  fi
  log "disk guard: ${free}G free on ${path} (minimum ${min}G)."
}
