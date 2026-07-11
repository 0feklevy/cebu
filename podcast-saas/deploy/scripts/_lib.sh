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
