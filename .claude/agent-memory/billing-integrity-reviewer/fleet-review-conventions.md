---
name: fleet-review-conventions
description: How the FlowVid review fleet expects billing findings to be written and where the ground truth lives (stack.md, PROTOCOL.md, OUTPUT_DIR)
metadata:
  type: reference
---

Ground truth for every review run, read in this order:
- `.claude/reference/stack.md` — what the repo actually is (Fastify 4 + Postgres/Drizzle, NOT
  Express/MySQL; `podcast-saas/CLAUDE.md` is stale GoDaddy/MySQL boilerplate and must be ignored).
  If the agent prompt contradicts it, stack.md wins **and the contradiction is itself a finding**
  with `category: fleet`.
- `.claude/review/PROTOCOL.md` §2 — finding format and the severity rubric. Severities are applied
  by the rubric test, not by feel; every P0/P1 is handed to an adversarial verifier whose job is to
  refute it, and a P0 nobody can confirm never ships as a P0.

**Write only to the `OUTPUT_DIR` the orchestrator hands you** (`.claude/review/runs/<run-id>/`).
The filename comes from the orchestrator's dispatch message, not from the agent file — in run
2026-08-15T2109 those two disagreed (`billing.md` vs `billing-integrity.md`) and the orchestrator's
name won per PROTOCOL §1. Never guess a run-id.

Paths in findings are **repo-root-relative** (`podcast-saas/backend-api/src/...`). Commands need
`-C`: `pnpm -C podcast-saas --filter backend-api test`.

Reviewers are read-only: no edits to source, no git state changes, no migrations, no `.env` reads.
This is enforced by `.claude/hooks/fleet-guard.mjs`, not merely requested.

Related: [[verified-non-findings]]
