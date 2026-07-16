#!/usr/bin/env bash
#
# scan-bundle-localhost.sh — fail if a production browser bundle contains a hardcoded
# loopback/internal-host reference. Run AFTER `next build` for both frontends. Catches the
# class of bug where a missing/dev build var bakes http://localhost:8080 into shipped JS.
#
#   ./deploy/scripts/scan-bundle-localhost.sh
#
# Scans only browser-served static chunks (.next/static). Reports, per offending file: the
# filename, the match count, and a short excerpt around each match (NOT the whole minified
# chunk) with a best-effort guess at the originating variable — without dumping bundles.

set -uo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Real leak signatures: a loopback host on one of OUR dev ports, or an internal Docker
# service host. Excludes the app's loopback-DETECTION set (bare hostnames, no port) and
# third-party SDK internals like Firebase's bare `http://localhost` (no port).
PATTERN='(localhost|127\.0\.0\.1):(8080|3000|3001)|https?://(backend|worker|nginx|client-web|admin-web)(:|/)'
MAX_EXCERPTS=3

rc=0
for app in client-web admin-web; do
  dir="${REPO_DIR}/${app}/.next/static"
  if [ ! -d "${dir}" ]; then
    echo "[scan] ${app}: no ${dir} (build first) — skipping"
    continue
  fi

  app_hits=0
  # List only files that contain a match (fast), then report each concisely.
  while IFS= read -r file; do
    [ -z "${file}" ] && continue
    count="$(grep -aoE "${PATTERN}" "${file}" 2>/dev/null | wc -l | tr -d ' ')"
    [ "${count}" = "0" ] && continue
    app_hits=$((app_hits + count))
    rc=1
    rel="${file#${REPO_DIR}/}"
    echo "[scan] ✖ ${rel}  (${count} match$([ "${count}" != "1" ] && echo es))"
    # Short excerpts: ~50 chars around each match; guess the nearest `name=` / `"name"`.
    grep -aoE ".{0,50}(${PATTERN}).{0,20}" "${file}" 2>/dev/null | head -n "${MAX_EXCERPTS}" | while IFS= read -r ex; do
      hint="$(printf '%s' "${ex}" | grep -oE '[A-Za-z_$][A-Za-z0-9_$]*[:=]' | tail -1)"
      printf '        …%s…%s\n' "${ex}" "${hint:+   (near: ${hint})}"
    done
    [ "${count}" -gt "${MAX_EXCERPTS}" ] && printf '        … +%d more\n' "$((count - MAX_EXCERPTS))"
  done < <(grep -alrE "${PATTERN}" "${dir}" --include='*.js' 2>/dev/null | sort -u)

  if [ "${app_hits}" -eq 0 ]; then
    echo "[scan] ✓ ${app}: no loopback/internal-host references in the browser bundle"
  else
    echo "[scan] ✖ ${app}: ${app_hits} total loopback/internal-host reference(s) in the bundle"
  fi
done

echo
[ "${rc}" -eq 0 ] && echo "[scan] PASS" || echo "[scan] FAIL — a localhost/internal-host URL is baked into a shipped bundle"
exit "${rc}"
