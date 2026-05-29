#!/usr/bin/env bash
# dev.sh — reliable Next.js dev server
# Kills stale process on port 3000, raises macOS file limit, starts fresh.
# .next is intentionally NOT deleted — HMR handles file changes, and deleting
# it forces a cold start that makes the EMFILE problem worse.

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Kill anything holding port 3000
echo "→ Freeing port 3000..."
lsof -ti:3000 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 0.3

# 2. Raise the macOS open-file limit for this process tree.
ulimit -n 65536 2>/dev/null || true

# 3. Permanent system-level fix (no effect if already applied or no sudo)
sudo launchctl limit maxfiles 65536 200000 2>/dev/null || true

echo "→ Starting Next.js on http://localhost:3000"
cd "$DIR"
exec node_modules/.bin/next dev -p 3000
