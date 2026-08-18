# Frontend review — client-web / admin-web

Scope covered: `podcast-saas/client-web/{app,components,hooks,lib,middleware.ts}` and
`podcast-saas/admin-web/{app,components,lib}`. Traced primary flows: project open → editor
load → timeline edit → save (VideoPlayer/useEditorPlayback/TimelinePanel/SectionEditor),
upload (VideoUploader, multipart + presigned paths), export dialog → progress
(useProjectExport, useProjectDuplication, podcast studio ExportDialog/AudioStudio), viewer
playback (HLSPlayerShell/useProjectPlayer, PlaylistViewer), and admin auth
(AdminGate/firebase.ts). `pnpm -C podcast-saas --filter client-web typecheck` and
`--filter admin-web typecheck` both reported clean per the baseline; no new compile errors
introduced by anything below.

General note: this codebase carries an unusually large amount of in-line audit history
(comments citing prior findings like "frontend-007", "perf-006", "P0.1"-"P0.8", "cc fix").
Most obvious hook/media-lifecycle bugs in the high-traffic files (`useProjectPlayer.ts`,
`useEditorPlayback.ts`, `useProjectExport.ts`, `useProjectDuplication.ts`, `VideoUploader.tsx`,
`mixEngine.ts`, `useClipBuffers.ts`) have already been hardened by earlier review passes —
cleanup functions, generation counters, and `aliveRef`/`cancelled` guards are consistently
present and correct where checked. The findings below are gaps that survived that hardening.

---

### [P2] Editor's avatar-circles audio taps are never released, leaking Web Audio nodes per project switch
- id: frontend-001
- location: podcast-saas/client-web/components/VideoPlayer.tsx:896-903 (MultiClipPlayer's `<AvatarCirclesOverlay>` usage); leaked resource lives in podcast-saas/client-web/lib/avatarAudioGraph.ts:18 (`taps` map) and is only ever drained by podcast-saas/client-web/components/viewer/useProjectPlayer.ts:3576-3577
- category: bug
- confidence: high
- status: confirmed
- what: `AvatarCirclesOverlay` calls `ensureAvatarAnalyser(els)` (avatarAudioGraph.ts:31) on the
  editor's `hook.videoARef`/`hook.videoBRef` elements every animation frame while avatar circles
  are enabled and visible. That function permanently registers a `MediaElementAudioSourceNode` +
  `GainNode` per `<video>` element in the module-level `taps` Map (avatarAudioGraph.ts:18), and the
  module's own header comment says the entries "are released explicitly via
  releaseAvatarElement() from the player cleanup so unmounted elements don't leak" (perf-006).
  The viewer (`useProjectPlayer.ts`) does call `releaseAvatarElement` on unmount for both its
  video refs. `VideoPlayer.tsx`'s `MultiClipPlayer` (the editor preview player) never imports or
  calls `releaseAvatarElement` anywhere.
- why: Every time the editor for a project with avatar circles enabled is mounted (opening the
  editor, switching between projects in the same session, or navigating away and back), a fresh
  pair of `<video>` elements is created and tapped into the shared graph, and the old elements'
  taps are never removed. The `taps` Map keeps strong references to the detached
  `MediaElementAudioSourceNode`/`GainNode`/old `<video>` elements for the lifetime of the tab,
  so repeated editor visits within one session accumulate live Web Audio graph nodes without
  bound — the exact leak perf-006 was written to close, but only closed on the viewer side.
- evidence: Read avatarAudioGraph.ts in full (only two call sites for `releaseAvatarElement`,
  both in useProjectPlayer.ts:3576-3577); `grep -rn "releaseAvatarElement" podcast-saas/client-web`
  shows no call from VideoPlayer.tsx or any editor-side component. Read VideoPlayer.tsx's
  `MultiClipPlayer` in full — its only cleanup effects (lines 396-399, 526) clear sim timers and
  destroy the b-roll HLS instance, never the avatar taps.
- fix: In `MultiClipPlayer`, add an unmount effect that calls
  `releaseAvatarElement(hook.videoARef.current)` and `releaseAvatarElement(hook.videoBRef.current)`,
  mirroring `useProjectPlayer.ts:3576-3577`. Since both editor and viewer need the same cleanup,
  consider moving it into `AvatarCirclesOverlay` itself (release on unmount using the refs it
  already receives) so neither caller can forget it again.
- effort: S

---

### [P2] Guidance SSE handlers can throw on non-JSON payloads, leaving the UI stuck "busy" and the EventSource open
- id: frontend-002
- location: podcast-saas/client-web/components/SectionEditor.tsx:1017-1045
- category: bug
- confidence: medium
- status: confirmed
- what: `runGuidanceStream`'s `status`, `done`, and `error` SSE listeners each call
  `JSON.parse(e.data)` directly with no `try/catch` (unlike every other `JSON.parse` call site in
  this same file, e.g. lines 883/888/892, which are all wrapped). If the payload is not valid
  JSON — e.g. an upstream proxy/gateway timeout page, a truncated chunk, or a plain-text 5xx body
  forwarded through the stream — `JSON.parse` throws synchronously inside the listener.
- why: A thrown exception inside an `addEventListener` callback aborts only that callback; none of
  the statements after the parse run. For the `done` handler that means `applyGuidanceSim`,
  `setGuidanceBusy(false)`, and `es.close()` never execute — the "Analyzing…"/"Publishing…" spinner
  (`guidanceBusy`) stays true forever and the EventSource connection is never closed (a second
  open connection accumulates on every retry). The same applies to the `error` handler: a
  non-JSON error body means the user never sees `guidanceError` and the busy state never clears,
  so the only way out is a full page reload.
- evidence: Read SectionEditor.tsx:1000-1046 in full; confirmed no try/catch wraps any of the
  three `JSON.parse` calls in this block, in contrast to the guarded parses at lines 883/888/892
  in the same file (which use the same `try { … } catch { /* ignore */ }` pattern this block is
  missing).
- fix: Wrap each `JSON.parse(e.data)` in try/catch; on parse failure, fall back to
  `setGuidanceError('Guidance generation failed')`, clear `guidanceBusy`/`guidanceStatusMsg`, and
  close+null the EventSource — the same terminal cleanup the `onerror` handler already performs.
- effort: S

---

### [P2] Playlist auto-advance countdown interval is never cleared on component unmount
- id: frontend-003
- location: podcast-saas/client-web/components/viewer/playlist/PlaylistViewer.tsx:49, 142-153
- category: bug
- confidence: high
- status: confirmed
- what: `handleProjectComplete` starts a `setInterval` stored in `countdownTimer.current`
  (line 142) that ticks the up-next countdown once a second and eventually calls
  `setCurrentPos(nextPos)`. It is cleared by `clearCountdown()`, which is called from `startAt`,
  `goToLobby`, and `playNextNow` — all user-driven navigation paths. There is no `useEffect`
  cleanup (`return () => clearCountdown()` or equivalent) that runs when `PlaylistViewer` itself
  unmounts.
- why: If the user navigates away from the playlist route (or the parent unmounts this component
  for any other reason) while an auto-advance countdown is in flight, the `setInterval` keeps
  firing every second for the rest of the tab's lifetime — calling `setState` on an unmounted
  component every second, forever, with no way for React to ever stop it. This is exactly the
  "missing cleanup for timers" class of bug the review is scoped to catch, and it sits on the
  playlist auto-advance path, which is exercised on every multi-video playlist view.
- evidence: Read PlaylistViewer.tsx in full; `clearCountdown` (line 105-109) is referenced from
  `startAt`/`goToLobby`/`playNextNow` only — no effect in the component registers it as an unmount
  cleanup. Contrast with the `fullscreenchange` effect two lines below (94-98), which correctly
  returns a cleanup function.
- fix: Add `useEffect(() => () => clearCountdown(), [clearCountdown]);` (or inline the ref clear)
  so the interval is always torn down on unmount, not just on explicit navigation.
- effort: S

---

## Scope notes / clean areas

- `useProjectExport.ts` and `useProjectDuplication.ts`: polling hooks are correctly guarded
  (`aliveRef`, `cancelled`, consecutive-failure bound, effect keyed on the id so cleanup always
  clears the right interval). No findings.
- `VideoUploader.tsx`: presigned/multipart upload paths correctly revoke the duration-probe
  object URL (`measureVideoDuration`), retry with backoff, and abort orphaned multipart uploads
  on failure. No findings.
- `useEditorPlayback.ts` / `useSegmentedPlaybackCore.ts` / `mixEngine.ts` / `useClipBuffers.ts` /
  `useMixWaveform.ts`: HLS/AudioContext lifecycles are torn down correctly on unmount (`hls.destroy()`,
  `ctx.close()`, generation counters guarding stale async completions). No findings.
- `admin-web/lib/firebase.ts` (`AdminFirebaseAuthProvider`): the `onAuthStateChanged` callback is
  async and unguarded against out-of-order resolution if auth state flips twice in quick
  succession (a stale `isAdmin` fetch could resolve after a newer one and overwrite it) — noted
  but not filed as a finding: `AdminFirebaseAuthProvider` mounts once at the app root and is
  realistically driven by a single sequential login, so the race is not reachable on a real user
  path today.
- `middleware.ts`: correctly scoped via `config.matcher`; the per-request backend fetch for every
  `/c/*` page is a latency/perf concern, not a correctness one — signalled to performance-reviewer
  below rather than filed here.

## Signals
See `signals.md` for the one cross-domain handoff filed from this review.
