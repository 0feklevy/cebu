#!/usr/bin/env bash
# Run the storage/DB volume census against production, safely.
#
# WHY THIS EXISTS. The census is a .sql file, so running it means getting three things right at
# once, and the first attempt on the production VM got all three wrong in one line:
#
#   1. the env file is NOT at the repo root — compose loads `../.env` from deploy/, i.e.
#      podcast-saas/.env. Grepping the repo root silently found nothing;
#   2. an unset connection string does not make psql fail loudly — it falls back to a LOCAL unix
#      socket, and the error you get ("is the server running locally?") describes a machine you
#      were not trying to reach;
#   3. the census holds one READ ONLY transaction with session-level SETs, so it must not go
#      through Supabase's TRANSACTION pooler (6543), where consecutive statements can land on
#      different backends and those SETs quietly stop applying.
#
# So this resolves the URL the same way db/migrate.ts does, refuses the transaction pooler for the
# same reason, and never echoes the connection string. (psql may still name the HOST in a
# connection error it writes to the output file; credentials never appear.)
#
#   ./deploy/scripts/run-storage-census.sh [output-file]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$HERE/../.." && pwd)"          # …/podcast-saas
SQL="$HERE/storage-census.sql"
OUT="${1:-/tmp/storage-census-$(date +%Y%m%d-%H%M%S).out}"
ENV_FILE="$PKG_ROOT/.env"

[ -f "$SQL" ] || { echo "census SQL not found at $SQL" >&2; exit 1; }
command -v psql >/dev/null || { echo "psql not installed — sudo apt-get install -y postgresql-client" >&2; exit 1; }

# Read one variable out of the env file without sourcing it (sourcing would export every secret
# in the file into this shell and any child of it) and without ever echoing the value.
read_env() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | head -n1 | sed 's/^["'"'"']//; s/["'"'"']$//'
}

# Same order of preference as backend-api/src/db/migrate.ts, and for the same reason: whichever
# endpoint is session-mode is the one both that runner and this census need.
SRC=''
URL="$(read_env MIGRATION_DATABASE_URL)"; [ -n "$URL" ] && SRC='MIGRATION_DATABASE_URL'
if [ -z "$URL" ]; then URL="$(read_env QUEUE_DATABASE_URL)"; [ -n "$URL" ] && SRC='QUEUE_DATABASE_URL'; fi
if [ -z "$URL" ]; then URL="$(read_env DATABASE_URL)";       [ -n "$URL" ] && SRC='DATABASE_URL'; fi
# An explicitly exported variable still wins, for a one-off against a different endpoint.
if [ -n "${CENSUS_DATABASE_URL:-}" ]; then URL="$CENSUS_DATABASE_URL"; SRC='CENSUS_DATABASE_URL (env)'; fi

if [ -z "$URL" ]; then
  echo "No connection string found." >&2
  echo "Looked for MIGRATION_DATABASE_URL, QUEUE_DATABASE_URL, DATABASE_URL in: $ENV_FILE" >&2
  [ -f "$ENV_FILE" ] && echo "That file exists; these are the variable NAMES it defines:" >&2 \
    && grep -oE '^[A-Z_][A-Z0-9_]*=' "$ENV_FILE" | tr -d '=' | sort | sed 's/^/  /' >&2
  [ -f "$ENV_FILE" ] || echo "That file does NOT exist. On the VM it is /home/ubuntu/cebu/podcast-saas/.env" >&2
  exit 1
fi

# Port test, not hostname: *.pooler.supabase.com serves BOTH modes, and 5432 there is the SESSION
# pooler the deploy docs tell operators to use. Rejecting the host would reject the correct setup.
if printf '%s' "$URL" | grep -qE ':6543(/|\?|$)'; then
  echo "Refusing to run: $SRC points at the TRANSACTION pooler (port 6543)." >&2
  echo "The census runs inside one READ ONLY transaction with session-level SETs; on the" >&2
  echo "transaction pooler those stop applying between statements and the output is unreliable." >&2
  echo "Use the SESSION pooler (5432) or the direct connection — e.g." >&2
  echo "  CENSUS_DATABASE_URL='<session-mode url>' $0" >&2
  exit 2
fi

echo "Running census via $SRC (session-mode) → $OUT"
# ON_ERROR_STOP so a failed section aborts rather than leaving a half-answer that reads complete.
if psql "$URL" -v ON_ERROR_STOP=1 -f "$SQL" > "$OUT" 2>&1; then
  echo "✓ census complete → $OUT"
  echo "  It contains aggregates only — no titles, emails, transcripts, tokens, URLs or keys."
  echo "  Tail:"; tail -n 20 "$OUT" | sed 's/^/    /'
else
  echo "✗ census failed — see $OUT" >&2
  tail -n 20 "$OUT" >&2
  exit 1
fi
