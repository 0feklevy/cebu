# Anam avatar startup latency — client-side root-cause investigation

Scope: `podcast-saas/client-web/components/avatar/**`, `lib/avatarAudioGraph.ts`, `next.config.ts`,
import graph for `@anam-ai/js-sdk`. Backend half (`/api/v1/avatar/start`, `/end`, concurrency
allocation) is out of scope — signalled separately.

## Ordered sequence of awaits, click → first avatar frame

1. User clicks "Ask!" → `AskAvatarButton` → `setAvatarOpen(true)` (`ViewerPage.tsx:122`).
2. `AvatarPopup` token-fetch effect fires: `await startAvatarSession(undefined, projectId)` —
   `podcast-saas/client-web/components/avatar/AvatarPopup.tsx:56` → POST `/api/v1/avatar/start`
   (network round trip; backend allocates the Anam session + concurrency slot **before** any
   client-side audio/video prep starts). This is a hard dependency — the SDK client cannot be
   constructed without the session token.
3. `setToken(data.sessionToken)` → re-render → `AvatarConversation` **mounts for the first time**
   (`AvatarPopup.tsx:59, 142`). Nothing in step 4 onward can start before this point, because the
   `<video id="anam-avatar-video">` element these steps touch does not exist until
   `AvatarConversation` renders its JSX (`AvatarConversation.tsx:291`).
4. `createClient(sessionToken, …)` — `AvatarConversation.tsx:183`. Synchronous, cheap.
5. Audio pre-warm IIFE, entirely serialized after step 3 (`AvatarConversation.tsx:190-211`):
   `new AudioContext()` → `await audioCtx.resume()` (:194) → build oscillator/gain graph (sync) →
   `videoEl.srcObject = dest.stream` (:202) → `await videoEl.play().catch(()=>{})` (:203) →
   **unconditional `await new Promise(r => setTimeout(r, 150))`** (:204) → `srcObject = null` →
   `osc.stop(); audioCtx.close()`.
6. `client.streamToVideoElement(VIDEO_ELEMENT_ID)` — `AvatarConversation.tsx:210`. This is the
   actual Anam WebRTC join (SDP/ICE negotiation with the Anam engine) and is almost certainly the
   single biggest cost in the chain, but it does not start until step 5 has fully finished.
7. SDK sets `videoElement.srcObject = <live remote stream>` internally
   (`node_modules/@anam-ai/js-sdk/dist/main/modules/StreamingClient.js:493-495`) and relies on the
   `<video>` element's native `autoPlay` attribute to start rendering — the SDK does **not** call
   `.play()` itself.
8. `AnamEvent.VIDEO_PLAY_STARTED` (fires once the element visibly starts playing) or the
   `VIDEO_STREAM_STARTED` fallback (see anam-frontend-002) flips `videoStarted`, which removes the
   spinner overlay (`AvatarConversation.tsx:110-114, 292`).

Steps 2 and 5 are **not** genuinely dependent on each other — the audio-context pre-warm only
needs `window.AudioContext` and a `<video>` element it can temporarily attach to; it does not need
`sessionToken` at all. As written, they are fully serialized: the pre-warm cannot even begin until
the network round trip in step 2 completes and `AvatarConversation` mounts, because the `<video>`
element it manipulates is part of `AvatarConversation`'s own JSX. That serialization is avoidable
(see anam-frontend-001).

---

### [P1] A closed/abandoned avatar popup leaks the just-allocated Anam session, holding a concurrency slot that stalls or fails every subsequent open
- id: anam-frontend-001
- location: podcast-saas/client-web/components/avatar/AvatarPopup.tsx:47-71
- category: bug
- confidence: high
- status: confirmed
- what: The token-fetch effect starts `startAvatarSession(undefined, projectId)` (`:56`), which
  causes the backend to mint a session token and allocate an Anam concurrency slot *before* the
  promise resolves. If `open` (or `characterId`/`projectId`) changes before the fetch resolves —
  the viewer closes the popup, re-clicks "Ask", navigates away, or the parent page unmounts — the
  effect's cleanup sets `cancelled = true` (`:70`), and the `.then` callback at `:57-63` simply
  skips `setToken(...)`. Nothing else runs: `endAvatarSession(characterId)` is never called for
  that already-allocated session, because it is only invoked from `AvatarConversation`'s own
  unmount cleanup (`AvatarConversation.tsx:221`) or `handleLeave` (`:230`) — and
  `AvatarConversation` never mounted, since `token` was never set. The already-started Anam session
  is orphaned; it is not released until Anam's own session timeout expires server-side.
- why: This is a plain use-after-cancel gap — the effect distinguishes "should I update UI state"
  from "should I release the resource I already acquired," and only implements the first. Every
  quick close/reopen (or a page navigation mid-fetch, which is common on a video viewer) leaks one
  Anam concurrency slot. The slot-exhaustion failure mode is not hypothetical — the app names it
  itself: `AvatarConversation.tsx:78` explicitly warns of "an active session still holding your
  concurrency slot" as a known cause of the 20s connect timeout. That is exactly what this bug
  produces, repeatedly, over the course of normal viewer behaviour (impatient users routinely
  close a just-opened dialog or navigate back within a few hundred ms). It matches "very very
  slowly" better than any single-request latency budget: it is a slow, invisible accumulation —
  each leaked slot degrades every subsequent open for the same account/project until Anam's own
  timeout reclaims it, so the reported severity would plausibly vary session-to-session exactly as
  a "sometimes it's fine, sometimes it hangs" report would look.
- evidence: Read `AvatarPopup.tsx:47-71` in full — the effect body, the `.then` callback, and the
  cleanup are exactly as described; no code path calls `endAvatarSession` on the cancelled branch.
  Cross-checked `AvatarConversation.tsx:213-222` — `endAvatarSession` is only reachable via that
  component's own mount, which requires `token` to already be set. Confirmed
  `podcast-saas/client-web/components/avatar/avatarApi.ts:223-231` — `endAvatarSession` fires a
  `keepalive` POST and is the only client call to `/api/v1/avatar/end`.
- fix: In the cancelled branch of the `.then`, still call `endAvatarSession(data.characterId ??
  characterId)` before returning, so an already-allocated session is always released even when the
  UI decided not to use it:
  ```ts
  startAvatarSession(undefined, projectId).then((data) => {
    if (cancelled) { endAvatarSession(data.characterId ?? characterId); return; }
    setToken(data.sessionToken);
    ...
  })
  ```
  Also apply the same guard to the `.catch` path is unnecessary (a rejected `startAvatarSession`
  never allocated a session), but double-check the backend does not allocate on a 200 with a
  malformed body.
- verify: Add a test/manual repro — open the popup, close it within the same tick before the
  fetch can resolve (mock a delayed `startAvatarSession`), assert `endAvatarSession` is called
  with the resolved `characterId` once the delayed promise settles. `pnpm -C podcast-saas
  --filter client-web typecheck` stays clean (already green).
- cross: @backend-reviewer — please confirm server-side whether `/api/v1/avatar/start` allocates
  the Anam concurrency slot synchronously (before responding) or lazily on first
  `streamToVideoElement`; that determines whether this leak is a slot leak or "only" a wasted Anam
  session-minute. Also worth confirming whether `/api/v1/avatar/end` is idempotent/safe to call
  for a session the client never actually streamed to.
- effort: S

### [P2] `VIDEO_STREAM_STARTED` fallback adds an unconditional 2s delay before the spinner is dismissed, and treats "track attached" as "frame visible"
- id: anam-frontend-002
- location: podcast-saas/client-web/components/avatar/AvatarConversation.tsx:114
- category: bug
- confidence: medium
- status: confirmed
- what: `client.addListener(AnamEvent.VIDEO_STREAM_STARTED, () => { setTimeout(() =>
  setVideoStarted(true), 2000); })`. Per the SDK's own event typing
  (`node_modules/@anam-ai/js-sdk/dist/module/types/events/public/EventCallbacks.d.ts:9-10`),
  `VIDEO_STREAM_STARTED` fires when the remote `MediaStream` is attached
  (`StreamingClient.js:493-495` — `videoElement.srcObject = this.videoStream`), which happens
  **before** `VIDEO_PLAY_STARTED` (fired once the element is actually decoding/rendering frames,
  via `requestVideoFrameCallback` per `StreamingClient.js:495-502`). In the common case
  `VIDEO_PLAY_STARTED` fires shortly after (autoplay kicks in) and this 2s timer is a harmless
  no-op (state is already `true`). But when native `autoPlay` is blocked or delayed (see
  anam-frontend-003), `VIDEO_PLAY_STARTED` never fires, and this is the *only* path that ever
  clears the spinner — adding a flat, unconditional 2000ms on top of however long the browser
  autoplay retry/policy resolution takes, and it dismisses the spinner regardless of whether the
  element is actually rendering a frame.
- why: This is exactly the kind of flat, unconditional delay in the startup path the report is
  chasing — same category as the 150ms sleep, but an order of magnitude larger, and it only fires
  in the failure/fallback case, which is consistent with an intermittent "sometimes very very
  slow" report rather than a constant one.
- evidence: Read `AvatarConversation.tsx:109-119` (both listeners) and the SDK's
  `EventCallbacks.d.ts` + `StreamingClient.js:486-502` to confirm event ordering and payload
  semantics.
- fix: Make the fallback conditional on actual playback, not a flat timer: poll
  `videoEl.readyState >= HAVE_CURRENT_DATA` (or use `requestVideoFrameCallback` directly, same
  primitive the SDK itself uses for its own success metric) instead of a bare 2000ms `setTimeout`,
  so the spinner clears as soon as a frame is actually decoded rather than after a fixed budget
  that is sometimes too long and (if autoplay never recovers) sometimes still wrong.
- verify: With autoplay artificially blocked (Chrome flag or a muted-video timing test), confirm
  the spinner no longer clears when there's no visible frame, and confirm normal joins are not
  slowed down (the conditional check should typically resolve in well under 2000ms).
- effort: M

### [P1] Avatar `<video>` has no `muted` attribute and the SDK relies on native `autoPlay` with no fallback `.play()`/error surface — a real autoplay-policy stall with no visible failure
- id: anam-frontend-003
- location: podcast-saas/client-web/components/avatar/AvatarConversation.tsx:291
- category: bug
- confidence: medium
- status: suspected
- what: `<video id={VIDEO_ELEMENT_ID} autoPlay playsInline .../>` has no `muted` attribute. The SDK
  itself never calls `.play()` on this element for the real remote stream — it only sets
  `srcObject` (`StreamingClient.js:493-495`) and depends on the browser's native `autoPlay`
  attribute to start playback. Browser autoplay policies (Chrome, Safari) require either `muted`
  or an unexpired "user activation" window to allow a `<video>` with audio to autoplay. The click
  that opens `AvatarPopup` is the only user gesture in this flow, and by the time the real stream
  attaches it has passed through: the `/api/v1/avatar/start` network round trip
  (`AvatarPopup.tsx:56`), `AvatarConversation` mount, `createClient`, the audio pre-warm chain
  (`AudioContext` creation/resume, oscillator setup, a first `videoEl.play()` on the silent
  pre-warm stream, and the unconditional 150ms sleep — `AvatarConversation.tsx:190-211`), and then
  the SDK's own WebRTC join inside `streamToVideoElement` (SDP/ICE negotiation, the biggest single
  cost in the chain). On a slow network or a loaded device that whole chain can plausibly exceed a
  browser's transient-activation window, at which point the real stream's autoplay is silently
  blocked — no exception is thrown anywhere in this file, `videoElement.play()` is never even
  called by app code for the real stream, so there is no rejected promise to `.catch()`.
- why: If this fires, it produces exactly "very very slow" (or effectively hung): the element has
  a frame attached (`srcObject` set) but never renders it, `VIDEO_PLAY_STARTED` never fires, and
  the user is stuck staring at the spinner until the flat 2s `VIDEO_STREAM_STARTED` fallback
  (anam-frontend-002) fires and hides the spinner over what is still a black/frozen video with no
  audio — worse than slow, silently broken, with no error state to prompt a retry. I could not
  execute a real browser autoplay-policy test in this environment, so this is `status: suspected`,
  not confirmed — but the missing `muted` attribute and the SDK's undocumented reliance on native
  autoplay for the real stream are both directly verified facts, not speculation.
- evidence: Read `AvatarConversation.tsx:291` (no `muted`); grepped
  `node_modules/@anam-ai/js-sdk/dist/main/modules/StreamingClient.js` for `.play(`/`srcObject` and
  found no `.play()` call adjacent to the real-stream assignment at `:493-495`. Could not run a
  live browser check of transient-activation expiry against this specific chain's wall-clock time
  from this environment.
- fix: Add `muted` to the initial `<video>` element (or, if audio must be audible on first play,
  explicitly call `videoEl.play().catch(err => { if (err.name === 'NotAllowedError') { /* surface
  a "tap to start" affordance instead of an infinite spinner */ } })` after `streamToVideoElement`
  resolves, listening for the SDK's `srcObject` assignment via a `MutationObserver` or by wrapping
  `streamToVideoElement`'s resolution). At minimum, add a bounded, user-actionable fallback ("tap
  to unmute/play") instead of relying purely on native `autoPlay` with no error surface.
- verify: Simulate an expired-activation autoplay block (Chrome DevTools → disable "User gesture
  (autoplay)" flag, or wait past the activation window before triggering the real stream) and
  confirm the UI now shows a recoverable state instead of an indefinite spinner-then-frozen-frame.
- cross: @ui-ux-reviewer — if a "tap to play" affordance is added for the blocked-autoplay case,
  that's a UX/copy decision, not just a code fix.
- effort: M

### [P2] Audio pre-warm (AudioContext setup + unconditional 150ms sleep) is fully serialized after the network round trip it does not depend on
- id: anam-frontend-004
- location: podcast-saas/client-web/components/avatar/AvatarConversation.tsx:190-211
- category: perf
- confidence: high
- status: confirmed
- what: The audio pre-warm IIFE (`AudioContext` creation, `await audioCtx.resume()` at `:194`,
  oscillator/gain graph setup, `await videoEl.play()` at `:203`, and the unconditional `await new
  Promise(r => setTimeout(r, 150))` at `:204`) only needs `window.AudioContext` and a `<video>`
  element it can attach a throwaway silent stream to — it does not read `sessionToken` or anything
  else that depends on the `/api/v1/avatar/start` network response. As structured, though, it
  cannot start until `AvatarConversation` mounts (`AvatarPopup.tsx:142`), which cannot happen until
  `startAvatarSession` resolves (`AvatarPopup.tsx:56-63`), because the `<video id="anam-avatar-
  video">` element this code manipulates only exists inside `AvatarConversation`'s own JSX
  (`AvatarConversation.tsx:291`). So this ~150-400ms of pure client-side setup (AudioContext
  construction/resume + oscillator graph + a `play()` round trip + the fixed 150ms) is added
  serially on top of the network round trip, instead of running concurrently with it.
- why: This is exactly the "serialized work that could run in parallel" case the investigation
  asked about. The comment at `:187-189` explains the 150ms sleep is load-bearing (letting the
  OPUS decoder spin up before Anam's first RTP packets), so it cannot simply be deleted — but
  nothing requires it to happen *after* the token fetch. Moving it earlier removes it from the
  critical path entirely, since `streamToVideoElement`'s own WebRTC negotiation (SDP/ICE) is
  virtually certain to take longer than 150ms, giving the decoder time to warm up "for free" while
  the real connection negotiates.
- evidence: Read `AvatarPopup.tsx:47-71` and `AvatarConversation.tsx:171-224` together — confirmed
  no data dependency from the pre-warm IIFE on `sessionToken` or any other value produced by
  `startAvatarSession`; the only thing that gates it is JSX mount order.
- fix: Render a persistent (always-mounted, not conditional on `token`) `<video
  id="anam-avatar-video">` element in `AvatarPopup` itself (or a dedicated pre-warm hook that
  creates its own throwaway `<video>`) and kick off the `AudioContext` pre-warm as soon as `open`
  becomes true, in parallel with the `startAvatarSession` fetch, rather than waiting for
  `AvatarConversation` to mount. `AvatarConversation` then only needs to `await` the already-
  in-flight (or already-settled) pre-warm promise before calling `streamToVideoElement`.
- verify: Instrument both timings (e.g. `performance.mark`) before/after the change and confirm
  the pre-warm's wall-clock cost no longer appears in the click-to-`streamToVideoElement`-call
  delta.
- effort: M

### [P3] `@anam-ai/js-sdk` and the whole avatar UI are statically imported into every viewer page, whether or not the avatar is ever opened
- id: anam-frontend-005
- location: podcast-saas/client-web/components/avatar/AvatarConversation.tsx:5, components/avatar/AvatarPopup.tsx:7
- category: perf
- confidence: high
- status: confirmed
- what: `AvatarConversation.tsx:5` statically imports `createClient, AnamEvent` from
  `@anam-ai/js-sdk` at module scope. `AvatarPopup.tsx:7` statically imports `AvatarConversation`.
  `AvatarPopup` itself is statically imported (and unconditionally rendered, gated only by an
  internal `if (!open) return null`) from `ViewerPage.tsx:11,125`, `LessonPlayer.tsx:15,38`,
  `SharedViewerPage.tsx:11,137`, and `playlist/PlaylistViewer.tsx:14,256`. So the SDK and its
  transitive dependencies ship in the same bundle/chunk as every viewer page, for every viewer,
  regardless of whether they ever click "Ask".
- why: This is a bundle-size/TTI concern, not a click-to-first-frame one — once the page's JS is
  already loaded and parsed, this does not add latency to the "Ask" click itself. I'm recording it
  because the investigation explicitly asked for it and because on a slow initial load (e.g. a
  shared link opened on mobile data) it delays interactivity generally. This is
  `performance-reviewer`'s column (bundle size) — signalled below, not claimed here as a click-to-
  frame cause.
- evidence: `grep -rn "@anam-ai/js-sdk"` in `client-web` (excluding `node_modules`/`.next`) returns
  only the one static import in `AvatarConversation.tsx:5`; traced the import graph up through
  `AvatarPopup.tsx` to all four call sites via grep.
- fix: `const AvatarConversation = dynamic(() => import('./AvatarConversation'), { ssr: false })`
  in `AvatarPopup.tsx` (or lazy-load the whole `AvatarPopup`), so `@anam-ai/js-sdk` is only fetched
  once the user actually opens the dialog.
- cross: @performance-reviewer — bundle-size ownership; flagging the import graph, not sizing it.
- effort: S

### [Refuted hypothesis, recorded for completeness] StrictMode double-mount does not explain the production report
- id: anam-frontend-006
- location: podcast-saas/client-web/components/avatar/AvatarConversation.tsx:171-224
- category: bug
- confidence: high
- status: confirmed
- what: The `cancelled` guard at `:176,209,216` is real, load-bearing defensive code against React
  18/19 StrictMode's dev-only double-invocation of effects (confirmed no `reactStrictMode: false`
  override in `next.config.ts` — Next.js 15's default leaves it enabled). It correctly prevents
  the throwaway first mount from opening a second Anam session in **development**.
- why: React only double-invokes effects in development (`NODE_ENV !== 'production'` /
  StrictMode's dev-only double-render behaviour is a documented React invariant, not a build flag
  that ships to prod) — a production build never re-runs mount effects this way. Since the user's
  report is explicitly a **production** complaint, this guard's absence would not explain it, and
  its presence is not the fix for it either. Downgrading this hypothesis in favour of
  anam-frontend-001, which produces the same symptom class ("concurrency slot held by a stale
  session") through a path that is fully reachable in production.
- evidence: Read the full connect effect and its comment; confirmed no `reactStrictMode` override
  in `next.config.ts` (read in full — no such key is set, so Next's default applies, and that
  default is dev-only regardless of its value).
- fix: N/A — no action needed; recorded to close out the investigation's explicit hypothesis
  rather than leave it untested.
- verify: N/A
- effort: S
