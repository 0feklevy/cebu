---
name: flowvid-2026-08-26-audit-gaps
description: task-tracker close-out audit against origin/main@d31f755 (v0.2.10 live, v0.2.11 dispatch stuck) — supersedes the earlier same-day note; check these are still true before re-reporting
metadata:
  type: project
---

**This file was overwritten mid-day by a second 2026-08-26 audit session** (this one), run later
against `origin/main` at `d31f755` (PRs up through #159), after the earlier session's findings
(gallery-in-wrong-branch, unwired `sim-authoring.spec.ts`, three stale 🔴 headers) had ALL already
been fixed — PR #155 replanted the gallery onto `main`, PR #151/#156 wired `playwright.authoring.config.ts`
into `ci.yml`'s `browser-suites` job, and the three 🔴 headers this note used to describe are gone
(superseded by fresh ✅ CLOSED sections). If you're reading this and those fixes look undone again,
re-verify — don't assume this note is current without checking `git log` first, per
[[reverify-live-state-before-flagging-stale]]. **Concurrent-write hazard confirmed on this very file
today**: an earlier same-day write to this exact path was silently clobbered by another session using
the identical filename — treat any single-dated memory file as a race risk, not just repo state.

Method this session: `git worktree add --detach <scratchpad> origin/main`, ran the four test suites,
typecheck, lint, and read code directly for every claim. All six owner-reported bugs in the known set
(Minimal-UI picker scan/badges/panel — #151, Import gallery — #155, Save bridge label — pre-#141,
podcast wrong-table — #146, podcast is_broll divergence — #153, "Building" status vocabulary — #159)
are VERIFIED FIXED IN CODE, wired to real callers, and covered by passing tests. Full suites green:
shared 1094/1094, client-web 1851/1851, backend-api 4687/4705 (18 skipped = real-capture/real-encode
tests needing a browser/ffmpeg — BLOCKED-by-environment, not a gap), ops-release 461/461. typecheck
6/6 clean, lint 0 errors. `job-queue-014` (from [[flowvid-2026-08-22-audit-gaps]]) is now genuinely
closed: `typecheck:test` is wired into `ci.yml:181` via `deploy/scripts/typecheck-tests-ratchet.sh`,
0 errors.

**Ledger-integrity gaps found this session (DECISIONS.md vs. code/live state):**

1. **PR #151 has no header anywhere in DECISIONS.md** — real, tested, CI-wired work
   (`SimAuthoringBootstrap.ts`, `useSimAuthoring.ts`, `SimAuthoringClient.ts`,
   `playwright.authoring.config.ts`) the ledger never recorded, despite being exactly the kind of
   owner-reported fix the ledger exists to track. Same shape as the PR #51 gap in
   [[flowvid-decisions-process]].
2. **Top state header is stale again** — written in `cedec1d` (#156, 13:52:42Z) claiming "nothing
   sits merged-and-unshipped"; #158 (14:12:34Z) and #159 (14:47:19Z) merged afterward and were never
   folded back in.
3. **`SMOKE_PUBLIC_PATH` is NOT currently set**, contradicting the ledger's "UPDATE 2026-08-23: ...
   is now SET" line. `gh api repos/0feklevy/cebu/actions/variables` (11 vars, none `SMOKE_*`) and both
   `production`/`production-audit` environment variable lists are empty. Can't tell if it was unset
   later or never true — only that it's false now.
4. **The 🟢 "IN FLIGHT — media dedup foundation" header is stale.** PR #138 merged
   2026-08-25T10:47:44Z; `claimBlob`/`claimUploadedMedia` are wired into `images.controller.ts`,
   `audio.controller.ts`, `SimulationImportService.ts` — real callers. Video alone remains genuinely
   un-deduped (confirmed: zero `claimBlob`/`claimUploadedMedia` references in `video.controller.ts`).

**Proactive contract-drift sweep** (same shape as the podcast status bug, in
`shared/src/generated/client-v1.ts`, none currently causing a live bug):
`Project.status` (line 230, DB has real enum `projectStatusEnum`), `Project.metadata_status` (242,
DB comment documents `none|processing|ready|failed`), `VideoFile.status` (378, DB has real enum
`videoFileStatusEnum`, sibling `hls_status` two lines down IS a correct union), `VideoFile.crop_status`
(387, inline comment documents the closed set) — all typed bare `string` in the generated client
despite a closed vocabulary existing one line away or one field over in the same interface.

**Release run stuck.** v0.2.11 (`gh run 32984378104`, `workflow_dispatch` at 15:12:30Z) never left
`queued` with an empty `jobs` array for the entire ~56-minute audit session — `updated_at` stayed
identical to `created_at` throughout. No concurrency conflict (`group: production-release`,
`cancel-in-progress: false`, prior release completed cleanly at 11:38:52Z). Repo is public (should
have unrestricted GitHub-hosted Actions minutes). Looks like a GitHub Actions platform/runner-
allocation stall — flag for the owner to re-dispatch or check the Actions run page directly;
task-tracker has no way to diagnose further without a `user`-scoped token.
