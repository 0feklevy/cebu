# Test quality — findings

**Agent:** `test-quality-reviewer`
**Branch under review:** `fix/export-prod-assembly-and-consent-ui` @ `ae4b65b`
**Run:** `2026-08-13T2227`

## Suite status — green, and that is the problem

| Suite | Result | How |
|---|---|---|
| `backend-api` (full) | **125/128 files, 2185 tests green** | run by `media-pipeline-reviewer` this run; cited, not re-run |
| `backend-api` typecheck | clean | confirmed independently by `job-queue-reviewer` |
| `backend-api` targeted subset — `src/services/export src/queue src/services/billing src/services/storage` | **27 files passed, 2 skipped; 339 tests passed, 13 skipped** in 21.9s | my own run: `podcast-saas/backend-api/node_modules/.bin/vitest run … --reporter=dot` |
| Playwright | **not run** (per role prompt); all 9 configs reviewed statically | — |

Nothing is red. The findings below are therefore all about **signal**, not failures: this run's other
reviewers filed 8 confirmed P1s, and the suite is green across every one of them. Two of those P1s
are green because a test actively asserts the buggy behaviour is correct; the rest are green because
the path has no test at all.

### Checked and found clean (stated so the negatives are on record)
- **No snapshot rubber-stamping.** `grep toMatchSnapshot|toMatchInlineSnapshot` across
  `backend-api/src` → **0 hits**, and no `__snapshots__` directory exists. Not a risk here.
- **No pglite fixture leakage across files.** All 18 `new PGlite()` call sites are inside
  `beforeEach`/`beforeAll` or a per-call factory (`src/db/__tests__/pgliteHelper.ts:82`); none is a
  module-scope singleton, and vitest isolates per file regardless. The role prompt flags this as a
  hunting ground — it is not one in this repo.
- **Randomness is bounded.** `Math.random()` appears in 3 test files (`services/crop/__tests__/dsp.test.ts`,
  `export/capture/__tests__/injection.test.ts`, the realCapture suite); in each it is either the
  *subject* (the injected deterministic PRNG) or noise fed to a tolerance-based DSP assertion. No
  flakiness found there.
- **`describe.skip` is not being used to hide breakage.** Exactly one static `describe.skip` exists
  repo-wide, and it is an env-gate, not a disablement (see `test-008`).

---

### [P1] The replace test's fixture excludes the only case that breaks, and its assertions certify the broken behaviour as correct
- id: test-001
- location: podcast-saas/backend-api/src/controllers/v1/__tests__/simulations.replace.test.ts:114
- category: test
- confidence: high
- status: confirmed
- what: `simulations.replace.test.ts` is 21 KB and 12 `it`s across four `describe`s — the most
  thoroughly tested endpoint in `controllers/v1`. Its `FAKE_SIM` fixture (lines 114-124) declares
  `storage_prefix`, `entry_file`, `bridge_functions`, `status`, `error` — and **no
  `active_revision_id` and no `active_revision_entry_key`**. `PREFIX` (line 110) is hardcoded to the
  legacy path `simulations/${PROJECT_ID}/${SIM_ID}`, and the happy-path test then asserts
  `expect(uploadedKeys).toContain(\`${PREFIX}/index.html\`)` (line 233) and
  `expect(deletedKeys).toEqual([\`${PREFIX}/legacy.js\`])` (line 252).
- why: `simulation-001` (P1, confirmed) is precisely that `processReplace` writes to the legacy
  prefix while `resolveSimulationUrl` serves from `active_revision_entry_key` whenever it is
  non-null — so replace is a silent no-op for every revisioned simulation, which is every sim whose
  bridge has been published. The suite makes that invisible twice over: the fixture never has an
  active revision (so the broken branch is never entered), and the assertions **lock in writes to
  the legacy prefix as the expected outcome**. A developer fixing `simulation-001` by routing
  replace through `RevisionService` would turn lines 233 and 252 red and could reasonably read that
  as "my fix broke the replace endpoint". No test anywhere asserts what a client actually *receives*
  after a replace: `getSimPublicUrl` is mocked to an identity-ish stub (line 42) and its return value
  is never compared before/against after.
- evidence: Read the file's fixture block (100-205) and every assertion (210-430). Grepped
  `active_revision` across `src/controllers/v1/__tests__/` → **no matches in any of the 10 files**.
  The endpoint's own controller has no `active_revision` reference either (simulation-001's evidence).
- fix: Describe two additions to this file. **(a) The regression test:** seed
  `mockSimulations.findFirst` with `{...FAKE_SIM, active_revision_id: 'rev-1',
  active_revision_entry_key: 'simulations/proj-1/sim-1/revisions/rev-1/index.html'}`, POST a valid
  same-entry-name ZIP, and assert the endpoint **refuses with 409** (`expect(res.statusCode).toBe(409)`)
  **and touches nothing**: `expect(mockStorage.uploadFile).not.toHaveBeenCalled()`. Red today (the
  endpoint answers 202 and uploads). **(b) The served-bytes assertion the suite is missing entirely:**
  in the existing happy path, capture `mockStorage.getSimPublicUrl.mock.results` and assert the
  resolved entry URL contains the *same* key the new `index.html` was uploaded to —
  `expect(entryUrl).toContain(uploadedEntryKey)` — so any future divergence between "where replace
  writes" and "what the viewer reads" fails loudly instead of passing.
- verify: (a) must be red on `ae4b65b` and green after `simulation-001` is fixed. (b) must be green
  today and red if the write prefix and the read pointer are ever allowed to diverge again.
- cross: @simulation
- effort: M

### [P1] The Claude abort test's name asserts the opposite of its body, and its sole assertion survives deleting the implementation
- id: test-002
- location: podcast-saas/backend-api/src/services/llm/__tests__/ClaudeProvider.test.ts:203
- category: test
- confidence: high
- status: confirmed
- what: The test is named `'throws AppError ABORTED when signal fires'`. Its body aborts the
  controller, then does the opposite of throwing:
  ```
  // Aborted streams return partial content, not an error (break in loop)
  const result = await promise;
  expect(result.content).toBeDefined();
  ```
  (lines 220-223). `toBeDefined()` is the test's **only** assertion, and it passes for `''`, for
  `'partial'`, for any string at all — including whatever a gutted implementation returns.
- why: This is `llm-011` (P2, confirmed: "An aborted Claude stream returns partial content as a
  successful response") written down as an expectation rather than a bug. Three separate failures
  compound: the **name** claims a safety property the code does not have, so anyone auditing test
  names for abort handling gets a false positive; the **assertion** is vacuous, so the test cannot
  distinguish "returned the partial text it had" from "returned an empty string"; and the **comment**
  records the wrong behaviour as intended, which is how a defect becomes load-bearing. Downstream
  this is what makes `llm-001` (truncated output stored as complete) reachable — a caller cannot
  tell an aborted partial from a finished response.
- evidence: Read lines 189-226 in full. Scanned every `it`/`test` block in `backend-api/src` for
  blocks whose assertions are *exclusively* `toBeDefined()`/`toBeTruthy()`/`not.toBeNull()` — 22
  hits, of which 20 are legitimate positive controls in constraint suites ("this INSERT is accepted
  by the CHECK"). This one and `sections.publication.test.ts:240` are the two where the weak
  assertion is doing real work it cannot do.
- fix: Rename the test to what it observes and make the assertion load-bearing, then add the missing
  one. Replace the body's tail with: `expect(result.content).toBe('partial')` **and**
  `expect(result.stopReason ?? result.finishReason).not.toBe('end_turn')` — i.e. assert that an
  aborted response is distinguishable from a complete one. If the provider exposes no such field,
  that absence *is* the finding and the test should assert `await expect(promise).rejects.toThrow(/ABORT/)`
  once `llm-011` is fixed. Either way `toBeDefined()` must go.
- verify: the rewritten assertion must fail if `ClaudeProvider`'s stream loop is changed to return
  `{content: ''}`; `toBeDefined()` does not.
- cross: @llm-pipeline
- effort: S

### [P2] BillingService's ledger-mutation surface has no test at all — `markFailed` ordering included
- id: test-003
- location: podcast-saas/backend-api/src/services/billing/BillingService.ts:226
- category: test
- confidence: high
- status: confirmed
- what: `src/services/billing/__tests__/` contains exactly **one** file, `grantFromSession.test.ts`.
  Nothing tests `markFailed`, `markRefunded`, the dispute path, or the `PLATFORM_FEE_PERCENT` clamp.
  Grepped `markFailed` across all `*.test.ts` in `backend-api/src` → the only hits are in
  `services/simulation/__tests__/` (an unrelated identically-named helper).
- why: `billing-001` (P1, confirmed) is that `markFailed` has no status guard, so a late
  `payment_intent.payment_failed` overwrites a `completed` sale — a customer who paid loses access
  and the ledger says the payment failed. Stripe redelivers and reorders events by design, so this
  is not exotic. There is no ordering test because there is no test.
- evidence: `ls src/services/billing/__tests__/` → `grantFromSession.test.ts` only. Targeted vitest
  run over `src/services/billing` collected 1 file.
- fix: New file `podcast-saas/backend-api/src/services/billing/__tests__/markFailed.test.ts`, mocking
  `db` in the style `grantFromSession.test.ts` already establishes. **Scenario:** a
  `billing_transactions` row already at `status: 'completed'` receives a late
  `payment_intent.payment_failed` for the same payment intent. **Assertion:** the row is left alone —
  `expect(mockUpdateSet).not.toHaveBeenCalled()`, or if the guard is implemented as a `where` clause,
  assert the generated predicate includes the status condition and that `markFailed` resolves without
  mutating. A second case covers the legitimate order (`pending` → `failed`) and asserts the write
  **does** happen, so the guard cannot be "fixed" by disabling the method. **Companion assertion for
  `billing-007`:** assert `markFailed` returns/throws on `rowCount === 0` rather than logging success —
  `expect(logger.info).not.toHaveBeenCalledWith(expect.objectContaining({...}), 'Transaction marked failed')`
  when the update matched nothing.
- verify: the first case is red on `ae4b65b` (no guard exists) and green after `billing-001` is fixed.
- cross: @billing-integrity
- effort: M

### [P2] The Stripe webhook's signature verification has no test, and the file that looks like it does tests something else
- id: test-004
- location: podcast-saas/backend-api/src/controllers/v1/stripe-webhook.controller.ts:19
- category: test
- confidence: high
- status: confirmed
- what: Grepped `stripe|Stripe` across every `*.test.ts` in `backend-api/src` → two files:
  `services/billing/__tests__/grantFromSession.test.ts` (the grant handler, post-verification) and
  `config/__tests__/frontendCsp.test.ts` (a CSP host allowlist). Neither constructs a webhook
  request. `controllers/v1/__tests__/rawBodyRouteConfig.test.ts` is the natural place to look and is
  a decoy: its four tests assert that **multipart** routes carry **no** `rawBody` config
  (lines 109-153) — the inverse concern. It never touches the webhook route.
- why: The webhook is the repo's only unauthenticated write endpoint that moves money.
  `stack.md §6.3` names it a known-sensitive area on exactly two properties — signatures verified on
  the **raw** body, and idempotency against replay — and neither has a single assertion.
  `billing-002` (P2, confirmed) is that there is no `event.id` ledger, so replay safety is
  per-handler and only `grantFromSession` is idempotent. A refactor that reads `request.body`
  instead of the raw buffer would break signature verification in production and leave CI green.
- evidence: the two greps above; read `rawBodyRouteConfig.test.ts` in full (all 4 `it`s).
- fix: New file `podcast-saas/backend-api/src/controllers/v1/__tests__/stripeWebhook.signature.test.ts`,
  registering the route on a bare Fastify instance with `stripe.webhooks.constructEvent` mocked.
  **Four scenarios, four assertions.** (1) *Missing header*: POST with no `stripe-signature` →
  `expect(res.statusCode).toBe(400)` and `expect(constructEvent).not.toHaveBeenCalled()`.
  (2) *Bad signature*: `constructEvent` throws → `expect(res.statusCode).toBe(400)` and
  **`expect(mockBillingService.grantFromSession).not.toHaveBeenCalled()`** — the assertion that
  actually matters, that no handler ran. (3) *Raw body*: valid signature → assert the **first
  argument** `constructEvent` received is a `Buffer` byte-identical to the posted payload:
  `expect(Buffer.isBuffer(constructEvent.mock.calls[0][0])).toBe(true)` and
  `expect(constructEvent.mock.calls[0][0].equals(payload)).toBe(true)`. This is the one that catches
  a `JSON.parse`-then-re-`stringify` regression. (4) *Replay*: deliver the identical
  `checkout.session.completed` event twice → assert the grant write happens **once**
  (`expect(mockInsert).toHaveBeenCalledTimes(1)`), which is red until `billing-002` lands an
  `event.id` ledger.
- verify: (1)-(3) should be green today and are pure regression armour; (4) is red on `ae4b65b`.
- cross: @billing-integrity, @security
- effort: M

### [P2] `canServeMediaKey` — the media authorization gate — has zero tests, so both its fail-open branch and its paywall gap are invisible
- id: test-005
- location: podcast-saas/backend-api/src/services/storage/mediaAccess.ts:82
- category: test
- confidence: high
- status: confirmed
- what: `grep -rl "canServeMediaKey\|mediaAccess" --include="*.test.ts" src` returns **nothing**.
  `src/services/storage/__tests__/` has 7 files (mediaToken, uploadWithFallback, pathSafety, …) and
  none of them is about *authorization* — `mediaToken.test.ts` tests token signing, which is the
  credential, not the decision.
- why: Two confirmed findings live in this untested function. `security-002` (P2): the gate
  **fails open** — a database fault makes every private and paid video world-streamable.
  `billing-003` (P2): paid content is not paywalled at the byte-serving layer at all. A fail-open
  `catch` is the specific defect class that unit tests exist to catch, because it is invisible in
  every environment where the database is up — which is every environment a human tests in.
- evidence: the grep above; `ls src/services/storage/__tests__/`; my targeted run collected 7 storage
  files, none referencing `mediaAccess`.
- fix: New file `podcast-saas/backend-api/src/services/storage/__tests__/mediaAccess.test.ts` with
  `db` mocked. **Scenario A (the fail-open regression, red today):** make the ownership query reject —
  `mockDb.query.video_files.findFirst.mockRejectedValue(new Error('connection terminated'))` — call
  `canServeMediaKey(privateKey, anonymousUser)` and assert **`expect(await canServeMediaKey(...)).toBe(false)`**.
  Today it resolves `true`. **Scenario B (positive control, so A cannot be satisfied by returning
  `false` always):** a healthy query where the caller *is* the owner → `toBe(true)`.
  **Scenario C (`billing-003`):** a key belonging to a paid project, requested by an authenticated
  user with **no** `billing_transactions` row → `toBe(false)`.
- verify: A and C red on `ae4b65b`; B green throughout, which is what keeps the fix honest.
- cross: @security, @billing-integrity
- effort: M

### [P2] `firebase-auth.ts` has no test directory at all — the invite-claim path and the query-string token path are both unasserted
- id: test-006
- location: podcast-saas/backend-api/src/middleware/firebase-auth.ts:77
- category: test
- confidence: high
- status: confirmed
- what: `src/middleware/__tests__/` **does not exist**. Nine controller suites reference
  `firebase-auth`, and in all nine it is `vi.mock`ed into a two-line stub that stamps
  `req.dbUser = { id: 'user-1', … }` and calls `done()` — e.g.
  `simulations.replace.test.ts:83-88`. The middleware's own logic — token extraction, verification,
  user upsert, pending-invite claiming — is never executed by any test in the repo.
- why: `security-001` (P1, confirmed) is that a pending collaborator invite is claimed on email match
  with **`email_verified` never checked**, so anyone who signs up with the invitee's address inherits
  their access. `security-004` (P2) is that ID tokens are accepted from the query string on every
  authenticated route. Both live in code that no test loads. The nine mocks are not wrong — a
  controller test *should* stub auth — but they create the appearance of auth coverage across 9 files
  while the middleware itself has zero.
- evidence: `ls src/middleware/__tests__` → `No such file or directory`.
  `grep -rl firebase-auth --include="*.test.ts" src` → 9 controller files, all `vi.mock` stubs.
- fix: New file `podcast-saas/backend-api/src/middleware/__tests__/firebaseAuth.inviteClaim.test.ts`
  with `firebase-admin` mocked. **Scenario (red today):** `verifyIdToken` resolves a decoded token
  for `victim@example.com` with **`email_verified: false`**; the `users` table has a pending
  collaborator invite for that address. Run the middleware. **Assertion:** the invite is **not**
  claimed — `expect(mockUpdate).not.toHaveBeenCalled()` on the collaborators table — and the request
  either 403s or proceeds as an unlinked user. **Positive control:** the identical fixture with
  `email_verified: true` **does** claim the invite, so the guard cannot be implemented by disabling
  invite claiming. **Second file, `firebaseAuth.tokenSource.test.ts` (`security-004`):** a request
  carrying a valid token **only** in `?token=` is rejected with 401 while the same token in
  `Authorization: Bearer` succeeds.
- verify: both negative cases red on `ae4b65b`, both positive controls green throughout.
- cross: @security
- effort: M

### [P2] `localCaptureProvider.ts` is wired into the job registry with zero tests, while its sibling shipped with a full suite on the same branch
- id: test-007
- location: podcast-saas/backend-api/src/services/export/capture/localCaptureProvider.ts:309
- category: test
- confidence: high
- status: confirmed
- what: `localCaptureProvider.ts` is 330 lines, untracked (`??` in `git status`), and imported by
  `podcast-saas/backend-api/src/queue/registry.ts:14` — the one tracked file modified in the working
  tree. The registry change makes it **take precedence** over the tested path:
  `resolveLocalCaptureProvider() ?? resolveConfiguredCaptureProvider()` (registry.ts:44).
  `grep -rl localCaptureProvider --include="*.test.ts" src` → **no matches**. Its sibling
  `capture/isolation/containerCaptureProvider.ts` landed on this same branch **with** a 10.8 KB test
  file (`isolation/__tests__/containerCaptureProvider.test.ts`), so the gap is not a house style —
  it is one file that skipped the bar.
- why: Three confirmed P2s from `media-pipeline` all live in this untested file: `media-004`
  (returns `gate: 'passed'` at line 309 without ever running the sanity gate — a capture that
  produced garbage frames is reported as verified), `media-005` (its ffmpeg spawn bypasses the global
  `ffmpegLimit` concurrency cap), `media-006` (leaks its output directory on every success). Each is
  the kind of defect a 20-line unit test pins permanently, and the surrounding `capture/__tests__/`
  directory already has the fixtures — `sanityGate.test.ts` sits right there.
- evidence: `wc -l` = 330; the grep above; read `registry.ts` diff and lines 309/314 of the provider.
- fix: New file `podcast-saas/backend-api/src/services/export/capture/__tests__/localCaptureProvider.test.ts`.
  **(a) `media-004`:** stub the frame source to emit frames that fail the sanity gate (all-black, or
  fewer than the expected count) and assert the returned object is
  `expect(result.gate).toBe('failed')` with a non-empty `reason` — today line 309 returns
  `gate: 'passed'` unconditionally on the success path, so this is red. **(b) `media-005`:** spy on
  the `ffmpegLimit` semaphore and assert `expect(acquire).toHaveBeenCalledTimes(1)` before the spawn.
  **(c) `media-006`:** after a **successful** capture, assert the output directory no longer exists —
  `expect(existsSync(outDir)).toBe(false)` — mirroring the cleanup assertion the container suite
  already makes. **(d) The registry precedence, which nothing covers:** assert that with
  `EXPORT_CAPTURE_LOCAL` unset, `resolveLocalCaptureProvider()` returns `null` so the container
  provider wins — the dev-only overlay must not be reachable in a production container.
- verify: (a) and (c) red on the current working tree; (d) green today and guards the seam.
- cross: @media-pipeline
- effort: M

### [P2] The only suite that runs real ffmpeg over the export assembly is opt-in behind an env var nothing sets
- id: test-008
- location: podcast-saas/backend-api/src/services/export/__tests__/linearAssembler.realEncode.test.ts:42
- category: test
- confidence: high
- status: confirmed
- what: Two suites are env-gated off by default and they are the repo's only end-to-end media
  verification: `linearAssembler.realEncode.test.ts:42` (`EXPORT_REAL_ENCODE === '1'`, applied via
  `describe.runIf(ENABLED)` at line 210) and
  `capture/__tests__/playwrightScreenshotBackend.realCapture.test.ts:39-40`
  (`CAPTURE_REAL === '1'`, applied via `const D = ENABLED ? describe : describe.skip`). Grepped both
  variable names across every `.yml`, `.sh`, `.json` and `.ts` outside those two files → **the only
  occurrences are the files themselves and their own doc comments**. Nothing in
  `.github/workflows/`, nothing in `deploy/scripts/release-verify.sh`, no package script. These are
  the 2 skipped files / 13 skipped tests in my targeted run.
- why: `release-verify.sh:105` is a bare `pnpm -r test`, so CI encodes and probes nothing. The
  export path is the branch under review, and its behaviour against real ffmpeg — progress
  monotonicity, `amix normalize=0`, faststart, anamorphic handling — is verified only when a
  developer remembers a magic env var. That is a suite that exists but never runs, which per the role
  brief provides no signal. It also means `media-001` cannot be caught in CI even if the test for it
  were written into this file.
- evidence: the repo-wide grep for `EXPORT_REAL_ENCODE|CAPTURE_REAL` (10 hits, all inside the two
  test files); `sed -n '105p' deploy/scripts/release-verify.sh` → `pnpm -r test`; my run's tally line
  `Test Files 27 passed | 2 skipped`.
- fix: Add one CI job that sets `EXPORT_REAL_ENCODE=1` with ffmpeg installed
  (`apt-get install -y ffmpeg` or the same static build the backend image pins) and runs **only**
  `vitest run src/services/export/__tests__/linearAssembler.realEncode.test.ts`. Keep `CAPTURE_REAL`
  opt-in — it needs a browser download and belongs on a schedule, not a PR — but make its skip
  **visible**: replace `describe.skip` with `describe.todo` or emit a warning line, so a reader of CI
  output can tell the difference between "passed" and "never attempted". Leaving the gate is
  defensible; leaving it silent is not.
- verify: the new job is red if ffmpeg is missing (it must not silently skip) and green with ffmpeg
  present.
- cross: @media-pipeline, @config-deploy
- effort: M

### [P2] `media-001` has no test even in the suite designed for it — the silent source appears only on the timeline, never in the mix
- id: test-009
- location: podcast-saas/backend-api/src/services/export/exportPlan.ts:233
- category: test
- confidence: high
- status: confirmed
- what: `exportPlan.test.ts` is 26 KB and 24 `it`s covering timeline resolution, the RAW predicate,
  post-roll, branching, the identity snapshot and out-of-scope warnings. **None of them exercises an
  audio-less source.** The one no-audio fixture in the repo is the 25fps silent capture at
  `linearAssembler.realEncode.test.ts:177`, and it is placed only on the `timeline` array, never in
  `audio` (fixture block at 131-155) — plus that whole suite is gated off (`test-008`).
- why: `media-001` (P1, confirmed): `buildExportPlan` pushes an audio window for **every** main video
  with a duration and a storage key, unchecked, so a screen recording with no mic track makes ffmpeg
  refuse the mix graph and the export fails permanently with `code: 'unknown', retryable: true` — a
  project that can never be exported and an error message pointing nowhere near the cause. The plan
  builder is pure and fully mockable; this is a cheap test that does not exist.
- evidence: `grep -n "describe(\|it(" src/services/export/__tests__/exportPlan.test.ts` (24 tests,
  none about audio presence); `grep -rn "silent\|hasAudio\|audioStream" src/services/export/**/*.test.ts`
  → hits only in the gated realEncode suite and a b-roll volume test.
- fix: One new `it` in the existing `describe('buildExportPlan — timeline resolution …')` block of
  `podcast-saas/backend-api/src/services/export/__tests__/exportPlan.test.ts`. **Scenario:** two main
  videos, the second seeded with the no-audio marker the fix introduces (a `has_audio: false` column,
  or the probe result the assembler-side fix consults). **Assertion:** the returned plan's `audio`
  array contains a window for the first video and **not** the second —
  `expect(plan.audio.map(w => w.storageKey)).toEqual([mainA.storage_key])` — **and** the omission is
  loud: `expect(plan.warnings).toContainEqual(expect.objectContaining({ message: expect.stringContaining('no audio track') }))`.
  The warning assertion is the important half: this repo's own stated rule is that an exclusion is
  never silent (see the RAW-section test at line 331), and a fix that just drops the window would
  violate it.
- verify: red on `ae4b65b` (the window is pushed unconditionally), green after `media-001` is fixed.
- cross: @media-pipeline
- effort: S

### [P2] The queue suite tests the driver seam but never re-delivery, so no test can catch a duplicate-work defect
- id: test-010
- location: podcast-saas/backend-api/src/queue/__tests__/pgBossDriver.test.ts:80
- category: test
- confidence: high
- status: confirmed
- what: `src/queue/__tests__/` has 3 files and they do cover the *driver seam* honestly — inline
  swallows a rejected handler (`inlineDriver.test.ts:46`), the pg-boss send falls back inline when
  it rejects (`pgBossDriver.test.ts:35`), and a handler rejection propagates so pg-boss can retry
  (`pgBossDriver.test.ts:80`). What is absent is everything **downstream of a retry**: no test
  delivers the same job twice, no test asserts a claim is taken before work begins, and no test
  reaches a dead-letter queue. Same for `src/jobs/__tests__/videoGenerateQueue.test.ts`, whose two
  tests are purely about the concurrency semaphore (max 2 in flight, slot released on rejection).
- why: `job-queue-001` (P1, confirmed): `video_generate` has **no CAS claim** and startup recovery
  re-enqueues live jobs, duplicating B-roll clips, `video_files` rows and storage objects.
  `pgBossDriver.test.ts:80` proves the retry *happens*; nothing proves the retry is *safe*. That is
  the exact shape of a suite that looks like queue coverage and cannot catch the queue's worst bug.
  `job-queue-003` (P1) and `job-queue-004` (P2) — `QUEUE_OPTIONS` never reaching an existing queue,
  and dead-letter queues nothing consumes — are likewise untested.
- evidence: read all 3 queue test files and `videoGenerateQueue.test.ts` in full;
  `grep -rn "idempot\|dead" src/queue/__tests__/*.ts` → no matches.
- fix: New file `podcast-saas/backend-api/src/jobs/__tests__/videoGenerate.idempotency.test.ts`.
  **Scenario:** invoke the `video_generate` handler **twice** with the identical `{ jobId }` payload,
  as pg-boss does after a visibility-timeout expiry, against a mocked db whose job row is already
  `status: 'running'` with a non-null `external_task_id`. **Assertion:** the provider is called once
  and only once — `expect(mockProviderSubmit).toHaveBeenCalledTimes(1)` — **and** no second
  `video_files` row is inserted: `expect(mockInsert).toHaveBeenCalledTimes(1)`. Red today (no claim
  exists, so both invocations proceed). **Second scenario for `job-queue-003`, in
  `queue/__tests__/pgBoss.test.ts` (new):** call the queue bootstrap twice and assert that the second
  call reconciles options on the existing queue — `expect(mockUpdateQueue).toHaveBeenCalledWith('crop', expect.objectContaining({ retryLimit: … }))`
  — which is red because `updateQueue` is never called at all.
- verify: both red on `ae4b65b`; the idempotency test stays red until a CAS claim lands, which is the
  point of writing it now.
- cross: @job-queue
- effort: M

### [P2] `memoryToken` is well tested on the wrong half — the secret *resolution* that silently reuses `DATABASE_URL` is untested
- id: test-011
- location: podcast-saas/backend-api/src/services/avatar/memoryToken.ts:19
- category: test
- confidence: high
- status: confirmed
- what: `memoryToken.test.ts` has 6 solid tests — round-trip, forged secret, tampered body, tampered
  signature, expiry, malformed input. Every one of them calls `signMemoryTokenWith` /
  `verifyMemoryTokenWith`, the pure variants that take the secret **as an argument**. The exported
  wrappers `signMemoryToken` / `verifyMemoryToken` (lines 55-59) and the `resolveSecret()` they call
  (line 19-21) have **no test**.
- why: `config-deploy-003` (P1, confirmed): `resolveSecret()` is
  `AVATAR_MEMORY_SECRET || DATABASE_URL || 'insecure-dev-only-secret'`, `AVATAR_MEMORY_SECRET` is
  undocumented in `.env.example`, so in practice production HMACs capability tokens with the
  **database connection string** — and in any environment where `DATABASE_URL` is also unset, with a
  hardcoded literal that is in the repo. The suite's shape makes this maximally invisible: it looks
  like thorough crypto coverage, and the untested three lines are the only ones that decide what key
  is actually used. This is the general pattern worth naming — testing the pure function and
  skipping the resolver.
- evidence: read `memoryToken.ts` (59 lines) and `memoryToken.test.ts` (43 lines) in full; every test
  uses the `…With` variants and the literal `SECRET = 'test-secret-abc'`.
- fix: Add a `describe('resolveSecret')` block to the existing
  `podcast-saas/backend-api/src/services/avatar/__tests__/memoryToken.test.ts`. **Three cases, using
  `vi.stubEnv`.** (1) `AVATAR_MEMORY_SECRET` set → a token signed by `signMemoryToken()` verifies
  under `verifyMemoryTokenWith(process.env.AVATAR_MEMORY_SECRET!, …)` and **fails** under
  `verifyMemoryTokenWith(process.env.DATABASE_URL!, …)`. (2) **The regression that matters:**
  `AVATAR_MEMORY_SECRET` unset with `DATABASE_URL` set → assert the module **throws at
  resolution** rather than falling back — `expect(() => signMemoryToken('p','s')).toThrow(/AVATAR_MEMORY_SECRET/)`.
  Red today (it silently succeeds using the DB URL). (3) Both unset in `NODE_ENV=production` → also
  throws, so the `'insecure-dev-only-secret'` literal can never reach production. Never print the
  resolved value in an assertion message.
- verify: (2) and (3) red on `ae4b65b`; (1) green throughout.
- cross: @config-deploy, @security
- effort: S

### [P2] Coverage is configured but unenforced, and its lens excludes every controller, route and middleware
- id: test-012
- location: podcast-saas/backend-api/vitest.config.ts:46
- category: test
- confidence: high
- status: confirmed
- what: The `coverage` block sets `provider: 'v8'` and `include: ['src/services/**/*.ts']` with
  `exclude: ['src/db/**']` (lines 46-50). There is **no `thresholds`** key, so no coverage number can
  ever fail a run, and no CI step invokes `--coverage` at all (`release-verify.sh:105` is a bare
  `pnpm -r test`). Because `include` is an allowlist scoped to `src/services/**`, everything under
  `src/controllers/**` (27 public + 7 admin route files), `src/middleware/**`, `src/queue/**`,
  `src/jobs/**` and `src/lib/**` is **outside the measurement entirely** — a coverage report run
  today would show nothing at all about the HTTP surface.
- why: This is the mechanism behind several findings above rather than a separate defect: `test-005`
  (no `mediaAccess` test) would surface as an uncovered file, but `test-006` (no middleware test) and
  `test-004` (no webhook test) would not even appear as gaps, because those directories are not in
  the lens. A coverage config that cannot report on the auth middleware or the money endpoint is
  reporting on the wrong thing.
- evidence: read `vitest.config.ts:46-50`; `grep -rn "coverage" .github/workflows/ deploy/scripts/` →
  no `--coverage` invocation anywhere.
- fix: Two edits, both small. (a) Widen `include` to `['src/**/*.ts']` and move the intentional
  omissions into `exclude` (`src/db/migrations/**`, `src/_archive/**`, `src/scripts/**`), so the
  default is "measured" and each exemption is a deliberate line. (b) Add a `thresholds` block pinned
  at **today's actual numbers, not aspirational ones** — run `vitest run --coverage` once, read the
  totals, set `lines`/`functions`/`branches` two points below them, and add `--coverage` to
  `release-verify.sh:105`. A ratchet at the current level costs nothing and makes a coverage
  *regression* fail CI, which is the only coverage rule worth having.
- verify: `pnpm -C podcast-saas --filter backend-api test -- --coverage` reports on controllers and
  middleware after (a), and fails if a PR deletes a tested file's tests after (b).
- cross: @config-deploy
- effort: S

### [P2] Eight of nine Playwright configs run nowhere, and the ninth is a two-spec liveness probe — no browser test gates any PR
- id: test-013
- location: podcast-saas/client-web/playwright.config.ts:16
- category: test
- confidence: high
- status: confirmed
- what: I read all 9 configs. Seven pin a single spec each via `testMatch`
  (`canary`→`sim-canary.spec.ts`, `leak`→`sim-leak.spec.ts`, `protocol`→`sim-protocol.spec.ts`,
  `transport`→`sim-transport.spec.ts`, `sim`→`sim-transitions.spec.ts`,
  `rebuilt`→`rebuilt-packages.spec.ts`, `viewer`→`viewer-e2e.spec.ts`), each across
  chromium+firefox+webkit. The default `playwright.config.ts` has `testDir: './e2e'` and **no
  `testMatch`**, so it collects all 11 specs on 3 engines. `playwright.production.config.ts`
  allowlists exactly two (`production-audit.spec.ts`, `production-smoke.spec.ts`) on chromium only.
  **Only the production config is ever executed** — in `release.yml:436`, `rollback.yml:166`,
  `production-audit.yml:170,229`, all post-deploy against the live site. `ci.yml` runs neither.
  Adding to what `config-deploy-006` established: **`sim-perf.spec.ts` and `sim-pool.spec.ts` have no
  dedicated config at all**, so their only path to execution is the default config, which nothing
  invokes — they are the two specs furthest from any runner.
- why: Nine suites of three-engine browser coverage — protocol conformance, cross-cycle leak
  detection, transport handling, transition timing, rebuilt-package parity, viewer e2e — produce
  **zero signal on every PR**. This is not a gap in coverage; it is coverage that exists, cost real
  effort to write, and is indistinguishable from deleted. Concretely against this run:
  `simulation-005` (P2, the v2 window listener verifies no origin) is exactly what
  `sim-protocol.spec.ts` is shaped to catch, and it shipped. The one config that does run is a
  liveness probe against production — by design (its header comment is explicit and correct about
  why) — so it verifies the site is up, not that the sim runtime is right.
- evidence: read all 9 config files; `ls e2e/` (11 specs + 3 helpers); the workflow greps above;
  `client-web/package.json` → `test: vitest run`, `test:smoke: playwright test` (the default config,
  invoked by nothing).
- fix: This is a triage decision, and the honest first step is to **classify, not to wire everything
  up**. For each of the 7 pinned suites, decide: does it need real infra (a database, a built
  `shared/dist`, a running backend)? Those that do not — `sim-protocol`, `sim-transport`,
  `sim-transitions` are the candidates, since they drive the runtime through fixtures — go into
  `ci.yml` on chromium only, as one job, on PRs touching `client-web/**` or `shared/src/sim/**`.
  Those that do (`sim-leak` at 30-minute timeouts, `rebuilt-packages` which needs `REBUILT_DIR`,
  `viewer-e2e`) go into a nightly scheduled workflow. Anything nobody will own in either bucket
  should be **deleted**, and deleting it is a better outcome than leaving it, because it stops
  advertising coverage that does not exist. Also give `sim-perf.spec.ts` and `sim-pool.spec.ts` an
  explicit config or fold them into an existing one, so no spec is reachable only through a config
  nothing runs.
- verify: after the change, `grep -c "playwright test --config" .github/workflows/*.yml` is greater
  than the current production-only count, and every config file under `client-web/` is named by at
  least one workflow or is gone.
- cross: @config-deploy (who owns `.github/workflows/**` and filed the CI-side fact as
  `config-deploy-006`; this finding is the suite-health half)
- effort: M

### [P3] A blanket 60 s test and hook timeout, raised twice under load, now hides genuine hangs
- id: test-014
- location: podcast-saas/backend-api/vitest.config.ts:38
- category: test
- confidence: high
- status: confirmed
- what: `testTimeout: 60_000` and `hookTimeout: 60_000` apply to **every** test in the backend suite.
  The config's own comment documents the escalation honestly: the default 5 s was raised to 30 s
  because PGlite boots a WASM Postgres per file and replays migrations, then 30 s → 60 s after the
  linear-export and sim-capture PGlite suites landed and "18 hooks timed out … under
  `release:verify`, which runs every workspace's suite concurrently".
- why: The diagnosis is right and the mitigation is the bluntest available. 18 PGlite-booting files
  need a long **hook** budget; the other ~110 files, which are pure and mock everything, now also get
  60 s. A test that deadlocks on an unresolved promise — the failure mode most likely in the async
  export and queue code under review — costs a full minute before reporting, and a genuine
  performance regression in a pure function has 60 s of headroom before anything notices. The comment
  also predicts its own next step: the number "simply grew with the suite" and will grow again.
- evidence: read `vitest.config.ts:26-45` including the full comment; the 21.9 s duration of my
  27-file targeted run against a 60 s per-test budget shows the ratio.
- fix: Return the global to something tight (`testTimeout: 10_000`) and give the long budget only to
  the files that need it, via `describe`-level or file-level overrides in the ~18 PGlite suites —
  `describe('…', { timeout: 60_000 }, () => {…})`, or a `beforeAll(async () => {…}, 60_000)` on the
  boot hook specifically. That way the DB boot keeps its headroom and a hung unit test fails in ten
  seconds. Better still, hoist the PGlite boot into a shared setup file so the migrations replay once
  per worker rather than once per file, which removes the pressure that caused both raises.
- verify: full suite stays green; a deliberately hung pure test fails in ~10 s rather than ~60 s.
- cross: @performance
- effort: M
