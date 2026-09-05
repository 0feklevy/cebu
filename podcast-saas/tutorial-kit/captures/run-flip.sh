#!/bin/bash
# Ownership flip runner (local stack only).
set -euo pipefail
cd "$(dirname "$0")/../../backend-api"
exec npx tsx --env-file-if-exists=../.env ../tutorial-kit/captures/flip-ownership.mts "$@"
