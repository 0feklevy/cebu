---
name: verified-non-findings
description: Billing claims that LOOK like P0s in FlowVid but were traced and found correct — check these before filing, and re-verify the cited lines still say what this claims
metadata:
  type: project
---

Three billing "smells" in `podcast-saas/` were traced to the source and found **correct** as of
commit `2d187e3` (review run 2026-08-15T2109). Do not re-file them without re-reading the cited
code first — they are the obvious false-P0s in this domain.

1. **Stripe webhook signature IS verified over the raw bytes.**
   `controllers/v1/stripe-webhook.controller.ts` registers the route inside a plain async
   `app.register(...)` plugin and adds an `application/json` parser with `parseAs: 'buffer'`.
   Fastify clones the content-type-parser table per encapsulated plugin
   (`fastify/lib/pluginOverride.js` — `buildContentTypeParser`), so the buffer override is scoped
   to this route and the rest of the app keeps JSON. `existingParser()` allows overriding the
   built-in JSON parser, so it does not throw at boot.
   **Why it matters:** if someone ever wraps that register call in `fastify-plugin`, or hoists the
   parser to the root instance, signature verification breaks silently — that IS a P0. Check the
   encapsulation, not just the `constructEvent` call.

2. **The webhook/reconcile double-grant race is benign.** `grantFromSession` reads `tx.status`
   outside the transaction, but `user_purchases` carries `UNIQUE (user_id, content_type,
   content_id)` (migration `024_billing.sql`) and the insert uses `onConflictDoNothing`. The
   idempotency lives in the DB constraint, not the code.

3. **Customer money is integer minor units end to end.** `amount_cents`, `platform_fee_cents`,
   `creator_payout_cents`, `price_cents` are all `INTEGER`, and `calculateFees` derives the payout
   by subtraction so fee + payout always re-sums. The float ledger is a *different* column —
   `token_usage.cost_cents` is `double precision` (migration 046), which is a real finding.

Also settled: this product has **no subscriptions or trials** (one-off pay-to-unlock only), and
there is **no admin manual credit/refund endpoint** — so "trial expiry in local time" and
"unaudited manual credit" are not applicable findings here.

Related: [[fleet-review-conventions]]
