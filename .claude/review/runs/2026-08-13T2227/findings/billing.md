# Billing Integrity — findings

Agent: `billing-integrity-reviewer`. Run: `2026-08-13T2227`.
Scope swept: `stripe-webhook.controller.ts`, `billing.controller.ts` (v1 + admin),
`BillingService.ts`, `UsageTrackingService.ts`, `RateLimitService.ts`, `middleware/rate-limit.ts`,
`lib/rateLimit.ts`, `billing_transactions` / `token_usage` / `user_purchases` in `db/schema.ts`
+ `db/migrations/024_billing.sql`, `046_token_usage_cost_precision.sql`.

---

## Verified NON-findings (stated explicitly — these were the P0 candidates)

**1. Webhook signature verification is sound. Not a finding.**
`podcast-saas/backend-api/src/controllers/v1/stripe-webhook.controller.ts:12-17` registers the route
inside an encapsulated `app.register(async (scoped) => …)` and calls
`scoped.addContentTypeParser('application/json', { parseAs: 'buffer' }, …)`. I verified this
actually works rather than assuming it:
- Fastify **4.29.1** (`podcast-saas/node_modules/.pnpm/fastify@4.29.1/…/lib/contentTypeParser.js:83`)
  — `existingParser()` returns `false` for `application/json` when the registered parser is still
  `this[kDefaultJsonParse]`, so overriding the built-in JSON parser does **not** throw
  `FST_ERR_CTP_ALREADY_PRESENT`, and the override is confined to the child scope.
- `grep -rn "addContentTypeParser" backend-api/src` returns **exactly one** hit (the webhook).
  Nothing replaces the JSON parser globally, and `server.ts` registers **no** `addHook` at all,
  so nothing reads/re-serialises the body before the handler.
- `BillingService.verifyWebhook` (`BillingService.ts:184-190`) passes that Buffer straight into
  `stripe.webhooks.constructEvent(payload, signature, secret)` and **throws** when
  `STRIPE_WEBHOOK_SECRET` is unset — it is not lenient. The handler 400s on failure
  (`stripe-webhook.controller.ts:26-29`).

**Conclusion: the signature is verified over the exact raw bytes. There is no unsigned-webhook P0.**

**2. `checkout.session.completed` redelivery does not double-grant. Not a finding.**
`grantFromSession` short-circuits on `tx.status === 'succeeded'` (`BillingService.ts:199`) and the
grant insert uses `.onConflictDoNothing()` (`:216`). I checked the constraint is real in the
**migration**, not just the Drizzle model: `db/migrations/024_billing.sql:53` has
`UNIQUE (user_id, content_type, content_id)`, matching `schema.ts:796`. The read-then-act at
`:197-199` is a TOCTOU, but the unique constraint absorbs it and a Checkout Session is one charge,
so there is no double-charge path here.

**3. Platform fee arithmetic is correct. Not a finding.**
`calculateFees` (`BillingService.ts:44-47`) is integer minor units: `Math.round()` on the fee and
the payout as the **complement** (`amountCents - platformFeeCents`), so the parts always sum to the
total exactly. `billing_transactions` money columns are `integer` (`schema.ts:768-771`,
`024_billing.sql:25-28`). No float currency in the customer-charging path.

---

### [P1] `markFailed` has no status guard, so a late `payment_intent.payment_failed` erases a completed sale
- id: billing-001
- location: podcast-saas/backend-api/src/services/billing/BillingService.ts:226
- category: data-integrity
- confidence: high
- status: confirmed
- what: `markFailed()` sets `status: 'failed'` keyed only on `billing_transactions.id`, with no
  guard on the current status. A transaction already in `succeeded` (or `refunded`) is silently
  overwritten.
- why: Stripe does not guarantee event order, and this handler makes reordering *likely* rather
  than theoretical. A Checkout Session where the buyer's first card is declined and the second
  succeeds emits **both** `payment_intent.payment_failed` (attempt 1) and
  `checkout.session.completed` — both carrying the same `transactionId`, because it is set on the
  PaymentIntent at `BillingService.ts:161` (`payment_intent_data.metadata`) *and* on the session at
  `:162`. Worse, the webhook returns **500** on any handler error
  (`stripe-webhook.controller.ts:59`), so a `payment_intent.payment_failed` that hits one transient
  DB error is redelivered by Stripe minutes-to-hours later — long after the session completed.
  The result is a paid, captured charge whose row reads `failed`:
  `/api/v1/billing/earnings` filters `eq(status, 'succeeded')`
  (`controllers/v1/billing.controller.ts:155`) so the creator's sale and payout **disappear from
  their earnings**, and the admin overview (`controllers/admin/v1/billing.controller.ts:15-19`)
  under-reports volume and platform fees. The buyer keeps access (the `user_purchases` row is
  independent), so nothing surfaces as an error — the money is simply mis-stated.
- evidence: Read `BillingService.ts:222-237` in full — the `opts.transactionId` branch is
  `.set({ status: 'failed', … }).where(eq(billing_transactions.id, opts.transactionId))`, no `and`,
  no status predicate, and it `return`s before the PI-keyed branch. No caller guards it either
  (`stripe-webhook.controller.ts:41-45` calls it unconditionally). `services/billing/__tests__/`
  contains only `grantFromSession.test.ts` — `markFailed` has **zero** test coverage.
- fix: Make the transition monotonic — only `pending` may become `failed`:
  `.where(and(eq(billing_transactions.id, opts.transactionId), eq(billing_transactions.status, 'pending')))`,
  and apply the same predicate to the `paymentIntentId` branch at `:232-236`.
- verify: New test in `services/billing/__tests__/markFailed.test.ts` asserting a `succeeded` row is
  untouched — red before, green after; `pnpm -C podcast-saas --filter backend-api test` stays green.
- cross: @test-quality
- effort: S

### [P2] No Stripe `event.id` ledger — redelivery safety is per-handler, and only one handler is idempotent
- id: billing-002
- location: podcast-saas/backend-api/src/controllers/v1/stripe-webhook.controller.ts:31
- category: data-integrity
- confidence: high
- status: confirmed
- what: `event.id` is never recorded or checked. There is no webhook-event table anywhere in the
  schema or migrations, so replay/redelivery protection is whatever each handler happens to provide.
- why: `grantFromSession` is genuinely idempotent (status short-circuit + unique constraint), but
  `markFailed` is not (billing-001), and `handleRefund`/`handleDispute` re-run blind. Because the
  handler returns 500 on error (`:59`), Stripe *will* redeliver, and redelivery is unbounded in
  time — unlike raw replay by a third party, which `constructEvent`'s default 300s timestamp
  tolerance already bounds. This is the structural reason billing-001 is reachable.
- evidence: `grep -rn -i "stripe_event|webhook_event|event_id" backend-api/src/db/migrations/`
  returns nothing; `schema.ts` has no such table; `event.id` appears nowhere in
  `stripe-webhook.controller.ts` (the handler reads only `event.type` and `event.data.object`).
- fix: Add a `stripe_webhook_events (event_id TEXT PRIMARY KEY, type TEXT, received_at TIMESTAMPTZ)`
  migration (appended to the hardcoded list in `db/migrate.ts`). In the handler, open a transaction,
  `INSERT … ON CONFLICT DO NOTHING`, and skip the effect when zero rows were inserted — the insert
  and the effect in the **same** transaction, so a rollback un-claims the event.
- verify: Deliver the same event id twice in a test; assert the second call performs no writes.
- cross: @database-reviewer
- effort: M

### [P2] Paid content is not paywalled at the byte-serving layer
- id: billing-003
- location: podcast-saas/backend-api/src/services/storage/mediaAccess.ts:76
- category: data-integrity
- confidence: high
- status: confirmed
- what: `canServeMediaKey()` authorises media on token / visibility / ownership only. It never
  consults `access_type` or `BillingService.hasAccess`. For a project with
  `visibility='public'` **and** `access_type='paid'` — exactly what a monetised video is — line 76
  returns `true` for any unauthenticated caller holding the key.
- why: The paywall is enforced on the *metadata* routes (`player.controller.ts:50`, `:90`, `:124`,
  `share.controller.ts:29`, `permalink.controller.ts:78`/`:99`, `playlists.controller.ts:195` — that
  coverage is good) but not on the bytes. A single paying buyer can redistribute the HLS/mp4 URL and
  it streams forever to anyone, with no purchase and no expiry, because the public-visibility branch
  short-circuits before any token check. Revenue leak rather than auth bypass — the key is a UUID
  and I found no unauthenticated endpoint that leaks it for a locked project, so this is P2, not P0.
- evidence: Read `mediaAccess.ts` end to end; `grep -n "access_type|hasAccess"` in that file returns
  nothing. Allow-order is documented in its own header comment (lines 5-12) and omits billing.
- fix: In `canServeMediaKey`, after resolving the project, load `access_type`/`price_cents` and when
  `access_type === 'paid'` require `BillingService.hasAccess(user?.id ?? null, 'project', project.id)`
  — i.e. paid content must fall through to the token/owner branches instead of being granted by
  `visibility === 'public'`.
- verify: Test that a `public` + `paid` project's `hls/{id}/…` key is denied to an anonymous caller
  and allowed to a purchaser.
- cross: @security-reviewer
- effort: M

### [P2] LLM usage is metered only after the provider returns, so aborted calls are billed by the vendor but never recorded
- id: billing-004
- location: podcast-saas/backend-api/src/services/llm/LLMService.ts:223
- category: bug
- confidence: high
- status: confirmed
- what: `usageTracking.record(...)` runs *after* `provider.send(...)` resolves. If the call throws —
  timeout, or `opts.abortSignal` firing when the client disconnects mid-stream
  (`LLMService.ts:217`) — no `token_usage` row is written, even though the provider has already
  consumed and will charge for the tokens generated so far.
- why: Two consequences. (1) Cost under-reporting: the ledger that every $-report reads is missing
  the spend. (2) Quota bypass: the rolling-24h generation cap counts `token_usage` rows
  (`LLMService.ts:143-152`, `systemAi.ts:72-83`), so a caller who repeatedly starts an expensive
  generation and aborts near completion consumes real vendor spend while their cap counter stays
  at zero. Metering is also deliberately fail-open on DB error (`:236-238`, logged and swallowed),
  which is defensible for not 500-ing a paid-for response but means lost rows are invisible unless
  someone reads logs.
- evidence: Read `LLMService.ts:212-238`. The `record` call is downstream of the awaited provider
  call with no `try/finally` around it, and there is no partial-usage capture on the error path.
  Same shape at `:380-392`.
- fix: Capture whatever usage the provider reports on the error path too — wrap the provider call in
  `try/catch`, and in the catch record a `token_usage` row with the partial/estimated usage and a
  task suffix (e.g. `:aborted`) before rethrowing.
- verify: Test that an aborted `send` still writes one `token_usage` row.
- cross: @llm-pipeline-reviewer
- effort: M

### [P2] `RateLimitService.checkTokenBudget` is dead code — the weekly/monthly token budgets are never enforced
- id: billing-005
- location: podcast-saas/backend-api/src/services/usage/RateLimitService.ts:9
- category: bug
- confidence: high
- status: confirmed
- what: `checkTokenBudget()` (defaults 100k weekly / 500k monthly) has **zero callers**. The class is
  never instantiated anywhere in the backend.
- why: The file reads as the cost-control layer and is not one. The only limit that actually runs is
  the rolling-24h *generation count* cap, which is **off by default** — `LLMService.ts:132-133`
  documents "Per-user generation quota — OFF by default (`generation_limit_enabled=false` =>
  unlimited)". So on a default deployment there is no token budget and no call cap: one
  authenticated account can drive unbounded Anthropic/OpenAI/Gemini/Groq spend.
- evidence: `grep -rn "RateLimitService|checkTokenBudget" --include="*.ts" backend-api/src` returns
  only the definition file itself (2 hits, both `RateLimitService.ts`). Confirmed the live cap is a
  different mechanism at `LLMService.ts:137-155` and `systemAi.ts:72-83`.
- fix: Either wire `checkTokenBudget` into `LLMService.send*` alongside the existing generation-cap
  check, or delete the file so it stops implying a protection that does not exist. If wiring it in,
  note it sums `input_tokens + output_tokens` only — `cached_input_tokens` (`schema.ts:316`) is
  excluded and should be counted or explicitly justified.
- verify: `grep` shows a live call site; a test asserts a user over budget is rejected.
- effort: M

### [P2] No rate limit on any billing endpoint, though the helper exists and is used elsewhere
- id: billing-006
- location: podcast-saas/backend-api/src/controllers/v1/billing.controller.ts:56
- category: bug
- confidence: high
- status: confirmed
- what: Neither `/api/v1/billing/checkout` (`:56`) nor `/api/v1/billing/checkout/reconcile` (`:79`)
  is rate limited. `lib/rateLimit.ts` is imported by `podcast-render`, `podcast`, `avatar`, `broll`,
  `podcast-script`, `podcast-studio` and `sim-rum` controllers — but not by `billing.controller.ts`.
- why: Each `/checkout` call inserts a `billing_transactions` row (`BillingService.ts:139`) **and**
  creates a real Stripe Checkout Session (`:150`). An authenticated user looping it fills the
  transactions table with orphan `pending` rows (which the admin overview counts,
  `admin/v1/billing.controller.ts:16`) and burns the account's Stripe API quota. `/reconcile` makes
  an unbounded `stripe.checkout.sessions.retrieve` per request (`BillingService.ts:272`) with a
  caller-supplied id, giving an authenticated user a free Stripe-API amplifier.
- evidence: Read `billing.controller.ts` end to end — no `rateLimit` import, no limiter in any
  `preHandler`. Compared against `grep -rn "lib/rateLimit"`, which lists 7 other controllers.
- fix: Apply `rateLimit(\`billing:checkout:${userId}\`, …)` to both routes. Note `lib/rateLimit.ts:8`
  is an in-process `Map`, so the effective limit multiplies by replica count — key on the
  authenticated user id (available from `firebaseAuthMiddleware`), never on IP.
- verify: Test that the N+1th call in a window gets 429.
- cross: @performance-reviewer
- effort: S

### [P2] Refund/dispute/failure writes never check rows-affected, and log success unconditionally
- id: billing-007
- location: podcast-saas/backend-api/src/services/billing/BillingService.ts:248
- category: data-integrity
- confidence: high
- status: confirmed
- what: `handleRefund` (`:244-252`) and `handleDispute` (`:254-261`) key their `UPDATE` on
  `stripe_payment_intent_id`, discard the result, and then log
  `'[billing] refund recorded (access retained)'` / `'[billing] dispute recorded'` whether or not a
  row matched. `markFailed` has the same unchecked shape.
- why: `stripe_payment_intent_id` is only populated by `grantFromSession` (`:208`). Any transaction
  that never reached the grant — buyer paid but every webhook delivery 500'd, then the charge was
  refunded — still has `NULL` there, so the refund `UPDATE` matches **zero rows**, the row stays
  `pending` forever, and the log claims the refund was recorded. `:208` also writes `NULL` whenever
  `session.payment_intent` is not a string (an expanded object), which would permanently detach that
  transaction from all future refund and dispute events.
- evidence: Read `BillingService.ts:239-261`. No `.returning()`, no rowCount check; `logger.info` at
  `:251` is unconditional and outside any branch.
- fix: Use `.returning({ id: billing_transactions.id })` and `logger.warn` when the array is empty
  so an unmatched refund is visible. Additionally at `:208`, resolve the id from the expanded object
  (`typeof pi === 'string' ? pi : pi?.id ?? null`) instead of collapsing to `null`.
- verify: Test that a refund for an unknown PaymentIntent logs a warning rather than an info.
- cross: @observability-reviewer
- effort: S

### [P2] `PLATFORM_FEE_PERCENT` clamp does not guard NaN, so a typo'd env value breaks every checkout
- id: billing-008
- location: podcast-saas/backend-api/src/services/billing/BillingService.ts:22
- category: bug
- confidence: high
- status: confirmed
- what: `Math.max(0, Math.min(100, parseInt(process.env.PLATFORM_FEE_PERCENT ?? '15', 10)))`. The
  clamp looks defensive but `Math.min(100, NaN)` is `NaN` and `Math.max(0, NaN)` is `NaN`, so a
  non-numeric value propagates as `NaN`.
- why: `calculateFees` then returns `{ platformFeeCents: NaN, creatorPayoutCents: NaN }`, and
  `createCheckoutSession` inserts those into the `integer` columns `platform_fee_cents` /
  `creator_payout_cents` (`schema.ts:770-771`) — Postgres rejects `NaN` for `integer`, so **every**
  checkout fails at `BillingService.ts:139` with an opaque 400 from
  `billing.controller.ts:70-71`. `/api/v1/billing/status` also serialises it as
  `platformFeePercent: null`. Fails closed, but with no diagnosable message. `parseInt` also
  silently truncates a legitimate `"15.5"` to `15`.
- evidence: Read `:22` and `:44-47`; traced the insert at `:139-146` to the `integer` column types
  in `schema.ts:770-771` and `024_billing.sql:27-28`.
- fix: `const raw = Number(process.env.PLATFORM_FEE_PERCENT ?? 15); const PLATFORM_FEE_PERCENT = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 15;`
  and log a warning when the env value was present but unparseable.
- verify: Unit test with `PLATFORM_FEE_PERCENT='abc'` asserting the fee falls back to 15.
- cross: @config-deploy-reviewer
- effort: S

### [P2] `token_usage.cost_cents` is `double precision` — floating-point money in the cost ledger
- id: billing-009
- location: podcast-saas/backend-api/src/db/schema.ts:319
- category: data-integrity
- confidence: medium
- status: confirmed
- what: Migration 046 deliberately changed `cost_cents` from `integer` to `double precision` so
  sub-cent utility calls stop rounding to zero. The intent is right; the type is not.
- why: This is the one place money is stored as a float. It is *internal cost accounting*, not the
  customer-charging path (`billing_transactions` is correctly integer cents), so the blast radius is
  reports rather than charges — but `sum(double precision)` over a growing ledger accumulates
  representation error and is order-dependent under a parallel plan, so the same report can return
  different totals. Values are already produced pre-rounded to 4dp (`systemAi.ts:133`), which is
  exactly the shape `numeric` handles exactly.
- evidence: `schema.ts:319` (`doublePrecision('cost_cents')`) and
  `db/migrations/046_token_usage_cost_precision.sql:5`. Contrast with `schema.ts:768-771`, integer.
- fix: `ALTER COLUMN cost_cents TYPE numeric(14,6)` (expand/contract-safe: all current readers treat
  it as a number), or store integer micro-cents. New migration + append to the hardcoded list in
  `db/migrate.ts`.
- verify: `pnpm -C podcast-saas --filter backend-api typecheck` stays clean; a sum test over
  10k sub-cent rows returns an exact total.
- cross: @database-reviewer
- effort: M

### [P2] The webhook's security-critical properties have no test at all
- id: billing-010
- location: podcast-saas/backend-api/src/controllers/v1/stripe-webhook.controller.ts:19
- category: test
- confidence: high
- status: confirmed
- what: The only billing test is `services/billing/__tests__/grantFromSession.test.ts`. Nothing
  covers: that the handler receives a raw `Buffer` (not a parsed object), that a bad signature 400s,
  that a missing `stripe-signature` header 400s, or `markFailed` / `handleRefund` / `handleDispute`
  at all.
- why: The raw-body property is invisible in review and trivially destroyed by an unrelated change —
  someone adding a global `addContentTypeParser` or a body-reading `onRequest` hook in `server.ts`
  would silently turn signature verification into theatre, with no test to catch it. Note
  `controllers/v1/__tests__/rawBodyRouteConfig.test.ts` sounds relevant but is not — it asserts the
  *multipart* upload routes carry no `rawBody` route metadata, and never touches Stripe.
- evidence: `ls services/billing/__tests__/` → one file (read in full, covers only the transaction
  atomicity and the two early-returns of `grantFromSession`).
  `grep -rln "stripe|billing" --include="*.test.ts"` → 3 files, the other two unrelated
  (`frontendCsp`, `projectDuplication`).
- fix: Add `controllers/v1/__tests__/stripeWebhook.test.ts` using `app.inject()`: assert
  `request.body` is a `Buffer` inside the handler, that a tampered payload yields 400, and that a
  missing header yields 400.
- verify: New suite green; `pnpm -C podcast-saas --filter backend-api test`.
- cross: @test-quality
- effort: M

### [P3] Chargebacks retain content access
- id: billing-011
- location: podcast-saas/backend-api/src/services/billing/BillingService.ts:254
- category: data-integrity
- confidence: high
- status: confirmed
- what: `handleDispute` records `status: 'disputed'` and intentionally leaves the `user_purchases`
  grant in place, per the documented "STATUS ONLY … grace model" decision at `:239-243`.
- why: Reported as P3 because it is an explicit product decision, not an oversight. Flagging it only
  so the decision is re-confirmed for *disputes* specifically: grace on a refund is a goodwill
  choice, but on a chargeback the buyer has taken the money back and keeps the content, which is the
  standard carding pattern. Refund and dispute currently share one policy.
- evidence: Read `:239-261`; neither handler deletes from `user_purchases`, and `hasAccess`
  (`:94-101`) reads only that table, never the transaction status.
- fix: Product call. If access should end on a chargeback, delete the matching `user_purchases` row
  inside `handleDispute` (keyed via `transaction_id`), leaving `handleRefund` as-is.
- effort: S

### [P3] `scriptGenerationRateLimit` does not rate limit anything
- id: billing-012
- location: podcast-saas/backend-api/src/middleware/rate-limit.ts:6
- category: maintainability
- confidence: high
- status: confirmed
- what: The function checks only `admin_settings.generation_paused`; its own comment says "per-user
  rate limits disabled". Its sole caller is `_archive/v1-podcast-pipeline/controllers/stream.controller.ts:17`,
  which is excluded from review — so it has no live callers.
- why: A `preHandler` named `scriptGenerationRateLimit` reads as cost protection in every route
  definition it appears in. Combined with billing-005, two of the three files that look like the
  rate-limiting layer enforce nothing.
- evidence: Read `middleware/rate-limit.ts` in full (18 lines);
  `grep -rn "scriptGenerationRateLimit" --include="*.ts"` → definition + one `_archive` caller.
- fix: Rename to `generationPauseGate` (it is a useful pause check), or delete with the archive.
- effort: S

### [P3] A failed Stripe session creation leaves an orphan `pending` transaction forever
- id: billing-013
- location: podcast-saas/backend-api/src/services/billing/BillingService.ts:139
- category: data-integrity
- confidence: high
- status: confirmed
- what: The `billing_transactions` row is inserted at `:139-146` *before*
  `stripe.checkout.sessions.create` at `:150`. If that call throws, the row survives with
  `status='pending'` and a `NULL stripe_checkout_session_id`, and nothing ever reaps it.
- why: These rows are counted as `pendingTransactions` on the admin dashboard
  (`admin/v1/billing.controller.ts:16,29`), so the number drifts upward permanently and stops
  meaning "payments in flight". Also the accumulation target for billing-006.
- evidence: Read `:139-172`; no `try/catch` around the Stripe call, no compensating delete.
- fix: Wrap `:150-165` in `try/catch` and mark the row `status='failed'` (or delete it) before
  rethrowing.
- verify: Test that a rejecting `sessions.create` leaves no `pending` row.
- effort: S
