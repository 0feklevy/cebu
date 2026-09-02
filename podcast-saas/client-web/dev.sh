#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Freeing port 3000"
lsof -ti:3000 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 0.5

cd "$DIR"

export WATCHPACK_POLLING=true
export CHOKIDAR_USEPOLLING=true
export NEXT_TELEMETRY_DISABLED=1

ulimit -n 65536 2>/dev/null || true

LOG_FILE="${DEV_LOG:-/tmp/nextjs-dev.log}"
: > "$LOG_FILE"

echo "ulimit: $(ulimit -n)"
echo "Log: $LOG_FILE"
# The car-mode player's on-device VAD assets are served from public/vad/ (git-ignored) — copied
# here exactly as the build does, so a fresh checkout does not 404 on /vad/*.
node scripts/copy-vad-assets.mjs
echo "Starting Next.js with polling watcher"
pnpm exec next dev -p 3000 2>&1 | tee "$LOG_FILE"
