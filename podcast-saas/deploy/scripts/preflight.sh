#!/usr/bin/env bash
#
# preflight.sh — verify the VM is ready for TLS issuance + deployment.
# Run this on the VM BEFORE ./init-ssl.sh. It is a HARD GATE: a non-zero exit means
# "do not continue" — Let's Encrypt (and the deploy) would fail.
#
# Checks:
#   1. DNS resolves for flowvidco.com, www, app, api (+ admin if configured).
#   2. Each name resolves to the expected public IP.
#   3. Ports 80 and 443 are reachable on the public IP (SG/network path).
#   4. Outbound HTTPS to the Let's Encrypt CA works (certbot prerequisite).
#   5. No NATIVE host service (e.g. apt-installed nginx/apache) squats on 80/443,
#      which would stop our nginx CONTAINER from binding those host ports.
#
# Expected IP resolution order:  $1 (arg)  ->  $EXPECTED_IP  ->  EC2 metadata  ->  ipify.
#
# Usage:
#   ./preflight.sh                       # auto-detect this VM's public IP as expected
#   ./preflight.sh 44.225.68.155         # assert domains point at this IP
#   EXPECTED_IP=44.225.68.155 ./preflight.sh
#   ALLOW_PORT_WARN=1 ./preflight.sh     # proceed despite an ambiguous port result
#                                        # (use ONLY after confirming the SG from your laptop)

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

# This is a diagnostic script that intentionally runs probes expected to fail
# (closed ports, non-resolving names). Disable errexit so one failed probe doesn't
# abort the whole run; we track outcomes explicitly via the fail/warn counters.
set +e

[ -f "${ENV_FILE}" ] || die "Missing ${ENV_FILE}. Copy deploy/.env.example -> deploy/.env first."

DOMAIN_ROOT="$(env_get DOMAIN_ROOT)"
DOMAIN_WWW="$(env_get DOMAIN_WWW)"
DOMAIN_APP="$(env_get DOMAIN_APP)"
DOMAIN_API="$(env_get DOMAIN_API)"
DOMAIN_ADMIN="$(env_get DOMAIN_ADMIN)"

# Required names must resolve to the VM. admin is optional (the stack runs without it).
REQUIRED=("${DOMAIN_ROOT}" "${DOMAIN_WWW}" "${DOMAIN_APP}" "${DOMAIN_API}")
for d in "${REQUIRED[@]}"; do [ -n "${d}" ] || die "A required DOMAIN_* is empty in deploy/.env"; done

fail=0   # hard failures -> exit non-zero
warn=0   # soft warnings -> reported, do not block (unless they are the only issue you care about)

# ---- resolve the expected public IP ----------------------------------------
resolve_a() {
  local host="$1"
  if command -v dig >/dev/null 2>&1; then
    dig +short A "${host}" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n1
  elif command -v host >/dev/null 2>&1; then
    host -t A "${host}" 2>/dev/null | awk '/has address/{print $NF; exit}'
  else
    getent ahostsv4 "${host}" 2>/dev/null | awk '{print $1; exit}'
  fi
}

detect_public_ip() {
  local tok ip
  tok="$(timeout 3 curl -sS -X PUT 'http://169.254.169.254/latest/api/token' \
        -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
  if [ -n "${tok}" ]; then
    ip="$(timeout 3 curl -sS -H "X-aws-ec2-metadata-token: ${tok}" \
          'http://169.254.169.254/latest/meta-data/public-ipv4' 2>/dev/null || true)"
  fi
  [ -z "${ip:-}" ] && ip="$(timeout 5 curl -sS 'https://api.ipify.org' 2>/dev/null || true)"
  printf '%s' "${ip}"
}

EXPECTED_IP="${1:-${EXPECTED_IP:-}}"
if [ -z "${EXPECTED_IP}" ]; then
  log "No expected IP given — detecting this VM's public IP…"
  EXPECTED_IP="$(detect_public_ip)"
fi
[ -n "${EXPECTED_IP}" ] || die "Could not determine the expected public IP. Pass it: ./preflight.sh <IP>"
log "Expected public IP: ${EXPECTED_IP}"
echo

# ---- 1 & 2. DNS resolution + IP match --------------------------------------
log "Checking DNS…"
check_dns() {
  local host="$1" optional="${2:-0}" got
  got="$(resolve_a "${host}" || true)"
  if [ -z "${got}" ]; then
    if [ "${optional}" = "1" ]; then printf '  %-24s %s\n' "${host}" "not resolving (optional — skipping)"; warn=1
    else printf '  %-24s %s\n' "${host}" "FAIL — does not resolve"; fail=1; fi
    return
  fi
  if [ "${got}" = "${EXPECTED_IP}" ]; then
    printf '  %-24s -> %s  OK\n' "${host}" "${got}"
  else
    if [ "${optional}" = "1" ]; then printf '  %-24s -> %s  WARN (expected %s)\n' "${host}" "${got}" "${EXPECTED_IP}"; warn=1
    else printf '  %-24s -> %s  FAIL (expected %s)\n' "${host}" "${got}" "${EXPECTED_IP}"; fail=1; fi
  fi
}
for d in "${REQUIRED[@]}"; do check_dns "${d}" 0; done
[ -n "${DOMAIN_ADMIN}" ] && check_dns "${DOMAIN_ADMIN}" 1
echo

# ---- 3. Port reachability (80/443) -----------------------------------------
# timeout exit code 124 = filtered/timeout (likely SG closed); other nonzero = refused
# (host reachable, nothing listening yet — expected before the first deploy); 0 = open.
log "Checking ports 80/443 on ${EXPECTED_IP} (path/SG test)…"
check_port() {
  local port="$1" rc
  if timeout 5 bash -c ">/dev/tcp/${EXPECTED_IP}/${port}" 2>/dev/null; then rc=0; else rc=$?; fi
  if [ "${rc}" -eq 0 ]; then
    printf '  port %-3s  OPEN (a service is listening)\n' "${port}"
  elif [ "${rc}" -eq 124 ]; then
    printf '  port %-3s  TIMEOUT — likely blocked by the AWS Security Group (or no route)\n' "${port}"
    if [ "${ALLOW_PORT_WARN:-0}" = "1" ]; then warn=1; else fail=1; fi
  else
    printf '  port %-3s  reachable but closed (OK pre-deploy — nginx not up yet)\n' "${port}"
  fi
}
check_port 80
check_port 443
cat <<NOTE
  NOTE: from a VM, connecting to its own public IP can be unreliable (EIP hairpinning).
        The authoritative inbound test is from YOUR LAPTOP:
            nc -vz ${EXPECTED_IP} 80 && nc -vz ${EXPECTED_IP} 443
        Port 80 MUST be open to the internet or Let's Encrypt HTTP-01 will fail.
NOTE
echo

# ---- 4. Outbound to the Let's Encrypt CA -----------------------------------
log "Checking outbound HTTPS to Let's Encrypt…"
if timeout 8 bash -c ">/dev/tcp/acme-v02.api.letsencrypt.org/443" 2>/dev/null; then
  printf '  acme-v02.api.letsencrypt.org:443  reachable  OK\n'
else
  printf '  acme-v02.api.letsencrypt.org:443  UNREACHABLE — certbot cannot obtain certs\n'
  warn=1
fi
echo

# ---- 5. Native host services squatting on 80/443 ---------------------------
# Our nginx CONTAINER publishes host ports 80:80 and 443:443. If a native service
# (commonly an apt-installed nginx/apache) already listens there, `docker compose up`
# fails to bind. This check only makes sense on the VM (Linux); it's skipped elsewhere.

# Is one of OUR containers already publishing this host port? (then it's not a conflict)
docker_publishes_port() {
  local port="$1"
  command -v docker >/dev/null 2>&1 || return 1
  docker ps --format '{{.Ports}}' 2>/dev/null | grep -qE "(^|,| )[0-9.]*:${port}->|:::${port}->|\[::\]:${port}->"
}

check_host_listeners() {
  log "Checking for native host services on ports 80/443…"

  if [ "$(uname -s 2>/dev/null)" != "Linux" ]; then
    printf '  (skipped — not Linux; run this ON THE VM for a real result)\n'; return
  fi
  local tool=""
  if command -v ss >/dev/null 2>&1; then tool="ss"
  elif command -v netstat >/dev/null 2>&1; then tool="netstat"
  else
    printf '  (skipped — neither ss nor netstat available)\n'; return
  fi

  # Emit "PORT RAWPROC" lines for any LISTEN socket on 80/443. RAWPROC may be empty
  # when the process name is hidden (needs root); we cross-check Docker in that case.
  local hits
  if [ "${tool}" = "ss" ]; then
    hits="$(ss -ltnp 2>/dev/null | awk '$1=="LISTEN"{
              n=split($4,a,":"); port=a[n];
              if(port!=80 && port!=443) next;
              proc=""; for(i=5;i<=NF;i++){ if($i ~ /^users:/) proc=$i }
              print port, proc }')"
  else
    hits="$(netstat -ltnp 2>/dev/null | awk '$1 ~ /^tcp/ {
              n=split($4,a,":"); port=a[n];
              if(port!=80 && port!=443) next;
              print port, $7 }')"   # $7 = PID/Program  or  '-'
  fi

  if [ -z "${hits}" ]; then
    printf '  ports 80/443 are free on the host  OK\n'
    if ! command -v ss >/dev/null 2>&1 && [ "${tool}" = "netstat" ]; then :; fi
    printf '  (tip: run with sudo to reveal root-owned process names)\n'
    return
  fi

  local conflict=0 port proc name
  while read -r port proc; do
    [ -z "${port}" ] && continue
    # Extract a friendly process name from either ss (users:(("nginx",..))) or netstat (1234/nginx).
    name="$(printf '%s' "${proc}" | sed -E 's/.*users:\(\("([^"]+)".*/\1/; s#^[0-9]+/##')"
    [ "${name}" = "${proc}" ] && [ "${proc#users:}" != "${proc}" ] && name=""   # unparsed ss token

    if printf '%s' "${proc}" | grep -qE 'docker-proxy|dockerd'; then
      printf '  port %-3s  bound by Docker (our stack) — OK\n' "${port}"
    elif [ -z "${proc}" ] || [ "${proc}" = "-" ]; then
      # Name hidden (no root). Is it one of our containers?
      if docker_publishes_port "${port}"; then
        printf '  port %-3s  published by our nginx container — OK\n' "${port}"
      else
        printf '  port %-3s  IN USE by a host process (name hidden — re-run with sudo) — CONFLICT\n' "${port}"
        conflict=1
      fi
    else
      printf '  port %-3s  IN USE by native process "%s" — CONFLICT\n' "${port}" "${name:-${proc}}"
      conflict=1
    fi
  done <<< "${hits}"

  if [ "${conflict}" -ne 0 ]; then
    fail=1
    cat <<'MSG'
  A native service is occupying port 80 and/or 443. Our nginx CONTAINER cannot bind it,
  so init-ssl.sh / deploy.sh would fail. Free the port(s) on the VM first:

      sudo ss -ltnp | grep -E ':80|:443'      # identify it
      sudo systemctl disable --now nginx      # or: apache2 / httpd / caddy
      sudo ss -ltnp | grep -E ':80|:443'      # confirm empty

  Then re-run this preflight.
MSG
  fi
}
check_host_listeners
echo

# ---- verdict ---------------------------------------------------------------
if [ "${fail}" -ne 0 ]; then
  die "PREFLIGHT FAILED — do NOT run init-ssl.sh yet. Fix the FAIL items above."
elif [ "${warn}" -ne 0 ]; then
  warn "Preflight passed with warnings. Review them before proceeding."
  ok "Required DNS + ports look ready."
  exit 0
else
  ok "Preflight passed. Safe to run ./scripts/init-ssl.sh"
  exit 0
fi
