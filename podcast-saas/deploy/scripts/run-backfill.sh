#!/usr/bin/env bash
#
# run-backfill.sh — run the URL backfill inside the deployed backend image and print
# ONLY its machine-readable JSON report on stdout (logs go to stderr).
#
#   run-backfill.sh                                  # report / dry-run (no writes)
#   run-backfill.sh --apply                          # apply IF the plan is safe (script self-blocks otherwise)
#   run-backfill.sh --apply --approve-unsafe         # apply with recorded human approval
#   run-backfill.sh --apply --max-affected 100       # raise the policy ceiling consciously
#
# Exit codes bubble up from the script: 0 ok, 2 blocked-by-policy, 1 error.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"
require_env_file

RAW="$(mktemp)"
trap 'rm -f "${RAW}"' EXIT

set +e
compose run --rm --no-deps backend node dist/scripts/backfill-localhost-urls.js --json - "$@" > "${RAW}" 2>&2
rc=$?
set -e

# Everything except the sentinel JSON block goes to stderr for the humans.
sed '/^---URL-BACKFILL-REPORT-JSON---$/,/^---END-URL-BACKFILL-REPORT-JSON---$/d' "${RAW}" >&2 || true

# The JSON block (if any) is the ONLY stdout output.
sed -n '/^---URL-BACKFILL-REPORT-JSON---$/,/^---END-URL-BACKFILL-REPORT-JSON---$/p' "${RAW}" | sed '1d;$d'

exit "${rc}"
