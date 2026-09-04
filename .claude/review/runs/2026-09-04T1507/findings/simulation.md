# simulation-reviewer — heavy 3D package readiness review

Run: 2026-09-04T1507 (no OUTPUT_DIR was handed to me; I created this run directory and am saying so
rather than writing into an existing run I would have had to guess).

Scope of this pass: the five risk areas named in the brief, read against the simulation subsystem,
the storage adapters, the export capture path and the viewer pool. Nothing was executed; no
Playwright suite was run; no database was touched.

Two scope notes before the findings:

- **`SimBridgeContract.ts` is not the postMessage protocol.** My standing brief says to read it
  first and write down the message table. It is the *replace-compatibility* checker (static anchor
  resolution for "Replace simulation"). The wire protocol lives in `shared/src/sim/*` +
  `services/simulation/simRuntimeChild.ts` + `client-web/lib/sim/SimRuntimeClient.ts`. Filed as
  `simulation-013` (`fleet`).
- **Production is Supabase today; R2 is the staged cutover** (`getStorageAdapter.ts:80` — "the
  cutover window (owner ruling 2026-09-03, staged R2)"). Several findings below are latent on
  Supabase and become live the moment `STORAGE_BACKEND` names r2 as primary. That is exactly the
  window the heavy package is landing in.

---

### [P0] R2 serves simulations straight from the bucket, bypassing /sim-public — no boot snippet, no CSP, no publication gate
- id: simulation-001
- location: podcast-saas/backend-api/src/services/storage/R2StorageAdapter.ts:335
- category: security
- confidence: high
- status: confirmed
- what: `R2StorageAdapter.getSimPublicUrl()` returns `` `${this.publicUrl}/${path}` `` — the raw R2
  public bucket URL. `LocalStorageAdapter.getSimPublicUrl` (`LocalStorageAdapter.ts:162`) and
  `SupabaseStorageAdapter.getSimPublicUrl` (`SupabaseStorageAdapter.ts:437-451`) both return
  `` `${serveBase()}/sim-public/${path}` ``. `MigratingStorageAdapter.getSimPublicUrl`
  (`MigratingStorageAdapter.ts:118`) delegates to the primary, so `STORAGE_BACKEND=migrating` with
  `STORAGE_PRIMARY=r2` inherits the bucket URL too.
- why: Everything `/sim-public/*` does at SERVE time is lost for every sim under R2:
  * `injectSimBootSnippet` (`sim-public.controller.ts:125`) — the `#simboot` minimal-UI cloak, the
    `clearBootHide` listener, the authoring `CONNECT` hook, and the `SIM_PAINTED_FALLBACK`. The
    controller's own comment (lines 55-58) states these live at serve time *precisely so* they reach
    every stored package without republication. Under R2 they reach none.
  * the sim CSP (`sim-public.controller.ts:302-313`) — `frame-ancestors` is the whole of
    security-003's ambient lockdown. A bucket URL carries no CSP, so any page on the internet can
    frame a customer's simulation.
  * `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy`.
  * **the publication gate.** `sim-public.controller.ts:266-275` 404s a revision whose status is not
    in `PUBLICLY_SERVED_STATUSES` (`revisionIdentity.ts:72`) — the simulation-007 fix for
    draft/uploading/validating/failed revisions being world-readable. A raw bucket URL has no gate,
    and revision ids are public (they appear inside `simulation_url` in every player config —
    `SimulationService.ts:243`), so an aborted publication's bytes are readable by anyone who has
    seen any player config for that package. `RevisionService.gc()` still has no production caller,
    so those objects live forever.
- evidence: Read all four adapters' `getSimPublicUrl`. `sim-public.controller.ts` is the only place
  the snippet, the CSP and the status gate are applied; nothing in `R2StorageAdapter` reproduces
  them. `getStorageAdapter.ts:83-89,126-136` show `migrating`/`r2` both reachable from env alone.
  Commit `7231bb7` states outright: "production really does proxy sims through /sim-public/*
  (Supabase's public bucket force-downgrades text/html → text/plain, so the adapter routes through
  the backend)" — i.e. the proxy is load-bearing today and is what R2 removes.
- fix: Make `R2StorageAdapter.getSimPublicUrl` return `` `${publicApiOrigin()}/sim-public/${path}` ``,
  like the other two adapters, and let the existing binary-redirect branch in the controller hand
  the 302 to the CDN (after fixing `simulation-002`). If direct-bucket serving is wanted for the
  bandwidth, it must first reproduce all four capabilities at the edge (a Cloudflare Worker that
  injects the snippet and headers and consults the revision status), which is a much larger change
  than flipping an env var.
- verify: add a test asserting all three adapters' `getSimPublicUrl` contain `/sim-public/`; then
  `pnpm -C podcast-saas --filter backend-api test`. Manually: with `STORAGE_BACKEND=r2`, request a
  `draft` revision's entry key at the bucket URL and confirm it is refused.
- cross: @security-reviewer @config-deploy-reviewer
- effort: M

---

### [P1] Under R2 the sim-public binary redirect points at /hls-proxy, which 403s a `simulations/` key — every .glb 30MB asset fails
- id: simulation-002
- location: podcast-saas/backend-api/src/controllers/sim-public.controller.ts:374
- category: bug
- confidence: high
- status: confirmed
- what: The binary branch does `reply.redirect(storage.getPublicUrl(await resolveSimFileKey(key)), 302)`
  — `getPublicUrl`, not `getSimPublicUrl`. `R2StorageAdapter.getPublicUrl` (`R2StorageAdapter.ts:325-333`)
  returns `` `${backendUrl}/hls-proxy/${path}` `` for any key that does not start `hls/`. The
  `/hls-proxy/*` handler (`server.ts:367`) calls
  `authorizeMediaRequest(request, reply, key, 'hls/')`, whose prefix scope is `hls/`.
- why: The comment three lines above (`sim-public.controller.ts:361-364`) claims "Binary assets
  redirect to the bucket CDN … rather than serializing through this proxy (one full readObject per
  request), which made image-heavy sims crawl." Under R2 that is false in both halves: the redirect
  goes back to our own backend, and the scope check refuses it. For the molecular-motor package this
  is 29.7 MB (kinesin) + 5.5 MB (dynein) + 0.57 MB (microtubule) of `.glb` — `getSimulationContentType`
  maps `glb → model/gltf-binary` (`SimulationService.ts:183`), which is not in `PROXIED_TEXT_EXTS`
  (`sim-public.controller.ts:25`), so all three take this branch. Every legacy `simulation_url`
  already stored as `…/sim-public/…` (every row written in the Supabase era) keeps hitting this route
  after the cutover, so this is not hypothetical even if `simulation-001` is fixed by routing new
  URLs elsewhere. Secondary: if the scope check were widened, `/hls-proxy` labels every non-`.m3u8`
  body `Content-Type: video/mp2t` (`server.ts:379-381`) and supports no Range.
- evidence: Read `R2StorageAdapter.getPublicUrl` (325), `server.ts:364-420`, `mediaAccess.ts:97-102`
  (`mediaKeyScope(key)`; scope prefix is passed as `'hls/'` at `server.ts:367`).
  `hlsProxyUpstream.ts:12-14` documents that `getPublicUrl` for R2 deliberately routes back through
  the proxy — so this is the adapter behaving as designed, being called by the wrong caller.
- fix: In the binary branch, call `storage.getSimPublicUrl(...)` — or better, add an explicit
  `getSimAssetUrl(key)` to `StorageService` that each adapter implements as "the CDN URL for a sim
  binary", so the sim path never borrows the HLS URL builder.
- verify: unit test the binary branch with a fake R2 adapter and assert the redirect target does not
  contain `/hls-proxy/`. `pnpm -C podcast-saas --filter backend-api test`.
- effort: S

---

### [P1] The 5s prepare bound is a shared constant; a 29.7 MB model cannot make it, and three failures open the breaker for the session
- id: simulation-003
- location: podcast-saas/shared/src/sim/simFailurePolicy.ts:182
- category: bug
- confidence: high
- status: confirmed
- what: `SIM_PREPARE_TIMEOUT_MS = 5_000` is a module constant. `SimRuntimeClient.sendPrepare` arms it
  unconditionally (`client-web/lib/sim/SimRuntimeClient.ts:1495-1499`) and calls
  `failModern('prepare-timeout', …)` on expiry. The child awaits the section body's `prepare()`
  before posting `SECTION_APPLIED` (`simRuntimeChild.ts:832-836`), and a three.js package loads its
  GLB inside exactly that call. `prepare_budget_ms` — the only per-package number the system has —
  is *not* this bound; it is the residency LEAD WINDOW (`occurrencePlanner.ts:144-146`).
- why: The brief's own measurement is ~6 s to fetch the 29.7 MB kinesin model at 40 Mbps. That is a
  deterministic timeout on a healthy connection. `failModern` then calls `recordFailure`
  (`SimRuntimeClient.ts:1547`), and `SIM_BREAKER_THRESHOLD = 3` (`simFailurePolicy.ts:151`) opens the
  breaker, after which automatic preparation stops for that package **for the whole session** —
  three sections of one video are enough. The user sees a recovery surface, never the simulation.
  The file's own header (lines 175-179) calls these "FAILURE bounds, not reveal timers", which is
  correct and is why there is no force-reveal escape: the package simply fails.
- evidence: Read `simFailurePolicy.ts:150-204` and `SimRuntimeClient.ts:1486-1549`.
  `grep -rn "SIM_PREPARE_TIMEOUT_MS" client-web shared` shows no per-package override anywhere —
  only the constant, the e2e specs, and the one `setTimeout`.
- fix: Make the prepare bound per-package: `max(SIM_PREPARE_TIMEOUT_MS, simulations.prepare_budget_ms
  × safety)`, or a new `sim_revisions.metadata.weight.totalBytes`-derived floor, plumbed through
  `buildPlayerConfig` beside `sim_prepare_budget_ms` (`buildPlayerConfig.ts:1112`). The cheapest
  correct version: pass a `prepareTimeoutMs` into `SimRuntimeClient` per package and default it to
  the constant.
- verify: a unit test that constructs a `SimRuntimeClient` for a package with
  `prepare_budget_ms = 9000` and asserts the armed timer exceeds 5 000 ms. Red before, green after.
- cross: @frontend-reviewer
- effort: M

---

### [P1] Nothing feeds package weight into pool tier, residency capacity or prepare budget — the tier is decided by device alone
- id: simulation-004
- location: podcast-saas/client-web/components/viewer/useProjectPlayer.ts:462
- category: perf
- confidence: high
- status: confirmed
- what: `poolTierRef.current = simPoolModeRef.current === 'single' ? 'single' : canWarmUnpaused() ? 'all' : 'window'`.
  `canWarmUnpaused()` (`client-web/lib/simCapability.ts:12-32`) reads only `saveData`,
  `deviceMemory`, `hardwareConcurrency` and `(pointer: coarse)`. At tier `all`,
  `collectSimPool(config, SIM_POOL_CAP)` mounts up to `SIM_POOL_CAP = 4` (`lib/simPool.ts:25`)
  distinct packages up front, and `planResidency` runs with `capacity: 4`
  (`useProjectPlayer.ts:3108`). **Package bytes are not an input to any of these decisions.**
- why: `analyzeWeight` exists, is measured from the manifest, and is *recorded* — `RevisionService.ts:475`
  writes `{ totalBytes, fileCount, byCategory, largest, findings }` into `sim_revisions.metadata.weight`.
  Its only two readers in the entire repo are `RevisionService.compareWeight` (an operator report,
  line 931) and `scripts/sim-weight-report.ts`. `grep -rn "analyzeWeight\|totalBytes" backend-api/src
  shared/src client-web` finds no path from that number to `buildPlayerConfig`, to
  `prepare_budget_ms`, to `SIM_POOL_CAP`, or to the tier. So a Chrome desktop reporting 8 GB and
  8 cores gets tier `all` and mounts 4 × 35 MB = 140 MB of package downloads at t=0, contending with
  the HLS video that is also starting, plus four live WebGL contexts each holding the kinesin mesh's
  183 morph-target channels. The `lowend` / `dpr` / `mem` hints (`shared/src/sim/simUrl.ts`, exercised
  by `client-web/lib/simUrl.test.ts:83-110`) are stamped into the sim URL for the *package* to read —
  they do not influence our own residency at all.
- evidence: Read `useProjectPlayer.ts:444-481` and `3100-3160`, `lib/simPool.ts:25,180-193`,
  `lib/simCapability.ts`, `shared/src/sim/packageWeight.ts` (whole file), `RevisionService.ts:460-495,915-940`.
- fix: (a) plumb `sim_revisions.metadata.weight.totalBytes` onto the player config beside
  `sim_prepare_budget_ms` (`buildPlayerConfig.ts:104,117,1112` is the existing seam — a scalar per
  simulation, no jsonb on the hot path); (b) in `useProjectPlayer.ts:479`, compute the initial pool
  cap as a *byte budget* (e.g. admit packages in due order until the cumulative weight exceeds a cap
  that is itself a function of `deviceMemory`) rather than a fixed count; (c) demote tier `all` to
  `window` when any single package exceeds a threshold. Note `packageWeight.categorize`
  (`packageWeight.ts:27-43`) has no `glb`/`gltf`/`bin` case, so 35.8 MB of models is reported as
  `other` — add a `model` category so the report is legible before it is load-bearing.
- verify: unit-test the new cap function (heavy package ⇒ 1 admitted, light packages ⇒ 4); assert
  `buildPlayerConfig` emits the weight scalar. `pnpm -C podcast-saas --filter client-web test`.
- cross: @performance-reviewer @frontend-reviewer
- effort: L

---

### [P1] `sim_revisions.metadata` is queried with `jsonb - text` with no `jsonb_typeof` guard — a scalar row makes every project duplication throw
- id: simulation-005
- location: podcast-saas/backend-api/src/services/project/ProjectDuplicationService.ts:2170
- category: data-integrity
- confidence: high
- status: confirmed
- what: `jsonbScanExpression()` returns ``sql`(COALESCE(${col}, '{}'::jsonb) - 'duplicatedFrom')` `` for
  `sim_revisions.metadata`, unconditionally. It is used inside the escape scan at line 1679-1681,
  whose failure raises `ESCAPE_SCAN_PREFIX` and aborts the duplication (line 1686). The mirror copy
  in `scripts/diagnose-duplication.ts:1157-1161` is identical and equally unguarded — while
  `residualExpression`, forty lines below it in the same file, guards **every** case on
  `jsonb_typeof` and its own comment (`diagnose-duplication.ts:1175-1177`) says exactly why:
  "`jsonb - text` … raise `cannot delete from scalar` (SQLSTATE 22023) on a scalar or an array,
  which would take down the entire diagnosis — on the exact odd data that most deserves diagnosing."
- why: You verified that `timeline_sections.sim_meta` rows are stored as jsonb **string scalars**
  (`jsonb_object_keys` fails, `#>> '{}'` parses). `sim_revisions.metadata` is written by exactly the
  same writer class — `RevisionService.transition({ metadata: {...} })` through drizzle's jsonb
  codec — so the same rows are at risk. If any one is a scalar, duplicating any project that
  contains that simulation fails with 22023, and the message will read as an escape-scan failure
  rather than as a data-shape problem.
- evidence: Read `ProjectDuplicationService.ts:1670-1688, 2168-2173` and
  `diagnose-duplication.ts:1150-1197`. The guarded/unguarded asymmetry is in the two files' own
  comments.
- fix: Wrap the `- 'duplicatedFrom'` in the same `CASE WHEN jsonb_typeof(col) = 'object' THEN … ELSE
  COALESCE(col,'{}'::jsonb) END` shape `residualExpression` already uses, in **both** copies.
- verify: a pglite test that inserts a `sim_revisions` row with `metadata = '"a string"'::jsonb` and
  runs the scan expression — red before, green after.
- cross: @database-reviewer @backend-reviewer
- effort: S

---

### [P1] `PosterService.storePoster` writes `variants` through the drizzle jsonb codec, against a CHECK that requires a jsonb array — and no test exercises that pair
- id: simulation-006
- location: podcast-saas/backend-api/src/services/simulation/PosterService.ts:167
- category: data-integrity
- confidence: medium
- status: suspected
- what: `storePoster` inserts `variants` (a `PosterVariantRecord[]`) through drizzle. Migration 049
  adds `CHECK (jsonb_typeof(variants) = 'array' AND jsonb_array_length(variants) > 0)`
  (`db/migrations/049_sim_posters.sql:39-42`). If the drizzle+postgres.js jsonb write really does
  produce a string scalar — which is what `db/jsonb.ts:5-11` documents as the reason
  `jsonbStringArray` exists, and what you verified for `sim_meta` — then this insert violates the
  constraint with SQLSTATE 23514 and **poster storage fails in production on every capture**.
- why: The poster is the export's degradation target and the player's cold cover. A poster that is
  never *stored* means every heavy-package section that misses its paint deadline gets the generic
  cover instead of the still, and every degraded export window has `posterKey: null`.
- evidence: `db/jsonb.ts:5-11` — "postgres.js JSON-re-encodes any parameter bound to a jsonb cast,
  and Drizzle's jsonb codec pre-stringifies — so passing a JS string[] to a jsonb column stores a
  doubly-encoded jsonb *string* (jsonb_typeof = 'string'), which violates
  courses_outcomes_array_chk". That is the same failure against the same kind of constraint.
  `circleFaceUrls.ts:103-123` shows production holds **both** shapes for `avatar_config` and has
  code to tolerate it, so scalars are real. **Why this is `suspected` and not `confirmed`:** the two
  tests that could have caught it cannot see it. `posterService.test.ts:1-8` fakes the database with
  an in-memory table (no DDL, no constraints), and the real-engine half at line 673-771 inserts with
  its own SQL that explicitly casts `$n::jsonb` (line 703) and passes `'[]'`/`'{}'` strings — so the
  constraint is proven, the *drizzle write path against it* never is. Nothing in the suite would go
  red if `storePoster` produced a scalar.
- fix: One command settles it: `SELECT jsonb_typeof(variants), count(*) FROM sim_posters GROUP BY 1`
  (read-only, on the production replica, by someone permitted to). If any row is `string` — or if
  the table is unexpectedly EMPTY, which is the same symptom — build the value with
  `jsonb_build_array(...)` the way `db/jsonb.ts` does, or bind `sql`${JSON.stringify(variants)}::jsonb``.
  Regardless of the answer, add a realdb test that drives `storePoster` itself against migration 049's
  DDL, so the write path and the constraint meet in a test for the first time.
- verify: new realdb test red before the change (if the defect is real), green after; the DDL test
  at line 770-771 stays green.
- cross: @database-reviewer @test-quality-reviewer
- effort: M

---

### [P1] `sim_meta.runtimeValidated` is written `false` by both generation paths and set `true` by nothing, and read by nothing
- id: simulation-007
- location: podcast-saas/backend-api/src/controllers/v1/sections.controller.ts:1124
- category: bug
- confidence: high
- status: confirmed
- what: The brief's premise is that the non-stream POST route skips a validation the stream path
  performs. It does not — **both routes call the same function.** `generateOrReuseSection`
  (`sections.controller.ts:978-1138`) is documented as "the ONE place sim-script generation decides
  what to do and persists the result — shared by every route (GET/POST stream + non-stream POST)",
  and `runSseGeneration` (line 1192) simply wraps it with SSE framing. The LLM branch stamps
  `runtimeValidated: false` at line 1124, and there is no other write.
- why: `grep -rn "runtimeValidated\|runtime_validated" podcast-saas` returns exactly four hits:
  the two `false` writes (`sections.controller.ts:1124`, `bridgePresets.controller.ts:279`), the
  optional field on the type (`shared/src/generated/client-v1.ts:720`), and a fixture that also
  writes `false` (`shared/src/__tests__/simMetaShape.test.ts:73`). **No code path anywhere sets it
  true, and no code path anywhere reads it.** The design intent is recorded in
  `md-files/PHASE0-PROOF-STATE-AND-IDEMPOTENCY.md:174` — "`sim_meta.runtimeValidated` publishes as a
  claim" — and in `.claude/review/RESEARCH-ACTION-RECORDING-2026-08-25.md:2389` ("Set
  runtimeValidated to true only …"), but the promoting half was never built. The mechanical path
  (line 1042-1054) omits the field entirely and the `canReuse` path never touches `sim_meta` at all,
  so a section can also carry a *stale* `false` from a generation two edits ago.
- evidence: the grep above; read `sections.controller.ts:968-1138` and `1146-1210` in full.
- fix: Either (a) build the promoting half — the runtime already knows: `SECTION_APPLIED` carries
  `variantKey` + `configHash` (`simRuntimeChild.ts:830`) and `SECTION_PRESENTED` carries
  `framesSubmitted` (line 860); a `POST /sections/:id/bridge-validated` that matches the stored
  `bridgeHash` and flips the flag would make it mean something — or (b) delete the field from the
  two writers and from `client-v1.ts`, because an always-false claim that nothing reads is worse than
  no claim. Do not leave it as is: `sim_revisions.proof_states` (migration 081) already covers
  adjacent ground and a second dead flag beside it invites a reader to trust one of them.
- verify: after (a), an integration test that generates a bridge, posts the validation, and asserts
  `sim_meta.runtimeValidated === true`. After (b), the grep returns zero hits outside docs.
- cross: @types-contracts-reviewer
- effort: M

---

### [P1] Container capture cannot resolve a package whose served URL is not a `/sim-public/` key — the R2 cutover silently demotes every sim export
- id: simulation-008
- location: podcast-saas/backend-api/src/services/export/capture/isolation/containerCaptureProvider.ts:89
- category: bug
- confidence: high
- status: confirmed
- what: `parseServedSimUrl` locates the marker `'/sim-public/'` in the URL's pathname and returns
  `null` when it is absent (lines 96-100). `captureSection` then throws `CaptureUnavailable`
  (line 383-386), which `ProjectExportService` treats as the poster-fallback signal
  (`captureTypes.ts:140,191`).
- why: Combined with `simulation-001`, flipping storage to R2 makes *every* sim's served URL a bucket
  URL with no `/sim-public/` segment, so container capture becomes unavailable for every section at
  once and every sim window in every export degrades to a still. The degradation is at least
  *recorded* — `ProjectExportService.ts:376-383` builds a `poster-fallback` window per section and
  line 638-642 sets `quality_state: 'degraded'` — so this is not the "silent poster" failure mode;
  it is a total, correctly-labelled loss of motion in exports, triggered by an env change.
- evidence: read `containerCaptureProvider.ts:89-101, 379-386`; `captureTypes.ts:135-195`;
  `ProjectExportService.ts:370-390, 630-645`.
- fix: Resolve the package from `simulations.active_revision_entry_key` (a storage key we already
  hold) rather than by parsing the served URL. The URL should be the fallback, not the authority —
  this is the same lesson `simulationUrlResolver.ts` records at its top for the viewer.
- verify: unit test `captureSection` against a spec whose `servedSimUrl` is a bucket URL and assert
  it still stages the package.
- cross: @media-pipeline-reviewer
- effort: M

---

### [P2] The capture staging path materialises the whole package as Buffers in the Node heap, bounded only at 256 MiB
- id: simulation-009
- location: podcast-saas/backend-api/src/services/export/capture/isolation/containerCaptureProvider.ts:124
- category: perf
- confidence: high
- status: confirmed
- what: `fetchPackageFiles` accumulates `files: CaptureInputFile[]` where each entry holds
  `content: Buffer` from `storage.readObject(key)` (line 134-139). Nothing is released until the
  array is written out. The only bound is `MAX_PACKAGE_BYTES = 256 * 1024 * 1024` (line 104), and it
  is checked *after* the read that crossed it, so peak heap is the cap plus the last object.
- why: 35 MB per capture is survivable; the exposure is that the cap and the upload limit disagree
  in a dangerous direction — `SIMULATION_UPLOAD_MAX_BYTES = 250 MB` (`simulations.controller.ts:85`)
  is *compressed*, so an accepted package can legally exceed 256 MiB uncompressed and fail capture
  at the ceiling rather than at upload, and anything under it pins that many bytes of heap per
  concurrent capture.
- evidence: read `containerCaptureProvider.ts:103-150`; `simulations.controller.ts:85`;
  `services/security/zipGuard.ts:22` documents the 250 MB compressed limit explicitly.
- fix: Stream each object to the staging directory (`storage.streamObject` already exists on the R2
  adapter — `server.ts:391` uses it) instead of buffering, and check the running total against the
  cap *before* the read using `listObjects` sizes / a `HeadObject`.
- verify: a test with a fake adapter that asserts no more than one object's bytes are live at a
  time.
- cross: @media-pipeline-reviewer @performance-reviewer
- effort: M

---

### [P2] `MAX_BUDGET_MS = 10s` caps the residency lead window, and the budget deliberately excludes document load — the one cost that dominates a 35 MB package
- id: simulation-010
- location: podcast-saas/shared/src/sim/prepareBudget.ts:41
- category: perf
- confidence: high
- status: confirmed
- what: `planResidency` uses `budgetMsFor(packageKey)` as the lead window that decides when a package
  is `due` and therefore mounted (`occurrencePlanner.ts:143-148, 186-190`). That number comes from
  `resolveBudget`, whose sources are the session p90 and `canaryReportPrepareMs`, and
  `BUDGET_STEPS = ['prepare','section-applied','present','section-presented']` explicitly excludes
  `load` and `handshake` (`prepareBudget.ts:26-35`). `MAX_BUDGET_MS = 10_000` clamps the result.
- why: The exclusion is *correct for its stated reason* — the field measurement starts inside
  `activateModern`, so including load would make the two numbers incomparable, and the file says so.
  But the consequence is that the window used to decide **when to start downloading a document**
  contains no estimate of how long downloading it takes. For a 35 MB package that is ~6 s of pure
  fetch at 40 Mbps and far more on a phone, against a lead window that will typically resolve to a
  few hundred ms (`MIN_BUDGET_MS = 250` when there is no canary) and can never exceed 10 s. The
  package is admitted far too late and its section arrives cold.
- evidence: read `prepareBudget.ts` whole; `occurrencePlanner.ts:124-190`; `useProjectPlayer.ts:3100-3120`.
- fix: Separate the two numbers instead of overloading one. Keep `prepare_budget_ms` as the
  prepare-phase budget, and add a `mountLeadMs` = `loadEstimate(weightBytes, effectiveType) +
  prepareBudget`, used only by `planResidency`'s `withinLead`. `navigator.connection.downlink` plus
  the weight scalar from `simulation-004` gives a real estimate; `MAX_BUDGET_MS` must not clamp it.
- verify: a unit test for `planResidency` showing a 35 MB package admitted materially earlier than a
  0.5 MB one at the same due time.
- cross: @performance-reviewer
- effort: M

---

### [P2] `checkReplaceCompatibility` degenerates towards "always compatible" against a minified bundle
- id: simulation-011
- location: podcast-saas/backend-api/src/services/simulation/SimBridgeContract.ts:246
- category: bug
- confidence: medium
- status: confirmed
- what: Anchor resolution is substring/word-boundary existence over a corpus built by concatenating
  every text file in the bundle (`buildSources`, lines 217-230). `hasIdentifier` is
  ``new RegExp(`\\b${name}\\b`).test(code)`` and `hasClass`/`hasId` are similarly permissive.
- why: A Vite dist build puts ~715 KB of minified JS (three.js inlined) into `sources.code`. Minified
  output is a dense field of short identifiers and string literals; the probability that an arbitrary
  ≥3-character anchor appears *somewhere* in it by coincidence is high, and every coincidence is a
  false "still present". The gate's stated design (lines 30-35) deliberately trades sensitivity for
  near-zero false blocks, which is the right trade for hand-written sims — but at this bundle size
  the sensitivity approaches zero and the gate stops being evidence for anything. That matters
  because `compatible === true` is what lets "Replace simulation" keep the existing `bridge.js`, and
  the whole failure this module exists to prevent (a section body that finds nothing and no-ops, dead
  in production with no error) returns.
- evidence: read `SimBridgeContract.ts:203-294`. The 18/18 empirical validation in the header was
  against `boids-3d` and `murmuration-knob` — unminified, hand-written packages.
- fix: Record in `sim_revisions.metadata` whether the bundle looks minified (mean line length /
  identifier entropy over the JS corpus) and, when it does, report `sectionsUnverifiable` for anchors
  that resolve *only* inside minified chunks rather than counting them as `ok`. Surface that in
  `describeIncompatibility` so the owner is told "this replacement could not be checked", which is
  the honest answer, instead of "compatible".
- verify: a test that runs `checkReplaceCompatibility` with a bundle whose JS is a minified blob not
  containing the sim's real API, and asserts the report does not claim `ok`.
- effort: M

---

### [P2] `R2_PUBLIC_BASE_URL` / `R2_PUBLIC_URL` unset silently yields root-relative sim URLs
- id: simulation-012
- location: podcast-saas/backend-api/src/services/storage/R2StorageAdapter.ts:49
- category: bug
- confidence: high
- status: confirmed
- what: `this.publicUrl = (process.env.R2_PUBLIC_BASE_URL ?? '').replace(/\/+$/,'') || this.legacyPublicUrl`,
  and `legacyPublicUrl` is itself `(process.env.R2_PUBLIC_URL ?? '')`. With neither set, `publicUrl`
  is `''`, so `getSimPublicUrl(path)` returns `/simulations/...` and `uploadFile` returns the same as
  the stored URL (line 70). The constructor throws for missing credentials (lines 38-42) but not for
  a missing public base.
- why: This is the same class as the `localhost`-baked-into-an-absolute-URL incident the release
  audit already scans for: a root-relative URL resolves against whichever origin happens to load it,
  so the entry document 404s from the app origin, and any row persisted with it is wrong forever. It
  is the highest-probability misconfiguration in the cutover the heavy package is landing in.
- evidence: read `R2StorageAdapter.ts:33-59, 62-71, 325-339`.
- fix: throw in the constructor when neither variable is set, with the same wording as the credential
  guard. Add the pair to the production-mode boot guards.
- cross: @config-deploy-reviewer
- effort: S

---

### [P3] `mediaAccess.ts` claims `/sim-public/*` calls the gate; it does not
- id: simulation-013
- location: podcast-saas/backend-api/src/services/storage/mediaAccess.ts:70
- category: maintainability
- confidence: high
- status: confirmed
- what: The comment reads "`/sim-public/*` had NO project check at all **until it started calling
  this gate**, which meant unsharing a project did not revoke access to its simulation (security-005,
  simulation-007)". `grep -rn "canServeMediaKey\|authorizeMediaRequest" backend-api/src` shows
  `/sim-public/*` does not call it; the callers are `/local-storage`, `/hls-public`, `/hls-proxy`,
  `/video-raw`, `/video-proxy` (`server.ts:309,338,367,429,514`).
- why: The hole is real and deliberately deferred — commit `7231bb7`'s body says so explicitly
  ("`/sim-public/*` still does not call the gate. I wrote that change and reverted it, because
  verifying the blast radius first showed it would BREAK AUTHORING… three of the seven simulations
  in production belong to private projects"). But a reader of `mediaAccess.ts` alone concludes the
  gate is wired in, which is exactly how a known deferred item becomes an invisible one.
  Signalled to security rather than re-filed: the authz decision is theirs.
- evidence: the grep above, plus `git log -1 7231bb7`.
- fix: change the comment to say the branch is *groundwork*, inert until a serve handler calls it,
  and name security-005 as the open item.
- cross: @security-reviewer
- effort: S

---

### [P3] `SimBridgeContract.ts` is not the wire protocol the fleet brief says it is
- id: simulation-014
- location: podcast-saas/backend-api/src/services/simulation/SimBridgeContract.ts:1
- category: fleet
- confidence: high
- status: confirmed
- what: `.claude/reference/stack.md:193` and the `simulation-reviewer` brief both describe
  `SimBridgeContract.ts` as "the message protocol between the host page and the sandboxed child" and
  instruct the reviewer to write down its message table first. The file is the static
  replace-compatibility checker; it contains no message types. The wire protocol is
  `shared/src/sim/*` (envelope, `simFailurePolicy.ts`, `rumEvents.ts`),
  `services/simulation/simRuntimeChild.ts` (the child half) and
  `client-web/lib/sim/SimRuntimeClient.ts` (the parent half).
- why: An agent following the instruction literally spends its first pass on the wrong file and may
  report "no message table" as a finding.
- fix: correct `stack.md` §6.4 and the agent brief to name the three real files.
- cross: @fleet-maintainer
- effort: S

---

### [P3] RUM records no document-load duration and no package weight, so the field cannot see the heavy-package failure mode
- id: simulation-015
- location: podcast-saas/shared/src/sim/rumEvents.ts:64
- category: maintainability
- confidence: high
- status: confirmed
- what: `RumEvent.durations` is `{ totalMs, prepareMs, presentMs, applyMs }`. There is no `loadMs`
  and no byte count. The header of `prepareBudget.ts:26-33` explains why the *budget* excludes load;
  the consequence here is that the telemetry excludes it too.
- why: The failure this whole review is about — the document taking 6 s to fetch its model — shows up
  in RUM only as a `failure` event with `code: 'prepare-timeout'` and a `furthestStage`, which is
  indistinguishable from a package whose `prepare()` is computationally slow. `packageRevision` is
  present, so weight *can* be joined server-side from `sim_revisions.metadata.weight`; a `loadMs`
  cannot be reconstructed at all.
- evidence: read `shared/src/sim/rumEvents.ts:33-86` and `RumService.ts` ingestion.
- fix: add an optional `loadMs` (document navigation → `DOCUMENT_READY`) to `RumEvent.durations` and
  bump `SIM_RUM_VERSION`; the server already refuses an unknown version.
- cross: @observability-reviewer
- effort: S

---

## What I checked and found sound (so it is not re-checked)

- **Poster fallback is not silent.** `ProjectExportService.ts:376-383` builds a typed
  `poster-fallback` window per section with its reason, line 577 counts `degradedWindows`, and
  line 638-642 sets `quality_state: 'degraded'` for the whole export. The brief's "silent static
  image" failure mode is not present.
- **RUM ingestion is bounded correctly.** `sim-rum.controller.ts` caps the body at 256 KB *before*
  parsing (line 35,44), rate-limits per `request.ip` with a documented `trustProxy: 1` justification
  (line 68), always answers 204 so the response is not a probe, never throws, and echoes nothing
  back. Batch size is capped at `RUM_MAX_EVENTS_PER_BATCH = 500`.
- **The boot snippet's message listener verifies its sender.** `sim-public.controller.ts:79`
  (`if (e.source !== window.parent) return`) and the authoring hook additionally checks
  `AO.indexOf(e.origin)` against the deployment's own `browserOrigins()` (line 68), embedded at
  serve time. Both capabilities are inert until an allowlisted parent transfers a port.
- **Revision-key cache policy is verified against the table, not the path shape.**
  `revisionIdentity.ts:106-196` requires a UUID at the revision position *and* a `sim_revisions` row
  belonging to the simulation in the same key, fails closed on any doubt, and caches both answers
  for 60 s with a bounded map. The `revisions/chapter01/` customer-directory trap is closed.
- **The publication gate is an allow-list.** `PUBLICLY_SERVED_STATUSES` (`revisionIdentity.ts:72`)
  is `active | retired | rolled_back`; an unrecognised status is refused, which is what makes adding
  a status safe during a rolling deploy.
- **Async-prepare identity is captured at call time.** `simRuntimeChild.ts:816-831` captures
  `applyActivation` before the await, so a slow `prepare()` (exactly what a 29.7 MB GLB produces)
  cannot post `SECTION_APPLIED` stamped with a section the viewer has since scrubbed to.
- **The capture dependency closure is a non-issue for this package.** `captureDependencies.ts` exists
  for CDN import maps; a Vite dist with three.js bundled has no external refs, so `bootComplete` is
  trivially true.
- **The deterministic clock does not have to wait for the GLB.** `driver.ts:164-183` bounds every
  phase by a REAL wall clock (`deps.now()`) while pumping virtual frames, and the container serves
  the staged package from local disk, so the fetch is disk-speed rather than 40 Mbps. The virtual
  clock advancing during an in-flight fetch is a correctness concern only for a package that
  measures its own load with `performance.now()`.
