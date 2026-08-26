---
name: flowvid-2026-08-26-audit-gaps
description: task-tracker audit of the sim-picker/gallery/podcast items against origin/main@00461b2 (v0.2.10) — check these are still true before re-reporting them
metadata:
  type: project
---

Full audit run 2026-08-26 against `origin/main` at `00461b2` (v0.2.10, confirmed fully deployed —
see below). Findings:

- **v0.2.10 is NOT mid-flight.** `gh run view 32964372557` shows every job including "Human
  approval" and "Deploy to production" completed successfully at 2026-08-26T12:08:36Z, deployed SHA
  = `00461b2` = current `origin/main` tip. A prior briefing describing it as "awaiting approval" was
  stale by the time of audit — always re-check `gh run list --workflow=release.yml` before repeating
  that framing. See [[reverify-live-state-before-flagging-stale]].
- **The "Import a simulation" gallery feature (owner-requested, PR #147) is NOT on main**, despite
  `gh pr list` showing it as `state: MERGED`. It was merged into a stacked branch
  `fix/api-double-stringify` (merge commit `f1483c8`), not into `main` — that base branch's own fix
  landed on main separately via PR #145 (different commit, same intent), and the stacked branch was
  never rebased/re-merged. `git merge-base --is-ancestor f1483c8 origin/main` → NO.
  `ImportSimulationDialog.tsx` on main is still the 127-line two-list picker with none of search/
  categories/multi-select/preview. This is the squash-merge-stacked-branch trap, see
  [[squash-merge-breaks-stacked-branches]] — but note here the PR *did* merge, just into the wrong
  base, so `gh pr list --state all` alone reads as done. Always check `baseRefName` too.
- **`sim-authoring.spec.ts` + `playwright.authoring.config.ts` exist and are real (11 browser tests,
  catches the DISARM/rAF-requeue bug per commit `7174a9a`) but are wired into NEITHER
  `.github/workflows/ci.yml` NOR `client-web/package.json` scripts** — grepped both, zero hits for
  "sim-authoring" or "playwright.authoring". Runnable only by hand
  (`npx playwright test --config=playwright.authoring.config.ts`). This is the only place the
  picker's badge geometry is checked, per the config's own header comment — currently unenforced.
- **`.claude/review/DECISIONS.md` carries THREE stale headers that contradict `origin/main`:**
  - line 315, `🔴 FIXED, NOT YET MERGED ... PR #146` (podcast wrong-table) — PR #146 merged to main
    2026-08-25T19:18Z, base `main`. Header never updated after merge.
  - line 1466, `🔴 FIXED, NOT YET MERGED` (triple JSON-encode / Save bridge) — PR #145 merged to
    main 2026-08-25T19:17Z, base `main`. Same staleness.
  - line 1424, `🟡 OPEN ... its header outlived it` (action-recording deep-review doc) — the 2,384
    missing lines were committed in `ca7a9d8` (2026-08-25), confirmed present on main (2,647 lines,
    §§1-17 all exist). The DECISIONS.md entry's own text says "it must be committed before anything
    else happens" but never got a closing update after that commit landed.
  Pattern: a merge or commit lands, but the ledger entry describing it as pending is never revisited.
  Worth checking DECISIONS.md 🔴/still-"pending" headers against `gh pr view <n> --json state,
  baseRefName,mergedAt` rather than trusting the emoji.
