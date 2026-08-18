#!/usr/bin/env bash
#
# TYPECHECK WHAT THE COMMIT ACTUALLY CONTAINS — not what your working directory happens to hold.
#
# WHY THIS EXISTS. On 2026-08-18 three commits on this branch shipped code that imported modules
# that were not in the commit: `server.ts` importing `hlsRecovery.js` and `corpusRecovery.js`,
# and `HLSTranscoder.ts`/`ffmpegGraph.ts` importing `ffmpegAspect.js`. Every one of them was
# preceded by a green `tsc --noEmit`. The typecheck was not wrong — it was answering a different
# question. Run inside a directory that still holds the untracked files, it proves those FILES are
# consistent with each other. It says nothing about whether the REPOSITORY is.
#
# The failure needs only a plausible habit: stage by explicit path (`git add a b c`), miss a new
# module, verify in place, commit. `git status` shows the leftover as untracked among dozens of
# other untracked files and reads as noise. CI catches it eventually; a teammate pulling the branch
# catches it immediately, in the least pleasant way.
#
# WHAT THIS DOES. Materialises the exact tree the commit would contain — `git write-tree` for the
# staged index, or a commit-ish you name — into a scratch directory, links node_modules and the
# built `shared/dist` in, and typechecks THAT. Nothing untracked can leak in, because nothing
# untracked is there.
#
#   ./deploy/scripts/verify-committed-tree.sh            # the staged index (use before committing)
#   ./deploy/scripts/verify-committed-tree.sh HEAD       # the last commit
#   ./deploy/scripts/verify-committed-tree.sh HEAD~3     # any commit-ish
#
# Add `--test '<vitest args>'` to also run suites against that tree:
#   ./deploy/scripts/verify-committed-tree.sh --test 'src/services/video src/lib'
#
# LIMITS, stated so nobody over-trusts it: it links the working tree's `node_modules` and
# `shared/dist` rather than reinstalling and rebuilding, so it does NOT catch a missing dependency
# in package.json or a stale `shared` build. It answers exactly one question — "does the committed
# source reference anything the commit does not contain" — and answers it definitively.

set -euo pipefail

TARGET="${1:-}"
RUN_TESTS=""
if [[ "${1:-}" == "--test" ]]; then RUN_TESTS="${2:-}"; TARGET=""; fi
if [[ "${2:-}" == "--test" ]]; then RUN_TESTS="${3:-}"; fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
WS="${REPO_ROOT}/podcast-saas"
[[ -d "$WS" ]] || { echo "not a FlowVid checkout: ${WS} missing" >&2; exit 2; }

if [[ -n "$TARGET" ]]; then
  TREE="$(git -C "$REPO_ROOT" rev-parse "${TARGET}^{tree}")"
  WHAT="$TARGET"
else
  # The staged index. Deliberately the default: the moment to catch this is BEFORE the commit.
  TREE="$(git -C "$REPO_ROOT" write-tree)"
  WHAT="the staged index"
fi

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
git -C "$REPO_ROOT" archive "$TREE" | tar -x -C "$SCRATCH"

echo "▸ verifying ${WHAT} (tree ${TREE:0:12}) in ${SCRATCH}"

# Link the things a source tree legitimately does not carry. Symlinks, not copies: fast, and it is
# obvious in the output that they came from outside the tree.
for pkg in backend-api client-web admin-web shared ops/release ops/ship; do
  src="${WS}/${pkg}/node_modules"
  [[ -d "$src" ]] && ln -sfn "$src" "${SCRATCH}/podcast-saas/${pkg}/node_modules" 2>/dev/null || true
done
[[ -d "${WS}/node_modules" ]] && ln -sfn "${WS}/node_modules" "${SCRATCH}/podcast-saas/node_modules" 2>/dev/null || true
[[ -d "${WS}/shared/dist" ]] && cp -R "${WS}/shared/dist" "${SCRATCH}/podcast-saas/shared/dist" 2>/dev/null || true

TSC="${WS}/podcast-saas/node_modules/.bin/tsc"
[[ -x "$TSC" ]] || TSC="${WS}/node_modules/.bin/tsc"
[[ -x "$TSC" ]] || TSC="${WS}/backend-api/node_modules/.bin/tsc"
[[ -x "$TSC" ]] || { echo "no tsc found — run pnpm install first" >&2; exit 2; }

fail=0
for pkg in backend-api shared client-web admin-web; do
  [[ -f "${SCRATCH}/podcast-saas/${pkg}/tsconfig.json" ]] || continue
  printf '  %-12s ' "$pkg"
  if (cd "${SCRATCH}/podcast-saas/${pkg}" && "$TSC" --noEmit) > "${SCRATCH}/${pkg}.log" 2>&1; then
    echo "ok"
  else
    echo "FAILED"
    sed 's/^/      /' "${SCRATCH}/${pkg}.log" | head -25
    fail=1
  fi
done

if [[ -n "$RUN_TESTS" ]]; then
  VITEST="${WS}/backend-api/node_modules/.bin/vitest"
  [[ -x "$VITEST" ]] || VITEST="${WS}/node_modules/.bin/vitest"
  printf '  %-12s ' "tests"
  if (cd "${SCRATCH}/podcast-saas/backend-api" && "$VITEST" run $RUN_TESTS) > "${SCRATCH}/test.log" 2>&1; then
    echo "ok"; tail -4 "${SCRATCH}/test.log" | sed 's/^/      /'
  else
    echo "FAILED"; tail -30 "${SCRATCH}/test.log" | sed 's/^/      /'; fail=1
  fi
fi

if [[ $fail -ne 0 ]]; then
  echo ""
  echo "✗ ${WHAT} does not stand on its own."
  echo "  A module it imports is missing from the tree — almost always a new file you created and"
  echo "  never staged. \`git status --short | grep '^??'\` will show it among the other untracked"
  echo "  files. This is exactly the error a working-tree typecheck cannot see."
  exit 1
fi

echo "✓ ${WHAT} typechecks with nothing untracked present."
