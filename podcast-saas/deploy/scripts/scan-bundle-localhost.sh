#!/usr/bin/env bash
#
# scan-bundle-localhost.sh — fail if a production browser bundle contains a hardcoded
# localhost/loopback reference. Run AFTER `next build` for both frontends. This catches the
# class of bug where a missing build arg bakes http://localhost:8080 into the shipped JS.
#
#   ./deploy/scripts/scan-bundle-localhost.sh
#
# Scans only the browser-served static chunks (.next/static). Server-only code and source
# maps are excluded (they never reach a browser).

set -uo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# A real leak is a loopback host on one of OUR dev ports (backend 8080, web 3000/3001).
# This excludes (a) the app's own loopback-DETECTION set (bare hostnames, no port) in the
# asset-URL guard, and (b) third-party SDK internals like Firebase's auth-emulator
# reference to a bare `http://localhost` (no port). Those are inert in production.
PATTERN='(localhost|127\.0\.0\.1):(8080|3000|3001)'

rc=0
for app in client-web admin-web; do
  dir="${REPO_DIR}/${app}/.next/static"
  if [ ! -d "${dir}" ]; then
    echo "[scan] ${app}: no ${dir} (build first with 'next build') — skipping"
    continue
  fi
  # -a: treat binary-ish chunks as text; --include JS only.
  hits="$(grep -ranE "${PATTERN}" --include='*.js' "${dir}" 2>/dev/null || true)"
  if [ -n "${hits}" ]; then
    echo "[scan] ✖ ${app}: browser bundle contains loopback references:"
    echo "${hits}" | head -20
    rc=1
  else
    echo "[scan] ✓ ${app}: no loopback references in the browser bundle"
  fi
done

[ "${rc}" -eq 0 ] && echo "[scan] PASS" || echo "[scan] FAIL — a localhost URL is baked into a shipped bundle"
exit "${rc}"
