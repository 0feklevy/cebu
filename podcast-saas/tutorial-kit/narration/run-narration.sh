#!/bin/bash
# Narration synthesis runner — executes inside backend-api so tsx resolves the backend's
# TypeScript services; loads the LOCAL env from whichever level holds it (workspace root or
# backend-api). DATABASE_URL stays localhost by the standing rule.
set -euo pipefail
cd "$(dirname "$0")/../../backend-api"
exec npx tsx --env-file-if-exists=../.env --env-file-if-exists=.env ../tutorial-kit/narration/synthesize-narration.mjs "$@"
