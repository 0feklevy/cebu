#!/usr/bin/env bash
#
# export-worker-smoke.sh — the REAL image smoke test: launch the pinned Chrome inside the
# production-equivalent jail and require it to actually RENDER.
#
# Why this exists: `test -x` and `--version` both passed on the v0.1.21 image whose binary died at
# first real launch ("Invalid file descriptor to ICU data received.", exit 133) because the COPY
# had separated the executable from its CfT distribution (icudtl.dat & friends). Only a render
# proves the runtime packaging AND the sandbox mechanism together.
#
# The jail below is the production argv (containerRunArgs.ts) minus the mounts (no package is
# served; Chrome renders a data: URL). The successful Ubuntu 26.04 verification run
# (runbook §7a) is exactly this command with MECHANISM=sys-admin.
#
# Usage:
#   ./export-worker-smoke.sh <image> [mechanism]
#     image      e.g. podcast-saas/export-worker:v0.1.22
#     mechanism  userns | sys-admin   (default: sys-admin — the Ubuntu ≥23.10 AppArmor reality)
#
# Exit 0 and "FLOWVID_SANDBOX=PASS" on success; nonzero with Chrome's own stderr otherwise.
set -euo pipefail

IMAGE="${1:?usage: export-worker-smoke.sh <image> [userns|sys-admin]}"
MECHANISM="${2:-sys-admin}"
MARKER="FLOWVID-SANDBOX-OK"

CAPS=(--cap-drop ALL)
case "$MECHANISM" in
  userns) ;;
  # BOTH caps are required, experimentally proven: SYS_ADMIN alone dies at
  # sys_chroot("/proc/self/fdinfo/") with exit 133 once the namespace layer is granted.
  sys-admin) CAPS+=(--cap-add SYS_ADMIN --cap-add SYS_CHROOT) ;;
  *) echo "unknown mechanism '$MECHANISM' (allowed: userns, sys-admin)" >&2; exit 2 ;;
esac

# No sandbox-disabling flag and no privileged mode, ever — the POINT of this smoke is that
# Chrome's own sandbox INITIALISES inside the jail. (A unit test pins those flags as absent.)
OUT="$(docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777 \
  --user 1000:1000 \
  "${CAPS[@]}" \
  --security-opt no-new-privileges:true \
  --pids-limit 256 \
  --memory 2048m --memory-swap 2048m --cpus 2 \
  --entrypoint /opt/chrome-headless-shell \
  "$IMAGE" \
  --headless --disable-dev-shm-usage --dump-dom "data:text/html,${MARKER}")"

echo "$OUT"
if printf '%s' "$OUT" | grep -q "$MARKER"; then
  echo "FLOWVID_SANDBOX=PASS (mechanism=$MECHANISM)"
else
  echo "FLOWVID_SANDBOX=FAIL — Chrome exited 0 but the marker did not render" >&2
  exit 1
fi
