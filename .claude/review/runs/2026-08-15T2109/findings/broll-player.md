# B-roll player review — "b-rolls jump in the wrong place"

Scope: `podcast-saas/client-web/components/viewer/useProjectPlayer.ts`, `HLSPlayerShell.tsx`,
`components/viewer/types.ts`, and `components/VideoPlayer.tsx` (editor preview, explicitly in
scope as "the b-roll/overlay rendering path around it").

`pnpm -C podcast-saas --filter client-web typecheck` — green, no errors. This bug is a runtime
logic defect invisible to the type system and, per the brief, uncaught by the 1389 vitest tests
and 6 Playwright suites — none of them appear to re-fetch `player-config` mid-session or assert
overlay placement against a config that changed after mount.

## Verdict on the three suspects, ranked

**Suspect 1 (stale config closure) is CONFIRMED and is the primary mechanism. Rank #1, fix first.**
**Suspect 2 (first-match-wins ordering) is CONFIRMED as a real but secondary defect. Rank #2.**
**Suspect 3 (drift correction) is REFUTED as an independent cause — the 1.0s resync is fed by
the same stale data as #1, so it cannot explain a wrong-clip jump beyond what #1 already does.
Rank #3 (worth tightening, not the root cause).**

---

### [P1] `onTick`'s b-roll/audio/image overlay logic is frozen to the FIRST `config` the player ever received, and `config` provably changes post-mount in the public viewer
- id: broll-player-001
- location: podcast-saas/client-web/components/viewer/useProjectPlayer.ts:2712-2997 (onTick, `useCallback(fn, [])`), reading `config.broll_clips`/`config.clip_overlays` at :2351, :2751; `config.audio_cutaways` at :2395; `config.image_overlays` at :2437
- category: bug
- confidence: high
- status: confirmed
- what: `onTick` is `useCallback(fn, [])` — React returns the exact closure created at the hook's
  first render, forever. That closure calls `updateBrollOverlay`, `updateAudioCutaway`,
  `updateImageOverlay` and inlines `config.broll_clips` directly (:2751) for the pre-warm lookahead.
  All of these read the `config` **function parameter** of `useProjectPlayer`, not a ref. Every
  seek-driven call site that also invokes these functions is equally frozen: the progress-scrub
  effect (`useProjectPlayer.ts:3583`, closes `}, []);` at :3719), the arrow-key seek effect
  (`:3815`, deps `[startPlayback, togglePlay, showControls, loadSegment]` — none of which depend
  on `config`), and `resumeFromSim`'s `commit` (:3913, calls `updateBrollOverlay` at :3962). There
  is no `configRef` anywhere in the file (`grep -n configRef` returns nothing) — unlike
  `segmentsRef.current`/`timelineRef.current`, which the sibling segment/simulation branches of the
  same `onTick` correctly consult and which get mutated explicitly by branch-navigation and
  duration-sync code. B-roll/audio-cutaway/image-overlay data has no such ref; it is the one
  category of overlay state with no live-update path at all.
- why: the premise this was previously rated P2 on — "config is set into state exactly once and
  never updated post-mount" — is false. Traced the only real caller,
  `podcast-saas/client-web/components/viewer/ViewerPage.tsx:33-81`: the `useEffect` that fetches
  `/player-config` and calls `setConfig(data)` has dependency array `[projectId, authLoading,
  getIdToken]` (line 81). `getIdToken` comes from `useAuth()` →
  `podcast-saas/client-web/lib/firebase.ts:158-162`, whose context value is provided at
  `firebase.ts:139-155` as a **brand-new object literal on every render of `FirebaseAuthProvider`**,
  containing `getIdToken` as a **plain `async () => {...}` defined inline at `firebase.ts:114`, not
  wrapped in `useCallback`**. `FirebaseAuthProvider` is mounted once, at the tree root
  (`podcast-saas/client-web/app/layout.tsx:60`), wrapping every page including the viewer. Its own
  state (`user`, `loading`) is set from `onAuthStateChanged` (`firebase.ts:97-112`), and it also
  re-renders whenever ITS parent, `ThemeProvider` (`lib/theme.tsx:41`), re-renders — `ThemeProvider`
  holds `theme`/`resolvedTheme` state that changes on any `setTheme()` call from elsewhere in the
  app, or the OS dark-mode media-query listener at `theme.tsx:52-58`. Any of these — a second
  browser tab signing in/out (Firebase Auth syncs auth state across tabs, re-firing
  `onAuthStateChanged` in every open tab including a viewer mid-playback), a theme toggle
  elsewhere in the app, or an OS color-scheme flip while the video plays — gives `getIdToken` a
  new identity. That re-fires ViewerPage's effect: it calls `check()` again, which does NOT check
  whether it already has a config — it unconditionally re-fetches `/player-config` and, since the
  project is already ready, calls `setConfig(data)` again with a **new object** (:66). React does
  not remount `HLSPlayerShell` (no `key` on it in `ViewerPage.tsx:118`), so `useProjectPlayer` runs
  again with a new `config` argument on the same hook instance — proving the value genuinely
  changes while the player is live. But because every consumer of b-roll/overlay data is frozen at
  mount as shown above, this refetch is a silent no-op for playback: the viewer keeps using
  whatever `broll_clips`/`clip_overlays`/`audio_cutaways`/`image_overlays` array it fetched on the
  VERY FIRST load, for the entire session, no matter how many times the config is corrected
  server-side afterward. If the first fetch raced a backend job that later de-duplicated or
  re-timed b-roll entries (the "known duplicate-append job bug" referenced in the brief), the
  player never sees the fix — it keeps placing b-roll clips at their original, wrong offsets for
  as long as the tab stays open. That reads exactly as "b-rolls jump in the wrong place": the
  editor/author sees corrected data on their next page load, but any viewer who already had the
  page open keeps seeing the old placement, forever, with no visible error.
- evidence: read `useProjectPlayer.ts:2348-2446` (the three update functions closing over the
  `config` parameter), `:2712` and `:2997` (onTick's `[]` dep array), `:3583`/`:3719` (scrub
  effect's `[]` dep array), `:3815`/`:3861` (keydown effect deps, none config-derived), `:3913`-
  `:3962` (`resumeFromSim`'s `commit` calling the same frozen `updateBrollOverlay`); read
  `ViewerPage.tsx:20-81` end to end (the poll effect, its deps, and the unconditional `setConfig`
  inside `check()`); read `lib/firebase.ts:93-162` (unmemoized context value, `getIdToken` inline
  async arrow with no `useCallback`); read `lib/theme.tsx:41-69` (state that re-renders
  `ThemeProvider`, `FirebaseAuthProvider`'s parent); read `app/layout.tsx:54-66` (provider nesting
  at the root, so this reaches every viewer page); confirmed `grep -n configRef
  useProjectPlayer.ts` returns nothing — there is no ref-backed mirror of `config` anywhere in the
  file for ANY field, so this is not b-roll-specific machinery gone wrong, it is the complete
  absence of a live-config path.
- fix: mirror the pattern the file already uses for segments/timeline: add
  `const configRef = useRef(config); configRef.current = config;` (assigned unconditionally in the
  render body, the same idiom already used for `onProjectCompleteRef`/`onNavigateRef` at
  `useProjectPlayer.ts:328-331`), then change `updateBrollOverlay`, `updateAudioCutaway`,
  `updateImageOverlay`, and the :2751 pre-warm lookahead to read `configRef.current.broll_clips` /
  `.clip_overlays` / `.audio_cutaways` / `.image_overlays` instead of the closed-over `config`
  parameter. Separately (defense in depth, not a substitute): `ViewerPage.tsx`'s poll effect should
  not re-run its fetch once `config` is already set — guard `check()` with a ref
  (`hasLoadedRef.current`) so an unstable `getIdToken` identity can only matter before first load,
  and depend on a stable token-getter (wrap `getIdToken` in `useCallback` in `firebase.ts`, or drop
  it from the dependency array with a documented ref pattern) rather than relying on effect
  idempotency to save it.
- verify: add a test that mounts `useProjectPlayer` with a config containing one b-roll clip at
  offset 10s, ticks past it, then re-renders the hook with a NEW config object whose only change is
  that clip's `global_offset_sec` moved to 40s, ticks again at t=10s and asserts the overlay is
  now silent (not still showing the clip that "shouldn't" be there per the corrected config) —
  red before the fix (frozen closure still shows it), green after. Also add a Playwright case that
  triggers a second `/player-config` fetch while the viewer is playing (e.g. simulate the auth
  context re-rendering) and asserts b-roll placement reflects the LATEST fetch, not the first.
- cross: none — this is fully inside the frontend column, though the "known duplicate-append job
  bug" that produces the corrected-then-reverted data is backend-owned; noted in signals.md.
- effort: M

### [P2] `.find()` over the concatenation of `broll_clips` and `clip_overlays` has no ordering guarantee or overlap tie-break
- id: broll-player-002
- location: podcast-saas/client-web/components/viewer/useProjectPlayer.ts:2351-2355
- category: bug
- confidence: high
- status: confirmed
- what: `const brollClips = [...(config.broll_clips ?? []), ...(config.clip_overlays ?? [])];
  const clip = brollClips.find((b) => gt >= b.global_offset_sec && gt < brollEnd) ?? null;`. If two
  entries — whether both `broll_clips`, both `clip_overlays`, or one of each — have overlapping
  `[global_offset_sec, global_offset_sec + (end_sec - start_sec))` windows, `.find()` silently picks
  whichever one appears first in the concatenated array. There is no sort, no priority field, no
  z-order, and no de-dup by id anywhere in this function or in `types.ts` (`BrollClip`/`ClipOverlay`
  at types.ts:78-96 carry no ordering/priority field at all). The array order is whatever
  `config.broll_clips`/`config.clip_overlays` arrived in from the backend — this file has no
  visibility into that ordering and cannot assume it is offset-sorted or duplicate-free.
- why: given the brief's context of a known duplicate-append job that can create overlapping
  entries, this is the second, independent way "the wrong clip plays" can happen — not because the
  data is stale (finding 001) but because, even with perfectly fresh data, two valid-looking
  entries covering the same instant resolve by accidental array position, not by any authored
  intent (e.g. "latest edit wins" or "explicit z/priority wins"). A backend fix that appends a
  corrected entry rather than replacing the old one (exactly what a duplicate-append bug does) will
  keep the OLD entry winning forever, because `.find()` returns the first match and the old one
  was appended first.
- evidence: read lines 2348-2390 in full; read `types.ts:78-96` for `BrollClip`/`ClipOverlay` —
  neither declares a priority/updated-at/z-index field the client could tie-break on. No sort call
  anywhere between the spread at :2351 and the `.find()` at :2352.
- fix: minimal client-side mitigation: when clips overlap, prefer the one with the LATER
  `global_offset_sec`-adjusted match... but overlap by definition means both match the same `gt`,
  so offset alone can't disambiguate. The correct fix is a data contract, not a client heuristic —
  flagged to backend/types-contracts below. Client-side, at minimum, replace `.find()` with a
  reduce that logs (via `simTelemetry` or equivalent) when more than one clip matches the same
  `gt`, so an overlap in production is observable instead of silently resolved by array order.
- verify: unit test with two `BrollClip` entries whose windows overlap by 2s; assert the currently-
  selected clip and that a telemetry/dev-warning event fires exactly once per overlap entry into a
  new window (not once per tick).
- cross: @types-contracts-reviewer — the actual fix (a `priority`/`updated_at` field, or a backend
  guarantee that `broll_clips`/`clip_overlays` are never allowed to overlap) is a contract decision,
  not something the player can correctly infer from timing alone.
- effort: S (client mitigation) / needs backend contract change for a real fix

### [P3] 1.0s drift-resync tolerance is inherited from finding 001's stale data, not an independent bug — tighten but do not chase separately
- id: broll-player-003
- location: podcast-saas/client-web/components/viewer/useProjectPlayer.ts:2382-2389 (b-roll), :2418-2429 (audio cutaway)
- category: bug
- confidence: medium
- status: confirmed
- what: `if (Math.abs(actualBrollTime - expectedBrollTime) > 1.0) { refs.videoBroll.current.currentTime
  = Math.max(0, expectedBrollTime); }`. This branch only runs when `clip?.id === activeBrollRef.current?.id`
  — i.e., it corrects DRIFT within the same clip, it never re-selects which clip is active. Traced
  every seek path (`endScrub` at :3612-3653, arrow-key seek at :3829-3855, `resumeFromSim`'s commit
  at :3877-3963) — all three call `updateBrollOverlay(targetGlobal)` directly after computing the
  new global time, so a seek re-evaluates clip SELECTION immediately (via the `clip?.id !==
  activeBrollRef.current?.id` branch at :2357) rather than relying on the 1.0s tolerance to catch
  up. The 1.0s branch only fires for small (<what should be sub-frame) timeupdate-driven jitter
  within an already-active clip, which is a reasonable, bounded correction and not itself a source
  of visible "wrong clip" jumps.
- why: rated down from the brief's "examine closely" framing because tracing every call site shows
  seeks are handled by clip re-selection, not by the drift branch — the drift branch cannot explain
  a wrong CLIP playing, only an up-to-few-second visible stutter/snap within the correct clip on a
  buffering stall. It is real (1.0s is a generous window — a 900ms-off b-roll plays silently
  wrong-positioned footage for up to a second before snapping), but it is downstream of finding 001:
  since `expectedBrollTime` is computed from the same frozen `config` clip object, tightening this
  tolerance does nothing to fix misplaced clips — it only affects how quickly drift within a
  correctly-selected clip is caught.
- evidence: read the three seek call sites listed above in full; confirmed each calls
  `updateBrollOverlay` with the seek's OWN target time, which goes through the clip-selection
  branch (:2357-2381), not the drift branch (:2382-2389), whenever the target clip differs from
  `activeBrollRef.current`.
- fix: lower the tolerance from 1.0s to ~0.3s (matching the `SECTION_BOUNDARY_EPSILON_SEC` scale
  used elsewhere in this file) to reduce the worst-case visible desync window; low priority, do
  after finding 001.
- verify: existing/added drift unit test asserting resync fires at the new threshold.
- cross: none
- effort: S

## Suspect not confirmed: id collision between `broll_clips` and `clip_overlays`
Checked whether a `BrollClip` and a `ClipOverlay` could share an `id` and be treated as "the same
clip" at `activeBrollRef.current?.id` (useProjectPlayer.ts:2357). `types.ts:78-96` gives both
`id: string` with no documented namespace, but per `stack.md` §4 the schema uses `uuid` primary
keys throughout (145 uuid columns) — if `broll_clips.id` and `clip_overlays.id` (or whatever the
backing tables are named) are both database UUIDs, cross-table collision probability is
negligible and not a realistic production mechanism. This is a data-contract question I cannot
settle from the client alone; flagged to types-contracts/database in signals.md rather than filed
as a client finding, since a wrong claim here would be exactly the kind of finding the protocol
says costs more than ten missed P3s.

## Editor preview (`VideoPlayer.tsx`) — investigated per orchestrator's specific hypothesis, REFUTED there
The orchestrator asked me to verify whether an editor-side PATCH `/sections` response, spliced into
state per commit 8248936, reproduces the SAME "frozen closure" mechanism as finding 001 inside the
editor's own preview player. It does not, for two independent reasons, both verified by reading the
code (not asserted):

1. **Different implementation.** The editor (`VideoEditor.tsx`) does not use `useProjectPlayer.ts`
   at all — `grep -rln "useProjectPlayer" client-web` shows only `HLSPlayerShell.tsx` and its own
   tests. The editor renders `components/VideoPlayer.tsx`'s `MultiClipPlayer`, a separate component
   with its own b-roll implementation.
2. **The editor's b-roll effects are not frozen.** `activeBrollSection` is computed fresh every
   render in `VideoEditor.tsx:507` (`sectionAtPlayhead(...)`, inline in the render body — always
   current React state, not a ref/closure) and passed as a prop. `VideoPlayer.tsx`'s seek effect
   (`:528-542`) only re-runs on `activeBrollSection?.id` change, so repositioning the SAME clip
   (same id, new `start_sec`/`global_offset_sec`) would not re-trigger IT — but the separate drift-
   resync effect at `VideoPlayer.tsx:552-563` depends on `[hook.globalTime]`, which the file's own
   comment states changes at "timeupdate rate (~8-10 Hz)". That effect recomputes `expected` from
   whatever `activeBrollSection` prop is current AT THAT RENDER (a fresh closure each render, unlike
   `useProjectPlayer`'s `useCallback(fn, [])`), and self-corrects any drift over the 1.0s tolerance
   within roughly one tick. So a mid-session section edit in the editor self-heals within ~1s; it
   does not silently persist for the rest of the session the way finding 001 does in the public
   viewer.

Verdict: the orchestrator's specific chain (author drags a b-roll → PATCH splice → frozen closure
→ permanent editor-preview misplacement) does not hold — the editor has no equivalent of the
frozen `onTick`. The PUBLIC VIEWER mechanism (finding broll-player-001) is real, independently
verified, and is the one that matches "b-rolls jump in the wrong place" as a production complaint
(a viewer session outlasting a data correction), not the editor-drag scenario. I looked for the
editor's own version of "first-match-wins" (whether `sectionAtPlayhead` in
`lib/sectionInterval.ts`, called from `VideoEditor.tsx:507`, has the same ordering gap as finding
002) but `VideoEditor.tsx`/`lib/sectionInterval.ts` are outside this agent's assigned scope
(`useProjectPlayer.ts`, `HLSPlayerShell.tsx`, `VideoPlayer.tsx`, `types.ts`) — signaled below for
whichever agent owns the editor surface.
