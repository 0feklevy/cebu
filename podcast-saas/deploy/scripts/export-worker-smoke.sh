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

# ── Stage D: PRODUCTION TOPOLOGY — a nested entry loading ../bridge.js ────────────────────────
# Stage C's fixture is one flat self-contained document, so it cannot fail the v0.1.23 bug: that
# incident was a NESTED entry whose `../bridge.js` lived at the package root and was never staged.
# This stage reproduces the real shape — package-root runtime + nested entry + a module and a
# stylesheet — and requires the FULL handshake, so a package-root regression cannot pass again.
echo "=== STAGE D: production-topology capture (nested entry, ../bridge.js) ==="
WORK_D="$(mktemp -d /tmp/flowvid-capture-smoke-d.XXXXXX)"
IN_D="$WORK_D/input"; OUT_D="$WORK_D/output"
mkdir -p "$IN_D/scene/src" "$OUT_D"
trap 'rm -rf "$WORK" "$WORK_D"' EXIT

# The generated runtime AT THE PACKAGE ROOT — exactly where a real package keeps bridge.js. It
# owns the handshake: SIM_READY on load, SCRIPT_APPLIED on startScript, SIM_PAINTED on first draw.
cat > "$IN_D/bridge.js" <<'JS'
;(function () {
  var ctx = null, frame = 0, running = false;
  function draw() {
    frame += 1;
    var c = document.getElementById('c');
    ctx = ctx || (c && c.getContext('2d'));
    if (ctx) {
      ctx.fillStyle = 'hsl(' + ((frame * 29) % 360) + ',90%,50%)';
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#000'; ctx.font = '48px monospace';
      ctx.fillText('FRAME ' + frame, 40, 190);
      if (frame === 1) window.postMessage({ type: 'SIM_PAINTED' }, '*');
    }
    if (running) requestAnimationFrame(draw);
  }
  window.addEventListener('message', function (e) {
    var d = (e && e.data) || {};
    if (d.type === 'startScript') {
      window.postMessage({ type: 'SCRIPT_APPLIED', token: d.token }, '*');
      if (!running) { running = true; requestAnimationFrame(draw); }
    }
    if (d.type === 'PING_SIM_READY') window.postMessage({ type: 'SIM_READY' }, '*');
  });
  requestAnimationFrame(function () { window.postMessage({ type: 'SIM_READY' }, '*'); });
})();
JS

# The NESTED entry — the shape `findEntryHtml` produces from a folder-ZIP, loading the root bridge
# upward and its own assets downward. If staging ever flattens or re-anchors, this 404s.
cat > "$IN_D/scene/index.html" <<'HTML'
<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="./app.css">
<canvas id="c" width="640" height="360"></canvas>
<script type="module" src="./src/main.js"></script>
<!-- SIM_BRIDGE_SCRIPT_START -->
<script src="../bridge.js?v=smoke"></script>
<!-- SIM_BRIDGE_SCRIPT_END -->
HTML
printf 'html,body{margin:0;background:#000}\n' > "$IN_D/scene/app.css"
printf 'export const ready = true;\n' > "$IN_D/scene/src/main.js"

cat > "$IN_D/capture-spec.json" <<'JSON'
{
  "specVersion": 1,
  "sectionId": "smoke-d",
  "simulationId": null,
  "configHash": "smoke",
  "entryPath": "scene/index.html",
  "entryQuery": "?section=smoke-d&v=smoke",
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
chmod -R a+rX "$IN_D"; chmod a+rwX "$OUT_D"

set +e
timeout 240 docker run --rm "${CAGE[@]}" "${CHROME_CAPS[@]}" \
  --mount "type=bind,src=$IN_D,dst=/input,ro" \
  --mount "type=bind,src=$OUT_D,dst=/output" \
  "$IMAGE"
ENTRY_D_EXIT=$?
set -e
echo "entrypoint exit: $ENTRY_D_EXIT"
[ -f "$OUT_D/result.json" ] || { echo "STAGE-D: FAIL — no result.json written" >&2; exit 1; }
echo "--- result.json ---"; cat "$OUT_D/result.json"; echo
# A package-root regression surfaces HERE, named: "package is missing 1 requested file(s): bridge.js".
[ "$ENTRY_D_EXIT" -eq 0 ] || { echo "STAGE-D: FAIL — entrypoint exited $ENTRY_D_EXIT (see result.json above)" >&2; exit 1; }
grep -q '"status": *"ok"'   "$OUT_D/result.json" || { echo "STAGE-D: FAIL — status is not ok" >&2; exit 1; }
grep -q '"gate": *"passed"' "$OUT_D/result.json" || { echo "STAGE-D: FAIL — sanity gate did not pass" >&2; exit 1; }
grep -q '"frameCount": *60' "$OUT_D/result.json" || { echo "STAGE-D: FAIL — expected 60 frames" >&2; exit 1; }
COUNT_D=$(ls "$OUT_D/frames"/frame-*.jpg 2>/dev/null | wc -l | tr -d ' ')
[ "$COUNT_D" -eq 60 ] || { echo "STAGE-D: FAIL — $COUNT_D frame files, expected 60" >&2; exit 1; }
if cmp -s "$OUT_D/frames/frame-000000.jpg" "$OUT_D/frames/frame-000059.jpg"; then
  echo "STAGE-D: FAIL — first and last frames are byte-identical (static capture)" >&2; exit 1
fi
echo "STAGE-D: PASS — nested entry + ../bridge.js handshake, 60 frames, first/last differ, gate passed"

# ── Stage E: THE REAL DEPENDENCY SHAPE — three.js, offline, WebGL, changing frames ─────────────
# Stages C and D prove the container serves a package and drives the handshake, but both fixtures
# draw with plain canvas 2D and neither imports anything. The v0.1.26 incident lived in the gap:
# the package declared `"three": "https://cdn.jsdelivr.net/npm/three@0.169.0/…"`, the cage has no
# network, the module graph never resolved, and the canvas stayed black with an EMPTY renderer
# string. This stage reproduces that exact shape — CDN import map, real Three.js module graph, a
# real WebGLRenderer — after the trusted offline closure has rewritten it, and demands actual
# WebGL frames. It is the only stage that can fail the dependency bug.
echo "=== STAGE E: offline dependency closure (three.js, WebGL, network-none) ==="
WORK_E="$(mktemp -d /tmp/flowvid-capture-smoke-e.XXXXXX)"
IN_E="$WORK_E/input"; OUT_E="$WORK_E/output"
mkdir -p "$IN_E/scene/src" "$OUT_E"
# The vendor step WRITES into the input tree, and it runs as uid 1000 while this script usually
# runs under sudo — so the directory it must write into would otherwise be root-owned and the
# materialisation dies with EACCES before Chrome is ever started. Made writable here and returned
# to read-only below, which is how production mounts it anyway.
chmod -R a+rwX "$IN_E"
trap 'rm -rf "$WORK" "$WORK_D" "$WORK_E"' EXIT

# The trusted closure, materialised by the SAME code the provider runs. Node resolves the backend's
# compiled modules inside the image, so this exercises the real registry (hashes verified) — not a
# hand-copied vendor tree.
docker run --rm --network none --user 1000:1000 \
  --mount "type=bind,src=$IN_E,dst=/work" \
  --entrypoint node "$IMAGE" -e '
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
(async () => {
  const { loadTrustedRegistry } = await import("/app/backend-api/dist/services/export/capture/dependencies/trustedRegistry.js");
  const reg = await loadTrustedRegistry();
  const three = reg.descriptors().find((d) => d.name === "three");
  if (!three) throw new Error("STAGE-E: the image ships no trusted three pack");
  for (const f of await reg.materialise(three)) {
    const dest = join("/work", f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.content);
  }
  console.log("VENDOR-OK", three.name + "@" + three.version, Object.keys(three.files).length, "files");
})().catch((e) => { console.error("VENDOR-FAIL:", e && e.message); process.exit(1); });
' | tee "$WORK_E/vendor.log"
grep -q 'VENDOR-OK' "$WORK_E/vendor.log" || { echo "STAGE-E: FAIL — trusted vendor materialisation failed" >&2; exit 1; }

# The bridge, at the package ROOT (production topology), owning the handshake.
cat > "$IN_E/bridge.js" <<'JS'
;(function () {
  window.addEventListener('message', function (e) {
    var d = (e && e.data) || {};
    if (d.type === 'startScript') {
      window.postMessage({ type: 'SCRIPT_APPLIED', token: d.token }, '*');
      if (window.__startScene) window.__startScene();
    }
    if (d.type === 'PING_SIM_READY') window.postMessage({ type: 'SIM_READY' }, '*');
  });
  requestAnimationFrame(function () { window.postMessage({ type: 'SIM_READY' }, '*'); });
})();
JS

# The entry: a NESTED document whose import map names the CDN — byte-shaped like production. The
# offline closure must have rewritten it to the local vendor tree by the time Chrome loads it.
cat > "$IN_E/scene/index.html" <<'HTML'
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#000}canvas{display:block}</style>
<canvas id="c" width="640" height="360"></canvas>
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"
  }
}
</script>
<script type="module" src="./src/main.js"></script>
<!-- SIM_BRIDGE_SCRIPT_START -->
<script src="../bridge.js?v=smoke"></script>
<!-- SIM_BRIDGE_SCRIPT_END -->
HTML

# A REAL three.js scene: WebGLRenderer, an addon from the prefix mapping, and motion every frame.
cat > "$IN_E/scene/src/main.js" <<'JS'
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setSize(640, 360, false);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 640 / 360, 0.1, 100);
camera.position.z = 4;
new OrbitControls(camera, canvas);              // proves the PREFIX mapping resolved
scene.add(new THREE.AmbientLight(0xffffff, 1.2));
const mesh = new THREE.Mesh(
  new THREE.TorusKnotGeometry(0.9, 0.32, 96, 16),
  new THREE.MeshStandardMaterial({ color: 0x44ccff, roughness: 0.35, metalness: 0.1 }),
);
scene.add(mesh);

let frame = 0;
let running = false;
function tick() {
  frame += 1;
  mesh.rotation.x = frame * 0.05;
  mesh.rotation.y = frame * 0.07;
  scene.background = new THREE.Color(`hsl(${(frame * 7) % 360}, 70%, 35%)`);
  renderer.render(scene, camera);
  if (frame === 1) window.postMessage({ type: 'SIM_PAINTED' }, '*');
  if (running) requestAnimationFrame(tick);
}
window.__startScene = () => { if (!running) { running = true; requestAnimationFrame(tick); } };
// Render one frame immediately so the very first beginFrame has real WebGL output.
tick();
JS

cat > "$IN_E/capture-spec.json" <<'JSON'
{
  "specVersion": 1,
  "sectionId": "smoke-e",
  "simulationId": null,
  "configHash": "smoke",
  "entryPath": "scene/index.html",
  "entryQuery": "?section=smoke-e&v=smoke",
  "entryFragment": "",
  "startScript": { "simpleUi": false, "autoScript": false, "uiHide": [] },
  "durationSec": 2,
  "fps": 30,
  "width": 640,
  "height": 360,
  "warmupFrames": 30,
  "posterKey": null,
  "output": { "format": "jpeg", "quality": 80, "frameDir": "frames", "namePattern": "frame-%06d.jpg" },
  "wallClockTimeoutSec": 240
}
JSON

# Everything under the input tree was just written by this script (root under sudo); the rewrite
# step runs as uid 1000 and edits the entry document in place, so ownership has to allow it.
chmod -R a+rwX "$IN_E"

# The offline rewrite the provider performs, applied here through the SAME shared function.
docker run --rm --network none --user 1000:1000 \
  --mount "type=bind,src=$IN_E,dst=/work" \
  --entrypoint node "$IMAGE" -e '
const { readFileSync, writeFileSync } = require("node:fs");
(async () => {
  const m = await import("/app/backend-api/dist/../../shared/dist/sim/captureDependencies.js")
    .catch(() => import("shared/sim/captureDependencies"));
  const { planCaptureDependencies, rewriteEntryHtmlForCapture } = m;
  const { loadTrustedRegistry } = await import("/app/backend-api/dist/services/export/capture/dependencies/trustedRegistry.js");
  const reg = await loadTrustedRegistry();
  const p = "/work/scene/index.html";
  const html = readFileSync(p, "utf8");
  const closure = planCaptureDependencies(html, reg.descriptors());
  if (!closure.bootComplete) throw new Error("closure incomplete: " + JSON.stringify(closure.unresolved));
  const out = rewriteEntryHtmlForCapture(html, closure, { neutraliseUnresolvedVisualRefs: true });
  writeFileSync(p, out.html);
  console.log("REWRITE-OK", out.rewrittenSpecifiers.join(" | "));
})().catch((e) => { console.error("REWRITE-FAIL:", e && e.message); process.exit(1); });
' | tee "$WORK_E/rewrite.log"
grep -q 'REWRITE-OK' "$WORK_E/rewrite.log" || { echo "STAGE-E: FAIL — offline import-map rewrite failed" >&2; exit 1; }
grep -q 'cdn.jsdelivr.net' "$IN_E/scene/index.html" && { echo "STAGE-E: FAIL — the CDN import map survived the rewrite" >&2; exit 1; }
chmod -R a+rX "$IN_E"; chmod a+rwX "$OUT_E"

set +e
timeout 300 docker run --rm "${CAGE[@]}" "${CHROME_CAPS[@]}" \
  --mount "type=bind,src=$IN_E,dst=/input,ro" \
  --mount "type=bind,src=$OUT_E,dst=/output" \
  "$IMAGE"
ENTRY_E_EXIT=$?
set -e
echo "entrypoint exit: $ENTRY_E_EXIT"
[ -f "$OUT_E/result.json" ] || { echo "STAGE-E: FAIL — no result.json written" >&2; exit 1; }
echo "--- result.json ---"; cat "$OUT_E/result.json"; echo
[ "$ENTRY_E_EXIT" -eq 0 ] || { echo "STAGE-E: FAIL — entrypoint exited $ENTRY_E_EXIT (see result.json above)" >&2; exit 1; }
grep -q '"status": *"ok"'   "$OUT_E/result.json" || { echo "STAGE-E: FAIL — status is not ok" >&2; exit 1; }
grep -q '"gate": *"passed"' "$OUT_E/result.json" || { echo "STAGE-E: FAIL — sanity gate did not pass (this is the v0.1.26 signature)" >&2; exit 1; }
grep -q '"frameCount": *60' "$OUT_E/result.json" || { echo "STAGE-E: FAIL — expected 60 frames" >&2; exit 1; }
# The renderer string is the proof that a WebGL context was really created — it was EMPTY in the
# v0.1.26 failure, because the module graph never resolved and nothing ever asked for a context.
grep -q '"rendererString": *""' "$OUT_E/result.json" && { echo "STAGE-E: FAIL — renderer string is empty: no WebGL context was created" >&2; exit 1; }
COUNT_E=$(ls "$OUT_E/frames"/frame-*.jpg 2>/dev/null | wc -l | tr -d ' ')
[ "$COUNT_E" -eq 60 ] || { echo "STAGE-E: FAIL — $COUNT_E frame files, expected 60" >&2; exit 1; }
if cmp -s "$OUT_E/frames/frame-000000.jpg" "$OUT_E/frames/frame-000059.jpg"; then
  echo "STAGE-E: FAIL — first and last frames are byte-identical (the scene never animated)" >&2; exit 1
fi
echo "STAGE-E: PASS — three.js resolved offline, WebGL rendered, 60 frames, first/last differ, gate passed"

echo "FLOWVID_SMOKE=PASS (A: chrome cage, B: backend contract, C: entrypoint capture, D: production topology, E: offline dependency closure; mechanism=$MECHANISM)"
