# billing-integrity — findings

Commit under review: `2d187e3` (main). Whole-codebase review.
Scope swept: `podcast-saas/backend-api/src/services/billing/**`, `services/usage/**`,
`controllers/v1/stripe-webhook.controller.ts`, `controllers/v1/billing.controller.ts`,
`controllers/admin/v1/billing.controller.ts`, `middleware/rate-limit.ts`, `lib/rateLimit.ts`,
plus every call site of `BillingService.hasAccess`, `UsageTrackingService.record`,
`recordChatUsage/recordImageUsage/recordVideoUsage`, and the `billing_transactions` /
`user_purchases` / `token_usage` schema + migration `024_billing.sql` / `046_token_usage_cost_precision.sql`.

## What is CORRECT (verified, stated so the report is honest about it)

**Webhook authenticity is genuinely correct — this is not a finding.** I traced the bytes:

- `podcast-saas/backend-api/src/controllers/v1/stripe-webhook.controller.ts:12-18` registers the
  route inside `app.register(async (scoped) => …)`. That is a plain async plugin (not wrapped in
  `fastify-plugin`), so Fastify creates a child context.
- `node_modules/.pnpm/fastify@4.29.1/node_modules/fastify/lib/pluginOverride.js:45` does
  `instance[kContentTypeParser] = ContentTypeParser.helpers.buildContentTypeParser(instance[kContentTypeParser])`
  — the parser table is **cloned per encapsulated plugin**, so the `parseAs: 'buffer'` override
  applies to this route only and the rest of the app keeps the JSON parser.
- `lib/contentTypeParser.js:83-88` (`existingParser`) returns `false` when the current
  `application/json` parser is still the built-in one, so the override is permitted rather than
  throwing `FST_ERR_CTP_ALREADY_PRESENT` at boot.
- `request.body` is therefore the untouched `Buffer` handed to
  `BillingService.verifyWebhook` → `stripe.webhooks.constructEvent(payload, signature, secret)`
  (`services/billing/BillingService.ts:184-190`), stripe **22.2.0**. No re-serialisation anywhere.
- Failure modes are closed: missing signature → 400 (`:21`); missing `STRIPE_WEBHOOK_SECRET` or
  `STRIPE_SECRET_KEY` → throw → 400 (`:26-29`); handler error → 500 so Stripe retries (`:57-60`).
  `constructEvent` also enforces the default 300 s timestamp tolerance, which bounds naive replay.

**The webhook/reconcile race is benign.** `grantFromSession` reads `tx.status` outside the
transaction (`BillingService.ts:199`), so the webhook and the `/unlock` reconcile call can both
enter the transaction. The second one is harmless: the row `UPDATE` serialises under READ
COMMITTED and the `user_purchases` insert is protected by
`UNIQUE (user_id, content_type, content_id)` (`db/migrations/024_billing.sql:52`, mirrored at
`db/schema.ts:796`) plus `.onConflictDoNothing()`. No double grant.

**Money is in integer minor units everywhere in the Stripe path.** `amount_cents`,
`platform_fee_cents`, `creator_payout_cents`, `price_cents` are all `INTEGER`;
`calculateFees` uses `Math.round` on integer cents and derives the payout by subtraction
(`BillingService.ts:44-47`), so fee + payout **always** re-sums to the total, including 0 and
100 %. No float arithmetic on customer money. (`token_usage.cost_cents` is a different story —
see billing-011.)

**Admin billing routes are admin-gated.** Both routes in
`controllers/admin/v1/billing.controller.ts` use `firebaseAdminRequired`
(`middleware/firebase-admin-required.ts:11`), and there is **no** manual credit/refund/grant
endpoint anywhere in the admin surface — so there is no unaudited money-mutation path to report.

**No subscriptions/trials exist in this product.** The model is one-off pay-to-unlock, so there is
no trial-expiry or local-time comparison to get wrong.

---

### [P1] A free playlist silently un-paywalls every paid video inside it
- id: billing-001
- location: podcast-saas/backend-api/src/controllers/v1/playlists.controller.ts:620
- category: bug
- confidence: high
- status: confirmed
- what: `buildPlaylistPlayConfig` calls `buildPlayerConfig(i.project_id, viewerUserId)` for every
  member project with no per-project entitlement check. `buildPlayerConfig`
  (`services/buildPlayerConfig.ts`) contains **zero** billing logic — grep for `access_type`,
  `BillingService` and `hasAccess` in that file returns nothing; every other caller
  (player/share/permalink) gates it explicitly first. The only gate on the playlist route is the
  **playlist's own** `access_type` (`playlists.controller.ts:193`, `permalink.controller.ts:98`),
  and `playlists.access_type` defaults to `'free'` (`db/migrations/024_billing.sql:9`).
- why: A creator who sells a video (`projects.access_type='paid'`) and also drops it into any
  playlist — the ordinary way content is organised here — and shares that playlist
  (`POST /api/v1/playlists/:id/share` → `/pl/{token}`, or a permalink) hands out the full
  `PlayerConfig`, including token-bearing media URLs, to any anonymous visitor. The paywall on that
  video is gone with no warning and no UI indication. Worse, `playlist_items` accepts any project
  the caller can *edit*, which includes projects shared with them as a collaborator
  (`playlists.controller.ts:501`, `projectsEditableByWhere`), so an invited collaborator can
  publish someone else's paid video for free — while the equivalent share-token route
  (`share.controller.ts:26-36`) correctly refuses.
- evidence: Read `playlists.controller.ts:597-640` — the doc comment addresses only the opposite
  direction ("a playlist purchase covers everything inside it") and justifies skipping the
  re-gate with "Items are owner-owned … so there is no cross-tenant exposure", which answers a
  tenancy question, not an entitlement one. Read `services/buildPlayerConfig.ts` in full: no
  billing import. No test covers a paid project inside a free playlist (only billing test is
  `services/billing/__tests__/grantFromSession.test.ts`).
- fix: In `buildPlaylistPlayConfig`, when `playlist.access_type !== 'paid'`, resolve each member
  project's `access_type` (the rows are already fetched into `projectMap` at line 622) and for any
  `'paid'` project call `BillingService.hasAccess(viewerUserId, 'project', id)`; on false emit the
  same `{locked:true, price_cents, …}` stub the other routes emit instead of `config`. Keep the
  existing bundle behaviour when the playlist itself is paid and purchased.
- verify: new test — free playlist + paid member project + anonymous viewer → item comes back
  `locked`, and `config.videoUrl`-bearing fields are absent; red before, green after.
- cross: @backend-reviewer @security-reviewer
- effort: M

### [P1] Two open Checkout sessions for the same content can charge a buyer twice, with no second grant and no refund path
- id: billing-002
- location: podcast-saas/backend-api/src/services/billing/BillingService.ts:132
- category: data-integrity
- confidence: medium
- status: confirmed
- what: `createCheckoutSession` guards with `hasAccess()` (line 132) — a check that is only true
  *after* a payment completes. Nothing prevents two `pending` `billing_transactions` +
  two live Stripe sessions for the same `(payer, content_type, content_id)`: there is no unique
  index for that tuple (`db/migrations/024_billing.sql:19-40` has only three plain indexes). If
  the buyer pays both (Checkout sessions stay payable for 24 h — the "did that go through? let me
  retry" path, or two tabs), Stripe charges twice. The second `grantFromSession` flips its
  transaction to `succeeded`, then its `user_purchases` insert hits
  `.onConflictDoNothing()` (line 216) and does nothing — and the result is never inspected.
- why: The customer is charged twice, receives one entitlement, and the system emits no signal at
  all: the second transaction reads as a clean `succeeded` sale, it is counted in
  `/api/v1/billing/earnings` and in the admin `totalVolumeCents`, and the creator is credited a
  payout for a purchase that was silently swallowed. Detecting it requires a human comparing
  `billing_transactions` to `user_purchases`.
- evidence: Read `BillingService.ts:121-173` (create) and `:192-220` (grant). No `where` on
  status/uniqueness constrains a second pending row; `024_billing.sql` creates
  `idx_billing_tx_payer/creator/session` only — no unique constraint. `.onConflictDoNothing()` at
  line 216 has no `.returning()`, so the swallow is invisible. No test exercises a second
  transaction for content the user already owns.
- fix: (1) In `createCheckoutSession`, before inserting, look up an existing `pending` transaction
  for the same `(payer_user_id, content_type, content_id)` and re-use its Stripe session
  (`stripe.checkout.sessions.retrieve`) when it is still `open`; back it with a partial unique
  index `CREATE UNIQUE INDEX … ON billing_transactions (payer_user_id, content_type, content_id)
  WHERE status = 'pending'`. (2) In `grantFromSession`, add `.returning()` to the
  `user_purchases` insert; when it returns zero rows and the existing purchase's `transaction_id`
  differs from `tx.id`, log at error level and set the transaction `status:'refund_due'` so the
  duplicate charge is visible (an automatic `stripe.refunds.create` is the stronger option).
- verify: unit test with two pending transactions for one `(user, content)` → second grant must
  not report success silently; integration check that a second `POST /api/v1/billing/checkout`
  returns the *same* session URL.
- cross: @database-reviewer
- effort: M

### [P1] The purchase grant never checks `session.payment_status`, and `checkout.session.async_payment_failed` is not handled
- id: billing-003
- location: podcast-saas/backend-api/src/controllers/v1/stripe-webhook.controller.ts:33
- category: bug
- confidence: medium
- status: confirmed
- what: `checkout.session.completed` is routed straight into `grantFromSession`, and
  `grantFromSession` (`BillingService.ts:193-220`) inspects only `session.metadata.transactionId`
  and `tx.status` — never `session.payment_status` or `session.amount_total`. For
  delayed-notification payment methods Stripe emits `checkout.session.completed` with
  `payment_status: 'unpaid'` and settles later via `async_payment_succeeded` /
  `async_payment_failed`. The controller subscribes to `async_payment_succeeded`
  (line 34) — proving delayed payments are expected here — but there is **no**
  `async_payment_failed` case, so the `default: break` at line 54 discards it.
- why: With any delayed-notification method enabled on the Stripe account, access is granted the
  moment checkout completes and is **never revoked** when the payment subsequently fails: the
  `user_purchases` row stays, the transaction stays `succeeded`, and the creator's earnings report
  counts a sale that never settled. The asymmetry is the tell — the reconcile path *does* check
  (`BillingService.ts:277`: `if (session.payment_status === 'paid')`), the webhook path does not.
- evidence: Read `stripe-webhook.controller.ts:32-56` and `BillingService.ts:192-220` line by line.
  `grep -n "payment_status" services/billing/BillingService.ts` → only line 277 (reconcile).
  Precondition, stated plainly: this is unreachable while the Stripe account offers card-only
  checkout, because cards complete as `paid`. It becomes live the moment ACH/SEPA/Bacs/Boleto/
  Konbini is switched on in the Stripe Dashboard — a config change, not a code change.
- fix: In `grantFromSession`, return early unless `session.payment_status === 'paid'`
  (leaving the transaction `pending` for the async event to finish). Add a
  `case 'checkout.session.async_payment_failed'` that resolves the transaction by
  `session.metadata.transactionId`, sets `status:'failed'`, and deletes the matching
  `user_purchases` row for that `transaction_id`.
- verify: unit test — `grantFromSession` with `payment_status:'unpaid'` performs no writes; a
  subsequent `async_payment_succeeded` grants exactly once.
- effort: S

### [P1] Admin-set per-user token budgets are never enforced — `RateLimitService` has zero call sites
- id: billing-004
- location: podcast-saas/backend-api/src/services/usage/RateLimitService.ts:9
- category: bug
- confidence: high
- status: confirmed
- what: `RateLimitService.checkTokenBudget(userId, weeklyLimit, monthlyLimit)` is never
  instantiated or called anywhere in the backend. Meanwhile the admin API accepts and persists the
  values it was written to consume: `PUT /api/admin/v1/users/:id/limits` writes
  `weekly_token_limit` / `monthly_token_limit` (`controllers/admin/v1/users.controller.ts:36-47`),
  the columns exist (`db/schema.ts:122-123`), and the admin UI renders and edits them
  (`podcast-saas/admin-web/app/users/page.tsx:49-50,131,144`).
- why: An admin who caps a runaway user's token budget gets a UI that confirms the cap and a
  backend that ignores it — unbounded LLM spend on that user continues. The only live cost cap is
  a *different* control (`admin_settings.generation_limit_enabled` → a rolling-24h **call count**,
  `services/llm/LLMService.ts:137-159`), and it is off by default, so a fresh install has no
  per-user spend ceiling at all.
- evidence: `grep -rn "RateLimitService\|checkTokenBudget" backend-api/src` (excluding
  `_archive/`) returns only the class definition at `RateLimitService.ts:8-9`. `grep -rn
  "weekly_token_limit\|monthly_token_limit"` across backend-api/admin-web/shared returns only the
  schema, the admin write endpoint, the admin UI, and the shared type — no reader.
- fix: Either wire it in — call `checkTokenBudget(userId, user.weekly_token_limit,
  user.monthly_token_limit)` from `LLMService._sendStructuredOnce`/`sendText` and from
  `systemAi.assertGenerationAllowed` before the provider call, throwing
  `AppError(LLMErrorType.LIMIT_EXCEEDED, …, 429)` — or delete the service, the columns, the admin
  endpoint fields and the UI controls. Shipping a cap that does nothing is the worst of the three.
- verify: test that a user whose `token_usage` sum for the week exceeds `weekly_token_limit` gets
  429 from a generation endpoint; today that test cannot even be written against a call site.
- cross: @llm-pipeline-reviewer @test-quality
- effort: M

### [P2] `markFailed` has no status guard, so an out-of-order `payment_intent.payment_failed` overwrites a succeeded sale
- id: billing-005
- location: podcast-saas/backend-api/src/services/billing/BillingService.ts:226
- category: data-integrity
- confidence: high
- status: confirmed
- what: `markFailed` updates by id (or PI id) with `where(eq(billing_transactions.id, …))` and no
  predicate on the current `status`. Stripe does not guarantee webhook ordering, and a
  PaymentIntent legitimately emits `payment_failed` for a declined first attempt before succeeding
  on a retry of the *same* PI. Whichever event lands last wins.
- why: A paid, granted purchase can end up recorded as `status:'failed'` with an `error` string,
  while the `user_purchases` grant remains. The buyer keeps access; the ledger says the payment
  failed; `/api/v1/billing/earnings` (which filters `status = 'succeeded'`) drops the sale and the
  creator is under-paid; the admin overview undercounts revenue. Purely silent.
- evidence: Read `BillingService.ts:222-237`. Both branches set `status:'failed'` unconditionally.
  Compare `grantFromSession:199`, which *does* short-circuit on a terminal status — the guard
  exists on one path and not the other.
- fix: Add a terminal-state predicate to both updates:
  `.where(and(eq(billing_transactions.id, id), notInArray(billing_transactions.status,
  ['succeeded','refunded','partially_refunded','disputed'])))`, and log when the update affects
  zero rows.
- verify: unit test — `markFailed` against a `succeeded` transaction performs no state change.
- effort: S

### [P2] Refund and dispute handlers key only on `stripe_payment_intent_id`, which one code path writes and can write as NULL
- id: billing-006
- location: podcast-saas/backend-api/src/services/billing/BillingService.ts:250
- category: data-integrity
- confidence: high
- status: confirmed
- what: `handleRefund` and `handleDispute` locate the row exclusively by
  `eq(billing_transactions.stripe_payment_intent_id, pi)`. That column is written in exactly one
  place — `grantFromSession:208` — and that write is
  `typeof session.payment_intent === 'string' ? session.payment_intent : null`, i.e. it also
  *clears* the column whenever the field is not a bare string (an expanded PaymentIntent object,
  or a session type without one).
- why: Any refund or chargeback whose event is delivered before the grant completes, or whose
  transaction was granted from a session where `payment_intent` was not a plain string, matches
  **zero rows** and is silently discarded — Drizzle's `update … where` reports no error for an
  empty match, and neither handler inspects the row count. The transaction then reads as a healthy
  `succeeded` sale forever, so refunded revenue is still counted in creator earnings and the admin
  totals.
- evidence: Read `BillingService.ts:239-261` and `:205-218`. `grep -n "stripe_payment_intent_id"`
  in that file → written only at line 208; read at 235, 250, 259. Neither handler checks an
  affected-row count.
- fix: Resolve refunds/disputes through `charge.payment_intent` **and** the checkout session /
  `metadata.transactionId` (`stripe.paymentIntents.retrieve(pi)` → `metadata.transactionId`, which
  `createCheckoutSession:161` already sets), and never null out an already-set
  `stripe_payment_intent_id` — use `sql\`coalesce(excluded…, existing)\`` semantics or omit the
  field when the value is not a string. Log an error when the update affects zero rows.
- verify: unit test — refund event for a transaction whose `stripe_payment_intent_id` is NULL must
  still land on the right row (or at minimum log an error rather than no-op).
- effort: M

### [P2] No Stripe `event.id` ledger — redelivery and out-of-order delivery are unguarded by construction
- id: billing-007
- location: podcast-saas/backend-api/src/controllers/v1/stripe-webhook.controller.ts:31
- category: data-integrity
- confidence: high
- status: confirmed
- what: The handler never records `event.id`, and there is no table or unique index for processed
  Stripe events (`grep -rn "event.id" backend-api/src` → no matches; `024_billing.sql` has no such
  table). Idempotency today is emergent — it rests on the `user_purchases` unique index and the
  `tx.status === 'succeeded'` short-circuit — not on a dedupe key.
- why: Today's handlers survive replay by luck of being state-setting. Two of them already do not
  survive re-**ordering** (billing-005, billing-006), and the next handler someone adds (a
  credit, a payout, a counter increment) inherits a webhook with no replay protection at all.
  Recording the event id inside the same transaction as the effect is the structural fix for the
  whole class.
- evidence: Read `stripe-webhook.controller.ts` in full; no persistence of `event.id`, no
  `processed_events`-style table in `db/schema.ts` (grep for `event_id` → nothing in the billing
  region). `grantFromSession` is the only handler with any dedupe, and it is a status check, not
  an event check.
- fix: Add `stripe_events (event_id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at TIMESTAMPTZ
  NOT NULL DEFAULT now())` in a new migration, and in the handler insert `event.id` with
  `onConflictDoNothing().returning()` **inside** the same `db.transaction` as the effect —
  zero rows returned means "already processed", return 200 without re-applying. Also store
  `event.created` so a stale event can be rejected against `completed_at`.
- verify: post the same signed payload twice; the second must be a no-op and still 200.
- cross: @database-reviewer
- effort: M

### [P2] `PLATFORM_FEE_PERCENT` parsing silently truncates decimals and can propagate NaN into the ledger
- id: billing-008
- location: podcast-saas/backend-api/src/services/billing/BillingService.ts:22
- category: bug
- confidence: high
- status: confirmed
- what: `Math.max(0, Math.min(100, parseInt(process.env.PLATFORM_FEE_PERCENT ?? '15', 10)))`.
  `parseInt` truncates: `"7.5"` → `7`, `"12.5"` → `12`. And `??` only defaults on
  `undefined`/`null`, so a **present but empty** value (exactly what `env_file: ../.env` produces
  for `PLATFORM_FEE_PERCENT=` — see `deploy/docker-compose.yml:32-33`) yields `parseInt('')` =
  `NaN`, and `Math.max(0, Math.min(100, NaN))` is `NaN`, not `0`.
- why: The decimal case is the dangerous one because it is silent: a platform configured for a
  7.5 % fee charges 7 % forever, on every sale, with nothing anywhere reporting the discrepancy —
  and `platform_fee_cents` is what the admin revenue dashboard reports. The NaN case fails loudly
  but late: `platformFeeCents`/`creatorPayoutCents` become `NaN`, the `billing_transactions`
  insert on integer columns errors, and every checkout returns a 400 with an opaque message.
- evidence: Read `BillingService.ts:22,44-47`. `.env.example:108` documents `PLATFORM_FEE_PERCENT=15`.
  JS semantics: `Math.min(100, NaN) === NaN`, `Math.max(0, NaN) === NaN`. `deploy/docker-compose.yml`
  passes the whole root `.env` via `env_file`, so a blank assignment reaches the process as `''`.
- fix: Parse once at module load with `Number(...)`, reject non-finite/out-of-range values by
  throwing at boot (fail fast, before any money moves) or falling back to 15 with a
  `logger.error`, and keep the percentage as a number so `Math.round(amountCents * pct / 100)`
  supports fractional percentages.
- verify: unit test on `calculateFees` across `PLATFORM_FEE_PERCENT` ∈ {`'0'`,`'15'`,`'7.5'`,`''`,
  `'abc'`,`'150'`} asserting fee+payout === amount and fee ≥ 0 in every case.
- cross: @config-deploy-reviewer
- effort: S

### [P2] LLM usage is recorded only after a successful provider response, so failed and aborted calls are billed by the vendor but never metered
- id: billing-009
- location: podcast-saas/backend-api/src/services/llm/LLMService.ts:223
- category: data-integrity
- confidence: high
- status: confirmed
- what: `usageTracking.record(...)` runs *after* `await provider.sendMessage(...)` returns
  (lines 206-238, and again at 368-394 in `sendText`). Any throw from the provider — timeout,
  5xx, `abortSignal` firing on a client disconnect mid-stream — skips the ledger write entirely.
  On top of that, the record itself is fail-open by design: a failed insert is caught and logged
  (`:236-238`), and every `systemAi` wrapper swallows its own errors
  (`services/llm/systemAi.ts:147,192,222`).
- why: Two consequences, both financial. (1) Under-billing/under-visibility: a streamed generation
  aborted at 90 % has consumed nearly all its output tokens at the vendor, and `token_usage`
  records nothing — the admin cost report understates real spend. (2) Quota bypass: the rolling-24h
  cap counts `token_usage` rows (`LLMService.ts:144-151`, `systemAi.ts:75-82`), so a user who
  aborts every request is never counted and can generate without limit while still incurring
  vendor cost.
- evidence: Read `LLMService.ts:206-260` and `:361-397`; the `record` call is unreachable on the
  throw path and there is no `finally`. Read `systemAi.ts:118-150,172-225` — all three recorders
  are `try/catch` → `logger.warn`, never rethrow.
- fix: Wrap the provider call so partial usage is recorded on the error path too: capture whatever
  `usage` the provider surfaces (or an estimate from streamed chunk length) in a `finally`/`catch`
  and record it with a `task` suffix such as `…:aborted`, keeping it inside the quota count.
  Separately, add a metric/alert on `usage record failed` so silent ledger loss is visible.
- verify: test that a provider rejection still produces a `token_usage` row; today no test covers
  the failure path of `record`.
- cross: @llm-pipeline-reviewer @observability-reviewer
- effort: M

### [P2] Transient-error retry around b-roll `submit` can double-bill an external video provider
- id: billing-010
- location: podcast-saas/backend-api/src/jobs/video.generate.ts:83
- category: bug
- confidence: high
- status: confirmed
- what: `externalTaskId = await withRetry(() => svc.submit(...))`, and `isTransientError`
  (lines 25-33) retries on `etimedout`, `timeout` and `429`. A submit whose *response* timed out
  may well have been accepted upstream — Kling/Seedance/Veo generation is charged at submit, and
  none of the submit calls carries an idempotency key. The retry then starts a second paid
  generation whose task id is discarded.
- why: Direct over-billing: two provider generations, one `recordVideoUsage` row (line 95, written
  once after the successful submit), so the ledger under-reports exactly the spend that was
  duplicated. The file is otherwise careful about this — the resume path at lines 64-69 and
  `recoverStuckVideoGenerations` (lines 229-249) both exist specifically to avoid double-billing,
  which makes the retry-on-timeout the odd one out.
- evidence: Read `jobs/video.generate.ts:25-49,63-104`. `svc.submit` →
  `services/video-generation/VideoGenerationService.ts` submit* methods; no idempotency key on
  any provider request. `recordVideoUsage` is only called on the fresh-submit branch.
- fix: Do not retry `submit` on timeout classes at all (retry only on connection-refused / 429 with
  a provider idempotency key where supported); or persist an `attempted_submit_at` marker before
  the call and, on retry after a timeout, poll the provider for an existing task before
  re-submitting.
- verify: test that a timeout from `submit` fails the job rather than issuing a second submit.
- cross: @job-queue-reviewer
- effort: M

### [P2] `token_usage.cost_cents` is `double precision` — the cost ledger is float money
- id: billing-011
- location: podcast-saas/backend-api/src/db/schema.ts:319
- category: data-integrity
- confidence: high
- status: confirmed
- what: Migration `046_token_usage_cost_precision.sql` converted `cost_cents` from `integer` to
  `double precision` to stop sub-cent calls rounding to zero. The stated problem was real; the
  chosen type is not exact. Values are produced as `Math.round(raw * 10_000) / 10_000`
  (`systemAi.ts:134`), i.e. deliberately 4-decimal-place quantities — which is precisely what
  `numeric(14,4)` represents exactly and `double precision` does not.
- why: Every admin cost report aggregates this column with `sum()`
  (`controllers/admin/v1/users.controller.ts:65-75`). Floating-point `sum()` in Postgres is
  order-dependent, so the same query over the same rows can return a different total between runs
  (different plan, different parallelism), and error accumulates with row count. For a ledger used
  to reason about spend — and eventually to bill anyone — that is the wrong data type.
- evidence: `db/schema.ts:319` (`doublePrecision`), `db/migrations/046_token_usage_cost_precision.sql:6`
  (`ALTER COLUMN cost_cents TYPE double precision`), aggregation at
  `controllers/admin/v1/users.controller.ts:65-75` and `admin/v1/pipeline-stats.controller.ts:42-43`.
- fix: New forward migration `ALTER TABLE token_usage ALTER COLUMN cost_cents TYPE numeric(14,4)
  USING cost_cents::numeric(14,4)` and switch the Drizzle column to `numeric` (note: Drizzle
  returns `numeric` as `string`, so the readers in the two admin controllers must parse). Storing
  integer micro-cents is the alternative and avoids the string round-trip.
- verify: `pnpm -C podcast-saas --filter backend-api typecheck` after the column type change
  surfaces every reader that needs updating.
- cross: @database-reviewer
- effort: M

### [P2] Media authorization ignores `access_type`, so the paywall on the actual bytes is URL secrecy with a shared 7–8 day token
- id: billing-012
- location: podcast-saas/backend-api/src/services/storage/mediaAccess.ts:76
- category: security
- confidence: high
- status: confirmed
- what: `canServeMediaKey` allows a media key when the owning project's `visibility` is
  `public`/`unlisted`, or when the URL carries a valid scoped media token. It never consults
  `projects.access_type` or `user_purchases`. The token's scope is the whole project
  (`videos/{projectId}`) and its expiry is **quantised to a UTC-day boundary**
  (`services/storage/mediaToken.ts:53-58`), so every buyer of a given video receives a
  byte-identical URL that stays valid for 7–8 days for anyone who has it, with no auth.
- why: The paid-content gates in `player`/`share`/`permalink` protect the *config*, not the
  bytes. Once one purchaser copies a media URL out of devtools (or the config JSON is cached or
  shared), the paid video is world-readable for up to eight days, and the same URL works for every
  other visitor because the token is deterministic. Revocation is impossible short of rotating
  `ENCRYPTION_KEY`.
- evidence: Read `services/storage/mediaAccess.ts:60-88` — no billing import at all; read
  `mediaToken.ts:36-58` for the day-quantised, project-scoped HMAC. Note also the deliberate
  fail-open at `mediaAccess.ts:82-87`: a DB error allows the request.
- fix: In `canServeMediaKey`, after resolving the project, if `access_type === 'paid'` require
  either a purchase (`user_purchases` for the resolved viewer) or a token minted **with the
  buyer's identity in the scope** — extend `mediaKeyScope` to `videos/{projectId}:{userId}` for
  paid content and mint a short TTL (minutes/hours, not days) for that case, keeping the
  day-quantised cache-friendly token for free content only.
- verify: test that a `paid` project's `videos/{id}/…` key is refused for an anonymous request with
  no token, and that a token minted for buyer A does not authorize buyer B.
- cross: @security-reviewer @performance-reviewer
- effort: L

### [P2] Billing has almost no test coverage — the raw-body signature path, fee arithmetic, refunds and every entitlement gate are untested
- id: billing-013
- location: podcast-saas/backend-api/src/services/billing/__tests__/grantFromSession.test.ts:1
- category: test
- confidence: high
- status: confirmed
- what: The only billing test in the repo is `grantFromSession.test.ts` (3 cases, all against
  mocked Drizzle). Untested: webhook signature verification over the raw buffer; the encapsulated
  content-type-parser scope that makes it work; `calculateFees`; `markFailed`; `handleRefund`;
  `handleDispute`; `reconcileCheckout`; `createCheckoutSession`; and every `hasAccess` gate in
  `player`/`share`/`permalink`/`playlists`.
- why: The raw-body property is the single load-bearing security invariant in this domain and it
  is enforced by a subtle Fastify encapsulation detail. Someone hoisting the content-type parser to
  the root instance, or wrapping `registerStripeWebhookRoutes` in `fastify-plugin`, would break
  signature verification for every future event **and** silently re-parse bodies app-wide, with a
  fully green test suite.
- evidence: `grep -rln "stripe\|billing" --include='*.test.ts' backend-api/src` → three files, of
  which only `services/billing/__tests__/grantFromSession.test.ts` is a billing test (the other two
  are a CSP test and the project-duplication test). Read that file in full: it covers the
  transaction-handle invariant and two early returns, nothing else.
- fix: Add `services/billing/__tests__/webhookRawBody.test.ts`: build a real Fastify instance,
  register `registerStripeWebhookRoutes`, `app.inject` a payload signed with a test
  `STRIPE_WEBHOOK_SECRET`, assert 200; then assert that a body-mutating re-serialisation (or a
  tampered byte) yields 400; and assert a normal JSON route on the same instance still receives a
  parsed object. Add table-driven tests for `calculateFees` (see billing-008) and a
  `markFailed`-after-`succeeded` test (billing-005).
- verify: new tests fail if the parser is moved out of the encapsulated scope.
- cross: @test-quality
- effort: M

### [P2] `scriptGenerationRateLimit` is registered on no route, and does not rate-limit anything
- id: billing-014
- location: podcast-saas/backend-api/src/middleware/rate-limit.ts:6
- category: maintainability
- confidence: high
- status: confirmed
- what: The exported middleware is referenced nowhere (`grep -rn "scriptGenerationRateLimit"`
  returns only its definition). Its body checks `admin_settings.generation_paused` and nothing
  else — the comment on line 10 says "per-user rate limits disabled" — so even if it were wired up
  it would not limit a rate. The name is the only rate limiting in the file.
- why: A reader auditing cost controls finds a file called `middleware/rate-limit.ts` and
  reasonably concludes the expensive generation endpoints are rate limited. They are not by this;
  the only real limiter is the in-process `lib/rateLimit.ts` applied ad-hoc at ten call sites.
  Misleading safety surface is how cost incidents get missed.
- evidence: `grep -rn "scriptGenerationRateLimit" backend-api/src` → `middleware/rate-limit.ts:6`
  only. Read lines 1-18: single `generation_paused` check.
- fix: Delete the file and fold the pause check into the existing `assertGenerationAllowed`
  (`services/llm/systemAi.ts:62`), which already performs it — or rename it to
  `generationPauseGate` and register it on the generation routes.
- effort: S

### [P3] The quota check is a read-then-act with no reservation, so concurrent requests all pass the same cap
- id: billing-015
- location: podcast-saas/backend-api/src/services/llm/LLMService.ts:143
- category: bug
- confidence: high
- status: confirmed
- what: The rolling-24h generation cap counts `token_usage` rows, then makes the provider call, then
  inserts the row. N requests issued together all observe the pre-call count and all proceed.
  `systemAi.assertGenerationAllowed:72-90` has the identical shape.
- why: The cap is a cost control; its bound is `limit + concurrency`, not `limit`. With the cap set
  to 50 and a scripted client issuing 100 parallel requests, all 100 run. Bounded and only live
  when an admin enables `generation_limit_enabled`, hence P3.
- evidence: Read `LLMService.ts:137-159` (count) and `:223-235` (insert, after the call). No lock,
  no reservation row, no `SELECT … FOR UPDATE`.
- fix: Insert a reservation row (or increment a per-user counter with `INSERT … ON CONFLICT DO
  UPDATE … RETURNING`) *before* the provider call and reconcile the token figures after, so the
  admission decision and the accounting are one atomic step.
- cross: @llm-pipeline-reviewer
- effort: M

### [P3] Chargebacks keep access, under a comment that only justifies keeping access for refunds
- id: billing-016
- location: podcast-saas/backend-api/src/services/billing/BillingService.ts:254
- category: bug
- confidence: high
- status: confirmed
- what: `handleDispute` records `status:'disputed'` and deliberately leaves the `user_purchases`
  grant in place, sharing the "STATUS ONLY … grace model" rationale written for `handleRefund`
  at lines 239-243.
- why: "Grace" is a defensible product decision for a refund the creator chose to issue. A dispute
  is the buyer taking the money back unilaterally: buy → watch → chargeback → keep permanent
  access, repeatable across accounts, with the creator's earnings report still counting the sale
  until someone reads the `disputed` status by hand.
- evidence: Read `BillingService.ts:239-261`; one comment block covers both handlers and only
  reasons about refunds. `charge.dispute.closed` (the "you lost" event) is not handled at all —
  `stripe-webhook.controller.ts:54` discards it.
- fix: Handle `charge.dispute.closed` and, when `dispute.status === 'lost'`, delete the
  `user_purchases` row for that transaction; leave `dispute.created` as status-only so an
  in-progress dispute does not punish a buyer who wins it.
- effort: S

### [P3] `checkout.session.expired` is ignored, so abandoned checkouts stay `pending` forever
- id: billing-017
- location: podcast-saas/backend-api/src/controllers/v1/stripe-webhook.controller.ts:54
- category: data-integrity
- confidence: high
- status: confirmed
- what: Every abandoned Checkout leaves a `pending` `billing_transactions` row that nothing ever
  resolves — `checkout.session.expired` hits the `default: break`.
- why: `GET /api/admin/v1/billing/overview` reports `pendingTransactions` as an operational signal
  (`controllers/admin/v1/billing.controller.ts:16,29`); it monotonically inflates with abandoned
  carts, so the one number an admin would use to spot genuinely stuck payments is unusable. It also
  makes the pending-session de-duplication proposed in billing-002 harder to reason about.
- evidence: Read `stripe-webhook.controller.ts:32-56`; the switch handles four event types.
- fix: Add `case 'checkout.session.expired'` → resolve by `session.metadata.transactionId` and set
  `status:'expired'` (guarded by the same terminal-state predicate as billing-005).
- effort: S

### [P3] Fleet: my dispatch prompt and the orchestrator disagree on the findings filename
- id: billing-018
- location: .claude/review/PROTOCOL.md:31
- category: fleet
- confidence: high
- status: confirmed
- what: The agent prompt for this domain says to write `OUTPUT_DIR/findings/billing.md` and
  `.jsonl`; the orchestrator's dispatch message says `billing-integrity.md` / `.jsonl`. Per
  PROTOCOL §1 the handed-down `OUTPUT_DIR` paths win, so I wrote `billing-integrity.*`.
- why: If a future run follows the agent file instead, the orchestrator's merge step reads a
  filename that does not exist and this domain silently contributes zero findings to `REPORT.md` —
  a failure mode with no error message, which is exactly the drift class `fleet-maintainer` owns.
- evidence: This session's dispatch message names `billing-integrity.md`; the domain agent prompt
  names `billing.md`. Both refer to the same `OUTPUT_DIR`.
- fix: Make the domain agent file state the filename as `<your-domain>` and define the domain slug
  in one place (`stack.md` §3 ownership matrix), so the agent file and the orchestrator cannot
  drift.
- cross: @fleet-maintainer
- effort: S
