#!/usr/bin/env bash
# Tests for _lib.sh's release retention and disk guard — run against a `docker` and a `df` shim on
# PATH that record what they were asked, so the policy is exercised, not read.
#
#   bash deploy/scripts/__tests__/lib.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${HERE}/../_lib.sh"

SHIM="$(mktemp -d)"
trap 'rm -rf "${SHIM}"' EXIT
export SHIM_LOG="${SHIM}/log"
: > "${SHIM_LOG}"

# docker: lists a mixed set of tags; refuses to remove one image "in use".
cat > "${SHIM}/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "${SHIM_LOG}"
case "$1 $2" in
  "image ls")
    printf '%s\n' \
      "podcast-saas/backend:v0.3.1" "podcast-saas/client-web:v0.3.1" "podcast-saas/admin-web:v0.3.1" \
      "podcast-saas/backend:v0.3.0" "podcast-saas/client-web:v0.3.0" "podcast-saas/admin-web:v0.3.0" \
      "podcast-saas/backend:v0.2.9" "podcast-saas/client-web:v0.2.9" "podcast-saas/admin-web:v0.2.9" \
      "podcast-saas/backend:v0.2.8" \
      "podcast-saas/backend:<none>" \
      "nginx:1.27-alpine" "certbot/certbot:latest"
    ;;
  "image rm")
    [ "$3" = "podcast-saas/admin-web:v0.2.9" ] && exit 1   # "in use"
    exit 0
    ;;
esac
EOF
# df: free space comes from FAKE_FREE_GB.
cat > "${SHIM}/df" <<'EOF'
#!/usr/bin/env bash
if [ -n "${FAKE_DF_FAIL:-}" ]; then exit 1; fi
printf 'Filesystem 1G-blocks Used Available Use%% Mounted on\n/dev/root 58G 16G %sG 28%% /\n' "${FAKE_FREE_GB:-42}"
EOF
chmod +x "${SHIM}/docker" "${SHIM}/df"
export PATH="${SHIM}:${PATH}"

pass=0; fail=0
check() {   # check <description> <command...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: ${desc}"; fi
}
in_lib() {  # run a function from _lib.sh in a subshell; the exit code is the result
  ( . "${LIB}"; "$@" )
}

# ── retain_app_images ─────────────────────────────────────────────────────────
out="$(in_lib retain_app_images v0.3.1 v0.3.0 2>&1)"
check "removes the older backend tag"          grep -q "docker image rm podcast-saas/backend:v0.2.9" "${SHIM_LOG}"
check "removes the older client-web tag"       grep -q "docker image rm podcast-saas/client-web:v0.2.9" "${SHIM_LOG}"
check "removes an even older tag"              grep -q "docker image rm podcast-saas/backend:v0.2.8" "${SHIM_LOG}"
check "keeps the current release"              bash -c '! grep -q "image rm podcast-saas/[a-z-]*:v0.3.1" "$SHIM_LOG"'
check "keeps the rollback release"             bash -c '! grep -q "image rm podcast-saas/[a-z-]*:v0.3.0" "$SHIM_LOG"'
check "never touches nginx"                    bash -c '! grep -q "image rm nginx" "$SHIM_LOG"'
check "never touches certbot"                  bash -c '! grep -q "image rm certbot" "$SHIM_LOG"'
check "leaves untagged layers to prune"        bash -c '! grep -q "image rm .*<none>" "$SHIM_LOG"'
check "never forces (-f) a removal"            bash -c '! grep -q "image rm -f" "$SHIM_LOG"'
check "an in-use image is kept and said so"    grep -q "kept podcast-saas/admin-web:v0.2.9 (in use" <<<"${out}"
check "reports the count removed"              grep -q "removed 3" <<<"${out}"
check "a 'none' rollback is just a tag nobody has" in_lib retain_app_images v0.3.1 none

# ── require_free_disk_gb ──────────────────────────────────────────────────────
check "passes with room to spare"              env FAKE_FREE_GB=42 bash -c '. "$0"; require_free_disk_gb /var/lib/docker 8' "${LIB}"
check "passes exactly at the floor"            env FAKE_FREE_GB=8  bash -c '. "$0"; require_free_disk_gb /var/lib/docker 8' "${LIB}"
refusal_output="$(env FAKE_FREE_GB=3 bash -c '. "$0"; require_free_disk_gb /var/lib/docker 8' "${LIB}" 2>&1)"; refusal_code=$?
check "refuses below the floor"                [ "${refusal_code}" -ne 0 ]
check "the refusal names the numbers"          grep -q "only 3G free on /var/lib/docker; 8G is the minimum" <<<"${refusal_output}"
check "DEPLOY_ALLOW_LOW_DISK=1 overrides once" env FAKE_FREE_GB=3 DEPLOY_ALLOW_LOW_DISK=1 bash -c '. "$0"; require_free_disk_gb /var/lib/docker 8' "${LIB}"
check "an unreadable df warns, never refuses"  env FAKE_DF_FAIL=1 bash -c '. "$0"; require_free_disk_gb /var/lib/docker 8' "${LIB}"

echo "deploy lib tests: ${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]
