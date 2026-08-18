# Run manifest — 2026-08-15T2109

Required by PROTOCOL.md §1 and missing until now. Written after the fact, from the artifacts and
the git history, so it records what the run ACTUALLY did rather than what was planned.

## Scope

Whole-codebase review of the FlowVid monorepo, not a diff review.

- **Commit under review:** `2d187e3` (main at the time)
- **Remediation base:** `30c0a4b` — the head of PR #31 plus two CI fixes. Chosen deliberately: PR
  #31 was open, CI-green after those fixes, and already contained export/queue/migration work the
  remediation would otherwise have duplicated.
- **Remediation branch:** `fix/night-audit-2026-08-15`
- **Status:** NOT READY. See `FIX_PLAN.md` for the blockers.

## Agents dispatched

**Wave 1 — 16 specialist reviewers, in parallel:** backend, security, database, media-pipeline,
job-queue, llm-pipeline, billing-integrity, simulation, frontend, ui-ux, performance,
types-contracts, test-quality, observability, config-deploy, dependency.

**Verification:** 32 `finding-verifier` runs over the P1 set — three adversarial lenses per P0
(correctness, guard, reachability), one per P1. No product P0 was filed, so the three-lens path went
unexercised.

**Supplementary, dispatched after gaps appeared:** frontend-viewer and frontend-editor (the first
frontend pass returned only three findings across 282 files); scripts-ship (a fleet audit proved
`ops/ship/**` and `backend-api/src/scripts/**` were named by zero agent definitions); anam-backend,
anam-frontend, anam-latency, broll-player, broll-data (the owner reported two production symptoms
mid-run); fiji-advisor; fleet-maintainer; task-tracker; patent-scout.

**Total:** 57 agents in the review phase (25 reviewers, 32 verifiers), plus the remediation streams.

## Artifacts

| File | What it is |
|---|---|
| `findings/*.md`, `findings/*.jsonl` | 330 findings, 25 domains, human- and machine-readable |
| `VERIFIED.jsonl` | 33 lines / 32 unique ids — see the integrity note below |
| `signals.md` | 121 cross-agent handoffs |
| `DETERMINISTIC.md` | every measured number, with the command that produced it |
| `REPORT.html` | the ranked report (87 KB) |
| `FIX_PLAN.md` | what was fixed, what is blocked, and on what |
| `../../patents/2026-08-16-novelty-dossier.md` | novelty assessment: 2 survivors, 28 rejections |
| `<worktree>/.audit-ledger/ledger.jsonl` | per-finding ledger, two axes |

## Integrity notes — read these before trusting the numbers

1. **`VERIFIED.jsonl` is not clean.** 33 lines, 32 unique ids, of which only **29 belong to the
   corpus**: `database-002` appears twice, and three `orch-*` verdicts have no source finding (they
   verify the orchestrator's own claims, not the fleet's). So 301 of 330 findings never received an
   adversarial verdict — including **5 P0 and 33 P1**, not only P2/P3 as first reported.
2. **Reporter severity is not a verdict.** Of the 32 findings ever verified, **23 were downgraded**.
   The ledger therefore carries `reportedSeverity` and `correctedSeverity` as separate fields.
3. **Five findings files were written hours after `VERIFIED.jsonl`** — the Anam and b-roll
   investigations were dispatched after the verification stage had run. They are unverified by
   construction, and the run had no completion barrier to prevent that.
4. **Per-agent guard hooks were inactive for this run.** Frontmatter hooks need workspace trust;
   only the project-wide secrets floor fired. The secrets floor held and `git diff --stat` was empty
   throughout the review phase, but the read-only guarantee PROTOCOL.md describes was weaker than
   stated. Filed as `fleet-019`.
5. **`rootCauseId` is empty on all 330 rows.** The clustering pass is not done, so the P2/P3
   backlog is still a flat list with known duplicates.
