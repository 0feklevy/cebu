#!/usr/bin/env bash
#
# logs.sh — convenience wrapper around `docker compose logs`.
#
# Usage:
#   ./logs.sh                 # tail all services (last 200 lines, follow)
#   ./logs.sh backend         # tail one service
#   ./logs.sh backend worker  # tail several
#   SINCE=1h ./logs.sh nginx  # time-bounded, no follow
#   TAIL=1000 ./logs.sh backend

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"
require_env_file

TAIL="${TAIL:-200}"

if [ -n "${SINCE:-}" ]; then
  compose logs --since "${SINCE}" --tail "${TAIL}" "$@"
else
  compose logs -f --tail "${TAIL}" "$@"
fi
