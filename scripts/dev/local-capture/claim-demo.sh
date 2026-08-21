#!/usr/bin/env bash
# Local dev helper: hand the seeded demo project to whoever signed in last at
# http://localhost:3000 (the app auto-creates an anonymous user on first load).
# Run AFTER opening the app once in the browser. Local DB only.
set -euo pipefail

PROJECT_ID="00000000-0000-4000-a000-0000000f1c7e"

psql -h localhost -U postgres -d podcast_saas -Atc "
WITH u AS (SELECT id, default_org_id, email, is_anonymous
           FROM users ORDER BY last_seen_at DESC NULLS LAST LIMIT 1)
UPDATE projects
   SET created_by = (SELECT id FROM u),
       org_id     = (SELECT default_org_id FROM u)
 WHERE id = '${PROJECT_ID}'
RETURNING 'project now owned by user ' || created_by;"
