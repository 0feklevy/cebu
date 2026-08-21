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
