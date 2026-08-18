# Frontend reviewer — viewer/player surface (supplementary pass)

Scope: `podcast-saas/client-web/components/viewer/**`, `components/VideoPlayer.tsx`,
`components/viewer/HLSPlayerShell.tsx`, `lib/sim/**`, `lib/{avatarAudioGraph,simCapability,
simPool,simPoolMode,simTelemetry,sectionInterval}.ts`. This is a second pass behind a first
sweep that already filed three P2s (avatar-tap leak in the editor, guidance SSE JSON.parse,
playlist countdown interval) — none of those are re-reported here.

Method: read `useProjectPlayer.ts` (4042 lines) essentially in full, in ~350-line chunks,
plus `VideoPlayer.tsx`, `HLSPlayerShell.tsx`, `transitionCoordinator.ts`, `SimRuntimeClient.ts`
(timer/dispose paths), `SimTransport.ts`, `frameEvidence.ts`, `boundaryClock.ts`,
`simulationLease.ts`, `rumClient.ts`, `poolResidency.ts`, `browserFloor.ts`,
`presentationPolicy.ts`, `SimSurface.tsx`, `SimPoolOverlay.tsx`, `SimPresentationLayers.tsx`,
`AvatarCircleViz.tsx`, `AvatarCirclesOverlay.tsx`, `avatarAudioGraph.ts`, `useCropOverlay.ts`,
`ChoiceOverlay.tsx`, `ControlsBar.tsx`, `VideoLayer.tsx`, `LessonPlayer.tsx`,
`SharedViewerPage.tsx`, `PlaylistViewer.tsx`, `UpNextSidebar.tsx`, `useSimRuntime.ts`.

**General note, stated up front because it shapes every finding below:** this surface carries
an unusually deep audit history baked directly into the code as comments (P0.1–P0.8, F1–F6,
"audited" call-outs with the specific defect and reproduction each guard exists for). Nearly
every classic media-lifecycle bug this task brief asks to hunt for — unhandled `play()`
rejections, blob URLs, HLS teardown ordering, rVFC/rAF cleanup, two-phase eviction races,
MessageChannel/port leaks, StrictMode double-invoke — has already been through at least one
prior remediation pass, with the reasoning and the regression it fixes left in place as a
comment. `pnpm -C podcast-saas --filter client-web typecheck` is clean; nothing below is a
compile error. The two findings filed are gaps that survived that hardening; both are backed by
a full read of the surrounding function and an explicit trace of the code path.

---

### [P2] `onTick`'s broll/audio-cutaway/image-overlay/branching logic is permanently bound to the `config` object passed on the player's first render
- id: frontend-viewer-001
- location: podcast-saas/client-web/components/viewer/useProjectPlayer.ts:2348 (`updateBrollOverlay`), :2393 (`updateAudioCutaway`), :2435 (`updateImageOverlay`), :321 (`branching`), all invoked from :2712 (`onTick`, `useCallback(..., [])`)
- category: bug
- confidence: high
- status: confirmed
- what: `updateBrollOverlay`, `updateAudioCutaway` and `updateImageOverlay` read
  `config.broll_clips`, `config.clip_overlays`, `config.audio_cutaways` and
  `config.image_overlays` directly off the `config` parameter closed over from whichever render
  defined them (useProjectPlayer.ts:2351, :2395, :2437) — not from a ref. `branching`
  (useProjectPlayer.ts:321, `const branching = config.branching ?? null;`) is the same: a plain
  `const`, re-derived every render, but only ever read inside functions that are themselves
  frozen. `onTick` — the function driving the whole playback loop off the video element's
  `timeupdate` event (useProjectPlayer.ts:3060 `v.addEventListener('timeupdate', () => { if (v
  === videoRef.current) onTick(); })`) — is declared `useCallback(() => {...}, [])`
  (useProjectPlayer.ts:2712 and :2996-2997), so React freezes it at the FIRST render and never
  recreates it. Because `onTick` calls `updateBrollOverlay(gt)`, `updateImageOverlay(gt)` and
  `updateAudioCutaway(gt, …)` by name (useProjectPlayer.ts:2744-2746), it forever calls the
  closures those names were bound to on mount — i.e. mount-time `config`. This is a real
  contrast with the rest of the file: the segment/timeline/simulation path this same `onTick`
  drives (`updateSimOverlay`, the boundary sentinel, the branching choice-point lookup via
  `currentSequence()`) all read `segmentsRef.current`/`timelineRef.current`, refs the file
  explicitly keeps live across renders for exactly this reason (see the file's own header
  comment on why the hook is "all refs, no state"). The broll/cutaway/image/branching path did
  not follow that discipline.
- why: If a caller ever re-renders `HLSPlayerShell`/`useProjectPlayer` with a `config` whose
  `broll_clips`/`clip_overlays`/`audio_cutaways`/`image_overlays`/`branching` differ from what
  was passed at mount (e.g. a live-preview surface, a "refresh config without remounting"
  optimization, or the caption/processing poll in `ViewerPage`/`SharedViewerPage` being extended
  to also carry updated overlay data), the player will keep scheduling b-roll clips, audio
  cutaways, image overlays and branching choice points from the STALE mount-time list for the
  rest of the session — silently, with no error, because every other prop of the config renders
  correctly (segments/timeline are ref-driven and do update). This is exactly the "effect
  captures a stale value instead of tracking it live" class of bug called out in the task brief,
  just inverted: the mount-time snapshot is a plain closed-over object rather than a ref, so
  there is no live source at all for these four fields once the tick loop is bound.
- evidence: Read useProjectPlayer.ts:2340-2446 (the three `update*Overlay` functions, all plain
  `const`s, not `useCallback`), :2712-2997 (`onTick`, confirmed `useCallback(fn, [])`), and
  :3058-3109 (`attachListeners`, itself `useCallback(fn, [onTick, onEnded, scheduleHide,
  showControls])` — but `onTick`'s own identity never changes, so this does not rescue it) and
  :3435-3580 (the mount effect that calls `attachListeners(vA); attachListeners(vB);` once, deps
  `[]`). Cross-checked that the parallel segment/timeline path uses `segmentsRef.current` /
  `timelineRef.current` (refs assigned inside effects/actions that DO run on branching/segment
  changes), confirming the broll/cutaway/image/branching path is the outlier. Checked every
  current call site that constructs a `config` for this hook — `ViewerPage.tsx:33-81`,
  `SharedViewerPage.tsx:32-88`, `PlaylistViewer.tsx:62-91` — and in every one, `config`/`data`
  is written into state exactly once (`setConfig`/`setData` inside a poll loop that calls
  `clearInterval` the moment it succeeds), so today's callers happen not to trigger the stale
  path. The bug is latent under current call sites but real in the code, and the file's own
  convention (route everything the tick loop reads through a ref) is the fix pattern already
  used two paragraphs above it for the exact same problem class.
- fix: Mirror the pattern already used for `segmentsRef`/`timelineRef`: add
  `brollClipsRef`/`audioCutawaysRef`/`imageOverlaysRef`/`branchingRef` (or one combined
  `configRef`), populate them from `config` in a small effect keyed on the relevant config
  slices, and have `updateBrollOverlay`/`updateAudioCutaway`/`updateImageOverlay` and the
  `branching` checks in `onTick`/`onEnded`/`followEdge` read the ref instead of closing over
  `config` directly.
- verify: add a test that mounts `useProjectPlayer` with an initial `config.broll_clips = []`,
  re-renders it with a non-empty `config.broll_clips` (same hook instance, no remount), advances
  fake time into a clip's window, and asserts the b-roll overlay activates. Red before the fix
  (frozen empty array), green after.
- cross: @test-quality — no test in the suite renders `useProjectPlayer`/`HLSPlayerShell` twice
  with a changed `config` to catch this class of staleness; every existing test that touches
  broll/cutaway/image-overlay timing appears to construct the config once at mount.
- effort: M

---

### [P3] `attachListeners` re-registers a full set of video-element listeners on every mount-effect invocation, with no matching removal
- id: frontend-viewer-002
- location: podcast-saas/client-web/components/viewer/useProjectPlayer.ts:3058-3109 (`attachListeners`), called from :3484-3485 inside the mount effect at :3435-3580 (cleanup at :3522-3578)
- category: bug
- confidence: medium
- status: confirmed
- what: `attachListeners(v)` calls `v.addEventListener(...)` seven times (loadedmetadata,
  timeupdate, play, pause, ended, progress, playing) with inline anonymous handlers that are
  never stored anywhere. It is invoked twice per mount (`attachListeners(vA);
  attachListeners(vB);`) from inside the single mount effect at useProjectPlayer.ts:3435-3580.
  That effect's cleanup (useProjectPlayer.ts:3522-3578) is thorough — it destroys every Hls
  instance, clears every timer, disposes every `SimRuntimeClient`, releases avatar audio taps —
  but it never calls `removeEventListener` for anything `attachListeners` added, and there is no
  handle to do so (the listeners are anonymous closures, not named functions kept in a ref).
- why: The mount effect has an empty dependency array, so in ordinary production navigation
  (every current caller mounts a fresh `<video>` element per player instance — `PlaylistViewer`
  keys `HLSPlayerShell` by `project_id`, and `ViewerPage`/`SharedViewerPage`/`LessonPlayer` are
  each a fresh page-level mount with a fresh DOM node) this effect body runs exactly once per
  live `<video>` element and the gap is inert. It becomes live under React StrictMode's
  dev-only mount→cleanup→mount double-invoke: `refs.videoA.current`/`refs.videoB.current` are
  the SAME DOM node across both invocations (StrictMode does not tear down the DOM, only
  re-runs effects), so the second invocation calls `attachListeners` again on the same element
  and adds a second copy of every listener with none of the first copy removed. From then on
  every `timeupdate`/`play`/`pause`/`ended`/`playing` fires the handler logic twice per real
  event for the life of that mount (extra `onTick()` calls, duplicate `merge({ playing: true
  })`, `resumeHlsAfterSim()` invoked twice, etc.) — mostly idempotent state writes, but a
  genuine, unbounded-by-nothing violation of "effect cleanup must undo everything the effect
  did." It would also bite the moment any future caller re-mounts a `HLSPlayerShell` instance
  onto a persisted DOM node (e.g. an `<Activity>`/offscreen-cache pattern, which
  `lib/sim/useSimRuntime.ts:65-67` already explicitly guards against for the sim runtime client,
  showing the pattern is anticipated elsewhere in this codebase but not applied here).
- evidence: Read useProjectPlayer.ts:3058-3109 in full (no `removeEventListener` counterpart
  anywhere in the file for these seven listeners — confirmed via `grep -n
  "removeEventListener"` against the whole file, which lists only the pool-frame message
  listener, the progress-scrub pointer listeners, the keydown listener, and the mousemove/touch
  listener, none of which are these seven). Read the mount effect's cleanup in full
  (:3522-3578) and confirmed it is otherwise exhaustive (Hls destroy x4, every timer ref,
  runtime disposal, choice timer, cutaway/guidance audio pause, avatar tap release) but has no
  entry for these listeners. Confirmed every current call site keys or freshly mounts
  `HLSPlayerShell` per player instance (`PlaylistViewer.tsx:231` `key={currentItem.project_id}`;
  `ViewerPage`/`SharedViewerPage`/`LessonPlayer` are one-per-page-mount), so production
  reachability is StrictMode/dev-remount-pattern only today — noted honestly rather than
  claimed as a live production defect.
- fix: Either wrap `attachListeners` so it stores the handler references (e.g. return a cleanup
  function like the other effects in this file do, or keep a `WeakMap<HTMLVideoElement,
  Array<[string, EventListener]>>` similar to the existing `_hlsErrHandlers` WeakMap pattern
  used for HLS error handlers) and call it from the mount effect's cleanup, or make
  `attachListeners` idempotent by first calling the removal for a video element it has already
  instrumented (track instrumented elements in a `Set` and early-return on a repeat call for
  the same element).
- verify: a test that mounts `useProjectPlayer` under `act(() => {})` twice against the same
  video element (simulating StrictMode) and asserts `addEventListener` was called exactly once
  per event type per element (spy on `HTMLVideoElement.prototype.addEventListener`).
- effort: S

---

## Scope notes / clean areas

- `SimRuntimeClient.ts` timer/dispose paths (`clearAllTimers`, `dispose`, two-phase eviction):
  every timer field is cleared in `clearAllTimers`, `dispose()` calls it, the window `message`
  listener is removed, and a pending eviction promise is force-settled rather than left
  dangling. No findings.
- `SimTransport.ts`: MessageChannel port lifecycle (`teardownChannels`, `closePort`, `close`)
  correctly closes every offered channel including the previously-adopted port on a document
  change, with the exact defect this fixed (`the previously ADOPTED port too, not just the
  pending losers`) documented in the code. No findings.
- `frameEvidence.ts` / `boundaryClock.ts`: rVFC/rAF probes are cancelled deterministically
  (`cancel()` clears the rVFC handle, the rAF handle and the non-arrival timer; `cancel` on the
  boundary sentinel does the same), and both are invoked from `useProjectPlayer`'s mount cleanup
  (`cancelPendingRevealFrames`, `boundarySentinelHandleRef.current?.cancel()`) and from
  `dispatchTransition`'s `CANCEL_FRAME_EVIDENCE`/`endHandoff` paths. No findings.
- `transitionCoordinator.ts`: pure reducer, exhaustively guards every event against a stale
  `generation`, and `revealsWithoutEvidence` is exported specifically so the "never reveal
  without evidence" invariant is checked rather than assumed. Traced the `EXIT_REQUESTED` →
  `SOURCE_ISSUED` → `MEDIA_READY` ordering against `beginCoordinatedExit`'s actual dispatch
  order in useProjectPlayer.ts:1621-1628 and confirmed they agree (a plausible bug I checked
  for and ruled out: `MEDIA_READY` dispatched before `SOURCE_ISSUED` would silently no-op the
  phase transition — it is not).
- `useCropOverlay.ts`, `AvatarCircleViz.tsx`: both RAF loops are cancelled in their effect
  cleanups; the crop-metadata fetch writes into a ref (not React state), so no
  setState-after-unmount risk even without an explicit cancellation flag.
- `useSimRuntime.ts`: explicitly handles the StrictMode/`<Activity>` double-invoke case that
  frontend-viewer-002 above does not (`clientRef.current = null` on dispose, so a stale disposed
  client cannot be reused by a remount) — cited as evidence that this codebase already knows the
  pattern and applies it inconsistently between the two effects that need it.
- Traced `resumeFromSim`'s coordinated-exit / legacy-reload branch (useProjectPlayer.ts:3877-
  3997) and the `beginCoordinatedExit`/`cancelCoordinatedExit` pair against every call site that
  can interrupt a handoff (`loadSegment`, a scrub, the unmount cleanup) — each cancels or
  replays through the same generation-guarded path; found no wedge state.

## Signals
None filed — no cross-domain issue surfaced outside this column during this pass.
