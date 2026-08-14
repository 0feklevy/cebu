# Simulation subsystem — findings

Reviewer: `simulation-reviewer`. Run `2026-08-13T2227`, commit `ae4b65b`.
Scope swept: `backend-api/src/services/simulation/**`, `shared/src/sim/**`, `sim-public.controller.ts`,
`sim-rum.controller.ts`, `controllers/v1/simulations.controller.ts`, plus the parent half of the
bridge in `client-web/lib/sim/` (read-only, to prove drift on BOTH sides).

## The v3 message table (from `shared/src/sim/runtimeProtocol.ts`)

`SimBridgeContract.ts` is **not** the postMessage protocol — it is the *replacement-compatibility*
checker for swapping a package's files under an existing `bridge.js`. The wire protocol lives in
`shared/src/sim/runtimeProtocol.ts` (v3, over a transferred `MessagePort`), with the child emitted
as ES5 source by `simRuntimeChild.ts` and the parent in `client-web/lib/sim/SimTransport.ts` +
`SimRuntimeClient.ts`.

| Direction | Messages | Child handles? | Parent handles? |
|---|---|---|---|
| Parent→child, document | `INIT_DOCUMENT` `SUSPEND_DOCUMENT` `RESUME_DOCUMENT` `SET_AUDIBLE` `SET_QUALITY` `DISPOSE_DOCUMENT` | all 6 (`simRuntimeChild.ts:1131-1136`) | n/a |
| Parent→child, activation | `PREPARE_SECTION` `PRESENT_SECTION` `ACTIVATE_SECTION` `PAUSE_AUTOMATION` `RESUME_AUTOMATION` `RELEASE_SECTION` `SET_UI_POLICY` `SET_AUTOMATION_POLICY` | all 8 (`simRuntimeChild.ts:1137-1144`) | n/a |
| Child→parent, document | `DOCUMENT_READY` `DOCUMENT_SUSPENDED` `DOCUMENT_RESUMED` `QUALITY_APPLIED` `DISPOSED` `CONTEXT_LOST` `CONTEXT_RESTORED` **`DOCUMENT_ERROR`** | emits all but `DOCUMENT_ERROR` | all 8 |
| Child→parent, activation | `SECTION_APPLIED` `SECTION_PRESENTED` `SECTION_RELEASED` `AUTOMATION_PAUSED` `AUTOMATION_RESUMED` `POLICY_APPLIED` `POLICY_REFUSED` `SECTION_ERROR` **`DOMAIN_EVENT`** | emits all but `DOMAIN_EVENT` | all 9 |

Checked and **clean** — no finding raised:
- Every parent→child message is dispatched by the child; the child's `CHILD_INBOUND` /
  `ACTIVATION_SCOPED` maps (`simRuntimeChild.ts:680-690`) match `CHILD_INBOUND_TYPES` /
  `ACTIVATION_SCOPED_TYPES` (`runtimeProtocol.ts:480-485`, `134-141`), and a parity test pins it
  (`backend-api/src/scripts/__tests__/v3FixtureParity.test.ts:583-584`).
- Handshake cannot deadlock: parent re-offers every 150 ms bounded at 12 channels
  (`SimTransport.ts:210,258`) with a hard `SIM_BOOTSTRAP_TIMEOUT_MS` deadline falling back to
  legacy (`SimTransport.ts:213-224`); the child refuses a duplicate offer for an epoch it already
  adopted (`simRuntimeChild.ts:1174-1180`) and the parent mints a new `documentId` before
  re-offering (`SimRuntimeClient.ts:1246-1258`). v2 keeps running alongside, so a lost v3 handshake
  degrades rather than hangs.
- Origin IS verified on both bootstrap listeners: child checks `e.source === win.parent` **and**
  `d.parentOrigin === e.origin` (`simRuntimeChild.ts:1154,1158`); parent checks `e.source ===
  frame.contentWindow` and `e.origin === targetOrigin` (`SimTransport.ts:241-242`) and addresses
  the offer to an exact origin, never `'*'` (`SimTransport.ts:278`).
- Version negotiation exists and refuses rather than guesses (`runtimeProtocol.ts:429-431`,
  `simRuntimeChild.ts:695`).
- `revisionIdentity.ts` fails closed on every doubt and checks the simulation↔revision pair, not
  just the shape (`revisionIdentity.ts:88-111`). Revision immutability holds: one write chokepoint
  requiring `uploading` status (`RevisionService.ts:331-350`), CAS on every transition, demote →
  promote → pointer ordering, and a GC floor of 2 with an age guard.
- The poster/config identity hash covers every field of `SimPresentationConfig`
  (`simIdentity.ts:106-126` vs `72-85`) — no missing rendering axis.
- `packageRevisionFor` IS revision-aware (`simRevision.ts:125-134`); an earlier hypothesis that a
  bridge-preserving replace would collide poster identities is **refuted** for revisioned packages.
- `sim-public.controller.ts` requires the full storage key (three UUIDs) — a sim id alone is not
  sufficient to read any revision, published or not. No unpublished-revision exposure found.
- RUM ingestion is rate-limited per real client IP, body-capped at 256 KB, schema-validated,
  field-clamped, kill-switched server-side, and reaped in bounded batches. No finding.

---

### [P1] "Replace simulation" writes to the legacy prefix, so it is a silent no-op for any simulation that has an active revision
- id: simulation-001
- location: podcast-saas/backend-api/src/services/simulation/SimulationService.ts:2614
- category: bug
- confidence: high
- status: confirmed
- what: `processReplace` uploads every replacement file to `` `${prefix}/${relPath}` `` — the
  simulation's *legacy mutable* `storage_prefix`. It never creates a revision and never touches
  `simulations.active_revision_entry_key`. But once a simulation has an active revision, that
  pointer is what every read path serves from: `resolveSimulationUrl` returns
  `getSimPublicUrl(pointer.active_revision_entry_key)` and ignores the stored URL entirely
  (`services/simulation/simulationUrlResolver.ts:72-74`).
- why: The owner uploads new files, the endpoint answers `202` and then logs `'Simulation files
  replaced'` (`controllers/v1/simulations.controller.ts:431-436`), and the live simulation does not
  change — not in the viewer, not in the editor. It is worse than a no-op: the next bridge
  generation resolves its base package from the ACTIVE REVISION's manifest
  (`SimulationService.ts:3033-3059`) and never re-reads the legacy prefix, so the replaced bytes
  are permanently stranded and can only be recovered by re-uploading as a new simulation. The
  replace route has no reference to `active_revision` at all (`grep active_revision
  controllers/v1/simulations.controller.ts` → no matches), so nothing warns the caller. Every
  simulation whose bridge has been published through `publishSectionBridge` has an active revision
  (`SimulationService.ts:3190-3197`), which is the mainstream path for any sim used on a timeline.
- evidence: Read `processReplace` in full (SimulationService.ts:2524-2645): the only writes are
  `uploadFile(\`${prefix}/${relPath}\`, …)` at 2614 and a stale-key sweep that explicitly PRESERVES
  the `revisions/` subtree via `isSystemOwnedKey` (2560-2572). Read the caller
  (simulations.controller.ts:427-436): it sets `entry_file`, `bridge_functions`, `status` — no
  pointer flip, no `RevisionService` call. Read `simulationUrlResolver.ts:67-75`: the pointer wins
  whenever it is non-null. `grep -n "active_revision" controllers/v1/simulations.controller.ts`
  returns nothing.
- fix: Refuse the replace with a 409 when `simulations.active_revision_id` is non-null, naming the
  correct path ("regenerate the bridge to publish a new revision"). The durable fix is to route
  replace through `RevisionService`: `createDraft` → `writeFile` the new bundle → `validate` →
  `activate`, reusing the `onActivated` hook the generation path already uses, so a replace becomes
  one more revision instead of a write nothing reads.
- verify: Add a unit test that seeds a `simulations` row with a non-null `active_revision_id` and
  asserts the replace endpoint refuses (or that `active_revision_entry_key` advances); it must be
  red before the change. `pnpm -C podcast-saas --filter backend-api test` and
  `pnpm -C podcast-saas --filter backend-api typecheck` stay clean.
- cross: @backend-reviewer
- effort: M

### [P1] The bridge-compatibility gate reads the legacy `bridge.js`, so it passes unconditionally for revisioned packages
- id: simulation-002
- location: podcast-saas/backend-api/src/controllers/v1/simulations.controller.ts:382
- category: bug
- confidence: high
- status: confirmed
- what: The replace endpoint loads the bridge to check against from
  `` `${sim.storage_prefix}/bridge.js` `` with `.catch(() => '')`. In the revision layout the
  bridge lives at `<prefix>/revisions/<revisionId>/package/bridge.js`
  (`SimulationService.ts:3027` composes `bridgeManifestPath = \`${PACKAGE_SUBDIR}/bridge.js\``,
  read via `revisionFileKey` at 3049-3050). So the read either misses entirely — yielding `''` —
  or returns a *pre-migration* bridge that is no longer the one being served.
- why: `checkReplaceCompatibility` parses section bodies out of the string it is given
  (`SimBridgeContract.ts:357`, `193-199`). An empty string parses to zero sections, so
  `sectionsBroken === 0` and the report is `compatible: true` with `sectionsTotal: 0`
  (`SimBridgeContract.ts:384-400`). The module's own honesty valve does not fire either:
  `sectionsUnverifiable` counts sections with `checked === 0`, and with no sections parsed it is
  also 0 — so the report claims a clean bill of health having proven nothing. This is precisely
  the outcome the module header calls "a checker that fails the no-op replace is worse than no
  checker at all", inverted: the gate that exists to stop a silently dead sub-simulation reaching
  production is disabled for exactly the packages on the new publication path. (Given
  simulation-001 the replace does not land at all today, so the two must be fixed together —
  fixing 001 alone makes this gate live *and* blind.)
- evidence: Read simulations.controller.ts:381-395 (the read + `.catch(() => '')`, then
  `checkReplaceCompatibility({ bridgeJs, … })`). Read SimBridgeContract.ts:354-401: `contracts` is
  built from `extractContractsFromBridge(opts.bridgeJs)`, the `sections` loop never executes for an
  empty bridge, and `compatible` is `sectionsBroken === 0 && structural.length === 0`. Read
  SimulationService.ts:3027 and 3047-3050 for the revision-relative bridge path.
- fix: Resolve the bridge through the pointer: when `sim.active_revision_id` is set, read
  `revisionFileKey(sim.storage_prefix, sim.active_revision_id, \`${PACKAGE_SUBDIR}/bridge.js\`)`;
  fall back to the legacy key only when the pointer is null. Separately, make an empty bridge an
  explicit outcome rather than a silent pass — return `compatible: false` (or a distinct
  `bridgeUnavailable` flag) when `bridgeJs` is empty *and* the package has timeline sections, since
  "there are sections but no bridge to check" is a fact the caller must see.
- verify: Unit-test `checkReplaceCompatibility` with `bridgeJs: ''` and a non-empty `sections`
  list; assert it does not report `compatible: true`. Red before, green after.
- cross: @backend-reviewer
- effort: S

### [P2] The child claims `contextEvents: true` but only wires canvases that exist at bootstrap, and the canary grants `managed-presentable` on that flag
- id: simulation-003
- location: podcast-saas/backend-api/src/services/simulation/simRuntimeChild.ts:661
- category: bug
- confidence: high
- status: confirmed
- what: `capabilities()` hardcodes `contextEvents: true` for every package, while
  `wireContextEvents()` is called exactly once, from `onBootstrap` (`simRuntimeChild.ts:1192`), and
  binds `webglcontextlost` / `webglcontextrestored` by iterating
  `doc.getElementsByTagName('canvas')` at that instant (`simRuntimeChild.ts:1062-1066`). A canvas
  the simulation creates later — the normal case; `SimBridgeContract.ts:24-27` documents that these
  packages build their DOM inside `App.init()`, *after* the bridge handshake — never gets a
  listener.
- why: `contextEvents` is load-bearing for classification: `allCapable` requires it, and
  `managed-presentable` requires `allCapable` (`shared/src/sim/canaryContract.ts:176-184`). So a
  package can be certified as one that reports context loss when it structurally cannot. The
  consequence is on the reveal path: `CONTEXT_LOST` is what makes the parent hide an invalidated
  frame and arm `SIM_CONTEXT_RESTORE_TIMEOUT_MS`
  (`client-web/lib/sim/SimRuntimeClient.ts:1254-1272`, whose own comment says "leaving it up is
  showing a wrong state"). With no listener bound, a real GPU context loss produces no message at
  all, so neither the hide nor the bounded failure ever happens and the user is left looking at a
  dead canvas for the rest of the section.
- evidence: Read `capabilities()` (simRuntimeChild.ts:652-668) — `contextEvents` is a literal
  `true`, unlike `managedLifecycle`/`onDemandRender`/`suspendable`, which are correctly derived
  from `opts.allManaged`. Read `wireContextEvents` (1046-1068) and its single call site (1192,
  inside `onBootstrap`). `grep -n "wireContextEvents" simRuntimeChild.ts` → definition + one call.
  Read canaryContract.ts:174-184 for the `allCapable` conjunction.
- fix: Bind at document level instead of per-element — `doc.addEventListener('webglcontextlost',
  handler, true)` in the capture phase catches the events from canvases created later, since they
  bubble to nothing but do fire on the target during capture. Re-running `wireContextEvents()` at
  the end of `onPrepare` is a cheaper partial fix but still misses a canvas built asynchronously.
  If neither is taken, derive `contextEvents` from whether any canvas was actually wired, so the
  capability report stays honest and the canary demotes rather than over-promises.
- verify: Extend `services/simulation/__tests__/simBridgeContract.test.ts` (or a new child-runtime
  test) with a document whose canvas is appended after install, dispatch `webglcontextlost`, and
  assert a `CONTEXT_LOST` envelope is posted.
- cross: @test-quality-reviewer
- effort: S

### [P2] `DOCUMENT_ERROR` is declared, allowed inbound and handled by the parent, but no child ever emits it
- id: simulation-004
- location: podcast-saas/shared/src/sim/runtimeProtocol.ts:73
- category: bug
- confidence: high
- status: confirmed
- what: `DOCUMENT_ERROR` is exported (`runtimeProtocol.ts:73`), included in `SimInboundType`
  (`:123`) and in `PARENT_INBOUND_TYPES` (`:473`), carries a payload type
  (`DocumentErrorPayload`, `:357-360`), and the parent has a live handler that calls
  `failModern('document-error', …)` (`client-web/lib/sim/SimRuntimeClient.ts:1400-1402`). The
  emitted child runtime never posts it: `grep -n "DOCUMENT_ERROR"
  backend-api/src/services/simulation/simRuntimeChild.ts` returns nothing, and the same holds for
  the fixture generator `backend-api/src/scripts/gen-sim-fixture.ts`.
- why: There is no way for the child to report a *document-level* fault. `SECTION_ERROR` covers
  only activation-scoped failures and requires a live activation. A throw inside `onInit`, a
  package that adopts the port but cannot answer `INIT_DOCUMENT`, or a runtime the document breaks
  after adoption all produce silence, so the parent learns about it only when a timer expires —
  losing the message, the `fatal` flag and the specific failure code that
  `failModern('document-error', …)` was written to surface. The parent branch is unreachable code
  that reads as covered.
- evidence: `grep -rn "DOCUMENT_ERROR" backend-api/src shared/src client-web/lib` → declarations in
  `runtimeProtocol.ts` (73, 123, 473) and the parent handler in `SimRuntimeClient.ts` (76, 1400)
  only; zero producers. Read simRuntimeChild.ts:980-1043 (the whole document lifecycle): every
  post is `DOCUMENT_READY` / `DOCUMENT_SUSPENDED` / `DOCUMENT_RESUMED` / `QUALITY_APPLIED` /
  `DISPOSED`.
- fix: Emit it. Wrap the `onEnvelope` dispatch (`simRuntimeChild.ts:1127-1147`) in a try/catch that
  posts `DOCUMENT_ERROR { message, fatal: true }` on a throw, and post it from `onInit` when
  `INIT_DOCUMENT` cannot be honoured. Alternatively, if document-level errors are deliberately out
  of scope, delete the type, the payload, the `PARENT_INBOUND_TYPES` entry and the parent branch —
  a declared message with no producer is drift either way.
- verify: `shared/src/sim/__tests__/runtimeProtocol.test.ts` — assert every member of
  `PARENT_INBOUND_TYPES` appears in the emitted child source (`buildChildRuntimeSource`), which
  would also have caught simulation-008.
- effort: S

### [P2] The v2 window listener — the path every stored package actually uses — verifies no origin
- id: simulation-005
- location: podcast-saas/client-web/lib/sim/SimRuntimeClient.ts:670
- category: security
- confidence: high
- status: confirmed
- what: `onMessage` filters inbound v2 traffic on `e.source !== this.frame.contentWindow` only
  (`SimRuntimeClient.ts:673`); there is no `e.origin` check anywhere in that handler. It then
  dispatches `SIM_READY`, `SCRIPT_APPLIED`, `SCRIPT_MISSING`, `SCRIPT_ERROR`, `POLICY_RESULT` and
  `USER_INTERACTION` (`:679-688`).
- why: `SimTransport.ts:6-18` — the v3 design document — names this exact weakness as the reason
  v3 exists: "`contentWindow` is a property of the ELEMENT, not of the document. It survives
  navigation. A message posted by the document that WAS in the iframe passes the check made against
  the document that is in it NOW", and "for the ACK stream it is not [harmless], because an ack is
  what authorises a reveal." The mitigation shipped as a *second, additive* protocol
  (`runtimeProtocol.ts:5-10`), and `SimRuntimeClient.ts:976` records that no stored package speaks
  v3 yet — so in production 100% of ack traffic still arrives on the unchecked listener. A sim is
  arbitrary customer HTML/JS and the served CSP does not restrict navigation
  (`sim-public.controller.ts:176-187` sets `base-uri`/`form-action` but no `frame-src`/navigation
  directive), so a document that navigates itself to a third-party origin leaves that origin
  posting acks the parent accepts.
- evidence: Read SimRuntimeClient.ts:670-690 in full — the only guards are `this.disposed` and the
  `contentWindow` comparison. `grep -n "origin" client-web/lib/sim/SimRuntimeClient.ts` → no
  origin comparison in the v2 path (SimTransport.ts:242 has one; this file does not).
- fix: Record the expected sim origin when the frame `src` is assigned (`deriveTargetOrigin` in
  `SimTransport.ts:111-119` already computes it) and reject any v2 message whose `e.origin` does
  not match it, keeping the existing `contentWindow` check as well. Frames with an opaque origin
  (`srcDoc`/`about:`) are already classified legacy and can keep the current behaviour explicitly.
- verify: Extend `client-web/__tests__/simRuntimeClientModern.test.ts` (or the v2 sibling) with a
  message carrying a foreign `origin` and assert it is ignored; red before, green after.
- cross: @security-reviewer
- effort: S

### [P2] `SECTION_ERROR` raised after an activation is released carries no activation identity, so the parent's validator drops it
- id: simulation-006
- location: podcast-saas/backend-api/src/services/simulation/simRuntimeChild.ts:1097
- category: bug
- confidence: high
- status: confirmed
- what: `runMaybeAsync`'s rejection handler posts `post('SECTION_ERROR', {…}, current)`, reading
  the module-level `current` at the time the promise settles rather than a snapshot taken when the
  call was made. `post()` only stamps `activationId`/`variantKey`/`configHash` when its third
  argument is truthy (`simRuntimeChild.ts:632-636`). After `releaseCurrent()` sets `current = null`
  (`:975`), a still-pending async `prepare`/`present`/`activate`/`pauseAuto` that rejects produces
  an envelope with no activation identity.
- why: `SECTION_ERROR` is in `ACTIVATION_SCOPED_TYPES` (`shared/src/sim/runtimeProtocol.ts:140`),
  so `validateEnvelope` rejects it with `missing-activation-id`
  (`runtimeProtocol.ts:449-452`) and the parent surfaces it as a generic `envelope-rejected`
  telemetry line instead of the section failure it is (`SimTransport.ts:324-329`). The error a
  package author needs — the one raised by the async hook that failed during teardown — is
  precisely the one that never arrives. It is a small window but a reachable one: `RELEASE_SECTION`
  during a slow async `prepare` is an ordinary scrub-away.
- evidence: Read `runMaybeAsync` (simRuntimeChild.ts:1089-1102) — the rejection callback closes
  over the variable `current`, not over a captured activation, unlike `onPresent`, which correctly
  snapshots `var activation = current` (`:835`) and posts against it (`:851`). Read
  `releaseCurrent` (:966-977) for `current = null`. Read `post` (:620-638) for the conditional
  identity stamping and `runtimeProtocol.ts:449-452` for the parent-side requirement.
- fix: Snapshot the activation at call time, exactly as `onPresent` already does — give
  `runMaybeAsync` a fourth parameter `activation` captured by the caller and post against that
  instead of the live `current`. The parent's `matchesActivation` will then correctly classify it
  as a stale-activation error rather than the transport dropping it as malformed.
- verify: A child-runtime test that resolves `PREPARE_SECTION` with a promise, sends
  `RELEASE_SECTION`, then rejects the promise, asserting the emitted envelope carries
  `activationId`.
- effort: S

### [P3] Every served sim entry document installs a `message` listener with no origin or source check
- id: simulation-007
- location: podcast-saas/backend-api/src/controllers/sim-public.controller.ts:48
- category: security
- confidence: high
- status: confirmed
- what: `SIM_BOOT_SNIPPET`, injected into every proxied sim entry HTML at serve time, registers
  `window.addEventListener("message", function(e){var d=e.data||{}; if(d&&d.type==="clearBootHide")
  {…remove #__simBootHide…}})` with no check on `e.origin` or `e.source`.
- why: Any frame that can post to the sim document can strip the minimal-UI boot cloak, so the sim
  paints its full UI — the exact flash the snippet exists to prevent. Impact is cosmetic and the
  blast radius is small because `frame-ancestors` limits embedders to the app/admin origins
  (`sim-public.controller.ts:169,184`), which is why this is P3 and not higher; it is listed
  because it is the one unchecked `message` listener in the subsystem and it ships in every sim
  document.
- evidence: Read sim-public.controller.ts:41-50 — the handler body has no guard. Contrast the two
  bootstrap listeners in the v3 path, which both check source and origin
  (`simRuntimeChild.ts:1154,1158`; `SimTransport.ts:241-242`).
- fix: Gate on the parent: `if (e.source !== window.parent) return;` inside the snippet, matching
  what the v3 child already does. Cheap, no behaviour change for the legitimate sender.
- verify: Assert on the injected string in an `injectSimBootSnippet` unit test.
- cross: @security-reviewer
- effort: S

### [P3] `DOMAIN_EVENT` is declared, allowed and handled but has no producer and no section-facing API
- id: simulation-008
- location: podcast-saas/shared/src/sim/runtimeProtocol.ts:111
- category: maintainability
- confidence: high
- status: confirmed
- what: `DOMAIN_EVENT` is declared (`:111`), typed (`DomainEventPayload`, `:362-366`), listed in
  `ACTIVATION_SCOPED_TYPES` (`:140`) and `PARENT_INBOUND_TYPES` (`:476`), and handled by the parent
  including a `userInteraction` special case (`SimRuntimeClient.ts:1403-1411`). Nothing produces
  it: `grep -n "DOMAIN_EVENT" simRuntimeChild.ts` → no matches, and `makeCtx`
  (`simRuntimeChild.ts:1071-1080`) hands section bodies `variantKey`, `config`, `scope`, `signal`,
  `autoScript` and `markPresented` — no emit function. A section physically cannot send one.
- why: Lower than simulation-004 because the user-visible behaviour is covered: the v2 bridge still
  posts `USER_INTERACTION` on the window and the v2 listener still runs alongside v3
  (`SimRuntimeClient.ts:687`, and `simRuntimeChild.ts:16-19` documents the deliberate
  coexistence), so "touch the sim → pause playback" (`components/VideoPlayer.tsx:241`) keeps
  working on modern packages. The cost is a protocol surface that reads as implemented and a
  parent branch no test can exercise end to end.
- evidence: greps above; read `makeCtx` at simRuntimeChild.ts:1071-1080 for the absent emit API.
- fix: Either add `emit(event, detail)` to the context object and post `DOMAIN_EVENT` against the
  current activation, or delete the type and the parent branch. Prefer the former — it is the
  intended replacement for the v2 `USER_INTERACTION` message.
- effort: S

### [P3] The bootstrap-accept contract says the accept travels on `window.postMessage`; it travels on the port
- id: simulation-009
- location: podcast-saas/shared/src/sim/runtimeProtocol.ts:547
- category: maintainability
- confidence: high
- status: confirmed
- what: The doc comment above `SIM_BOOTSTRAP_ACCEPT_KIND` reads "The child's answer, **also on
  `window.postMessage`**, proving it took the port." Both implementations use the port: the child
  posts the accept with `port.postMessage(...)` (`simRuntimeChild.ts:1191`) and the parent reads it
  in `onChannelFirstMessage`, bound to `channel.port1.onmessage`
  (`SimTransport.ts:275`, `291-303`).
- why: This file is the single source of truth for the protocol and is what a third implementation
  (the fixture generator, a future native child) would be written against. Following the comment
  produces a child whose accept the parent never sees — the handshake then times out at 1.5 s and
  every package is silently misclassified as legacy. The code is right; the specification is
  wrong, which is the more dangerous direction.
- evidence: Read runtimeProtocol.ts:546-554 and compare with simRuntimeChild.ts:1191 and
  SimTransport.ts:275/296. The e2e suites agree with the code, not the comment:
  `client-web/e2e/sim-transport.spec.ts:883` asserts the accept is an `out`/**port** event, and
  `v3FixtureParity.test.ts:583-584` pins `['in','window',BOOTSTRAP]`, `['out','port',ACCEPT]`.
- fix: Correct the comment to "on the transferred port, which is itself the proof it took the
  port". No code change.
- effort: S

### [P3] `simIdentity.ts` and `posterIdentity.ts` still say immutable revisions are unimplemented, and point a future maintainer at the wrong function
- id: simulation-010
- location: podcast-saas/shared/src/sim/simIdentity.ts:230
- category: maintainability
- confidence: high
- status: confirmed
- what: `derivePackageRevision`'s doc says "IMMUTABLE PACKAGE PUBLICATION IS NOT IMPLEMENTED YET
  (that is Priority 7) … When immutable revisions land, **only this function changes**"
  (`simIdentity.ts:230-236`). `posterIdentity.ts:21-25` repeats it: "NOT YET IMMUTABLE. Priority 7
  introduces immutable package revisions … Until then `packageRevision` is derived". Priority 7 has
  landed — `RevisionService`, `sim_revisions`, `active_revision_id` — and the resolution was
  implemented in a *different* function, `packageRevisionFor` (`simRevision.ts:125-134`), which
  branches on `active_revision_id` and keeps `derivePackageRevision` as the legacy arm.
- why: The instruction is now actively harmful. `simRevision.ts:106-124` spells out what changing
  `derivePackageRevision` would cost — "every `sim_posters` row is keyed on the derived value, and
  the lookup deliberately has NO fallback — a package that switched derivations would lose every
  poster it has", plus a canary verdict describing withdrawn bytes and four pinned Playwright
  suites. A maintainer who follows the comment in the file they are editing does exactly the thing
  the other file exists to forbid. (Noting for the record: I opened this expecting a live identity
  collision and the design refuted it — the axis is correctly revision-aware. Only the docs drifted.)
- evidence: Read simIdentity.ts:226-239, posterIdentity.ts:20-26 and simRevision.ts:102-134 side by
  side; read `buildPlayerConfig.ts:344-357` and `:405-430`, which call `packageRevisionFor` with
  `derivePackageRevision` injected as the pre-revision fallback.
- fix: Rewrite both comments to state that revisions have landed, that `packageRevisionFor` is the
  single resolver, and that `derivePackageRevision` is the frozen pre-revision arm that must not be
  changed. Add a one-line pointer from each to `simRevision.ts:103`.
- effort: S

### [P2] The legacy branch of `resolveSimulationUrl` returns a stored absolute URL verbatim, so a row written with a localhost origin keeps serving it
- id: simulation-011
- location: podcast-saas/backend-api/src/services/simulation/simulationUrlResolver.ts:72
- category: bug
- confidence: medium
- status: suspected
- what: `if (!pointer?.active_revision_entry_key || !storedUrl) return storedUrl ?? null;` — when a
  simulation has no active revision the stored `simulation_url` is returned byte-for-byte, with no
  check that its origin is still valid. Stored URLs are absolute and are composed at write time
  from `getSimPublicUrl` (`SimulationService.ts:2496`, `:2639`, `:3186`), which resolves the
  process's own `BACKEND_API_URL` at that moment.
- why: This is the failure class `config/publicOrigins.ts:3-8` was written for and that the
  existence of `scripts/backfill-localhost-urls.ts` shows has already reached production —
  browser-visible `http://localhost:8080/...`, which resolves to the *viewer's* machine. Prod
  writes are now protected (`requireOrigin` throws in production, `assertPublicOriginsForProd` is a
  boot assertion), so new poisoning is prevented; what is not defended is the *read* of rows
  written before that guard, or written by a dev/staging process against a shared database. The
  revisioned path is immune because it recomposes the URL from the pointer on every read (`:74`);
  only the legacy arm passes stored bytes straight through. `grep -rn "isNonPublicUrl"
  backend-api/src` shows the detector is used only by `publicOrigins.ts` itself and the one-shot
  backfill script — never on a read path.
- evidence: Read simulationUrlResolver.ts:67-75 and the three `getSimPublicUrl` write sites above.
  Read publicOrigins.ts:1-30 and 90-115 for the guard and the incident it documents. Marked
  `suspected` because whether legacy rows with a poisoned origin still exist is a data question I
  cannot answer without querying the database, which this review may not do — `legacySimulationIds()`
  (`RevisionService.ts:922-929`) proves un-revisioned simulations are still a supported state, but
  not that any carries a bad origin.
- fix: Make the legacy branch defensive rather than transparent: when `isNonPublicUrl(storedUrl)`
  is true, re-derive it via `storage.keyFromPublicUrl(storedUrl)` → `getSimPublicUrl(key)` and fall
  back to `null` if the key cannot be recovered, so the viewer shows a missing simulation instead
  of pointing the browser at itself. Both helpers already exist.
- verify: `SELECT count(*) FROM simulations WHERE active_revision_id IS NULL` and a
  `simulation_url LIKE '%localhost%'` scan on a **non-production** database confirms or refutes
  reachability; then a unit test on `resolveSimulationUrl` with a localhost stored URL and a null
  pointer.
- cross: @config-deploy-reviewer
- effort: S

### [P3] The RUM retention sweep runs on every API instance
- id: simulation-012
- location: podcast-saas/backend-api/src/server.ts:509
- category: perf
- confidence: high
- status: confirmed
- what: `startRumRetentionSweep()` is called unconditionally at server boot, so every API replica
  runs the same hourly `DELETE` loop over `sim_rum_events`, plus one immediate kick at startup
  (`RumService.ts:143-148`).
- why: Low impact by construction — the delete is idempotent, bounded to `RUM_REAP_BATCH` rows per
  statement and capped at 1000 passes (`RumService.ts:236,245`), so the losing replicas find
  nothing and exit the loop. It is worth recording only because with N replicas a deploy fires N
  concurrent sweeps against the same `ctid IN (…)` predicate in the process that also builds player
  configs, which is the contention the batching was introduced to avoid in the first place.
- evidence: Read server.ts:509 (no leader election, no env gate) and RumService.ts:124-150.
- fix: Wrap the sweep body in a Postgres advisory lock (`pg_try_advisory_lock`) so exactly one
  instance sweeps per interval and the others no-op immediately, or move the call to the worker
  entrypoint (`queue/startWorker.ts`), which already runs singly.
- cross: @job-queue-reviewer
- effort: S
