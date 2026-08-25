---
name: action-recording-phase0
description: Phase-0 design state of the action-recording feature — the proof-state decision (allow-list first, new statuses later) and the sectionVersion/idempotency gap
metadata:
  type: project
---

Action recording is in **Phase 0** (design-only gate) as of 2026-08-25. The gate is
`podcast-saas/md-files/ADR-ACTION-RECORDING-SEMANTICS.md` §6; the deep review is
`.claude/review/RESEARCH-ACTION-RECORDING-2026-08-25.md` §9/§15. No endpoint may be written until
the ADR is approved.

Two Phase-0 items were settled in `podcast-saas/md-files/PHASE0-PROOF-STATE-AND-IDEMPOTENCY.md`:

- **Proof state (ADR D8 / criterion 4):** recommended **inverting `isRevisionStatusPublic` to an
  allow-list** (`active`/`retired`/`rolled_back`/null) as a code-only Phase-0 change, and deferring
  new `proof_pending`/`proof_passed` statuses to Phase 2. The allow-list must ship in an EARLIER
  release than any new status value, because the deny-list form serves an *unknown* status publicly
  — so a rolling deploy would expose a `proof_pending` candidate.
- **Idempotency (criterion 7):** `timeline_sections` has **no** version/optimistic-concurrency column;
  one must be added with a `BEFORE UPDATE` trigger. There is no durable request-idempotency table in
  the repo — `sim_action_recordings` is new ground.

**Why:** the recording feature publishes public executable code, so a candidate must be replay-proven
while unreachable; and Apply is a multi-second build that a client will retry.

**How to apply:** when reviewing anything that touches `sim_revisions.status`,
`revisionIdentity.ts`, or `timeline_sections` writes, check it against that document first — the
decisions there are the intended direction, not yet implemented. Related: [[verify-a-code-comments-factual-claim]].
