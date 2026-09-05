---
name: flowvid-2026-09-05-tutorial-video-readiness-audit
description: readiness audit for FOLLOWUP-TASKS.md §8 (flagship tutorial/demo video) — implementation not started; maps which existing services are reusable and confirms the licensing gate blocks the demo-sim requirement
metadata:
  type: project
---

2026-09-05: audited the flagship "tutorial video + seeded demo project" task (spec:
`FOLLOWUP-TASKS.md` §8) against `origin/main` (`bde9317`, PR #191 merged — the
"tap-to-ask/library/playlist" batch §8 names as its prerequisite HAS shipped). Zero
implementation exists for any of the 7 deliverables — expected, since this is a starting-point
audit, not a post-hoc one. Value is in what's reusable vs. what's genuinely missing vs. what's
hard-blocked.

**Reusable building blocks found (with exact call sites), so a future session doesn't re-search:**
- **Narration TTS with spend recorded — real precedent, not just capability.** `GuidanceTTSService.
  synthesize()` (`backend-api/src/services/audio/GuidanceTTSService.ts:41`, plain ElevenLabs
  text-to-speech, 30s timeout, system-key-or-env resolution) is already wired to `recordTtsSpend`
  at `GuidanceService.ts:637` (`task: 'guidance_publish'`) and again at
  `VoiceQuestionService.ts:121` (tap-to-ask's answer TTS). This is the pattern a tutorial-narration
  generator should follow — same two calls, new `task` label (e.g. `tutorial_narration`), spend
  shows up in the existing admin spend dashboard for free.
- **Template-clone engine exists and is production-grade.** `ProjectDuplicationService`
  (`backend-api/src/services/project/ProjectDuplicationService.ts:344`) has `loadSnapshot` (no
  owner check inside the class — auth lives at the route), `dryRun`, `copyBytes`, `commitRows`,
  `run(duplicationId)`; wired to a real endpoint `POST /api/v1/projects/:id/duplicate`
  (`projects.controller.ts:545`) that enqueues job `project_duplicate`. Callable directly
  server-side (bypassing the HTTP ownership check) from a future seed hook. **What's missing is
  only the trigger**: grepped `onSignup|afterSignup|createUser|new_user` across
  `backend-api/src/services` and `controllers` — zero hits. No user-creation lifecycle hook exists
  anywhere in the backend.
- **HLS-master invariant is automatic, not extra work.** `runVideoTranscode`
  (`backend-api/src/services/video/runVideoTranscode.ts:21`) is the SAME function the general
  `transcode` queue job runs for any video file (`queue/registry.ts:26`), not something special to
  B-roll. Any normally-uploaded tutorial MP4 gets `hls_status: 'ready'` for free — no bespoke work
  needed for req (7)'s HLS piece, as long as ingestion goes through the normal upload path.
- **Caption gate specifics:** `captionsAvailable = captionStatus === 'ready' && !!activeCaptionState
  ?.vtt_url` gates the CC toggle (`HLSPlayerShell.tsx:259`, `ControlsBar.tsx:112-113`) — but the
  "Ask!" button itself (`AskAvatarButton`) is only hidden while the caption SETTINGS MENU is open,
  not by caption readiness (`SharedViewerPage.tsx:316` et al.). Tap-to-ask's grounding quality (not
  its visibility) depends on a transcript existing — not fully traced to a hard failure mode; flag
  for verification at implementation time rather than treated as fully confirmed either way.
- **Poster capture for sim sections has a live, open bug, same day as the latest merged commit.**
  DECISIONS.md:68 (2026-09-04 evening entry): "the editor's banner sweep STILL times out after the
  fix" — the CONNECT postMessage doesn't reach the sweep frame's listener. This is a real risk to
  req (7)'s poster invariant if the demo project's sim section is authored/re-captured through the
  editor while this is open.
- **No existing license-clean sample sim to substitute for kinesin/dynein.** `.sim-fixture/` is
  confirmed test-only (protocol-scenario names: `delayedack`, `nopaint`, `v3managed` — synthetic
  harness doubles, not presentable content). The sim-pool seed scripts
  (`seed-sim-pool-synthetic.ts`, `seedGuards.ts`) are explicitly refused against cloud storage or a
  non-local DB — dev/test fixtures only, not a production asset path.
- **No automatic first-login trigger found.** `TourButton.tsx` / `userPrefs.ts` show a manual
  in-app product tour (button-triggered), not an auto-start-on-first-login mechanism — so there is
  no existing "new user" moment to piggyback the demo-project seed onto either.

**The hard gate (req 6) is confirmed open from TWO independent, dated sources, not just the prior
kinesin/dynein memory:**
1. `CLAUDE.md` §8 (`podcast-saas/CLAUDE.md`), owner ruling dated 2026-09-03: "Anything that ships
   ... must be MIT/ISC/BSD/Apache-2.0-class ... 'non-commercial' or 'research only' weights ... are
   out."
2. `DECISIONS.md:77` (2026-09-04 entry), in the SAME paragraph that calls kinesin/dynein
   "integrated and battle-tested": "includes the CGTrader browser-delivery **licensing gate — still
   open, blocks public deploy of the kinesin GLB only** — and the dynein RCSB attribution that must
   return before public dynein delivery." Read closely: "integrated" there means the GENERIC sim
   pipeline was proven compatible with this heavy package (upload→bridge→activate, zero FlowVid
   code changes per the companion `kinesin-dynein-integration-final-verify` memory) — it does NOT
   mean the asset is a shippable, licensed, permanent product fixture. A future session should not
   read "integrated and battle-tested" in DECISIONS.md as license clearance.

**Open question found in code, not just asked by the owner:** the brand name is a THREE-way
conflict, not two. Code default + `podcast-saas/.env.example:188` both say "Interactive Video
Studio"; `deploy/.env.example:108` says "Podcast Studio"; the owner says "Flow Video" out loud. All
three live in the repo simultaneously — worth naming precisely when this question is put to the
owner rather than assuming it's a simple two-way pick.

**Process note, not a checklist item:** `FOLLOWUP-TASKS.md`'s own header says items 1-7 (library
minimalism etc.) should run "ONLY after the kinesin/dynein sim integration work is complete" — but
those items shipped (PR #189, #190, #191 merged) while the kinesin/dynein ASSET remains
license-blocked. Consistent with the "integrated ≠ shippable" reading above; the owner may have
knowingly proceeded on that basis, or the ordering constraint may have been read as
"pipeline-proven" rather than "license-cleared." Worth a one-line confirmation, not a blocker.

See [[kinesin-dynein-flowvid-integration]] (the original licensing-gate finding this confirms
still-open) and [[flowvid-decisions-process]] (DECISIONS.md conventions this audit relied on).
