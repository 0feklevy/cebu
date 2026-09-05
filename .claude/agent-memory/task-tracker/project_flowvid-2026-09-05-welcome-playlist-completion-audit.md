---
name: flowvid-2026-09-05-welcome-playlist-completion-audit
description: COMPLETION-pass re-audit of the overnight Welcome-playlist run (tutorial-kit/CHECKLIST.md, feat/welcome-tutorial-kit, PR #192) — most items moved to DONE with real evidence; two new load-bearing gaps found (undocumented sim licensing, branching-suppresses-overlays)
metadata:
  type: project
---

2026-09-05, ~12:00-12:20 EEST: re-verdicted `podcast-saas/tutorial-kit/CHECKLIST.md`'s baseline
against the finished build (commit range `77bf941..4fa4d79`, PR #192 open). Full per-item table is
in `CHECKLIST.md` itself now (a "COMPLETION PASS" section appended, not rewritten in place — the
original 13-section baseline stays as historical record). This memory is the findings worth not
re-discovering, not a copy of the table.

**Most of the night's work is real and wired, not just present.** Migration 085 + WelcomeSeedService
are called from BOTH `firebase-auth.ts:188` (post-signup) and `projects.controller.ts:165` (heal-on-
list) — not just defined. 10 unit tests have genuinely differentiated fixtures/assertions (verified
by reading, not just by the green count). Independently RE-RAN `seeding/e2e-seed-check.mjs` myself
against the live local stack (found the backend already running with the seed env active) — fresh
user got a clone, playable, playlist led with it, idempotent — PASS, not just trusted from
DECISIONS.md's attestation. All 5 films exist on disk (`assembly/out/film{1..5}.SCRATCH.mp4`),
ffprobe-confirmed h264/1920x1080/30fps, durations matching the README's targets closely. Loudness
independently re-measured: `volumedetect mean_volume -23.0dB` vs the -22.8dB reference — a genuine
match (caution: don't confuse this with the assembly pipeline's OWN `loudnorm` target of -19 LUFS,
a different metric that matches itself, not the reference number — these are easy to conflate).
The Solar-System This-moment prompt honesty claim (script says the on-camera prompt is verbatim
the seeded section's stored prompt) checked out character-for-character across THREE independent
sources: the script text, `build-template.mjs`'s source, and the actual API-committed value in
`TEMPLATE.json`.

**Two new, real, load-bearing gaps found — neither was in the baseline because neither existed yet:**
1. **Undocumented third-party sim licensing.** `captures/props/galton-board.zip` and
   `five-species.zip` (owner-GitHub sourced, per the PR body's own words) were added to the SEEDED
   template's library and one (Galton Board) wired into a LIVE section — with zero license text
   anywhere (checked inside both zips, and across CREATIVE-BRIEF/PRODUCTION-PLAN/README/DESIGN.md:
   zero hits). Unlike kinesin/dynein (dated owner permission, film-captures-only, cited repeatedly),
   these two have no equivalent clearance and are inside what every new user's account will contain.
   Also a plan deviation: `PRODUCTION-PLAN.md:40`'s own "Final seeded lineup (3 sims)" doesn't
   include either. See [[kinesin-dynein-flowvid-integration]] for the contrast case that DID get
   this right.
2. **Branching silently kills the image/audio sections on the same project.**
   `client-web/components/viewer/useProjectPlayer.ts:2506,2549` — both `updateBrollOverlay` and
   `updateAudioCutaway` open with `if (branching) return`. The seeded demo project has both a
   branching choice block AND an image section + audio sting. `TEMPLATE.json`'s own build notes
   flagged this exact tradeoff as needing a decision ("keep or drop the choice graph at capture
   time") — nobody decided; the build kept both, so the infographic and ambient sting will never
   render for a real viewer, despite reading as "done" in every build log. Nothing errors; the
   content is just invisibly dead. Same shape as [[a-prop-check-cannot-see-the-gate]] — the DATA
   existing said nothing about whether the VIEWER would ever show it.

**A live CI race happened mid-audit, resolved before I finished — textbook case for
[[reverify-live-state-before-flagging-stale]].** PR #192's CI had genuinely failed (Release
verification gate: admin a11y test expected 5 named switches, this PR's own new "Welcome project
seeding" toggle made it 6, uncounted; Static audits: `welcomeSeed.test.ts` tripped the backend
test-typecheck ratchet with 4 real TS errors vitest's runtime never surfaces). While I was
investigating, commit `4fa4d795` landed and fixed both by name. Polled the re-triggered run to
completion in the background rather than reporting the failure I'd already seen as current.

**Other confirmed-still-open items, none new in kind:** the G1-post gate self-contradiction
(baseline's own priority action) got WORSE, not better — README.md and both SCRIPT-1/2 headers now
say "G1-post CLEAR" while `PRODUCTION-PLAN.md` (unchanged since its one commit) still says G1-post
is "pending" and the PM/accuracy critic "still running," with zero PM findings ever recorded
anywhere. The teaser brand-mark-intro contradiction (script opens on product footage, brief wants a
brand-mark intro first) is also still unreconciled. No cross-engine (firefox/webkit) smoke artifact
exists for the actual playlist despite PR #192's body claiming one — the only firefox/webkit-
tagged files anywhere are stale, unrelated kinesin screenshots from the day before (confirmed by
opening the image, not just checking the filename).

**Hygiene, not a requirement gap:** the whole capture pipeline (10 scripts) resolves `playwright`
via a hardcoded `/Users/ofeklevy/Desktop/Kinesin and Dynin/3d-kinesin/package.json` anchor rather
than any in-repo dependency, though `playwright` is genuinely present in this monorepo already —
undercuts the README's own "regeneration contract, not archaeology" pitch on any other machine.

See [[checklist-recovery-when-baseline-not-reattached]] (the misplaced-memory-directory finding
this audit made — a stray `.claude/agent-memory/` tree was committed inside `backend-api/`) and
[[flowvid-2026-09-05-seeding-builder-route-intel]] / [[flowvid-2026-09-05-tutorial-video-readiness-audit]]
(the pre-build intel this completion pass confirms mostly came true).

**CRITICAL ADDENDUM (same session, ~12:10-12:20 EEST) — the CI race resolved into a REAL
regression, not a clean pass.** The re-triggered CI (after commit `4fa4d795` fixed the admin-a11y
and welcomeSeed-typecheck failures) came back green on `Static audits` but **`Release verification
gate` failed again, for an unrelated reason**: `client-web`'s test suite had never actually run in
the first CI attempt (pnpm's recursive-run stops at the first failing package, and `admin-web`
failed first, masking everything after it). With `admin-web` fixed, `client-web` ran for the first
time and failed 5/26 tests in `__tests__/simExitHandoff.test.tsx` + `viewerActiveSimUrl.test.tsx`.

**Proved this is a real regression, not a flake, by direct A/B comparison**: `git worktree add`
of `main` (symlinked node_modules + shared/dist rather than a full reinstall — fast and safe,
lockfiles were identical so this was valid) → same two spec files → **26/26 pass on main, 5/26 fail
on this branch**, reproducible locally with a plain `pnpm --filter client-web exec vitest run`. The
only `client-web` file this branch touches vs `main` is `useProjectPlayer.ts` (the post-roll
"Go back to video ADVANCES" feature) — confirmed the regression is caused by this PR, not
pre-existing on `main`. This is the single highest-priority item from the whole audit: a proven,
currently-blocking (`mergeStateStatus: UNSTABLE`) regression in core viewer sim-exit/transition
behavior, shipped alongside — and initially hidden behind — an unrelated a11y-test failure. Classic
"pnpm recursive-run first-fail masks what's behind it" trap: a green run only says the FIRST
failing package was fixed, never that nothing else was broken — always check whether every
workspace's tests actually EXECUTED, not just that the ones that ran, passed.

Also found (not yet fixed by anyone as of this pass): a SEPARATE, uncommitted, in-progress edit to
the same `useProjectPlayer.ts` (a `TEMP-DIAG` console.log + a fix for "choice doors appearing over
a live simulation section") — evidence the concurrent overnight run is actively working in this
exact function right now. Re-ran the 2 failing spec files against that uncommitted state too:
still 5 failed / 21 passed — that in-flight edit is a different, adjacent bug, not a fix for this
one. Don't assume adjacent in-progress work resolves a finding; always re-test.

See [[reverify-live-state-before-flagging-stale]] (the CI-race pattern this confirms again) — this
is now the second time in this repo's history that "poll CI to completion" changed the verdict, not
just the timestamp.
