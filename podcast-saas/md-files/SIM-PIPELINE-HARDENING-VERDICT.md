# Sim Pipeline Hardening — Status, Evidence, and Known Limitations

**Branch:** `feat/sim-pipeline-hardening` → `main` (base `ce5b9c0`).
**Input:** `md-files/FLOWVID-SIMULATION-PIPELINE-OPTIMIZATION-BRIEF.md` (external audit).
**Process:** the brief's claims were re-verified against the code by three adversarial passes; the
resulting branch was then put through a second, independent five-agent release-blocker audit whose
findings are folded in below. Several defects listed here were introduced *by this branch* and
caught by that second audit.

> **This PR does NOT implement the optimization brief.** It implements the brief's *causal* fixes
> inside the current architecture. The brief's platform program (posters, immutable revisions,
> MessageChannel protocol, shared runtime, managed lifecycle, predictive scheduler) is deferred —
> see §4. Read §5 before making any claim about this system's behaviour.

---

## 1. SHIPPED — fixes that take effect the moment this merges

These are player-side or serve-time and work against **stored, un-rebuilt** packages.

| Fix | What it changes |
|---|---|
| **Atomic exit** | `deactivateSim` / back-to-video now freeze + mute + close the guidance gate (to the still-known key — the old gate-off fired after the key was nulled and went nowhere), fade, and post `stopScript` only **after** the fade (`SIM_EXIT_STOP_MS=280` > 200 ms CSS). Kills the deterministic Minimal-UI Full-UI flash. |
| **Window-tier planner** | `flattenSimOccurrences` + `planWindowResidency`: whole-timeline absolute-time lookahead (was: current segment + 1), next **distinct** package, authoritative plan (an empty plan now evicts — the old `want.size > 0` guard retained frames through every gap). Frames still inside their exit fade are protected from eviction. |
| **Sim-first seed** | A timeline that *opens* on a simulation still pre-mounts its package on weak devices (the initial cap-0 change had removed this while still arming the pool). |
| **Play-gated arming** | The 12 s pool-arm fallback starts only after a real `play` attempt — an idle page no longer boots WebGL documents. |
| **DPR snapshot** | `devicePixelRatio` is captured once per page, so zoom/monitor changes no longer rewrite the iframe `src` and silently reload resident sims (whose `load` event was then misread, leaving stale `ready`/`painted` flags). |
| **Legacy nav cloak** | `navigateFrame` re-cloaks with the **target** section's `bootHide` (was: the package's first-using section, or none). |
| **A11y** | Hidden pool frames get `inert` + `aria-hidden` + `tabIndex=-1`. |
| **Transition cost** | The full-frame `backdrop-filter: blur(2px)` composited during the reveal is removed. |
| **Editor timeline player** (`VideoPlayer.tsx`) | Paint-gated reveal (`SIM_PAINTED` + `PING_SIM_PAINTED`, replacing the 50 ms guess as the primary signal) and the same deferred-`stopScript` atomic exit. |
| **Avatar sim overlay** (shipping viewer surface) | Now routes through `resolveSimUrl`, so a stored `sim_entry_url` minted under another origin is rebased instead of being blocked by `frame-src` CSP. |
| **Serving** | Local path injects the boot snippet (dev first-paint now matches prod); marker detection is exact-tag, not substring; text is `no-cache` + strong ETag; binary redirects are `302` + `max-age=3600` **and the uploaded object's own `Cache-Control` is bounded** (the redirect alone did not bound staleness — the object metadata is what a browser keeps). |
| **`#simboot`** | Appends after an author fragment instead of overwriting it. |

## 2. VERIFIED IN A REAL BROWSER

`client-web/e2e/sim-transitions.spec.ts` — **12/12 passing, Chromium.** Drives a REAL iframe running
the REAL generated artifacts (actual rAF gate, actual serve-time boot snippet, actual combined
bridge, produced by `backend-api/src/scripts/gen-sim-fixture.ts` from the production code paths) and
records **every animation frame**: the live animated overlay opacity, the sim's own `.controls`
display, and which section is applied.

Proven by rendered frames, not by message assertions:

1. cold Minimal-UI entry never paints Full UI (boot cloak + gate + snippet);
2. A → B in one package: no visible frame shows A after B is applied;
3. A → B → A repeatedly ends on the requested section;
4. **Minimal-UI exit: zero Full-UI frames while the overlay is fading** — with a **control test
   (4b) proving the OLD ordering *does* flash**, so test 4 genuinely discriminates;
5. a missing section id runs **nothing**, reports `SCRIPT_MISSING`, and never falls back to another
   body;
6. a throwing cleanup is reported and does **not** wedge later switches;
7. `startScript('constructor')` dispatches nothing and cannot brick the document;
8. a legacy bridge never emits `SCRIPT_APPLIED` — and *does* silently fall back on a missing section
   (the documented legacy behaviour the player must defend against);
9. a slow body (>200 ms) still applies and acks late;
10. **user interaction stops the auto-demo** while the section, its Minimal-UI policy and its
    visibility all survive;
11. a sim that **never calls rAF** emits no false paint — and must remain displayable (see §3).

**Not covered by browser tests:** Firefox/WebKit (only Chromium is installed here), the React viewer
end-to-end, real devices. The harness replays the player's message ordering; that the player *emits*
that ordering is pinned by the unit suites, not by this harness.

## 3. COMPATIBILITY FALLBACKS — deliberate, bounded, and honest

- **The apply gate never force-reveals a modern bridge.** `lib/simApplyGate.ts`: a same-document
  switch waits for `SCRIPT_APPLIED` **only** when the document has already proven it acks
  (`ackCapable === true` — a modern bridge acks on the package's *first* activation, before any
  switch can occur). Legacy/unknown documents reveal immediately, exactly as before: they never wait
  on silence, and there is **no timer that reveals an unacknowledged frame**. The earlier 200 ms
  ceiling did both of those things and is gone.
- **Every hold is terminal.** Making paint acks honest removed the only signal that sims which never
  drive `requestAnimationFrame` ever produced. Such a package would otherwise hold forever behind a
  spinner — a whole class made undisplayable. The 5 s stall bound is now **terminal**: it force-
  reveals best-effort rather than never. A package that genuinely paints never reaches it.
- **No permanent spinner.** `SCRIPT_MISSING` / `SCRIPT_ERROR` / a stalled apply degrade to *the video
  continuing to play* with telemetry — they do not park a failure affordance the viewer cannot act
  on, and they do not reveal the previous section's frozen frame.
- **Activation tokens.** Every `startScript` carries a monotonic token echoed on each ack, so a
  stale ack from a superseded activation (A→B→A faster than the child drains its queue) cannot
  release a live pending apply.

## 4. DEFERRED ROADMAP (explicitly not in this PR)

Deterministic visual fixtures across Firefox/WebKit + filmstrip CI · shared `SimRuntimeClient` /
`SimSurface` so viewer, editor timeline and Section Editor share one state machine · the full
activation-scoped envelope protocol over `MessageChannel` (`documentId`, `PREPARE/PRESENT/ACTIVATE`)
· section posters + publish-time browser canaries · the managed lifecycle contract
(`pauseAuto`/`suspend`/`setQuality`/`setAudible`, system-owned resource scopes) · immutable package
revisions + manifest-driven serving + real 304s · predictive scheduler budgets, `requestVideoFrameCallback`
boundaries, production RUM · per-package `compileAsync`/disposal/adaptive DPR.

## 5. KNOWN UNRESOLVED LIMITATIONS — read before claiming anything

1. **Stored packages do not have the new bridge or gate.** Verified live: **0 of 6** production
   simulations carry `SCRIPT_APPLIED`, the hardened dispatch, the guarded cleanup, or the honest
   paint gate. Until a rebuild (§6), those four fixes are **inert for all existing content** — the
   §1 fixes still apply. Two live rows (`49d20194`/`a7765242`, `a1ee064e`) have a `simulation_url`
   with no `?section=` and therefore already render a **wrong sub-simulation**, silently; that is a
   pre-existing data defect this PR does not repair.
2. **`SCRIPT_APPLIED` means "the body ran and one frame followed"** — it is posted from a system-rAF
   callback after `fn(params)` returns. It is *not* proof that the section's visible effect landed:
   the mandated body shape polls for async-built controls on ~200 ms intervals, so a body can ack
   before its hiding/mode change is visible. It is strictly better than `painted`, not a paint proof.
3. **`pauseScript` only works on rebuilt packages.** The v2 template now tracks the section body's
   own `setInterval`/`setTimeout` handles and clears them on `pauseScript` (browser-tested). On a
   **stored** bridge it remains a complete no-op: the auto-demo keeps fighting the user until the
   section ends. Timers created asynchronously *after* the body returns are not tracked.
4. **`simPause` still does not suspend everything.** It freezes rAF only. `setInterval`/`setTimeout`
   outside a tracked body, Web Workers and WebAudio keep running while hidden, and `simMute` silences
   only `<video>`/`<audio>` elements — **not `AudioContext` output**.
5. **Editor surfaces are not fully unified.** `VideoPlayer.tsx` got the paint gate and atomic exit,
   but retains an 800 ms blind fallback for pre-v4 packages and still shows the previous section
   across a sim→sim switch. `SectionEditor.tsx`'s preview is visible from mount and configures only
   after `SIM_READY`. Both are internal authoring tools; unifying them is the shared-runtime work.
6. **Binary assets already cached** by a viewer keep their year-long `immutable` entry; only objects
   uploaded after this change are bounded. Retroactive correctness needs content-addressed revisions.
7. **A hash router that matches the whole fragment** now sees `/scene/3&simboot=…` rather than
   `/scene/3`. The author fragment is preserved as a prefix, which is strictly better than the
   previous overwrite, but is not fully transparent.
8. **The window-tier planner re-flattens the timeline on every `timeupdate`** (~4 Hz) on exactly the
   constrained devices it targets. Correct, but not yet memoised.
9. **The new local-disk HTML branch** in `sim-public.controller.ts` drops the ETag/Range handling
   `serveLocalFile` provided and has no test coverage (the suite's mock storage cannot reach it).
10. **No "no flash on every device" claim is supported.** One browser, no physical devices, no
    Firefox/WebKit. What is proven is listed in §2 and nothing more.

## 6. STORED-BRIDGE ROLLOUT

**A rebuild is NOT required to merge** — every player-side change degrades gracefully against stored
bridges — but **no value is realised for existing content without it** (§5.1).

Verified read-only, in memory, against the live packages (`parseSectionEntries` → `wrapBridgeCombined`):
**body-preserving and protocol-upgrading** — boids-3d 5/5 sections and murmuration-knob 2/2 with
byte-identical bodies (whitespace-normalised), the new bridge parses, and each gains
`SCRIPT_APPLIED` + the own-property guard + the guarded cleanup. `parseSectionEntries` was made
idempotent so repeated rebuilds cannot accrete whitespace.

Dry run (already executed, read-only):

```
=== Combined-bridge rebuild (DRY RUN) — 6 ready simulation(s) ===
  SKIP     ising-kid-simu-complete / ising-kid-part2 / example — no bridge.js (404)
  WOULD UPDATE boids-3d          — 5 section(s)
  WOULD UPDATE murmuration-knob  — 2 section(s)
  WOULD UPDATE pluck-boids       — 1 section(s)
```

**Procedure (owner-run, after this PR deploys):**

```bash
cd podcast-saas/backend-api
npx tsx --env-file=../.env src/scripts/rebuild-sim-bridges.ts            # dry run — re-confirm the list
# BACK UP FIRST: the script has no rollback. Copy each package's bridge.js + entry HTML
# (simulations/<projectId>/<simId>/) out of the bucket before applying.
npx tsx --env-file=../.env src/scripts/rebuild-sim-bridges.ts --apply
```

It rewrites **all** `status='ready'` simulations (there is no `--only` flag) — with 3 in scope that
is acceptable; add a filter first if the inventory grows. The `?v=` hash changes in the entry HTML's
script tag; sections' stored `simulation_url` need no update (the stale `v=` there is only an entry
cache-buster, and the entry is served `no-cache`).

**Rollback:** restore the backed-up `bridge.js` + entry HTML. Code rollback alone does not revert
storage.
