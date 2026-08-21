---
name: fleet-audit-recommendations-go-unapplied
description: Fleet audits in this repo have a follow-through gap — always check whether the previous audit's recommended edits were actually applied before re-recommending them
metadata:
  type: project
---

Fleet audit findings in `.claude/review/FLEET-AUDIT.md` are only partially applied between runs.
Between the 2026-08-14 audit and the 2026-08-16 audit, the structural recommendations landed
(guard v2 rewrite, `.claude/settings.json` secrets floor, `stack.md` table/migration counts) but
the small per-agent text edits did **not**: "drop Groq from llm-pipeline-reviewer", "`71-file` →
`58-file` in database-reviewer", "`128` → `131` test count", "replace the 3 job filenames with the
11 registry names", "add a How-you-will-be-wrong section to 5 agents".

**Why:** the audit writes a report; nothing applies it. `review-fixer` is the only agent permitted
to edit, and it only runs against a review run's `FIX_PLAN.md`, not against `FLEET-AUDIT.md`. So
one-line prose edits fall through the gap while code-level ones get done by hand.

**How to apply:** at the start of every fleet audit, diff the previous audit's "Recommended edits"
table against the current files and report **application status** as its own section — an unapplied
recommendation is a finding, not a repeat. Note that a stale count drifts *further* while unfixed:
the backend test count was recommended `128 → 131`, was never changed, and by 2026-08-16 the true
value was 136. Re-derive, never carry forward the previous audit's number.

Related: [[stack-md-is-subject-not-source]]
