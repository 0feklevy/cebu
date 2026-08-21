#!/usr/bin/env bash
# One-shot local dev stack for the linear-video-export feature WITH live sim capture.
# Starts backend (EXPORT_CAPTURE_LOCAL=1), client, and the ownership watcher.
# The Firebase Auth EMULATOR must already be running on :9099 (see LOCAL-CAPTURE-README.md).
# NOTHING here touches production — DATABASE_URL/STORAGE are local (verified below).
set -uo pipefail

# Locations are derived, not hardcoded, so this runs from any checkout on any machine. Both are
# overridable: LOCAL_CAPTURE_ROOT for a non-standard layout, LOCAL_CAPTURE_SCRATCH for the logs.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
ROOT="${LOCAL_CAPTURE_ROOT:-$REPO/podcast-saas}"
SCRATCH="${LOCAL_CAPTURE_SCRATCH:-${TMPDIR:-/tmp}/flowvid-local-capture}"
mkdir -p "$SCRATCH"
PROJECT_ID="00000000-0000-4000-a000-0000000f1c7e"

# Guard: never boot against a non-local DB.
if ! grep -q '^DATABASE_URL=postgresql://postgres:postgres@localhost' "$ROOT/.env"; then
  echo "REFUSING: $ROOT/.env DATABASE_URL is not local. Fix it before running." >&2
  exit 1
fi

echo "→ emulator:  $(curl -s -m2 -o /dev/null -w '%{http_code}' http://127.0.0.1:9099/ || echo DOWN)  (must be 200)"

echo "→ (re)starting backend with EXPORT_CAPTURE_LOCAL=1"
lsof -ti:8080 | xargs kill 2>/dev/null; sleep 2
( cd "$ROOT/backend-api" && EXPORT_CAPTURE_LOCAL=1 nohup pnpm exec tsx --env-file=../.env src/server.ts >> "$SCRATCH/backend.log" 2>&1 & )
for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/health 2>/dev/null | grep -q 200 && break; sleep 2; done
echo "  backend: $(curl -s -m3 -o /dev/null -w '%{http_code}' http://localhost:8080/health)"

if ! curl -s -m2 -o /dev/null -w '%{http_code}' http://localhost:3000/ | grep -q 200; then
  echo "→ starting client (Next.js)"
  ( cd "$ROOT/client-web" && nohup pnpm exec next dev -p 3000 >> "$SCRATCH/nextjs.log" 2>&1 & )
  for i in $(seq 1 40); do curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null | grep -q 200 && break; sleep 2; done
fi
echo "  client:  $(curl -s -m3 -o /dev/null -w '%{http_code}' http://localhost:3000/)"

echo "→ starting ownership watcher (gives your anonymous browser session the demo project)"
pkill -f "claim-demo-watch" 2>/dev/null; sleep 1
nohup "$HERE/claim-demo-watch.sh" >> "$SCRATCH/watcher.log" 2>&1 &

cat <<EOF

READY.
  Open:  http://localhost:3000/projects/$PROJECT_ID/editor
  (auto anonymous login — do NOT click the Google button; it crashes on the emulator path)
  Export video → Export anyway → wait ~3-4 min (real-time capture per sim) → Download.

  Live backend log:  tail -f $SCRATCH/backend.log
EOF
