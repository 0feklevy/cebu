# Test quality — findings

Run: 2026-08-15T2109, commit 2d187e3 (main). Domain: test health and coverage of risky paths
(storage/local-fallback, export/ffmpeg, capture, queue, auth middleware, billing/Stripe webhook,
migration runner, contract drift), plus the 9 client-web Playwright configs.

## Suite status

**Green, independently re-run.** `pnpm -C podcast-saas --filter backend-api test`:
`133 passed | 3 skipped (136 files)`, `2278 passed | 18 skipped (2296 tests)` — exactly matches
`DETERMINISTIC.md`. Re-ran a 5-file subset (`src/queue`, `src/services/billing`,
`src/services/export/__tests__/projectExportService.test.ts`, `src/middleware`) in isolation:
`5 passed (5)`, `35 passed (35)` — no flakiness observed, and the `src/middleware` glob matched
zero test files (see test-quality-004). Backend suite wall time was ~630s in this run vs the
orchestrator's 162s, entirely explained by CPU contention from the other fleet agents' own test
runs happening concurrently (5 vitest worker processes competing on the box) — not a repo defect.

client-web / admin-web / shared / ops: relied on the orchestrator's `DETERMINISTIC.md` baseline
(1389 / 34 / — / 340 tests, all green) per the task's instruction not to re-run what's already
measured.

No red suite to report. The rest of this file is coverage and signal-quality gaps.

---

### [P2] 78% of v1 controllers have zero request-level tests, including the two files where this run's billing P1s live
- id: test-quality-001
- location: podcast-saas/backend-api/src/controllers/v1/__tests__/ (directory)
- category: test
- confidence: high
- status: confirmed
- what: 27 `*.controller.ts` files exist under `controllers/v1/`. Only 5 have any dedicated test
  file (`sections`, `simulations`, `corpus` (partially — object-name only), `projects` (partially —
  duplication-table-missing only), and export via `exportEndpoints.test.ts`). The other 22,
  including `billing.controller.ts`, `playlists.controller.ts`, `stripe-webhook.controller.ts`,
  `collaborators.controller.ts`, `share.controller.ts`, `avatar.controller.ts`, `video.controller.ts`,
  and every `podcast-*.controller.ts`, have no route-level test at all.
- why: `exportEndpoints.test.ts:175` shows the pattern this repo already knows how to write —
  `it('is owner-gated: a project the caller does not own is 404', ...)`. That pattern exists for
  exactly one resource. `billing-001` (playlists.controller.ts:620, a free playlist silently
  un-paywalls every paid video inside it) and `billing-003` (stripe-webhook.controller.ts:33,
  payment_status never checked) both live in files with zero tests — an `app.inject` ownership/
  entitlement test per resource would have given the fleet's own P1s a chance to be caught before
  merge, not just after.
- evidence: `ls podcast-saas/backend-api/src/controllers/v1/*.controller.ts | wc -l` → 27;
  `ls podcast-saas/backend-api/src/controllers/v1/__tests__/*.test.ts` → 10 files covering 5
  resources. Cross-checked against `billing.jsonl`/`backend.jsonl` P1s from this run.
- fix: for each of the 22 untested controllers, add one `app.inject` suite covering (a) the
  happy path, (b) an ownership/entitlement check per mutating or paid route (assert 403/404 for a
  caller who is not the owner/purchaser), and (c) one representative error branch. Start with
  `playlists.controller.ts` (billing-001) and `stripe-webhook.controller.ts` (test-quality-002).
- verify: new `app.inject` test red before a hypothetical fix, green after; no change to
  `pnpm -C podcast-saas --filter backend-api typecheck`.
- cross: @billing-integrity @backend
- effort: L

### [P1] stripe-webhook.controller.ts has zero tests — no proof of signature wiring, payment_status gating, or replay/idempotency
- id: test-quality-002
- location: podcast-saas/backend-api/src/controllers/v1/stripe-webhook.controller.ts:19
- category: test
- confidence: high
- status: confirmed
- what: `registerStripeWebhookRoutes` (raw-body content-type parser, `BillingService.verifyWebhook`
  call, and the `checkout.session.completed` / `async_payment_succeeded` / `payment_intent.payment_failed`
  / `charge.refunded` / `charge.dispute.created` switch) has no test file anywhere. The only related
  test, `grantFromSession.test.ts`, starts from an already-valid `Stripe.Checkout.Session` object and
  never goes through the controller, so it cannot see that the controller calls `grantFromSession`
  directly on `checkout.session.completed`/`checkout.session.async_payment_succeeded` with **no**
  `session.payment_status === 'paid'` guard — unlike the sibling call site at `BillingService.ts:278`,
  which does check it before calling the same function (this is `billing-003`, filed by
  billing-integrity this run).
- why: this is the entire inbound money-recognition surface for the app. Zero coverage means a
  regression in signature verification, event routing, or the payment_status gate (already present,
  per billing-003) ships silently.
- evidence: `grep -rl stripe src --include='*.test.ts'` → only `frontendCsp.test.ts` (CSP directive
  name) and `grantFromSession.test.ts` (unit-level, no controller). Read
  `stripe-webhook.controller.ts:31-33`: `case 'checkout.session.completed': case
  'checkout.session.async_payment_succeeded': await BillingService.grantFromSession(...)` — no
  status check. Read `BillingService.ts:277-278`: the *other* caller of `grantFromSession` does
  `if (session.payment_status === 'paid') { await this.grantFromSession(session); }`.
- fix: add `stripe-webhook.controller.test.ts` using `app.inject` with a real
  `stripe.webhooks.generateTestHeaderString`-style signed payload (or a mocked
  `BillingService.verifyWebhook`) covering: (1) invalid signature → 400, no DB write; (2)
  `checkout.session.completed` with `payment_status: 'unpaid'` → does NOT call `grantFromSession`
  (regression for billing-003); (3) the same Stripe event id delivered twice → transaction flips to
  `succeeded` once, second delivery is a no-op (replay/idempotency); (4)
  `payment_intent.payment_failed` resolves by `metadata.transactionId`, not by
  `stripe_payment_intent_id` (this file's own comment flags the historical bug at line 39).
- verify: test (2) is red against current code (grantFromSession is called unconditionally), green
  once billing-003 is fixed.
- cross: @billing-integrity
- effort: M

### [P2] BillingService.verifyWebhook / markFailed / handleRefund / handleDispute have zero unit tests
- id: test-quality-003
- location: podcast-saas/backend-api/src/services/billing/__tests__/grantFromSession.test.ts:1
- category: test
- confidence: high
- status: confirmed
- what: `BillingService.ts` exports `verifyWebhook` (184), `grantFromSession` (193), `markFailed`
  (222), `handleRefund` (244), `handleDispute` (254). Only `grantFromSession` has a test file; the
  other four are exercised nowhere (not by a unit test, not transitively — `stripe-webhook.controller.ts`
  itself is also untested, test-quality-002).
- why: `markFailed` is the fix for a previously-shipped "stuck pending" P0 (per its own comment at
  `stripe-webhook.controller.ts:37-39`) — a function whose whole purpose is a past incident has no
  regression test protecting it from recurring. `handleRefund`/`handleDispute` reverse money
  already granted; an off-by-one in either silently over- or under-refunds entitlements.
- evidence: `find src/services/billing -type f` → `BillingService.ts` +
  `__tests__/grantFromSession.test.ts` only.
- fix: add one `describe` block per function using the same `db.transaction`-mock pattern
  `grantFromSession.test.ts` already establishes: `markFailed` resolves by `transactionId` when
  present and falls back to `paymentIntentId` only when absent; `handleRefund` flips exactly the
  matching transaction and does not touch others sharing a `stripe_payment_intent_id` prefix;
  `handleDispute` is idempotent against a second `charge.dispute.created` for the same dispute id.
- verify: each new test fails against a deliberately-reverted version of its target function.
- cross: @billing-integrity
- effort: M

### [P2] The entire authn/authz middleware layer has zero test files
- id: test-quality-004
- location: podcast-saas/backend-api/src/middleware/ (directory)
- category: test
- confidence: high
- status: confirmed
- what: `firebase-auth.ts`, `firebase-admin-required.ts`, `rate-limit.ts` — every request in the app
  passes through one of these — have no `__tests__/` directory and no test file references them
  directly (only indirectly, as a mocked-out dependency, from unrelated controller tests).
  Independently confirmed: `npx vitest run src/middleware` matched zero test files.
- why: `security-003` (this run) is exactly a middleware defect — `firebase-auth.ts:45` trusts the
  Firebase email without checking `email_verified`, letting an unverified signup claim admin or a
  pending collaborator invite. A dedicated middleware suite with a decoded-token fixture
  (`email_verified: false`, matching a pending invite/admin email) is the cheapest possible
  regression test for that finding, and it does not exist because the file has no tests of any kind.
- evidence: `find src/middleware -type f` → 3 source files, 0 test files. Vitest run confirms.
- fix: add `middleware/__tests__/firebase-auth.test.ts` mocking `firebase-admin`'s
  `verifyIdToken` to return fixtures with `email_verified: true/false`, and assert the
  `email_verified: false` case does not resolve `request.dbUser` to an admin/invited account
  (regression for security-003). Add `rate-limit.test.ts` covering the per-IP window/reset the
  unauthenticated endpoints in this run's `security` findings rely on as their only bound
  (`avatar.controller.ts:166`, `:241`, `:260`).
- verify: the `email_verified:false` test is red today (per security-003), green once fixed.
- cross: @security
- effort: M

### [P2] RateLimitService has zero tests, matching its zero production call sites
- id: test-quality-005
- location: podcast-saas/backend-api/src/services/usage/RateLimitService.ts:9
- category: test
- confidence: high
- status: confirmed
- what: no test file exists for `RateLimitService.ts` or `UsageTrackingService.ts`
  (`find src/services/usage -type f` → 2 source files, 0 tests).
- why: `billing-004` (this run, P1) is that admin-set per-user token budgets are never enforced
  because `RateLimitService` has zero call sites. A test that constructs the service and asserts
  *some* controller path calls `.check()`/`.consume()` before a billable LLM call — even a coarse
  "grep the registered routes for a call site" wiring test — would have caught the missing
  integration directly, independent of unit-testing the service's own logic.
- evidence: directory listing above; cross-referenced against `billing-004` in
  `findings/billing-integrity.jsonl`.
- fix: unit-test `RateLimitService`'s window/reset logic in isolation, and add one wiring test per
  billable LLM route asserting the rate-limit service is invoked (fails today, since it is never
  called — this is the intended regression test for billing-004).
- verify: the wiring test is red until billing-004 is fixed.
- cross: @billing-integrity
- effort: M

### [P2] The only tests that exercise a real ffmpeg failure are opt-in and never run automatically
- id: test-quality-006
- location: podcast-saas/backend-api/src/services/export/__tests__/linearAssembler.realEncode.test.ts:42
- category: test
- confidence: high
- status: confirmed
- what: `linearAssembler.test.ts` (the file that always runs) covers only pure helpers —
  `ProgressParser`, `findMoovMdatOffsets`, `parseFfmpegFilters`, and the typed-error classes. The
  actual `LinearAssembler.assemble()` orchestration (real `spawn('ffmpeg', ...)`, non-zero exit,
  cancellation, duration gate) is only exercised in `linearAssembler.realEncode.test.ts`, gated by
  `process.env.EXPORT_REAL_ENCODE === '1'` (`describe.runIf(ENABLED)`), and its HLS sibling
  `hlsTranscoder.realEncode.test.ts` gated by `HLS_REAL_ENCODE === '1'`. Neither env var is set by
  any `.github/workflows/*.yml`, and `pnpm -C podcast-saas --filter backend-api test` reports these
  as part of the 18 skipped tests in the green run.
- why: this is the intersection of two hunt items — "no test on the transcode error path" and
  "integration tests silently skipped." The suite that *would* catch a real ffmpeg exit-code
  regression, a broken filter graph, or a cancellation race exists, is well-written (SIGTERM
  cancellation, seam ownership, amix normalization are all covered), and never runs anywhere in CI
  or in a default `pnpm test`. `media-001`/`media-002` (this run's two export/HLS P1s) are not even
  covered by these suites when they DO run — see test-quality-007 for the HLS side.
- evidence: `grep -n "child_process\|from '../LinearAssembler'" src/services/export/__tests__/*.test.ts`
  shows only the `.realEncode.` file imports `spawn`. `grep EXPORT_REAL_ENCODE
  .github/workflows/*.yml` → no matches.
- fix: either run the real-encode suites nightly/weekly in CI (with a job that installs ffmpeg) so
  they exercise real exit codes on a cadence, or, if that's judged too slow for CI, mock `spawn` in
  `linearAssembler.test.ts` itself (the pattern `hlsTranscoder.transcode.test.ts` already uses) to
  cover a non-zero ffmpeg exit and a missing-input `ENOENT` without needing a real binary.
- verify: a deliberately-broken `assemble()` (e.g. swallow a non-zero exit code) should fail a new
  mocked-spawn test; today nothing in the default suite would catch it.
- cross: @media-pipeline
- effort: M

### [P2] The mocked HLS transcode suite never simulates a non-zero ffmpeg exit code
- id: test-quality-007
- location: podcast-saas/backend-api/src/services/video/__tests__/hlsTranscoder.transcode.test.ts:137
- category: test
- confidence: high
- status: confirmed
- what: `hlsTranscoder.transcode.test.ts` fakes `spawn` at the boundary (a real, well-designed
  approach — see `gate (i)/(ii)/(iii)` tests for corrupt-output detection). But the fake spawn
  implementation always ends with `proc.emit('close', 0)` (line 137); no test ever drives the mock
  to emit `close` with a non-zero code, and the `error` event path (line 139) is only reachable
  through an exception thrown inside the test's own `fakeEncode()` helper, not by directly asserting
  "ffmpeg exited 1."
- why: a real ffmpeg non-zero exit (disk full, unsupported codec, OOM-killed mid-encode — the
  documented 2026-08-13 incident referenced in `pgBoss.ts:20-21`) is the single most common
  production failure mode for a transcode. Nothing in this suite proves `transcodeToHLS` rejects
  cleanly (rather than uploading a partial/corrupt tier) when that happens.
- evidence: `grep -n "close', [1-9]" src/services/video/__tests__/hlsTranscoder.transcode.test.ts`
  → no matches; every `close` emission in the file is `emit('close', 0)`.
- fix: add a test where the fake `ffmpeg` spawn resolves with `proc.emit('close', 1)` (no stdout
  written) and assert `transcodeToHLS(...)` rejects, and that `uploadWithFallback` was never called
  for that tier (no partial upload).
- verify: red against a mutant that ignores the exit code and proceeds to upload regardless.
- cross: @media-pipeline
- effort: S

### [P2] queue/registry.ts and queue/pgBoss.ts have zero tests — 8 of 9 job handlers and the dead-letter/retry config are unverified
- id: test-quality-008
- location: podcast-saas/backend-api/src/queue/registry.ts:23
- category: test
- confidence: high
- status: confirmed
- what: `queue/__tests__/` covers `inlineDriver.ts`, `pgBossDriver.ts`, `routing.ts`. `registry.ts`
  (the `handlers: JobHandlers` map from job name → service entrypoint, for all 9 job names) and
  `pgBoss.ts` (queue creation, `deadLetter` wiring, the per-queue `retryLimit`/`retryDelay`/
  `retryBackoff`/`expireInSeconds` table) have no test file. `pgBossDriver.test.ts` only exercises
  the `crop` job name end-to-end.
- why: `registry.ts`'s own docstring explains why handlers are constructed lazily/per-job (to break
  an import cycle and avoid stale-adapter capture in tests) — that's exactly the kind of
  order-of-evaluation subtlety a test should pin down and currently doesn't. `pgBoss.ts`'s
  `QUEUE_OPTIONS` table encodes load-bearing operational judgment calls (documented inline: why
  `project_export` gets 60 minutes, why retries are "safe" because `run()` no-ops on terminal
  states) with nothing asserting the values it ships, so a future edit can silently widen or shrink
  a retry/expiry window with no test noticing.
- evidence: `find src/queue -type f` → 7 source files, 3 test files (`inlineDriver`, `pgBossDriver`,
  `routing`); none imports `registry.js` or `pgBoss.js` directly.
- fix: add `registry.test.ts` that imports the real `handlers` map and, for each of the 9 job
  names, calls it with a typed stub payload and asserts the correct underlying service function was
  invoked with the correctly-extracted arguments (catches an argument-mapping typo that the type
  system alone would not, e.g. swapping two same-typed fields). Add a `pgBoss.test.ts` asserting the
  `QUEUE_OPTIONS` table's `retryLimit`/`expireInSeconds` values as an explicit snapshot-style
  contract, so a change to them is a reviewed diff, not a silent edit.
- verify: `registry.test.ts` fails if a handler is remapped to call the wrong service function.
- cross: @job-queue
- effort: M

### [P2] No regression test for the retry/restart double-append bug in b-roll generation
- id: test-quality-009
- location: podcast-saas/backend-api/src/jobs/__tests__/videoGenerateQueue.test.ts:69
- category: test
- confidence: high
- status: confirmed
- what: `videoGenerateQueue.test.ts` covers only concurrency limiting (`runs at most 2
  concurrently`, `releases the slot even when a running job rejects`). It does not touch the
  scenario `job-queue-001`/`job-queue-002` describe: a pg-boss retry or startup-recovery re-enqueue
  of the same b-roll job appending a second timeline section, because the download/append step
  itself is not claim-guarded the way the crop path is.
- why: this is a P1 filed in this run with a concrete, testable shape — "a retried or
  restart-recovered b-roll job re-downloads and appends a SECOND timeline section"
  (`video.generate.ts:58`, `:239`). It is directly testable without touching pg-boss: call the job
  handler twice with the same payload (simulating a retry) against a shared fake `db`/timeline-section
  store and assert exactly one section is appended.
- evidence: `grep -n '^describe\|it(' src/jobs/__tests__/videoGenerateQueue.test.ts` → only the two
  concurrency tests exist.
- fix: add a test that invokes the `video_generate` handler twice for the same `jobId` (simulating
  pg-boss's at-least-once redelivery) and asserts the timeline gains exactly one new section, not
  two — red today per job-queue-001/002, green once the append step is made idempotent/claimed.
- verify: as above.
- cross: @job-queue
- effort: M

### [P2] No test asserts a non-UUID route param returns 404 instead of 500
- id: test-quality-010
- location: podcast-saas/backend-api/src/controllers/v1/player.controller.ts:29
- category: test
- confidence: high
- status: confirmed
- what: no test anywhere in the suite sends a non-UUID `:id`/`:projectId` path segment and asserts
  a 404. `backend-001` (this run, P1) documents that such a request instead reaches a `uuid` column
  comparison and 500s (Postgres `22P02`), and `backend.md`'s own signal to this domain
  (`corpus.controller.ts:98`) already names this as a cheap `app.inject` test.
- why: this is a one-line reproduction (`app.inject({ method: 'GET', url:
  '/api/v1/projects/not-a-uuid/player-config' })`) for a defect that currently 500s on every
  affected route, and per `signals.md` it also inflates the unauthenticated 5xx rate an alerting
  pipeline watches (`backend.md`'s note to observability).
- evidence: `grep -rln "22P02\|non-UUID\|not-a-uuid" src --include='*.test.ts'` → no controller test
  matches (the one hit, `revisionIdentity.test.ts`, is unrelated sim-identity code).
- fix: add one `app.inject` test per representative UUID-keyed route (start with
  `player.controller.ts`, `corpus.controller.ts`) asserting a malformed id returns 404, not 500.
- verify: red today (500), green once backend-001 is fixed with an explicit UUID-shape check before
  the query.
- cross: @backend
- effort: S

### [P2] ContentModerationService's test suite never exercises the DB-seeded/admin-customized prompt branch — exactly where the real bug lives
- id: test-quality-011
- location: podcast-saas/backend-api/src/services/llm/__tests__/contentModeration.test.ts:49
- category: test
- confidence: high
- status: confirmed
- what: every test in this file sets `mocks.findFirst.mockResolvedValue(undefined)` in `beforeEach`
  (line 49), so `moderateGenerationInput` always falls through to the hardcoded
  `DEFAULT_MODERATION_PROMPT` (`ContentModerationService.ts:27`), whose JSON contract
  (`{"allowed": boolean, ...}`) matches `VerdictSchema` by construction. No test ever supplies a
  `system_prompts` row for key `content_moderation` (the `row?.content` branch at
  `ContentModerationService.ts:52`), which is the code path `llm-pipeline-002` (this run, P1)
  describes: a seeded/admin prompt that asks for `{flagged}` instead of `{allowed}` silently fails
  open on every call, forever, because `VerdictSchema.allowed` is always `undefined` for that
  response shape and `moderateGenerationInput` only blocks on an explicit `false`.
- why: the entire value of this fail-open-by-design service depends on the seeded prompt and the
  parser staying in agreement — that is precisely the one thing the test suite never checks, because
  it always substitutes its own hand-written `{"allowed": ...}` fixtures instead of driving the
  service through a seeded-row.
- evidence: `grep -n "findFirst.mockResolvedValue" src/services/llm/__tests__/contentModeration.test.ts`
  → one hit, always `undefined`. Read `ContentModerationService.ts:47-52`: `const systemPrompt =
  row?.content?.trim() || DEFAULT_MODERATION_PROMPT` — the customized-prompt branch is real code with
  no test reaching it.
- fix: add a test that sets `mocks.findFirst.mockResolvedValue({ content: '...' })` with a
  representative admin-customized prompt whose model response uses a *different* key than
  `allowed` (reproducing llm-pipeline-002's `{flagged}` shape) and assert the service does NOT
  silently pass — either by fixing the parser to be defensive, or, at minimum, by asserting today's
  behavior explicitly so a fix is provably tested.
- verify: with the reproduction fixture, the test is red (silently resolves) until llm-pipeline-002
  is addressed.
- cross: @llm-pipeline
- effort: S

### [P2] LLMService.retry tests mock UsageTrackingService as an empty stub — no assertion that a failed/aborted call is metered
- id: test-quality-012
- location: podcast-saas/backend-api/src/services/llm/__tests__/LLMService.retry.test.ts:23
- category: test
- confidence: medium
- status: confirmed
- what: `vi.mock('../../../services/usage/UsageTrackingService.js', () => ({ UsageTrackingService:
  vi.fn() }))` — a bare constructor mock with no methods. The suite drives `sendStructured` through
  a rejected/aborted call (`.catch(() => {})` at line 115) but never asserts anything about metering
  before or after.
- why: `llm-pipeline-005` (this run, P1) is that failed and aborted provider calls are never
  metered, letting the daily cost cap be bypassed. This test file is the natural home for that
  regression test — it already drives the exact failure/abort scenarios — but stops short of
  asserting on the usage side effect.
- evidence: `grep -n "UsageTrackingService\|catch\|abort" src/services/llm/__tests__/LLMService.retry.test.ts`
  shows the mock and the `.catch(() => {})` but no usage-side assertion in the file.
- fix: give the mock a real `vi.fn()` for whichever method records usage, and add an assertion that
  it is called (with a failure/zero-token marker, or however the fix records it) after a rejected
  and after an aborted `sendStructured` call.
- verify: red until llm-pipeline-005 is fixed, since today nothing records usage on that path.
- cross: @llm-pipeline
- effort: S

### [P1] The only Playwright suite covering the real production viewer cannot run in CI and is invoked by no workflow
- id: test-quality-013
- location: podcast-saas/client-web/playwright.viewer.config.ts:11
- category: test
- confidence: high
- status: confirmed
- what: `playwright.viewer.config.ts` (`viewer-e2e.spec.ts`) is explicitly documented as the only
  suite that exercises "the REAL React viewer... the real Next route, the real components, the real
  useProjectPlayer, the real generated bridge." Unlike every other non-production config (`sim`,
  `leak`, `canary`, `transport`, `protocol`, `rebuilt` — all of which self-bootstrap via an
  in-process fixture server, per `playwright.sim.config.ts:4`), this one has **no `webServer`** by
  design ("building/starting a second Next server here would clobber the .next directory of a dev
  server the developer is already running") and requires an already-running server at
  `VIEWER_E2E_BASE_URL`/`localhost:3000`. Grepping every `.github/workflows/*.yml` for
  `playwright.viewer.config` returns no hits — only `playwright.production.config.ts` is CI-wired.
- why: this is the single suite that would catch a break in the actual production viewer/player
  component tree, and it is structurally excluded from both CI (no workflow references it) and this
  review's own local Playwright pass (`DETERMINISTIC.md` section 2 ran 6 configs; `viewer` is not
  among them, consistent with it needing an external server). The most user-facing surface in the
  repo has zero automated coverage anywhere.
- evidence: `grep -n webServer podcast-saas/client-web/playwright.*.config.ts` → only `viewer` and
  `sim` mention `webServer` in a comment, and only `viewer`'s comment explains why it has none.
  `grep -rn playwright.viewer .github/workflows/*.yml` → no matches.
- fix: either give `playwright.viewer.config.ts` a dedicated `webServer` entry pointed at a
  purpose-built preview build (not the developer's own `.next`, e.g. `next build && next start -p
  <ephemeral-port>` in a scratch dir) so it can run headless in CI, or explicitly document it as a
  manual pre-release gate and add a lightweight compensating suite (even a Playwright test against
  `playwright.production.config.ts`'s already-CI-wired path) that exercises the same
  `useProjectPlayer`/bridge surface without a hand-started server.
- verify: `npx playwright test --config=playwright.viewer.config.ts --list` succeeds unattended in
  a clean CI checkout (today it cannot, since nothing starts the server it needs).
- cross: @frontend @config-deploy
- effort: M

### [P2] No contract test exists for shared/src/generated/client-v1.ts against the real backend routes
- id: test-quality-014
- location: podcast-saas/shared/src/generated/client-v1.ts:1
- category: test
- confidence: high
- status: confirmed
- what: `client-v1.ts` (1667 lines, hand-maintained despite the `generated/` directory name — a
  documented trap in `stack.md` §2) is never imported by any `*.test.ts` file in the repo. No test
  cross-checks a single URL string in this file against the `register*Routes(app)` calls the
  backend actually registers.
- why: `stack.md` §6 names exactly this as one of six known-sensitive areas: "backend route changes
  do not break the build" because nothing regenerates or checks this file. A route rename, a path
  param rename, or a removed endpoint on the backend side currently has zero automated signal on the
  client side — it fails at runtime in the browser, not in CI.
- evidence: `grep -rl 'client-v1' podcast-saas --include='*.test.ts'` → no matches anywhere in the
  monorepo (backend, client-web, admin-web, shared).
- fix: add a contract test (naturally lives in `shared` or as a backend test with `client-v1.ts`
  imported for its string literals) that collects every `app.get/post/put/patch/delete(url, ...)`
  call registered by `server.ts`'s full route set (via the same `onRoute` hook pattern
  `rawBodyRouteConfig.test.ts` already uses) and asserts every literal path string found in
  `client-v1.ts` matches a registered route pattern (accounting for `:param` vs template-literal
  interpolation).
- verify: the new test fails if a route registered in `client-v1.ts` is renamed/removed on the
  backend without updating the client.
- cross: @types-contracts
- effort: M

### [P2] fieldAggregates() has the same raw-Date-in-raw-SQL defect its sibling function is explicitly regression-tested against, with no test of its own
- id: test-quality-015
- location: podcast-saas/backend-api/src/services/simulation/RumService.ts:440
- category: test
- confidence: high
- status: confirmed
- what: `rumService.test.ts` (lines 261-311) contains an unusually deliberate regression test for
  `reapRumEvents`: it explicitly documents that PGlite (the test driver) silently accepts a raw
  JS `Date` bound into a raw `sql` template fragment while the *production* driver (`postgres.js`)
  throws `ERR_INVALID_ARG_TYPE` on the same input — and it captures driver-level bound parameters to
  assert no `Date` reaches that boundary. `fieldAggregates()` (`RumService.ts:430-441`) has the
  exact same shape — `AND created_at >= ${cutoff}` where `cutoff = new Date(...)` interpolated
  directly into a `sql` template — and no test reaches it with the same parameter-capture technique;
  its only test coverage (if any — not confirmed beyond this read) would go through the PGlite
  path, which cannot see this failure mode by the test suite's own documented admission.
- why: `fieldAggregates()` wraps its whole body in a `try/catch` that treats **any** thrown error as
  "no field data" and silently falls back to a lab number (`RumService.ts:454-457` per file
  context). If `postgres.js` throws on this Date the same way the sibling comment says it does for
  `reapRumEvents`, this function would silently return an empty map on every production call,
  forever — and nothing, in tests or in production logs (the catch is silent-by-design), would
  surface it.
- evidence: Read `RumService.ts:430-441` — `const cutoff = new Date(Date.now() - windowDays *
  86_400_000); ... sql\`... AND created_at >= ${cutoff} ...\``. Read `rumService.test.ts:266-268`:
  "postgres.js throws here on a Date, PGlite does not." Signaled to this domain by
  `simulation-reviewer` this run (`simulation-012`, filed P3/suspected/low-confidence against the
  bug itself); this finding is the test-coverage side, confirmed by direct read.
- fix: apply the same parameter-capture pattern `rumService.test.ts` already built for
  `reapRumEvents` to `fieldAggregates` — assert no `Date` instance reaches the driver boundary for
  this query too. If it fails, use the same fix as the reap path (stringify to ISO before
  interpolating, or bind via a typed Drizzle helper rather than a raw fragment).
- verify: new test is red today if the driver-boundary assertion is added and the code is
  unchanged (parameter capture would show a raw `Date`).
- cross: @simulation @database
- effort: S

### [P3] db/migrate.ts's own apply/rollback-marking logic is never exercised — migration tests bypass the runner
- id: test-quality-016
- location: podcast-saas/backend-api/src/db/__tests__/migration049.test.ts:24
- category: test
- confidence: medium
- status: confirmed
- what: `migration049/050/051/052/058.test.ts` are real and rigorous (replay actual `.sql` files
  against PGlite, prove ordering hazards, FK/CHECK behavior). But every one of them reads and
  applies the raw `.sql` files itself via `readdirSync`/`readFileSync` — none imports or exercises
  `db/migrate.ts`'s actual runner function. `database-001` (this run, P1: "migration runner marks a
  file applied after its transaction rolled back," `migrate.ts:58`) is therefore not something any
  existing migration test could catch, however many new `.sql`-content tests are added, because the
  bug is in the runner's bookkeeping, not in any migration's SQL.
- why: coverage-by-file-count is misleading here — 5 well-written migration test files exist, and
  none of them touches the one function where this run's migration P1 actually lives.
- evidence: `grep -n "from '../migrate" src/db/__tests__/*.test.ts` → no matches; each file's own
  docstring (e.g. migration049.test.ts:1-20) confirms it "replays the actual migration files in
  order" itself rather than calling the runner.
- fix: add `migrate.test.ts` that runs the real `runMigrations`/equivalent export from `migrate.ts`
  against a PGlite instance with a migration file engineered to throw a tolerated error code mid
  -transaction, and assert the file is NOT recorded in `schema_migrations` when its DDL didn't apply
  (regression for database-001).
- verify: red today per database-001, green once the runner only records success on a committed
  transaction.
- cross: @database
- effort: M

---

## Coverage metric caveat (context for every finding above)

`backend-api/vitest.config.ts:48-49` restricts `coverage.include` to `src/services/**/*.ts` only,
so the reported 54% statement coverage (`DETERMINISTIC.md` §4) excludes `controllers/**` (37
files), `queue/**` (7), `middleware/**` (3), `jobs/**` (3), `lib/**`, `config/**`, `server.ts`,
`worker.ts` — 64 non-test source files entirely absent from the number. Every zero-coverage gap
this file names above (controllers, middleware, registry/pgBoss) is invisible to that metric, not
just under-represented by it. Already flagged by the orchestrator; repeated here because it is the
structural reason none of test-quality-001/004/008 would show up by watching the coverage number
alone.
