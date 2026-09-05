#!/usr/bin/env bash
# Run the welcome-playlist template builder against the LOCAL stack.
# Preconditions: backend API on 127.0.0.1:8080, Firebase auth emulator on 127.0.0.1:9099,
# client-web dev server on 127.0.0.1:3000 (only needed for the viewer screenshots).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() { echo "PRECONDITION FAILED: $1" >&2; exit 1; }

curl -sS -m 5 -o /dev/null http://127.0.0.1:8080/health \
  || fail "backend API not answering on 127.0.0.1:8080 — start the dev stack first (pnpm -C podcast-saas dev)"
curl -sS -m 5 -o /dev/null http://127.0.0.1:9099/ \
  || fail "Firebase auth emulator not answering on 127.0.0.1:9099"
curl -sS -m 5 -o /dev/null http://127.0.0.1:3000/ \
  || echo "WARN: client-web not answering on 127.0.0.1:3000 — the viewer screenshots will fail" >&2

command -v node >/dev/null || fail "node not on PATH"
node -e 'const [m]=process.versions.node.split(".");process.exit(+m>=22?0:1)' \
  || fail "node >= 22 required (global fetch/FormData), found $(node --version)"

exec node "$HERE/build-template.mjs" "$@"
