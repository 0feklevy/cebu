#!/usr/bin/env bash
#
# export-worker-smoke.sh — three-stage image smoke, each stage inside the PRODUCTION cage.
#
#   A. Chrome cage smoke      - the pinned browser renders a marker under the full jail.
#   B. Backend contract smoke - the module named by the IMAGE'S OWN EXPORT_CAPTURE_BACKEND_MODULE
#                               loads and yields a real SimCaptureBackend (the v0.1.22 incident:
#                               Stage A passed while every capture container exited 1 here).
#   C. Entrypoint capture smoke - the REAL container entrypoint (node main.js) captures a tiny
#                               DETERMINISTIC, NON-STATIC fixture sim: loopback serving, bridge
#                               handshake, beginFrame pump, frames on /output, result.json. Frames
#                               must differ across the run — a dead compositor cannot pass.
#
# Every stage keeps the proven hardening: network none, read-only rootfs, tmpfs /tmp, non-root,
# cap-drop ALL (+ SYS_ADMIN+SYS_CHROOT only where Chrome runs), no-new-privileges, resource
# limits. No sandbox-disabling flag, no privileged mode, ever (a unit test pins their absence).
#
# Usage:
#   ./export-worker-smoke.sh <image> [mechanism]
#     image      e.g. podcast-saas/export-worker:v0.1.23
#     mechanism  userns | sys-admin   (default: sys-admin — the Ubuntu ≥23.10 AppArmor reality)
#
# Exit 0 only when ALL stages pass.
set -euo pipefail

IMAGE="${1:?usage: export-worker-smoke.sh <image> [userns|sys-admin]}"
MECHANISM="${2:-sys-admin}"
MARKER="FLOWVID-SANDBOX-OK"

CHROME_CAPS=(--cap-drop ALL)
case "$MECHANISM" in
  userns) ;;
  # BOTH caps, experimentally proven: SYS_ADMIN alone dies at sys_chroot("/proc/self/fdinfo/").
  sys-admin) CHROME_CAPS+=(--cap-add SYS_ADMIN --cap-add SYS_CHROOT) ;;
  *) echo "unknown mechanism '$MECHANISM' (allowed: userns, sys-admin)" >&2; exit 2 ;;
esac

# Mirrors buildContainerRunArgv's flag set (containerRunArgs.ts), including --init and
# --stop-timeout, so the smoke exercises the SAME cage production runs — not an approximation.
CAGE=(
  --init
  --stop-timeout 10
  --network none
  --read-only
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777
  --user 1000:1000
  --security-opt no-new-privileges:true
  --pids-limit 256
  --memory 2048m --memory-swap 2048m --cpus 2
)

# ── Stage A: Chrome renders inside the cage ────────────────────────────────────────────────────
echo "=== STAGE A: chrome cage render ==="
OUT_A="$(docker run --rm "${CAGE[@]}" "${CHROME_CAPS[@]}" \
  --entrypoint /opt/chrome-headless-shell "$IMAGE" \
  --headless --disable-dev-shm-usage --dump-dom "data:text/html,${MARKER}")"
echo "$OUT_A"
printf '%s' "$OUT_A" | grep -q "$MARKER" || { echo "STAGE-A: FAIL — marker did not render" >&2; exit 1; }
echo "STAGE-A: PASS (mechanism=$MECHANISM)"

# ── Stage B: the configured backend module satisfies the loader contract ───────────────────────
# Uses the image's OWN env var — no duplicated path that can drift from the Dockerfile.
echo "=== STAGE B: backend module contract ==="
OUT_B="$(docker run --rm "${CAGE[@]}" --cap-drop ALL \
  --entrypoint node "$IMAGE" -e '
import(process.env.EXPORT_CAPTURE_BACKEND_MODULE).then(async (m) => {
  const f = m.createBackend ?? m.default;
  const b = typeof f === "function" ? f() : f;
  if (!b || typeof b.captureSection !== "function" || typeof b.isAvailable !== "function") {
    throw new Error("module does not yield a SimCaptureBackend (createBackend/default missing or wrong)");
  }
  console.log("backend:", b.name, "available:", await b.isAvailable());
  console.log("BACKEND-CONTRACT-OK");
}).catch((e) => { console.error("BACKEND-CONTRACT-FAIL:", e && e.message); process.exit(1); });
')"
echo "$OUT_B"
printf '%s' "$OUT_B" | grep -q 'BACKEND-CONTRACT-OK' || { echo "STAGE-B: FAIL" >&2; exit 1; }
printf '%s' "$OUT_B" | grep -q 'available: true' || { echo "STAGE-B: FAIL — backend reports unavailable inside its own image" >&2; exit 1; }
echo "STAGE-B: PASS"

# ── Stage C: the full entrypoint captures a deterministic, NON-static fixture ──────────────────
echo "=== STAGE C: entrypoint capture (synthetic fixture) ==="
WORK="$(mktemp -d /tmp/flowvid-capture-smoke.XXXXXX)"
INPUT="$WORK/input"; OUTPUT="$WORK/output"
mkdir -p "$INPUT" "$OUTPUT"
trap 'rm -rf "$WORK"' EXIT

# The fixture sim: a canvas whose EVERY frame differs (hue + frame counter), speaking the minimal
# v2 bridge — SIM_READY at load, draw loop starts on startScript, SIM_PAINTED after the first draw.
cat > "$INPUT/index.html" <<'HTML'
<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style>
<canvas id="c" width="640" height="360"></canvas>
<script>
  var ctx = document.getElementById('c').getContext('2d');
  var frame = 0;
  function draw() {
    frame += 1;
    ctx.fillStyle = 'hsl(' + ((frame * 23) % 360) + ',90%,50%)';
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#000'; ctx.font = '48px monospace';
    ctx.fillText('FRAME ' + frame, 40, 190);
    if (frame === 1) window.postMessage({ type: 'SIM_PAINTED' }, '*');
    requestAnimationFrame(draw);
  }
  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.type === 'startScript') requestAnimationFrame(draw);
  });
  window.postMessage({ type: 'SIM_READY' }, '*');
</script>
HTML

cat > "$INPUT/capture-spec.json" <<'JSON'
{
  "specVersion": 1,
  "sectionId": "smoke-c",
  "simulationId": null,
  "configHash": "smoke",
  "entryPath": "index.html",
  "entryQuery": "",
  "entryFragment": "",
  "startScript": { "simpleUi": false, "autoScript": false, "uiHide": [] },
  "durationSec": 2,
  "fps": 30,
  "width": 640,
  "height": 360,
  "warmupFrames": 30,
  "posterKey": null,
  "output": { "format": "jpeg", "quality": 80, "frameDir": "frames", "namePattern": "frame-%06d.jpg" },
  "wallClockTimeoutSec": 180
}
JSON
chmod -R a+rX "$INPUT"; chmod a+rwX "$OUTPUT"

# The PRODUCTION entrypoint: default CMD (node dist/.../isolation/main.js), production mounts.
set +e
timeout 240 docker run --rm "${CAGE[@]}" "${CHROME_CAPS[@]}" \
  --mount "type=bind,src=$INPUT,dst=/input,ro" \
  --mount "type=bind,src=$OUTPUT,dst=/output" \
  "$IMAGE"
ENTRY_EXIT=$?
set -e
echo "entrypoint exit: $ENTRY_EXIT"
[ -f "$OUTPUT/result.json" ] || { echo "STAGE-C: FAIL — no result.json written" >&2; exit 1; }
echo "--- result.json ---"; cat "$OUTPUT/result.json"; echo
[ "$ENTRY_EXIT" -eq 0 ] || { echo "STAGE-C: FAIL — entrypoint exited $ENTRY_EXIT (see result.json above)" >&2; exit 1; }
grep -q '"status": *"ok"'    "$OUTPUT/result.json" || { echo "STAGE-C: FAIL — status is not ok" >&2; exit 1; }
grep -q '"gate": *"passed"'  "$OUTPUT/result.json" || { echo "STAGE-C: FAIL — sanity gate did not pass" >&2; exit 1; }
grep -q '"frameCount": *60'  "$OUTPUT/result.json" || { echo "STAGE-C: FAIL — expected 60 frames (2s × 30fps)" >&2; exit 1; }

FRAMES_DIR="$OUTPUT/frames"
COUNT=$(ls "$FRAMES_DIR"/frame-*.jpg 2>/dev/null | wc -l | tr -d ' ')
[ "$COUNT" -eq 60 ] || { echo "STAGE-C: FAIL — $COUNT frame files, expected 60" >&2; exit 1; }
# NON-STATIC proof: first and last frames must differ byte-wise — a dead beginFrame path cannot pass.
if cmp -s "$FRAMES_DIR/frame-000000.jpg" "$FRAMES_DIR/frame-000059.jpg"; then
  echo "STAGE-C: FAIL — first and last frames are byte-identical (static capture)" >&2; exit 1
fi
# Precise about what was actually checked: the first and last frames differ (the dead-compositor
# signal), NOT that all 60 files are pairwise distinct.
echo "STAGE-C: PASS — 60 frames, first/last differ, gate passed"

echo "FLOWVID_SMOKE=PASS (A: chrome cage, B: backend contract, C: entrypoint capture; mechanism=$MECHANISM)"
