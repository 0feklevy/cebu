---
name: flowvid-billing-review-descoped
description: owner descoped the planned billing review round on 2026-08-21 — don't propose dispatching billing-integrity-reviewer without checking this is still current
metadata:
  type: project
---

The 2026-08-21 CODEX response (P3-D/P3-F Round B) planned a dedicated billing review round: unpark
two P1 findings and dispatch `billing-integrity-reviewer` over Stripe webhook authenticity,
idempotency, entitlements and fee arithmetic. PR #48 (`docs/post-release-v0.1.36`) records that this
was cancelled: **"billing is descoped at the owner's direction... the billing feature is not
currently relevant."** The 24 `OUT_OF_SCOPE_BILLING` ledger findings (incl. two P1s — `billing-001`
"a free playlist silently un-paywalls every paid video inside it", and `test-quality-002`
"stripe-webhook.controller.ts has zero tests") stay parked deliberately, not fixed.

**Why:** explicit owner call, not a technical blocker — billing/paywalls are not part of the
product's current focus.

**How to apply:** do not recommend scheduling the billing round or dispatching
`billing-integrity-reviewer` as near-term work. The live money path today is dubbing, guarded
instead by the R-03 per-user monthly ceiling (`DUBBING_MONTHLY_BUDGET_CENTS`). Re-check
`DECISIONS.md`'s 🟡 section before assuming this is still descoped in a later session — it's an
owner preference, not a permanent architectural fact, and could change. See
[[flowvid-decisions-process]].
