#!/usr/bin/env bash
#
# release-verify.sh — one reliable, deterministic release gate. Run via `pnpm release:verify`.
#
# It reproduces a PRODUCTION build regardless of any developer .env.local files: those are
# temporarily moved aside so a `next build` cannot silently bake dev localhost URLs and call
# it a production build (the v0.1.1 incident). Public build URLs are supplied explicitly
# (overridable via env or a gitignored deploy/release.env). Stops on the first failure and
# ALWAYS restores the moved .env.local files, even on failure.
#
# Steps: frozen install → typecheck → non-interactive lint → tests → clean .next →
#        build client-web + admin-web with explicit prod URLs → scan bundles for localhost.
#
# Public production values (override by exporting them or via deploy/release.env):
#   NEXT_PUBLIC_API_URL   = https://api.flowvidco.com
#   NEXT_PUBLIC_APP_URL   = https://flowvidco.com
#   PUBLIC_SITE_URL       = https://flowvidco.com
#   ADMIN_ORIGIN          = https://admin.flowvidco.com
# No secrets are hardcoded; NEXT_PUBLIC_* are public build values only.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_DIR}"

c_g=$'\033[32m'; c_b=$'\033[34m'; c_r=$'\033[31m'; c_z=$'\033[0m'
step() { printf '\n%s▶ %s%s\n' "$c_b" "$*" "$c_z"; }
ok()   { printf '%s✓ %s%s\n' "$c_g" "$*" "$c_z"; }
die()  { printf '%s✗ %s%s\n' "$c_r" "$*" "$c_z" >&2; exit 1; }

# Optional gitignored file for public build vars (NEXT_PUBLIC_* only — never secrets).
if [ -f "${REPO_DIR}/deploy/release.env" ]; then
  step "Loading deploy/release.env"
  set -a; . "${REPO_DIR}/deploy/release.env"; set +a
fi

# Explicit production public URLs (defaults; override via env / release.env).
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-https://api.flowvidco.com}"
export NEXT_PUBLIC_APP_URL="${NEXT_PUBLIC_APP_URL:-https://flowvidco.com}"
export PUBLIC_SITE_URL="${PUBLIC_SITE_URL:-https://flowvidco.com}"
export ADMIN_ORIGIN="${ADMIN_ORIGIN:-https://admin.flowvidco.com}"
# NOTE: NODE_ENV is intentionally NOT forced to production here — `next build` sets it for
# the builds, while typecheck/lint/test run in their normal (test) env. Forcing production
# globally would break vitest tests that exercise development-mode code paths.

# Public Firebase config is needed for the build's static prerender (Firebase throws
# `auth/invalid-api-key` on an empty key). These are PUBLIC, non-secret values; the real
# ones are injected at actual deploy time (docker build args). Placeholders are fine here
# because this build is only SCANNED for localhost URLs, then discarded. Override via
# deploy/release.env for a production-identical build.
export NEXT_PUBLIC_FIREBASE_API_KEY="${NEXT_PUBLIC_FIREBASE_API_KEY:-release-verify-placeholder-key}"
export NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN="${NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN:-example.firebaseapp.com}"
export NEXT_PUBLIC_FIREBASE_PROJECT_ID="${NEXT_PUBLIC_FIREBASE_PROJECT_ID:-example}"
export NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET="${NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET:-example.appspot.com}"
export NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID="${NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:-000000000000}"
export NEXT_PUBLIC_FIREBASE_APP_ID="${NEXT_PUBLIC_FIREBASE_APP_ID:-1:000000000000:web:releaseverify}"

step "Release public URLs"
printf '  NEXT_PUBLIC_API_URL = %s\n  NEXT_PUBLIC_APP_URL = %s\n  PUBLIC_SITE_URL     = %s\n  ADMIN_ORIGIN        = %s\n' \
  "${NEXT_PUBLIC_API_URL}" "${NEXT_PUBLIC_APP_URL}" "${PUBLIC_SITE_URL}" "${ADMIN_ORIGIN}"

# ── Isolate developer .env.local files so the prod build can't consume dev values ──
# Bash compatibility: `${#MOVED[@]:-0}` is a BAD SUBSTITUTION on modern bash (CI runs
# bash 5; array-length expansion cannot take a `:-` default) even though macOS bash 3.2
# tolerated it. The portable, nounset-safe pattern used here: explicitly declare the
# array, guard on the plain length expansion (always valid for a declared array, even
# when empty), and expand "${MOVED[@]}" only inside the guarded branch (bash < 4.4
# errors on expanding an EMPTY array under `set -u`).
declare -a MOVED=()
restore_env_local() {
  if [ "${#MOVED[@]}" -gt 0 ]; then
    for f in "${MOVED[@]}"; do
      if [ -f "${f}.release-bak" ]; then mv -f "${f}.release-bak" "${f}"; fi
    done
    printf '%s↺ restored %d .env.local file(s)%s\n' "$c_b" "${#MOVED[@]}" "$c_z"
  fi
}
trap restore_env_local EXIT

step "Isolating .env.local files (dev overrides must not enter a prod build)"
for f in "${REPO_DIR}/.env.local" "${REPO_DIR}/client-web/.env.local" "${REPO_DIR}/admin-web/.env.local"; do
  if [ -f "${f}" ]; then mv -f "${f}" "${f}.release-bak"; MOVED+=("${f}"); echo "  moved: ${f#${REPO_DIR}/}"; fi
done
if [ "${#MOVED[@]}" -eq 0 ]; then echo "  (none present)"; fi

# ── 1. Frozen install ──────────────────────────────────────────────────────────
step "1/8 Install (frozen lockfile)"; pnpm install --frozen-lockfile; ok "install"

# ── 2. Typecheck ───────────────────────────────────────────────────────────────
step "2/8 Typecheck (all workspaces)"; pnpm -r typecheck; ok "typecheck"

# ── 3. Lint (non-interactive) ──────────────────────────────────────────────────
step "3/8 Lint (all workspaces, non-interactive)"; pnpm -r lint; ok "lint"

# ── 4. Tests ───────────────────────────────────────────────────────────────────
step "4/8 Tests"; pnpm -r test; ok "tests"

# ── 5. Clean stale build output ────────────────────────────────────────────────
step "5/8 Removing stale .next output"; rm -rf "${REPO_DIR}/client-web/.next" "${REPO_DIR}/admin-web/.next"; ok "cleaned"

# ── 6-7. Production builds with explicit public URLs ──────────────────────────────
step "6/8 Build client-web (production)"
( cd "${REPO_DIR}/client-web" && pnpm build ) || die "client-web build failed"
ok "client-web build"

step "7/8 Build admin-web (production)"
( cd "${REPO_DIR}/admin-web" && pnpm build ) || die "admin-web build failed"
ok "admin-web build"

# ── 8. Scan the shipped browser bundles for loopback URLs ───────────────────────
step "8/8 Scanning bundles for localhost/127.0.0.1/private hosts"
"${REPO_DIR}/deploy/scripts/scan-bundle-localhost.sh" || die "bundle scan found loopback references"
ok "bundle scan"

printf '\n%s========================================%s\n' "$c_g" "$c_z"
ok "RELEASE VERIFY PASSED — production bundles are clean of localhost URLs"
printf '%s========================================%s\n' "$c_g" "$c_z"
