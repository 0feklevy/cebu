#!/usr/bin/env bash
#
# Type-check the BACKEND TEST FILES, which nothing has ever done in CI.
#
# ── WHY A RATCHET AND NOT A CLEAN GATE ────────────────────────────────────────────────────────
# `tsconfig.test.json` was added for finding job-queue-014 and the ledger recorded that finding as
# closed. The config exists and the `typecheck:test` script exists — and no workflow, and no step of
# `release-verify.sh`, has ever invoked either. Grep both and you get nothing. So the gate was
# reported green while the drift it was built to stop carried on: there are 140 type errors across
# 51 test files today, in a repo whose production sources type-check clean.
#
# That is the finding's own warning arriving. Vitest executes TypeScript without checking it, so a
# test can be type-nonsense and still pass — and the concrete damage was already recorded when the
# config was written: exhaustive `{ [N in JobName]: ... }` maps in the queue tests had quietly
# stopped being exhaustive, one missing four of twelve job names and another missing `dub`, while
# the suite stayed green. An exhaustive map that is not exhaustive is worse than no map, because it
# reads as a guarantee.
#
# Turning this on as a clean `must be zero` gate today would mean fixing 140 errors in one pass,
# most of them needing a judgement about whether a cast is hiding a real defect. A gate that cannot
# be turned on is not a gate, and a red build on day one is a build people learn to ignore. So the
# rule is: NOTHING GETS WORSE.
#
#   * a test file that has no errors today may never acquire one
#   * a test file that has errors today may never acquire MORE
#   * fixing errors is always allowed, and the baseline is expected to shrink
#
# The baseline is per FILE rather than a single total on purpose. A total lets one file rot while
# another is cleaned up and still reports success, which is how a ratchet stops being trusted.
#
# ── UPDATING THE BASELINE ─────────────────────────────────────────────────────────────────────
# Only ever downward, and mechanically:
#
#   pnpm --filter backend-api exec tsc --noEmit -p tsconfig.test.json 2>&1 \
#     | grep -E '^src/.*error TS' | sed 's/(.*//' | sort | uniq -c \
#     | awk '{print $1" "$2}' | sort -k2 > .typecheck-test-baseline
#
# A commit that RAISES a number in that file should be refused in review. There is no legitimate
# reason to write a new type error into a test on purpose, and the whole value of this gate is that
# the number is one-way.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "$HERE/../../backend-api" && pwd)"
BASELINE="$API_DIR/.typecheck-test-baseline"

c_r=$'\033[31m'; c_g=$'\033[32m'; c_y=$'\033[33m'; c_z=$'\033[0m'

[ -f "$BASELINE" ] || { printf '%sMissing baseline: %s%s\n' "$c_r" "$BASELINE" "$c_z"; exit 2; }

cd "$API_DIR"

# `|| true` on the compiler, deliberately: a non-zero exit here means "there are errors", which is
# the expected state while the baseline is non-empty. The verdict belongs to the comparison below,
# not to tsc's exit code. Errors are matched on `^src/` so a compiler diagnostic that is not a file
# error — a config problem, an out-of-memory — cannot be silently counted as zero errors and pass.
raw="$(npx tsc --noEmit -p tsconfig.test.json 2>&1 || true)"

# ANY diagnostic that is not a file error means the check did not happen.
#
# The first version of this guard matched `error TS5`, on the reasoning that configuration errors
# live in the TS5xxx range. Mutation-testing it disproved that: an invalid `target` in
# `tsconfig.test.json` emits TS6046, the script counted zero file errors, and it reported "nothing
# got worse" in green — the exact vacuous pass the comment above claims to prevent, from the exact
# gate written to prevent it.
#
# So the rule is structural rather than a list of codes: a real file error begins with `src/`.
# Anything else — a bad option, an unreadable config, a compiler that ran out of memory — is the
# check failing to run, and that is never a pass.
if printf '%s\n' "$raw" | grep "error TS" | grep -qv '^src/'; then
  printf '%sThe compiler did not check the files, so this is not a pass:%s\n' "$c_r" "$c_z"
  printf '%s\n' "$raw" | grep "error TS" | grep -v '^src/' | head -5
  exit 2
fi

current="$(printf '%s\n' "$raw" | grep -E '^src/.*error TS' | sed 's/(.*//' | sort | uniq -c \
  | awk '{print $1" "$2}' | sort -k2 || true)"

now_total=$(printf '%s\n' "$current" | grep -c . || true)
[ -z "$current" ] && now_total=0

fail=0
regressed=""
appeared=""

# Every file that has errors NOW must be in the baseline with at least as many.
while read -r count file; do
  [ -z "${file:-}" ] && continue
  allowed="$(awk -v f="$file" '$2 == f { print $1 }' "$BASELINE")"
  if [ -z "$allowed" ]; then
    appeared="$appeared\n  ${file} (${count} new)"
    fail=1
  elif [ "$count" -gt "$allowed" ]; then
    regressed="$regressed\n  ${file}: ${allowed} → ${count}"
    fail=1
  fi
done <<< "$current"

base_errors=$(awk '{s+=$1} END {print s+0}' "$BASELINE")
now_errors=$(printf '%s\n' "$current" | awk '{s+=$1} END {print s+0}')

if [ "$fail" -ne 0 ]; then
  printf '\n%sBackend test files gained type errors.%s\n' "$c_r" "$c_z"
  [ -n "$appeared" ] && printf '\n%sFiles that were clean and are not any more:%s%b\n' "$c_y" "$c_z" "$appeared"
  [ -n "$regressed" ] && printf '\n%sFiles that got worse:%s%b\n' "$c_y" "$c_z" "$regressed"
  printf '\nVitest runs TypeScript without checking it, so these do not fail the suite — that is\n'
  printf 'precisely why they are worth stopping here. Fix them, or explain in review why the\n'
  printf 'baseline should move up (it should not).\n'
  printf '\nbaseline %s errors · now %s\n' "$base_errors" "$now_errors"
  exit 1
fi

if [ "$now_errors" -lt "$base_errors" ]; then
  printf '%s✔ backend test typecheck: %s errors, down from %s. Update .typecheck-test-baseline.%s\n' \
    "$c_g" "$now_errors" "$base_errors" "$c_z"
else
  printf '%s✔ backend test typecheck: nothing got worse (%s errors across %s files).%s\n' \
    "$c_g" "$now_errors" "$now_total" "$c_z"
fi
