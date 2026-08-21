# Linear Video Export — local capture, PR vs dev-only

## What got fixed (and what "perfect" still needs)

The export now **captures the live sims into the master clip, smoothly, at 1x speed.**

- **Smoothness/speed (FIXED):** capture uses CDP `Page.startScreencast` (the compositor pushes
  timestamped frames while the sim animates in real time), then resamples those frames onto an even
  `1/fps` grid (zero-order hold). Replaced the old `page.screenshot()` loop that played ~1.2–1.5×
  fast with stop-motion.
- **Handshake (FIXED, PR-worthy):** the capture driver required a `SCRIPT_APPLIED` ack that the
  shipped sim bridge never sends — only the test fixture did. It now gates on `SIM_PAINTED`.
- **Heavy/WebGL sims (VERIFIED):** boids-3d (thousands of WebGL birds) captures smooth. The
  `--use-gl=angle --use-angle=metal` launch flags keep WebGL on the GPU in new headless.
- **Minimal UI + autoScript (FIXED locally):** the capture now navigates with the viewer's
  `#simboot={"hide":[…]}` boot cloak (the `/sim-public/` proxy turns it into pre-paint hide CSS) and
  sends `startScript`+`simRelayout` without `clearBootHide`, so `simple_ui` sections capture with the
  controls hidden and full-UI sections keep them. Verified: boids-leaders (minimal) → no control
  panel; angry-bird (full) → panel visible.

### Minimal UI is now ARCHITECTURAL (in the PR commit)
- `exportPlan.withBootCloak` appends the viewer's `#simboot={"hide":[…]}` cloak to every scripted
  window's served URL (selectors iff `simple_ui`), the driver sends `simRelayout` and never
  `clearBootHide`, and the container package prep (`packageInput`) bakes the `data-simboot` snippet
  into HTML so the fragment works on the loopback server too. Unit-tested end to end; visually
  verified: Minimal-UI window → controls hidden, full-UI window → controls visible.

### Remaining, for "perfect"
1. **Sims that wait for interaction** (e.g. boids-leaders shows *"Click on the canvas to place
   leaders (0/3)"*) capture their idle/prompt state — they need an **autoScript body** (the sim's
   own generated `setInterval` animation) or synthetic clicks. This is sim-authoring, not capture:
   `auto_script:true` only matters if the sim body implements it.
2. Minimal UI needs the section's `sim_meta.uiControls.hide` set (the editor's Minimal-UI picker);
   a freshly-embedded sim has none until configured.

## Run it locally

Prereq (once): the Firebase Auth **emulator** on `:9099`. If it's not running:
```
cd <scratchpad>/fb-emulator && npx -y firebase-tools emulators:start --only auth --project demo-local
```
Then:
```
~/cebu/run-local-capture.sh
```
Open `http://localhost:3000/projects/00000000-0000-4000-a000-0000000f1c7e/editor` — auto anonymous
login (do **not** click the Google button; it crashes on the emulator path — this is a local-only
cosmetic issue, `firebase.ts` was intentionally left untouched for the PR). Export → Export anyway.

## PR split — keep the backend clean

**PR-worthy (real fixes / observability — safe to ship):**
- `backend-api/src/services/export/capture/driver.ts` (+ `__tests__/driver.test.ts`) — SCRIPT_APPLIED best-effort
- `backend-api/src/services/storage/mediaToken.ts` (+ test) — `exports/` token scope
- `backend-api/src/services/storage/mediaAccess.ts` — export→project resolution
- `backend-api/src/services/storage/LocalStorageAdapter.ts` — tokenized export download URL
- `backend-api/src/server.ts` — `/local-storage` export auth + **path-traversal guard** (security)
- `backend-api/src/services/storage/__tests__/pathSafety.test.ts` — traversal regression test
- `backend-api/src/controllers/v1/export.controller.ts`, `.../ProjectExportService.ts` — export logs
- `client-web/lib/useProjectExport.ts` (console logs), `client-web/components/ExportProgressPanel.tsx` (progress %)

**DEV-ONLY (do NOT include in the PR — local capture harness):**
- `backend-api/src/services/export/capture/localCaptureProvider.ts` — the whole file
- `backend-api/src/queue/registry.ts` — the `resolveLocalCaptureProvider()` line (revert to
  `new ProjectExportService().run(p.exportId)` for the PR)

Both dev-only pieces are gated on `EXPORT_CAPTURE_LOCAL=1` and no-op otherwise, so they are harmless
if they do ship — but production capture is the Linux `beginFrame` container, not this Playwright
path, so they don't belong in the PR.

Versioned dev helpers, in `scripts/dev/local-capture/`: `run-local-capture.sh`, `claim-demo*.sh`,
this README. They used to sit untracked at the repo root, which was a mistake twice over —
untracked files at the root are what blocked a deploy (PR #43), and a tool that only exists on
one laptop is one disk failure from gone while the export-throughput work is still open.
Locations are derived from the script's own path; `LOCAL_CAPTURE_ROOT` and
`LOCAL_CAPTURE_SCRATCH` override them. Nothing here touches production.
