#!/usr/bin/env bash
# dev.sh — reliable Next.js dev server
# Kills stale processes, wipes corrupt cache, raises macOS file limit, then starts fresh.

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Kill anything holding port 3000
echo "→ Freeing port 3000..."
lsof -ti:3000 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 0.3

# 2. Wipe .next so there is never a stale/corrupt build
echo "→ Clearing .next cache..."
rm -rf "$DIR/.next"

# 3. Raise the macOS open-file limit for this process tree.
#    Without this, watchpack hits EMFILE and Next.js silently fails to
#    watch routes, causing random 404s in dev mode.
ulimit -n 65536 2>/dev/null || true

# 4. Permanent system-level fix (no effect if already applied or no sudo)
sudo launchctl limit maxfiles 65536 200000 2>/dev/null || true

echo "→ Starting Next.js on http://localhost:3000"
cd "$DIR"
exec node_modules/.bin/next dev -p 3000
