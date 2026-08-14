# Frontend Reviewer — Findings

Scope: `podcast-saas/client-web/{app,components,hooks,lib,middleware.ts}`,
`podcast-saas/admin-web/{app,components,lib}`.

`pnpm -C podcast-saas --filter client-web typecheck` — clean (no errors).
`pnpm -C podcast-saas --filter admin-web typecheck` — clean (no errors).

Method: traced project open → editor load → timeline edit → save, upload, export dialog →
progress, and admin settings screens; grepped for createObjectURL/revokeObjectURL,
addEventListener/removeEventListener, setInterval/clearInterval, JSON.parse and fetch/.json()
call sites across the full scope (165 client-web + 18 admin-web files) and read the surrounding
function for each hit before judging it. Most of this codebase already carries evidence of prior
review passes (comments citing specific finding IDs like `perf-006`, `security-103`, `review F2`);
the three findings below are gaps that survived those passes.

---

### [P1] Guidance SSE handlers crash on a malformed payload and leave "Generate/Publish guidance" permanently disabled
- id: frontend-001
- location: podcast-saas/client-web/components/SectionEditor.tsx:1017-1036
- category: bug
- confidence: high
- status: confirmed
- what: `runGuidanceStream()` opens an `EventSource` and adds three named listeners — `status`
  (line 1018), `done` (line 1021), `error` (line 1031) — each of which does
  `JSON.parse(e.data)` with no `try/catch`. Contrast with the built-in `es.onerror` handler
  (lines 1037-1045), which is deliberately guarded and always resets state with a friendly
  message — the author clearly intended every failure path to leave the UI usable again, but the
  three named-event handlers were left unguarded.
- why: If the server ever emits a `done` or `error` event whose `data` is not valid JSON (a
  truncated write, a proxy/CDN chunking artifact, a backend bug emitting a partial frame before a
  crash — all realistic on a proxied SSE stream), `JSON.parse` throws synchronously inside the
  listener. Because `handled = true` (line 1030) runs *before* the throwing `JSON.parse` call in
  the `error` handler, the fallback `es.onerror` guard (`if (handled) return;`, line 1038) is
  already tripped and will never run for a later generic connection error either. The result: the
  throw aborts the handler before `setGuidanceBusy(false)`, `setGuidanceStatusMsg(null)`,
  `es.close()`, or `guidanceEsRef.current = null` ever execute. `guidanceBusy` stays truthy
  forever, and every action button that gates on it — confirmed via
  `disabled={!!guidanceBusy}` at SectionEditor.tsx:2215, 2223, 2286 — stays permanently disabled.
  The EventSource itself is also never closed (it is closed on unmount only, via the effect at
  line 990). This is exactly the "errors swallowed leaving the UI in a permanent pending state"
  failure mode, except the errors are not swallowed — they're thrown and uncaught, which is worse
  because it also skips the intended fallback (`es.onerror`) that would have shown a message.
- evidence: Read SectionEditor.tsx:1000-1046 in full. Confirmed `handled = true` precedes the
  throwing `JSON.parse` call at line 1031 (so `es.onerror`'s `if (handled) return;` guard is
  already tripped). Confirmed the three action buttons gated on `guidanceBusy` via
  `grep -n "guidanceBusy" SectionEditor.tsx` (lines 2215, 2223, 2286 all `disabled={!!guidanceBusy}`).
  Confirmed the unmount cleanup at line 990 (`useEffect(() => () => { guidanceEsRef.current?.close(); }, [])`)
  is the only other place the EventSource gets closed, so while mounted the stream stays open and
  the busy state stays stuck until the user navigates away and back.
- fix: Wrap each `JSON.parse(e.data)` in its own `try/catch` (mirroring the pattern already used
  elsewhere in this same file at lines 883, 888, 892). On parse failure, still run the reset path
  (`setGuidanceBusy(false)`, `setGuidanceStatusMsg(null)`, `es.close()`,
  `guidanceEsRef.current = null`) and surface a generic "Guidance generation failed" message via
  `setGuidanceError`, the same way the deliberately-guarded `es.onerror` handler already does.
- verify: Add a test/manual repro that dispatches a `done` or `error` MessageEvent with
  non-JSON `data` on a mock EventSource and assert `guidanceBusy` returns to `false` and the
  action buttons re-enable. `pnpm -C podcast-saas --filter client-web typecheck` stays clean.
- effort: S

---

### [P2] Playlist "up next" countdown timer is never cleared on unmount
- id: frontend-002
- location: podcast-saas/client-web/components/viewer/playlist/PlaylistViewer.tsx:49,105-109,132-162
- category: bug
- confidence: high
- status: confirmed
- what: `handleProjectComplete` (line 132) starts a `setInterval` at line 142 and stores its id in
  `countdownTimer` (a plain `useRef`, line 49). It is cleared in three places —
  `clearCountdown()` (called from `startAt`/navigation, `playNextNow`, `goToLobby`) and inline
  inside the interval callback itself when the countdown reaches zero — but there is no
  `useEffect(() => () => clearInterval(countdownTimer.current), [])` (or equivalent) that clears
  it when the component itself unmounts.
- why: If the user navigates away from the playlist page (client-side route change unmounting
  `PlaylistViewer`) during the ~6 s autoplay countdown between items, the interval keeps firing
  every second forever — nothing in the component's lifecycle ever calls `clearInterval` for that
  case. Every other polling/interval-owning effect in this codebase pairs its `setInterval` with a
  `return () => clearInterval(...)` cleanup (verified across all 20 `setInterval` call sites in
  client-web — `ViewerPage.tsx:79-81`, `SharedViewerPage.tsx:86-87`, `BrollPanel.tsx:96-97`,
  `VideoEditor.tsx:451-452,467-468`, `AudioStudio.tsx`, `PodcastEpisodePage.tsx:99-100`,
  `AvatarConversation.tsx:105-106`, `useProjectExport.ts:272-274`,
  `useProjectDuplication.ts:146-148`, `ProjectSettingsPanel.tsx:129-132` all have a matching
  `clearInterval` in the effect's return); `PlaylistViewer.tsx` is the one outlier, because this
  timer is owned by a callback-invoked ref rather than an effect, so it never got the
  unmount-cleanup pass the others did.
- evidence: `grep -n "countdownTimer" PlaylistViewer.tsx` shows only the three call-sites inside
  `clearCountdown`/the interval callback (lines 106, 142, 146) and the `useRef` declaration
  (line 49) — no cleanup effect. Cross-checked all 20 `setInterval(` sites in
  `podcast-saas/client-web` against their nearest `clearInterval`/`return () =>` and confirmed
  every other site pairs cleanly; this is the only unpaired one.
- fix: Add `useEffect(() => clearCountdown, [clearCountdown])` (or an unmount-only
  `useEffect(() => () => { if (countdownTimer.current) clearInterval(countdownTimer.current); }, [])`)
  near the other lifecycle effects in `PlaylistViewer.tsx`.
- verify: Mount `PlaylistViewer`, trigger `handleProjectComplete` with autoplay on, unmount before
  the countdown finishes, and assert no further `setCountdown`/`setCurrentPos` calls occur
  (e.g. via a jest fake-timer advance + spy). `pnpm -C podcast-saas --filter client-web typecheck`
  stays clean.
- effort: S

---

### [P3] `restore()` in the Audio Studio always re-seeds through the mount-time `laneOf`/`durOf`, not the current ones
- id: frontend-003
- location: podcast-saas/client-web/components/podcast/studio/AudioStudio.tsx:217-224 (restore),
  podcast-saas/client-web/components/podcast/studio/useMixDraft.ts:72-76 (reseed)
- category: bug
- confidence: low
- status: suspected
- what: `restore` is `useCallback(..., [showId, episodeId])` with
  `// eslint-disable-next-line react-hooks/exhaustive-deps` (AudioStudio.tsx:223-224), and calls
  `draft.reseed(tl, rev)`. Since `showId`/`episodeId` never change for a mounted episode page,
  `useCallback` returns the same function identity for the component's whole lifetime — which
  means `restore` keeps referencing the `draft` object (and therefore the `reseed` closure) from
  the render where it was first created. `reseed` is itself `useCallback(..., [durOf, laneOf])`
  in `useMixDraft.ts:72-76`, and `durOf`/`laneOf` (AudioStudio.tsx:51-52) get new identities every
  time the `clips` list changes (re-voicing a line calls `setClips`, which changes `durMap` via
  its `useMemo([clips])`, which changes `durOf`'s identity). So the `reseed` that `restore`
  actually calls is pinned to whatever `durOf`/`laneOf` existed at mount, not the current ones.
- why: `reseed` passes `durOf`/`laneOf` into `migrateTimelineToLanes` (useMixDraft.ts:73), which
  only *uses* durations when migrating a legacy (pre-`layout: 'lanes'`) snapshot — the
  `layoutMix(legacy, durOf)` call at useMixDraft.ts:30. For a snapshot already in `'lanes'`
  format (the normal case for anything saved by this app since the migration), the stale
  `durOf`/`laneOf` mostly doesn't matter because that branch returns early. The stale closure
  only bites when: (1) a user re-voices at least one line (changing `clips`, and therefore
  `durOf`'s identity) during the session, and (2) later restores a legacy-format snapshot — at
  which point the gap-conversion math runs against duration data that predates the re-voice.
  That is a narrow, low-frequency path, which is why this is filed at P3/low-confidence rather
  than P1 — but the staleness itself is real and directly traceable, not a guess.
- evidence: Read AudioStudio.tsx:51-52 (`laneOf`/`durOf` useCallback deps), :217-224 (`restore`'s
  own useCallback deps and eslint-disable), and useMixDraft.ts:49-76 (`reseed`'s deps and what it
  passes `durOf`/`laneOf` into). Did not construct a runtime repro (would require staging a
  legacy-format snapshot plus a mid-session re-voice); severity/confidence reflect that.
- fix: Either add `draft` to `restore`'s dependency array (accepting that `restore`'s identity
  will then change on every `clips` mutation), or thread `durOf`/`laneOf` through a ref the way
  `AudioStudio.tsx` already does for `timelineRef`/`buffersRef`/`durMapRef`/`laneOfRef` (lines
  89-96) so `reseed` always reads the current mapping without needing a new closure.
- verify: Save a legacy-format snapshot fixture, re-voice a line (changing `clips`), restore the
  snapshot, and assert the resulting timeline's gaps match a `migrateTimelineToLanes` call made
  with the post-re-voice `durOf`.
- effort: S

---

## Signals (cross-domain, routed via signals.md)

None filed this run — no findings surfaced that clearly belonged to another column (ui-ux,
performance, types-contracts) rather than being simply out of scope for the sweep.
