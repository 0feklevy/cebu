#!/usr/bin/env bash
# Local dev helper: keep the seeded demo project owned by whoever most recently used the app
# (their anonymous browser session). Runs ~5 min then exits. Local DB only.
set -euo pipefail
PROJECT_ID="00000000-0000-4000-a000-0000000f1c7e"
PSQL="psql -h localhost -U postgres -d podcast_saas -Atc"
last_owner=""
for i in $(seq 1 100); do
  row=$($PSQL "
    WITH u AS (SELECT id, default_org_id FROM users
               WHERE is_anonymous=true ORDER BY last_seen_at DESC NULLS LAST LIMIT 1)
    SELECT id::text||'|'||default_org_id::text FROM u" 2>/dev/null || true)
  uid="${row%%|*}"; orgid="${row##*|}"
  if [ -n "$uid" ] && [ "$uid" != "$last_owner" ]; then
    cur=$($PSQL "SELECT created_by::text FROM projects WHERE id='$PROJECT_ID'")
    if [ "$cur" != "$uid" ]; then
      $PSQL "UPDATE projects SET created_by='$uid', org_id='$orgid' WHERE id='$PROJECT_ID'" >/dev/null
      echo "[$(date +%H:%M:%S)] demo project → anonymous user ${uid:0:8}"
      last_owner="$uid"
    fi
  fi
  sleep 3
done
echo "watcher done"
