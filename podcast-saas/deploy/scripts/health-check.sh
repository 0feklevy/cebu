#!/usr/bin/env bash
#
# health-check.sh — snapshot of container + endpoint health. Exit 0 iff all green.
# Use standalone, from cron, or from an uptime monitor over SSH.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"
require_env_file

DOMAIN_ROOT="$(env_get DOMAIN_ROOT)"
DOMAIN_API="$(env_get DOMAIN_API)"
DOMAIN_ADMIN="$(env_get DOMAIN_ADMIN)"

rc=0

log "Container status:"
compose ps

echo
log "Container health states:"
for svc in backend worker client-web admin-web nginx certbot; do
  cid="$(compose ps -q "${svc}" 2>/dev/null || true)"
  if [ -z "${cid}" ]; then printf '  %-12s %s\n' "${svc}" "NOT RUNNING"; rc=1; continue; fi
  state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${cid}")"
  printf '  %-12s %s\n' "${svc}" "${state}"
  case "${state}" in healthy|running) ;; *) rc=1 ;; esac
done

echo
log "Internal backend /health (via container):"
if compose exec -T backend curl -fsS http://localhost:8080/health; then echo; else echo "  FAILED"; rc=1; fi

echo
log "Public HTTPS endpoints:"
endpoints=( "app|${DOMAIN_ROOT}" "api|${DOMAIN_API}|/health" )
[ -n "${DOMAIN_ADMIN}" ] && endpoints+=( "admin|${DOMAIN_ADMIN}" )
for pair in "${endpoints[@]}"; do
  IFS='|' read -r name host path <<< "${pair}"
  url="https://${host}${path:-/}"
  code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "${url}" || echo 000)"
  printf '  %-6s %-34s HTTP %s\n' "${name}" "${url}" "${code}"
  case "${code}" in 2*|3*) ;; *) rc=1 ;; esac
done

echo
[ "${rc}" -eq 0 ] && ok "All checks passed." || warn "One or more checks FAILED."
exit "${rc}"
