#!/usr/bin/env bash
#
# production-audit.sh — READ-ONLY snapshot of production state, as JSON on stdout.
# Never mutates containers, images, certificates, or data. Human logs go to stderr.
#
#   production-audit.sh --json     # JSON document on stdout (schema flowvid.vm-audit/v1)
#
# Collected:
#   - container health states (backend, worker, client-web, admin-web, nginx, certbot)
#   - internal backend /health response
#   - Docker disk headroom
#   - TLS certificate days-remaining per lineage (via the certbot image, one-off run
#     with an EXPLICIT --entrypoint — never the renewal-loop default)
#   - database URL audit (backfill script in report mode — no writes) when the
#     deployed backend image supports --json
#
# The GitHub production-audit workflow combines this with runner-side endpoint,
# CSP, and Playwright browser audits.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"
require_env_file

[ "${1:-}" = "--json" ] || die "Usage: production-audit.sh --json"
command -v python3 >/dev/null || die "python3 required."

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

DOMAIN_ROOT="$(env_get DOMAIN_ROOT)"
DOMAIN_API="$(env_get DOMAIN_API)"
DOMAIN_ADMIN="$(env_get DOMAIN_ADMIN)"
APP_VERSION="$(env_get APP_VERSION)"

# --- containers -----------------------------------------------------------------
: > "${WORK}/containers.tsv"
for svc in backend worker client-web admin-web nginx certbot; do
  cid="$(compose ps -q "${svc}" 2>/dev/null || true)"
  if [ -z "${cid}" ]; then
    printf '%s\tNOT RUNNING\n' "${svc}" >> "${WORK}/containers.tsv"
    continue
  fi
  state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${cid}" 2>/dev/null || echo unknown)"
  printf '%s\t%s\n' "${svc}" "${state}" >> "${WORK}/containers.tsv"
done

# --- internal backend /health -----------------------------------------------------
if compose exec -T backend curl -fsS --max-time 10 http://localhost:8080/health > "${WORK}/backend-health.txt" 2>/dev/null; then
  echo "1" > "${WORK}/backend-health.ok"
else
  echo "0" > "${WORK}/backend-health.ok"
  : > "${WORK}/backend-health.txt"
fi

# --- disk headroom ----------------------------------------------------------------
df -PBG /var/lib/docker 2>/dev/null | awk 'NR==2{gsub(/G/,"",$4); print $4}' > "${WORK}/disk-free-gb.txt" || echo "" > "${WORK}/disk-free-gb.txt"

# --- certificate expiry (one-off certbot run with EXPLICIT entrypoint) --------------
: > "${WORK}/certs.tsv"
for lineage in "${DOMAIN_ROOT}" "${DOMAIN_API}" ${DOMAIN_ADMIN:+"${DOMAIN_ADMIN}"}; do
  end="$(compose run --rm --no-deps --entrypoint sh certbot \
        -c "openssl x509 -enddate -noout -in /etc/letsencrypt/live/${lineage}/fullchain.pem 2>/dev/null" 2>/dev/null \
        | sed -n 's/^notAfter=//p' | tr -d '\r')"
  if [ -n "${end}" ]; then
    end_epoch="$(date -d "${end}" +%s 2>/dev/null || echo '')"
    if [ -n "${end_epoch}" ]; then
      days=$(( (end_epoch - $(date +%s)) / 86400 ))
      printf '%s\t%s\n' "${lineage}" "${days}" >> "${WORK}/certs.tsv"
      continue
    fi
  fi
  printf '%s\t\n' "${lineage}" >> "${WORK}/certs.tsv"
done

# --- database URL audit (report mode — READ ONLY) -----------------------------------
# The backfill script prints a sentinel-delimited JSON block on stdout. Older images
# (< v0.1.2) don't support --json; tolerate and report null.
if compose run --rm --no-deps backend node dist/scripts/backfill-localhost-urls.js --json - \
      > "${WORK}/backfill-raw.txt" 2>>"${WORK}/backfill-err.txt"; then
  sed -n '/^---URL-BACKFILL-REPORT-JSON---$/,/^---END-URL-BACKFILL-REPORT-JSON---$/p' "${WORK}/backfill-raw.txt" \
    | sed '1d;$d' > "${WORK}/backfill.json" || true
else
  log "backfill report run failed (old image without --json support?) — urlBackfill will be null."
fi
[ -s "${WORK}/backfill.json" ] || echo "null" > "${WORK}/backfill.json"

# --- assemble JSON (stdout carries ONLY this document) --------------------------------
python3 - "${WORK}" "${APP_VERSION}" <<'PY'
import json, sys, datetime, pathlib
work = pathlib.Path(sys.argv[1]); app_version = sys.argv[2]

containers = {}
for line in (work / "containers.tsv").read_text().splitlines():
    if "\t" in line:
        svc, state = line.split("\t", 1)
        containers[svc] = state

certs = {}
for line in (work / "certs.tsv").read_text().splitlines():
    if "\t" in line:
        lineage, days = line.split("\t", 1)
        certs[lineage] = int(days) if days.strip() else None

try:
    backfill = json.loads((work / "backfill.json").read_text())
except Exception:
    backfill = None

disk_raw = (work / "disk-free-gb.txt").read_text().strip()

doc = {
    "schema": "flowvid.vm-audit/v1",
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "appVersion": app_version,
    "containers": containers,
    "backendHealth": {
        "ok": (work / "backend-health.ok").read_text().strip() == "1",
        "body": (work / "backend-health.txt").read_text().strip()[:500],
    },
    "workerRunning": containers.get("worker") in ("running", "healthy"),
    "diskFreeGb": int(disk_raw) if disk_raw else None,
    "certDaysRemaining": certs,
    "urlBackfill": backfill,
}
print(json.dumps(doc, indent=2))
PY
