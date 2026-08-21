---
name: flowvid-viewer-player-hardening
description: FlowVid's viewer/player surface (useProjectPlayer.ts, HLSPlayerShell, lib/sim/**) is the most heavily audited code in the repo — where new bugs still hide
metadata:
  type: project
---

As of run `2026-08-15T2109` (supplementary viewer/player pass), `podcast-saas/client-web/components/viewer/**`,
`components/VideoPlayer.tsx`, `components/viewer/HLSPlayerShell.tsx`, and `lib/sim/**`
(`SimRuntimeClient.ts` 2460 lines, `useProjectPlayer.ts` 4042 lines, `transitionCoordinator.ts`,
`SimTransport.ts`, `frameEvidence.ts`, `boundaryClock.ts`, `poolResidency.ts`, `browserFloor.ts`,
`presentationPolicy.ts`) are, by a wide margin, the most extensively pre-reviewed code in this
repo. Every effect cleanup, every HLS/rVFC/rAF/MessageChannel teardown, every two-phase-eviction
race is already annotated with the specific defect it fixed (P0.1-P0.8, F1-F6, "audited"
call-outs with reproduction steps left in the comment). Reading the whole thing chunk-by-chunk
(~9000 lines total across the named files) turned up almost nothing new in the classic
leak/cleanup categories — that work has already been done, more thoroughly than a single
supplementary pass can redo.

**Why this matters:** don't spend review budget re-verifying "does this timer/listener/Hls
instance get cleaned up" in this surface — it is very likely already correct, and grepping for
`removeEventListener`/`clearTimeout`/`.destroy()`/`.dispose()` pairs will mostly confirm that.
[[flowvid-editor-admin-hardening]] documents the same phenomenon in the editor/admin surface;
this is the viewer/player equivalent.

**What actually turned up new (2026-08-15T2109 findings, frontend-viewer-001/002):**
1. A closure-staleness bug, not a missing-cleanup bug: `onTick` in `useProjectPlayer.ts` is
   `useCallback(fn, [])` — frozen at first render forever — and calls `updateBrollOverlay`/
   `updateAudioCutaway`/`updateImageOverlay`, which read `config.broll_clips`/`audio_cutaways`/
   `image_overlays` directly off the closed-over `config` PARAMETER rather than through a ref.
   Contrast: the segment/timeline/simulation path this same `onTick` drives correctly uses
   `segmentsRef.current`/`timelineRef.current` — the file's own convention for exactly this
   problem, applied inconsistently. Not reachable today (every current caller sets `config` into
   state exactly once, never updates it post-mount), but latent.
2. `attachListeners` (video element event listeners: loadedmetadata/timeupdate/play/pause/
   ended/progress/playing) has no matching `removeEventListener` in the mount effect's
   otherwise-exhaustive cleanup. Only reachable under React StrictMode's dev double-invoke
   (DOM node persists across the double effect run) — every real caller mounts a fresh `<video>`
   per instance, so production impact is essentially nil, but it's a genuine violation of
   "cleanup undoes everything the effect did," worth citing at low severity (P3) rather than
   dropping.

**How to apply:** on a future pass over this same scope, the productive hunt is (1) which
`useCallback(fn, [])`/`useCallback(fn, [stableRefDep])` functions close over a plain prop/const
instead of a ref — grep for `config\.` inside functions NOT suffixed `Ref` and check whether the
enclosing `useCallback`'s deps array can ever see that prop change; (2) whether any NEW caller of
`HLSPlayerShell`/`useProjectPlayer` (e.g. a future live-preview or hot-config-reload feature)
starts re-rendering with a changed `config`, which would make finding frontend-viewer-001 an
actual reachable P1/P0 rather than latent; (3) skip re-deriving the HLS/rVFC/MessageChannel
lifecycle correctness from scratch — read the comment above each teardown first, it almost always
already names the exact race and why the current code prevents it.
