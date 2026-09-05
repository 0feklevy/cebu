#!/bin/bash
# Boot the LOCAL backend with welcome-seeding enabled: the normal local env PLUS a second
# env-file carrying the three WELCOME_* vars (never edits .env). Template/playlist ids are
# read from TEMPLATE.json (written by build-template.mjs).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TPL_JSON="$HERE/TEMPLATE.json"
[ -f "$TPL_JSON" ] || { echo "TEMPLATE.json missing — run build-template first"; exit 1; }

SEED_ENV="$HERE/.seed-env.local"
node -e "
const t = require('$TPL_JSON');
const pid = t.demo?.projectId ?? '';
const pl  = t.playlist?.id ?? '';
if (!pid) { console.error('no demo project id in TEMPLATE.json'); process.exit(1); }
require('fs').writeFileSync('$SEED_ENV',
  'WELCOME_SEED_ENABLED=true\nWELCOME_TEMPLATE_PROJECT_ID=' + pid +
  (pl ? '\nWELCOME_TEMPLATE_PLAYLIST_ID=' + pl : '') + '\n');
console.log('seed env written for template', pid);
"
cd "$HERE/../../backend-api"
exec npx tsx --env-file=../.env --env-file="$SEED_ENV" src/server.ts
