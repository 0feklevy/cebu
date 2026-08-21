# Repo cleanup — inventory, moves, and approval requests

**Date:** 2026-08-20 (snapshot ~19:05–19:15) · **Branch:** `feat/library-share-minisite` (based at PR #29; `origin/main` is at #43/#44)
**Constraints honored:** nothing deleted; `podcast-saas/md-files/` untouched (a workflow wrote `LIBRARY-SHARE-MINISITE-PLAN.md` there at 19:14, mid-cleanup — it is live); no source dirs, no protected `.claude/` paths, no git add/commit/push; no tracked file moved.

## The single most important finding

**Half of the "untracked clutter" is not clutter — this branch is simply behind `origin/main`.**
`origin/main` (merged through PR #43, 2026-08-19) *tracks* `.claude/review/DECISIONS.md`, `DECISIONS-ARCHIVE.md`, `CODEX-DECISION-RESPONSE-2026-08-17.md`, `HANDOFF-2026-08-18.md`, `patents/`, `runs/2026-08-15T2109/`, `.claude/agents/meta/patent-scout.md`, `task-tracker.md`, and `.audit-ledger/`. On this branch they show as `??` only because the branch forked before PRs #32–#43 landed. Three of them (`DECISIONS.md`, `DECISIONS-ARCHIVE.md`, `CODEX-DECISION-RESPONSE-2026-08-17.md`) carry **local edits newer than main's copies** — this worktree is the live decision record ("dirty-by-design, docs only", per HANDOFF §1). Moving any of them would fork the record; also, differing untracked copies will **block a future merge of main** into this branch ("untracked working tree files would be overwritten"). The real fix for most of the git-status noise is merging/rebasing `origin/main` into this branch — not moving files.

---

## A. Inventory

### Repo root `/Users/ofeklevy/cebu/`

| Path | What it is | Evidence | Class |
|---|---|---|---|
| `claim-demo.sh` | Local-dev helper: reassigns the seeded demo project to the last anonymous user (local psql only) | Part of the export-capture debug harness; documented in `LOCAL-CAPTURE-README.md` ("untracked local helpers — not for the repo") | **WIP-untracked** — leave |
| `claim-demo-watch.sh` | 5-min ownership-watcher loop (local DB) | **Invoked by `run-local-capture.sh:35`** | **WIP-untracked** — leave |
| `.claim-demo-watch-long.sh` | **Byte-identical duplicate** of `claim-demo-watch.sh` (verified with `diff`), hidden by the leading dot | Zero functional references; its name appears once, descriptively, in the frozen run doc `runs/2026-08-15T2109/DETERMINISTIC.md:166`; no process running it. Left in place because that mention fails the strict zero-reference rule | **DELETE-CANDIDATE** |
| `run-local-capture.sh` | One-shot local stack for linear-video-export with live sim capture (`EXPORT_CAPTURE_LOCAL=1`), with a hard refuse-if-not-local-DB guard | Referenced by `LOCAL-CAPTURE-README.md:44` and `.claude/reference/solutions/structural-architecture-plan.md:290`. The export-capture **throughput blocker is still open** (`DECISIONS.md` "Known and accepted": ~10× too slow, unfixed) | **WIP-untracked** — leave |
| `LOCAL-CAPTURE-README.md` | The capture-fix record: what shipped in the PR vs. what stays dev-only, plus run instructions | Referenced by `structural-architecture-plan.md:46,290`; declares itself and the helpers intentionally untracked | **WIP-untracked** — leave; gitignore candidate |
| `.env.local` (root) | **Empty file, 0 bytes**, Aug 6 | Nothing at repo root loads env; already ignored by the root ignore rule `*.env.local` | **DELETE-CANDIDATE** |
| `.github/workflows/` (ci, release, rollback, production-audit) | Live CI/CD | Active workflows | **ACTIVE** |
| `_archive/2026-08-20/` | Created by this cleanup (holds the one moved file) | PROTOCOL.md §5 already instructs agents to skip `_archive/` | new — gitignore candidate |

### `.claude/review/`

| Path | What it is | Evidence | Class |
|---|---|---|---|
| `PROTOCOL.md`, `README.md` (modified) | Fleet contract + docs; the local edits register the two new agents (`patent-scout`, `task-tracker`; "24 → 26 agents") | Matches the agents tracked on origin/main — a pending, intentional doc update | **ACTIVE** — left modified |
| `FLEET-AUDIT.md` | `fleet-maintainer`'s designated output file | Wired into `settings.json:5`, `hooks/fleet-guard.mjs:6`, `fleet-guard.test.mjs:70`, `agents/meta/fleet-maintainer.md:78` | **ACTIVE** |
| `DECISIONS.md` | Open-decisions ledger, updated 2026-08-19 | Tracked on origin/main; **local copy is newer**; points at `DECISIONS-ARCHIVE.md` | **ACTIVE** |
| `DECISIONS-ARCHIVE.md` | Closed rulings (PR #38 "close the round") | Tracked on origin/main; **referenced by `DECISIONS.md:4`**; local copy differs | **ACTIVE** |
| `CODEX-DECISION-RESPONSE-2026-08-17.md` | The external reviewer's rulings — the source of D-13/D-14/D-16/D-17, updated 08-19; those items are still PARTIAL in `DECISIONS.md` | Tracked on origin/main; local copy differs | **ACTIVE** |
| `HANDOFF-2026-08-18.md` | Remediation-round handoff (round now closed via merged PR #32) | Tracked on origin/main (identical); **referenced by `.claude/agent-memory/patent-scout/project_stale_worktree_trap.md:18`** — archivable only after that pointer is updated, and the memory dir is off-limits | **ACTIVE** (historical but referenced) |
| `PR-BODY.md` | Draft body of PR #32 ("Night-audit remediation") | PR #32 **MERGED**; its GitHub body is this file verbatim; untracked on branch **and** absent from origin/main; zero inbound references | **ARCHIVE-SAFE → MOVED** |
| `runs/2026-08-13T2227/` (tracked) | First v2 fleet run, deliberately committed with the fleet upgrade | Cited by `reference/stack.md:130` ("Verified clean on 2026-08-14") and by run-2026-08-15 fleet findings | **ACTIVE** (referenced history) |
| `runs/2026-08-15T2109/` | Night-audit run artifacts (REPORT.html, DETERMINISTIC.md, findings/) | Tracked on origin/main; referenced by HANDOFF §1 and several agent-memory files | **ACTIVE** |
| `patents/` | Novelty dossiers: 2026-08-16 (.md + .jsonl) and 2026-08-19 (**.jsonl only — likely mid-run**, written 08-19 18:48) | Tracked on origin/main; `patent-scout` is a new active agent | **ACTIVE** |

### `.claude/` (other)

| Path | What it is | Evidence | Class |
|---|---|---|---|
| `agents/meta/patent-scout.md`, `task-tracker.md` | New fleet agents (untracked here) | **Tracked on origin/main**; protected dir | **ACTIVE** |
| `agent-memory/` (root, incl. empty `simulation-reviewer/`) | Live agent auto-memory | Protected by instruction | **ACTIVE** — untouched |
| `reference/solutions/structural-architecture-plan.md` | fiji-advisor's 57 KB structural plan (2026-08-16, `mode: unverified`) | Untracked everywhere, but sits in the PROTOCOL-sanctioned advisor output dir beside 4 tracked siblings | **WIP-untracked** — leave; commit candidate |
| `ship/` (`current` + `runs/ship-20260814T193503Z`) | Ship-conductor run evidence | Gitignored by design (`/.claude/ship/` in root .gitignore) | **ACTIVE** |
| `worktrees/` | Empty; Claude Code worktree target | Functional | **ACTIVE** |

### Scattered `.claude/` dirs inside packages (all: agent-memory only, none on origin/main)

| Path | Contents | Class |
|---|---|---|
| `podcast-saas/.claude/agent-memory/` | `backend-reviewer` (Anam latency root-cause + session semantics — substantive), `config-deploy-reviewer` (env-example split, config surface), `performance-reviewer` (**empty**), `frontend-reviewer` (**empty**) | **WIP-untracked** — leave |
| `podcast-saas/backend-api/.claude/agent-memory/` | `ui-ux-reviewer`, `performance-reviewer`, `types-contracts-reviewer`, `frontend-reviewer` (each with real notes), `test-quality-reviewer` (**empty**) | **WIP-untracked** — leave |
| `podcast-saas/client-web/.claude/agent-memory/` | `fleet-maintainer`, `fiji-advisor` (real notes) | **WIP-untracked** — leave |

These are **functional but misplaced** — fleet agents ran with cwd set to the package instead of the repo root, so their memory landed beside them (the exact class of bug the v2 fleet README documents for agents/). The content is real investigation knowledge (e.g. the Anam `controller.ts:197` latency root cause). **Recommended follow-up (owner action):** merge each `<agent>/` dir into root `.claude/agent-memory/<agent>/` and merge the MEMORY.md indexes — I did not do this because the destination is on the do-not-touch list. The 3 empty leaf dirs are rmdir candidates below.

### `podcast-saas/` root

| Path | What it is | Class |
|---|---|---|
| `md-files/` | 24 docs, and growing **while I write** (`LIBRARY-SHARE-MINISITE-PLAN.md` appeared 19:14). Listed below; **nothing touched** | UNTOUCHED |
| `.sim-fixture/`, `.rebuilt-fixture/` | Generated browser-test fixtures — inputs to `playwright.sim/rebuilt` configs; gitignored | **ACTIVE-generated** |
| `references/` | Tracked reference implementations (crop-processor, reference-podcast) | **ACTIVE** |
| `backend-api/.local-storage/` | Runtime storage fallback (R2 write-denied) — **live data**; gitignored | **ACTIVE** — never touch |
| `backend-api/src/services/export/capture/localCaptureProvider.ts` | Dev-only local capture provider, gated on `EXPORT_CAPTURE_LOCAL=1`; deliberately kept out of the PR (see LOCAL-CAPTURE-README "PR split"); absent from origin/main | **WIP-untracked** — leave |

### `client-web/` root

| Path | What it is | Class |
|---|---|---|
| 9 `playwright.*.config.ts` | Deliberate multi-suite architecture — the fleet's test-quality-reviewer is even briefed on "the nine Playwright configs". All accounted for: default (`playwright test` in `test:smoke`), sim/protocol/transport/canary/leak (paired e2e specs), production (wired into CI via `ops/release` contract test), rebuilt (rollout runbooks), viewer (known-unwired — already filed as a finding in run 2026-08-15T2109 `findings/test-quality.md:360`; not re-reported here) | **ACTIVE** |
| `coverage/` 7.6M · `e2e-results/` 1.1M · `test-results/` · `tsconfig.tsbuildinfo` | Generated; **all verified gitignored** (`git check-ignore` against `podcast-saas/.gitignore`) | **ACTIVE-generated**; optional disk cleanup below |
| `_archive/v1-podcast-pipeline/` | Tracked, deliberate archive of v1 components | **ACTIVE** (already an archive) |
| `.env.local` (736 B) | Local env config; gitignored; **not read, not touched** | **ACTIVE** |

Also generated-and-ignored: `backend-api/coverage/` 9.8M, `admin-web/tsconfig.tsbuildinfo` + `.next/`, `shared/dist/`. **No `.DS_Store`, no editor droppings (`*.orig`, `*~`, swap files) anywhere.**

### `md-files/` — historical vs. current (LIST ONLY — nothing moved, workflows writing here now)

Dates are git first-added → last-commit.

- **CURRENT / ACTIVE:** `LIBRARY-SHARE-MINISITE-PLAN.md` (written today, by a running workflow, for this very branch) · `LINEAR-VIDEO-EXPORT-PLAN.md` (08-12→13; export work still open) · `EXPORT-CAPTURE-ISOLATION.md` (08-13→14; capture line continued through PR #44 on 08-19) · `SIM-RUNTIME-PROTOCOL-V3.md` (08-04; current protocol reference)
- **HISTORICAL — merged-PR bodies:** `PR-BODY-P456.md` (08-04), `PR-BODY-P78.md` (08-05→07), `PR-BODY-SIM-AUDIT-REMEDIATION.md` (08-12)
- **HISTORICAL — completed rollouts/audits (superseded by the 08-11 deep audit → remediation → merged PRs chain):** `SIMULATION-VIDEO-PIPELINE-DEEP-AUDIT.md`, `SIM-AUDIT-REMEDIATION-PLAN.md` (08-11), `SIM-REBUILD-ROLLOUT.md` (08-01→03), `SIM-P456-ROLLOUT.md` (08-04), `P8-ROLLOUT-AND-DEVICE-VALIDATION.md`, `P8-MEASURED-EVIDENCE.md` (08-05), `SIM-PIPELINE-HARDENING-VERDICT.md` (08-01→02), `FLOWVID-SIMULATION-PIPELINE-OPTIMIZATION-BRIEF.md` (08-01), `sim-pool-audit-report.md` (07-31), `sim-performance-optimization-plan.md` (07-25), `sim-ui-controls-plan.md` (07-28)
- **HISTORICAL — founding docs (May–Jul):** `podcast-pipeline-architecture.md`, `llm-integration-guide.md`, `client-admin-ai-architecture.md` (05-27→29), `viewer-simulation-parallel-pipeline.md` (05-29→06-30), `podcast-studio-plan.md` (07-08)

A future `md-files/archive/` pass is sensible **only after the 5 workflows finish**, and note that rollout docs are cited by playwright-config runbooks (`SIM-REBUILD-ROLLOUT.md:122,227`), so move-with-grep, not en masse.

---

## B. Moves executed (1)

| # | From | To | Why safe |
|---|---|---|---|
| 1 | `/Users/ofeklevy/cebu/.claude/review/PR-BODY.md` | `/Users/ofeklevy/cebu/_archive/2026-08-20/claude-review/PR-BODY.md` | Untracked on this branch **and** absent from origin/main; zero inbound references (repo-wide grep, re-run clean after the move); its PR (#32) is merged and GitHub holds the identical canonical body |

**Reverse command:**
```bash
mv /Users/ofeklevy/cebu/_archive/2026-08-20/claude-review/PR-BODY.md /Users/ofeklevy/cebu/.claude/review/PR-BODY.md
```

Post-move verification: reference grep re-run — no references anywhere. No tracked file was moved, so the typecheck run was not required (per the agreed procedure) and was skipped.

---

## C. DELETE candidates — awaiting your approval (nothing deleted)

1. `/Users/ofeklevy/cebu/.claim-demo-watch-long.sh` — byte-identical duplicate of `claim-demo-watch.sh` (diff-verified), hidden by its leading dot; zero functional references (one descriptive mention in the frozen run doc `DETERMINISTIC.md:166`); no process running it.
2. `/Users/ofeklevy/cebu/.env.local` — 0 bytes since Aug 6; no application loads env from the repo root; nothing can lose a value that does not exist.
3–5. Three **empty** misplaced agent-memory leaf dirs (no files; git does not track directories): `podcast-saas/.claude/agent-memory/performance-reviewer`, `podcast-saas/.claude/agent-memory/frontend-reviewer`, `podcast-saas/backend-api/.claude/agent-memory/test-quality-reviewer`.

```bash
# Approved deletions — paste as-is
rm /Users/ofeklevy/cebu/.claim-demo-watch-long.sh
rm /Users/ofeklevy/cebu/.env.local
rmdir /Users/ofeklevy/cebu/podcast-saas/.claude/agent-memory/performance-reviewer \
      /Users/ofeklevy/cebu/podcast-saas/.claude/agent-memory/frontend-reviewer \
      /Users/ofeklevy/cebu/podcast-saas/backend-api/.claude/agent-memory/test-quality-reviewer
```

**Optional, separate decision — regenerable outputs (~18.5 MB), all gitignored; run only when no tests/workflows are running:**
```bash
# Optional: regenerated by the next test/coverage run
rm -rf /Users/ofeklevy/cebu/podcast-saas/client-web/coverage \
       /Users/ofeklevy/cebu/podcast-saas/backend-api/coverage \
       /Users/ofeklevy/cebu/podcast-saas/client-web/e2e-results \
       /Users/ofeklevy/cebu/podcast-saas/client-web/test-results
```

---

## D. GITIGNORE candidates (report only — no .gitignore edited)

Root `/Users/ofeklevy/cebu/.gitignore`:
```diff
@@ end of file @@
+
+# Cleanup archive (agents already skip _archive/ per review PROTOCOL §5)
+/_archive/
+
+# Local export-capture debug harness — deliberately not for the repo
+# (their own README says so, and PR #43 exists because untracked files block deploys)
+/claim-demo.sh
+/claim-demo-watch.sh
+/.claim-demo-watch-long.sh
+/run-local-capture.sh
+/LOCAL-CAPTURE-README.md
```
(Alternative for the harness: commit it under a `scripts/dev/` dir instead — it has real prod-safety guards and a README worth keeping. Owner's call; ignoring is the low-touch option.)

`podcast-saas/.gitignore` — one **dead entry**:
```diff
-# Review swarm run outputs (disposable; agent defs + protocol stay tracked)
-.claude/review/runs/
```
This pattern is anchored under `podcast-saas/`, where no `.claude/review/` exists — it matches nothing. Do **not** migrate it to the root .gitignore: current practice (origin/main) deliberately commits run dirs (`runs/2026-08-15T2109` landed via PR #32). Removing the stale line is the consistent fix.

---

## E. What I deliberately did NOT touch, and why

- **`podcast-saas/md-files/`** — 5 workflows are writing there; one new file appeared during this cleanup. Listed only.
- **Every `.claude/review/` doc except PR-BODY.md** — either tracked on origin/main (branch-behind, not stray), carrying local edits newer than main (live decision record), or referenced (`DECISIONS.md → DECISIONS-ARCHIVE.md`; agent memory → `HANDOFF-2026-08-18.md`; `stack.md:130` → run 2026-08-13T2227; settings/hook/test → `FLEET-AUDIT.md`).
- **Modified `PROTOCOL.md`/`README.md`** — the edits are the intentional, not-yet-committed registration of the two new fleet agents.
- **The root capture harness** (`claim-demo*.sh`, `run-local-capture.sh`, `LOCAL-CAPTURE-README.md`, `localCaptureProvider.ts`) — supports the still-open export-capture throughput blocker; cross-referenced by tracked-on-main docs; being untracked is by explicit design, not neglect.
- **Scattered package-level agent-memory** — functional knowledge; consolidation into root `.claude/agent-memory/` needs your go-ahead because that destination is protected, and one memory file contains a run-path reference that must survive the merge.
- **All generated/ignored dirs** (`coverage`, `e2e-results`, `test-results`, `.next`, `*.tsbuildinfo`, `.sim-fixture`, `.rebuilt-fixture`, `shared/dist`) and **`backend-api/.local-storage/`** (live runtime data). Neither `.env.local` file's contents were opened.
- **Protected paths** per instruction: `.claude/{agents,skills,settings*,agent-memory}/`, `~/.claude/`, sources, node_modules, pnpm/tsconfig files. No `git add`/`commit`/`push` was run; the one move used plain `mv` on an untracked file.

**Suggested next step (owner):** merge/rebase `origin/main` into `feat/library-share-minisite` — it retires ~14 of the 22 git-status entries at once and is the single biggest de-messifier available.
