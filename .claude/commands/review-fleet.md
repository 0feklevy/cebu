---
description: Run the FlowVid multi-agent review fleet — dispatches specialist reviewers in parallel, adversarially verifies every P0/P1, and produces one ranked report plus a safe fix plan.
argument-hint: [scope, e.g. "whole codebase" | "branch diff" | "export pipeline" | "security pass"]
---

Run the FlowVid review fleet over: **$ARGUMENTS** (if empty, review the current branch diff
`main...HEAD`).

Launch the `review-orchestrator` agent to do this. It will:

1. Read `.claude/reference/stack.md` and `.claude/review/PROTOCOL.md`.
2. Create `.claude/review/runs/<utc-timestamp>/` and write `MANIFEST.md` with the chosen scope
   profile and the commit under review.
3. Dispatch the specialist reviewers that own the affected subsystems **in parallel** — all 16 for
   a full audit, or the subset mapped from the changed files for a scoped run.
4. Dispatch `finding-verifier` against **every P0 and P1** to try to refute it, and apply the
   verdicts: refuted findings move to a "Rejected claims" appendix, uncertain ones are demoted.
5. Deduplicate across domains using the `.jsonl` files, route `signals.md`, and write `REPORT.md`
   and `FIX_PLAN.md`.
6. Report back with counts, the top five fixes, how many claims were rejected, and the artefact
   paths — then **ask** before applying anything.

Nothing is edited, committed, or pushed without your explicit approval. Reviewers cannot edit
source at all; `.claude/hooks/fleet-guard.mjs` denies it at the tool layer.
