---
name: reverify-live-state-before-flagging-stale
description: before flagging a DECISIONS.md line or ledger item as stale/unaddressed, check for open unmerged PRs and current gh run/deployment state — this repo changes concurrently during an audit
metadata:
  type: feedback
---

On 2026-08-21 a task-tracker audit was given a brief claiming the release run was "PAUSED at the
production approval gate." By the time the audit checked `gh run view` / `gh api .../deployments`,
the run had already completed (deploy `success` at 11:06:49Z, `v0.1.36` published at 11:07:13Z) —
the owner had approved it in real time during the audit. Separately, `git branch --show-current`
changed from `main` to `docs/post-release-v0.1.36` partway through the same session, because a
concurrent process (the owner or another agent) checked out and committed to a new branch in the
same working tree while the audit was reading files from it.

That branch turned out to carry an open, green, mergeable PR (#48) that already corrected several
of the exact `DECISIONS.md` lines the audit was about to report as "not reflected" — including the
Supabase 24h-auto-abort fact the brief asked to verify.

**Why this matters:** [[flowvid-decisions-process]] describes how status lands as small docs PRs
under the owner's merge-authorization rule — so a "gap" an audit finds may already be sitting
fixed-but-unmerged, which is a materially different finding than "nobody addressed this."

**How to apply:** near the end of an audit (not just at the start), re-run `gh run view` on any
in-flight run, `gh pr list --state open` for the repo, and `git branch --show-current` /
`git status --porcelain=v2 --branch`. Before writing "X is not reflected in the docs," grep for an
open PR touching the same file first. Report both states explicitly when they differ: what's true
on `main` (authoritative) vs. what's already drafted on an unmerged branch (ready, pending merge).

**Second confirmed occurrence, same day (2026-08-21, later session).** A ledger-completeness audit
(cross-checking 17 owner requests against `DECISIONS.md` + the CODEX response) opened with
`git branch --show-current` = `feat/dubbing-languages-and-progress`; by the time the audit re-checked
near the end, `HEAD` had silently become `main` and had fast-forwarded by two more merged PRs (#49,
docs/crop-fleet-audit) that were not there at the start — a `DECISIONS.md` re-read mid-audit picked
up 60 new lines (the production fleet audit section) that the first read had missed entirely. This
is not a one-off: treat "branch/HEAD moves under you mid-session" as a standing property of this
working tree, not an anomaly worth investigating on its own. The re-verification step in **How to
apply** below caught it both times.

**Third confirmed pattern, 2026-08-22 (DECISIONS.md 🟡 work-queue audit).** Staleness runs in
*both* directions here, not just "closed but unmerged":
- **Claimed DONE, actually unwired.** `job-queue-014` ("test files are not type-checked: `tsc
  --noEmit -p tsconfig.test.json` in CI") was listed as closed. The config and the `typecheck:test`
  npm script exist (`backend-api/tsconfig.test.json`, `package.json`), but grepping every workflow
  and `release-verify.sh` for `typecheck:test` finds zero references — it is never invoked. Running
  it directly found **140 type errors across 29 test files**, proof the never-wired check let real
  drift accumulate exactly as the original finding warned. Lesson: when a work-queue item's fix is
  "add X to CI," verify by grepping the actual CI workflow/script chain for the invocation, not just
  confirming the script/config file exists.
- **Claimed as a "ride-along" closure, only half true.** The same entry claimed `backend-008` and
  `job-queue-015` (corpus ingestion durability) closed as a side effect of a queue fix. A *different*
  finding (`observability-002`, a stuck-row sweep) was actually what shipped; `corpus.controller.ts`
  still fire-and-forgets `builder.ingest(...).catch(log)` in-process, never through pg-boss, and
  `jobs/corpus.ingest.ts` (a Trigger.dev task) remains dead, unimported code. Lesson: "ride along"
  closure claims bundling multiple ledger ids need each id checked individually — a shared root
  cause does not mean a shared fix landed.
- **Claimed OPEN/blocked, actually has real progress.** The a11y "schedule" cluster (6 `ui-ux-*`
  findings) was framed as still-open backlog, but 5 of 6 were fixed 3 days earlier in commit
  `384a782` (2026-08-19) with 29 passing accessibility tests today — the 🟡 section just hadn't been
  refreshed. Similarly "WAVE 4 — CROP · blocked at the first step" (no real footage exists yet) was
  contradicted by `backend-api/scripts/crop-eval/results/field-v1@v1.1.json`, a completed field eval
  over 13 real hand-labelled clips (`"quotable": true`) that had already produced a finding elsewhere
  in the same document (the CROP_ALGO=v2 no-op discovery). Lesson: a "blocked" or "not started" framing
  needs the same live-code check as a "done" one — don't assume the pessimistic direction is safe to
  skip verifying.

**Net practice:** treat every verdict in DECISIONS.md — DONE, ride-along-DONE, or NOT-STARTED — as
a claim to verify against code/tests/CI config, not as ground truth in either direction.

**Fourth confirmed occurrence, 2026-08-23 (v0.1.43 avatar-outage pre-ship audit).** Two more
variants of the same standing property, both non-blocking once re-verified:
- The primary worktree's checked-out branch changed from `fix/avatar-config-poison` to an unrelated
  `chore/client-lint-ratchet` (with live uncommitted edits to `client-web/*`) partway through a
  read-only audit — a concurrent agent/process working the same checkout on a different task. Every
  finding in this audit that mattered was taken from `git show <ref>:<path>` / `gh pr` (ref-pinned,
  branch-independent), so the switch didn't corrupt any verdict — but a check that reads the
  *working tree* directly (not via a ref) needs a beat of care about which branch is actually
  checked out right now.
- A PR's "Release verification gate" check was still `IN_PROGRESS` (~16 min run) when first read.
  Reporting `mergeStateStatus: UNSTABLE` at that snapshot would have been a misleading "blocked"
  finding — the same claimed-vs-actual gap this memory already warns about, just live rather than
  historical. Lesson for a pre-ship SHIP/DO-NOT-SHIP call specifically: poll `gh pr checks <n>` to
  completion (this gate reliably takes ~15-16 min) before issuing the verdict, don't snapshot a
  pending check as a blocker.
