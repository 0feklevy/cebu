# ADR — Action recording: execution, reset and clock semantics

**Status:** **APPROVED by the owner, 2026-08-25.** The twelve decisions in §2 are settled and the
build may not reopen them. What remains open is named honestly in §3 and §6 — the ADR was approved
with M1 and M3–M5 unmeasured, because those need a running stack or a browser and none of them can
move a §2 decision.
**Date:** 2026-08-25 · approved 2026-08-25
**Source:** `.claude/review/RESEARCH-ACTION-RECORDING-2026-08-25.md` §§6–17 (the deep-review ruling;
§§1–5 of that file are the superseded original proposal and are **not** an implementation plan).
**Supersedes:** nothing. **Blocks:** every phase of the action-recording build.

---

## 1. Why this ADR exists before any code

The feature is "record the author's interaction with a simulation, replay it deterministically for
the viewer, and stop paying an LLM ~50K tokens per bridge". The deep review returned a **conditional
GO for the visual picker** and a **NO-GO for the recording architecture as originally proposed**.

The NO-GO was not about the product idea. It was about four semantic claims the original proposal
made that the existing code does not support, and that no amount of careful implementation can make
true after the fact:

| Claim the proposal relied on | Why it is false here |
|---|---|
| Writing a control's `value` back to its baseline restores the simulation | It restores the **DOM**. It does not rewind a physics integrator, a particle system, a canvas, an RNG, or React internal state. |
| Clearing `setTimeout` handles is a pause | `pauseScript` only pauses handles registered through `simDemoTimer`; and a cleared timer loses its remaining delay, so resume is not resume. |
| A recorded timeline can be seeked into | Landing at t=8s by writing each slider's last-value-before-8s reproduces the *inputs*, not the *accumulated state* those inputs produced. |
| A generic synthetic `click` reproduces what the author did | `dispatchEvent` and `element.click()` produce **untrusted** events (DOM Standard). Anything gated on user activation silently does nothing. |

Each of those, left implicit, produces a feature that demos correctly and is wrong in production in
a way no test written against it would catch. This ADR fixes the semantics **explicitly**, including
the parts where the honest answer is a visible product limitation.

---

## 2. Decisions

### D1 — The client never produces code. It produces data.

The browser emits `ActionRecordingV1` — a typed, versioned, canonical IR. It does **not** compile,
does not emit JavaScript, and does not submit a bridge body. Only the server compiles.

*Rejected:* browser-side compilation to a JS bridge body (original proposal §2.3). The published
artifact is public executable code served without authentication from `/sim-public`; the boundary
that decides what goes into it must be the server, not the tab.

### D2 — `reload-document` is the default reset. In-place restore requires a proven adapter.

On leaving or re-entering a section, the default is: cancel the scheduler, hold the cover, **navigate
to a genuinely new document**, re-handshake, re-check baseline, then reveal.

An adapter may claim `restore` instead — but only if it returns a baseline `stateDigest` the server
recomputed and matched during proof. `AdapterRefV1` carries an `implementationHash`, so "an adapter
exists" is never enough; *that* adapter, at *that* hash, must have passed.

*Rejected:* restoring by writing baseline values back to controls. See §1.

### D3 — Generic timed replay is **entry-relative**. Seek restarts it.

During uninterrupted playback the recording follows the media clock. `pause`, `resume` and
`playbackRate` are supported. A **seek, or any re-entry, creates a pristine document and restarts the
recording from t=0.**

This is a visible product limitation and it is deliberate. The alternative — `section-synchronous`,
where entering mid-section lands at the right accumulated state — requires an adapter implementing
`seek(baseline, targetOffsetMs)` that is absolute and idempotent in both directions. Without one,
mid-section seek would show a picture that is *plausible and wrong*.

`ExecutionPolicyV1` is a discriminated union precisely so that `section-synchronous` **cannot be
expressed without** an `AdapterRefV1`. The compiler fixes the policy into the plan; the parent may
not choose reset or seek behaviour at runtime.

### D4 — `final-state` and `timeline` are an explicit author choice, never inferred.

A heuristic may *suggest* ("this looks like a final-state recording"), and the review UI shows the
suggestion. The author picks. Timestamp count does not reveal intent.

### D5 — The V1 support matrix contains **no generic click**.

Supported, absolute-value only: `range`, `number`, `checkbox`, `radio`, `select`.
Blocked in V1: generic button click, pointer drag, canvas/WebGL, ARIA/custom widgets, shadow DOM,
nested and cross-origin iframes, free text, `textarea`, `contenteditable`.
Never captured at all: `password`, `file`, `hidden`.

Generic click stays blocked **even when reset is `reload-document`**. Reload solves cleanup; it does
not prove the synthetic click triggered the right meaning. Entry requires an adapter with a proven
semantic `apply` and digest.

*This is the Phase-0 exit criterion that is easiest to erode and most expensive to lose.*

### D6 — A missing, ambiguous or stale locator is a blocking diagnostic. Never a silent no-op.

`LocatorV1` carries ordered candidates (`data-sim-control` → CSS-escaped `id` → unique `name` →
anchored structural path) plus a `fingerprint`. At capture, preview, server proof **and** runtime,
resolution must parse without exception, match **exactly one** element, and match the fingerprint.
Anything else raises `PlanDiagnosticV1` with the locator id and step index.

`name` alone is not a locator for a radio group — the shared `name` is the failure case, not the key.
Every id is passed through `CSS.escape` (CSSOM); raw `'#' + id` concatenation is not serialization.

### D7 — Preview never publishes. One explicit Apply publishes, once.

`Stop` ends capture. Local preview runs against a fresh document and must pass **twice** returning
the same final state. `Apply` sends IR to an authenticated endpoint, which fences on
`sourceRevisionId`, compiles, stages, proves against a fresh document, and only then activates by
revision CAS inside the transaction that updates the section.

### D8 — Proof happens on a **non-public** state, before activation.

The existing `canary_passed` revision status is **publicly served**, so it cannot host a candidate
that has not been proven.

**The justification for it being public does not survive contact with the code.**
`revisionIdentity.ts:43-44` says `canary_passed` is served because "the pre-activation canary drives
the real document over this route". Verified on 2026-08-25 — nothing does:

- `RevisionService.validate()` reads bytes back from **storage**, not over HTTP; `RevisionService.ts`
  contains no `fetch(`, no `http`, and no `getSimPublicUrl` at all.
- `sim-canary-publish.ts` consumes a **report file** (`--report <path>`). It does not drive a browser.
- `sim-canary.spec.ts:1710` intercepts `${API_ORIGIN}/**` and fulfils from an in-process server;
  `localPathFor:304` maps only `/sim-public/__e2e/…` and 404s everything else, so a real revision key
  is unreachable by construction.

And `shared/src/sim/simRevision.ts:33-42` states the opposite outright: `canary_passed` is *"NOT
proof that a canary ran"* — `validate()` moves a revision there on byte verification alone, and the
legacy migration publishes straight into it. **The name is historical.** So today a package that was
never canaried sits in a publicly-served status, justified by a comment describing a mechanism that
does not exist.

**Therefore the fix is the allow-list inversion, and it is ordered.** `isRevisionStatusPublic`
currently reads `status === null || !NEVER_PUBLISHED_STATUSES.has(status)` — an **unknown status is
public** ("Unknown status ⇒ yes (legacy)"). Adding a `proof_pending` status first would mean any
backend image that predates it serves unproven bytes. So:

1. **Release N** — invert `isRevisionStatusPublic` to an explicit allow-list (`active`, `retired`,
   `rolled_back`). This alone makes `validating` and `canary_passed` non-public and satisfies §6.4
   with no migration and no new status.
2. **Release N+1** — add the `proof_pending` / `proof_passed` statuses, once every serving image
   already refuses what it does not recognise.

`sim_revisions.status` is `text` with an inline `CHECK` (`050_sim_revisions.sql:41-43`), not a
Postgres enum — so a later status addition is a `DROP`/`ADD CONSTRAINT`, which this migration runner
can do inside its transaction. `ALTER TYPE … ADD VALUE` could not.

There is no publish-then-verify fallback. `retired` and `rolled_back` stay publicly reachable
deliberately — their bytes were served and an in-flight viewer still holds their URLs — so
**rollback is not revocation**. Recovery moves the active pointer; it does not unpublish a URL. That
containment limit goes in the runbook verbatim.

### D9 — Raw capture is ephemeral; the published artifact carries allowlisted values only.

Raw capture lives in editor memory and is discarded on cancel/navigation/unmount, or after a
successful Apply acknowledgement. A lost response does **not** discard the author's work — retry with
the same `Idempotency-Key`.

A type allowlist is **not** a sensitivity allowlist. Every control must be explicitly opted in as
public-artifact-safe, and the review UI shows the complete publication diff — locators, action kinds,
timestamps, and every value — for approval. A number is not safe by virtue of being a number.

Logs and metrics carry counts, hashes and error codes. Never selectors, labels or values.

### D10 — The picker is tri-state with a list fallback, and hide-the-rest is a suggestion.

Toolbar modes: **Interact / Keep visible / Hide / Clear mark**. Green and red are carried by icon
**and** text, not colour alone. `Escape` cancels, `Undo` restores a mark, and the existing checkbox
list stays a fully functional accessible fallback — including for controls that are off-screen or
inside a collapsed Advanced panel.

Single click, not double: the browser fires `click` before `dblclick`, so a double-click picker
flickers and is timing-dependent.

Deriving "hide everything the author didn't touch" is applied **only** on explicit confirmation, and
never when the control scan was truncated or stale.

### D11 — An LLM may return a typed patch. Never JavaScript, never a locator or a value.

`PlanPatchV1` is a closed union: `trim`, `scale-duration`, `set-easing`, `resample`. It carries
`basePlanHash`; the server applies it deterministically only on a hash match, then re-compiles and
re-proves.

### D12 — Zero new runtime dependencies in V1.

The semantic recorder is ours. rrweb (MIT, ~24KB gzip) stays a **future experiment**, justified only
if telemetry proves a missing session context the semantic recorder cannot supply — and it does not
solve iframes or privacy by default (`maskAllInputs` and `recordCanvas` both default to `false`, and
child frames need their own injection). `@puppeteer/replay` (Apache-2.0) is an **adapter target**,
not the canonical IR: Chrome Recorder replays as fast as possible by default, so its timing is a
debug affordance, not a product contract.

---

## 2b. Amendment A1 — the pre-recording picker (2026-08-26, owner-approved)

D10 and §5 were written for the picker as it exists *alongside* recording. The picker shipped
first, on its own, and two of their requirements do not survive contact with that ordering. Both
changes were put to the owner explicitly and approved; this section records them so the next reader
does not find the code disagreeing with §2 and assume drift.

**A1.1 — binary Keep/Hide replaces the four-mode toolbar, for now.** D10 specifies
Interact / Keep visible / Hide / Clear mark, with `Auto` meaning "no manual override, defer to the
derivation". Before recording exists there is nothing to derive *from*, so `Auto` and `Clear` are
the same state wearing two names, and a mode toolbar is three clicks guarding a binary. The picker
therefore ships with badges shown the whole time the panel is open and a single click toggling
Keep/Hide — the owner chose this over a separate pick mode when asked.

Tri-state returns with Phase-2 recording, where `Auto` becomes a real third state (derive from what
the recording touched) and `derivationMode` has something to read.

**What is NOT amended, and is implemented as written:** icon+text never colour alone; single click,
never double; the checkbox list stays a first-class accessible fallback and is the only path to a
control the simulation itself keeps hidden; Undo; Escape; and "hide everything untouched" is never
applied without an explicit action — additionally disabled outright when the scan was truncated or
stale, which §14.7 requires and which the `truncated` flag now carries end to end.

**A1.2 — the `sim_authoring_picker` flag (§5) is replaced by narrower containment.** A default-false
flag would have shipped the owner an unchanged, broken picker; the feature *is* the fix they asked
for. In its place:

| | |
|---|---|
| viewers | inert by construction — the capability does nothing until an allowlisted parent sends `CONNECT`, and only the editor does |
| kill switch | `SIM_AUTHORING_DISABLED=1` — the route 404s and the snippet stops advertising the hook, for every already-served document, with no migration and no editor deploy |
| rollback | revert the editor PR; the backend layer is inert on its own |

`sim_action_recording` and `sim_action_plan_runtime` (§5) are unaffected — recording still ships
behind its flag.

**Conforming, not deviating:** the transport is MessageChannel with a serve-time-embedded origin
allowlist, exactly as §7.3 and §8.6 specify. `CONNECT` is the only window-level message and carries
the port; everything after rides it. The full envelope (seq, ACK, CAPABILITIES) is Phase 2 and is
named so it replaces these types rather than growing a second vocabulary beside them.

---

## 3. What this ADR deliberately does not decide

These are Phase-0 **measurements**, not opinions. Each needs a number before the ADR is approved.

| # | Measurement | Decides |
|---|---|---|
| M1 | p95 latency of isolated fresh-document proof | whether Apply is synchronous or returns `202` + status URL |
| M2 | dormant + active bootstrap cost on a low-end device | whether capture code is inlined or lazily fetched after ARM — **byte half measured, see below** |
| M3 | draft-recording TTL and deletion policy on section delete | the retention row in the privacy section — **deletion half settled, see below** |
| M4 | `reload-document` cost, prewarm viability, re-entry latency | whether D3's restart is acceptable UX or needs pooling |
| M5 | the source-content hash that excludes the platform bridge | whether a future single rebase is possible instead of a hard 409 |

M2 and M4 can move D3 and D5's *ergonomics*. They cannot move D1, D2, D5, D8 or D9.

### M2, byte half — measured 2026-08-25, and it moves the target

Both existing serve-time/publish-time injections, measured as the fragment each adds to a bare
document:

| injection | raw | gzip | brotli |
|---|---:|---:|---:|
| `SIM_BOOT_SNIPPET` — serve time, today | 673 | **457** | 348 |
| rAF gate v4 — in every published entry document | 16,826 | **5,878** | 5,039 |

The research report proposes a launch target of "dormant bootstrap up to 5KB gzip". Against these
numbers that is **too generous by an order of magnitude**: 5KB gzip would nearly double what every
viewer already downloads on every simulation, to buy a capability that is inert for all of them and
used only by an author in an editor.

**Revised target: ≤ 1KB gzip dormant**, which is roughly twice the boot snippet's 457 and is
achievable for what the dormant phase actually has to be — one `message` listener and a capability
reply. Anything beyond that loads same-origin *after* ARM, which only an authoring session reaches.

The device half of M2 — handler cost at 60fps on low-end hardware — still needs a browser and is
not measured here.

### M3, deletion half — settled by the schema, and the TTL is now bounded rather than open

`PHASE0-PROOF-STATE-AND-IDEMPOTENCY.md` settles the deletion policy without needing a measurement:
`sim_action_recordings` carries `section_id … ON DELETE CASCADE`, so deleting a section takes its
recordings with it, and `source_revision_id` deliberately carries **no** FK because
`RevisionService.gc()` deletes those rows and now has a production caller.

What is left is one number — how long an *unapplied* draft survives — and it is no longer
unbounded. `mustRetainBytes('proof_pending')` is false, so an older image's gc sweep collects an
in-proof candidate once it passes `GC_MIN_AGE_MS` (1h). The draft TTL therefore has to sit inside
that window, which also makes it an input to M1: **proof must complete well inside the gc grace, or
the candidate it is proving is swept out from under it.**

That is a decision for the owner rather than a measurement, and it is deliberately not taken here.

---

## 4. Module boundaries

The recorder does not go into `SectionEditor.tsx` and the compiler does not go into
`SimulationService.ts`.

| Layer | Module |
|---|---|
| authoring protocol contract | `shared/src/sim/authoringProtocol.ts` |
| IR + Zod schema | `shared/src/sim/actionRecording.ts` |
| serve-time bootstrap | `backend-api/src/services/simulation/SimAuthoringBootstrap.ts` |
| client transport + FSM | `client-web/lib/sim/SimAuthoringClient.ts` |
| React orchestration | `client-web/hooks/useSimAuthoring.ts` |
| API | `backend-api/src/controllers/v1/actionRecordings.controller.ts` |
| validation + canonicalization | `backend-api/src/services/simulation/ActionRecordingService.ts` |
| deterministic compiler | `backend-api/src/services/simulation/ActionPlanCompiler.ts` |
| fixed runtime executor source | `backend-api/src/services/simulation/ActionPlanRuntime.ts` |

`SimulationService` gains exactly one narrow orchestration method, `applyRecordedActionPlan`. The
publication primitive is split or widened to expose **stage → proof callback → CAS activate**,
reusing `uploadSectionBridge`'s logic rather than duplicating it.

Three version numbers are independent and must not be conflated: the **authoring** protocol version,
the sim **runtime** protocol version (v2/v3), and the rAF **gate** version.

`shared` has no test runner of its own — its pure modules are tested from client-web's vitest project
(`SIM-RUNTIME-PROTOCOL-V3.md` §10). Golden fixtures for the IR, normalizer and compiler go there.

---

## 5. Feature flags

Following the established three-step resolution — env var → `admin_settings` column → built-in
default, editable at `/feature-flags` (`.env.example` §"Simulation runtime switches"):

| Flag | Values | Default | Purpose |
|---|---|---|---|
| `sim_authoring_picker` | `true\|false` | `false` | Phase 1 — the visual picker |
| `sim_action_recording` | `off\|internal\|allowlist\|on` | `off` | Phase 2 — the recording vertical slice |
| `sim_action_plan_runtime` | `true\|false` | `true` | Phase 3 kill switch — refuses to run an installed plan |

The kill switch must be enforced in **both** the parent and the child executor, and must be able to
block an `executorVersion` at serve time. The bootstrap itself stays inert regardless.

---

## 6. Exit criteria for Phase 0

| # | Criterion | State |
|---|---|---|
| 1 | This ADR approved | ✅ owner-approved 2026-08-25 |
| 2 | Golden fixtures pass: vanilla controls, React controlled inputs, DOM replacement, special and duplicate ids, radio groups, a hidden Advanced panel, an unsupported canvas | ✅ `rafGateRuntimeScanner.test.ts`, mutation-proven both directions |
| 3 | Serve-time bootstrap proven on an **old** revision and a **new** one, on both the local and cloud storage paths, with no rebuild and no stored-byte change | ✅ `sim-public.localParity.test.ts`, mutation-proven |
| 4 | `isRevisionStatusPublic` is an explicit allow-list, so an unrecognised status is refused rather than served | 🔨 approved 2026-08-25, its own PR — see D8 for why the two-release order is not negotiable |
| 5 | The scheduler is proven against a fake clock: pause, resume, rate, restart-on-seek, adapter seek both directions | ✅ `actionPlanScheduler.test.ts`, four mutations |
| 6 | The full lifecycle is proven: single reset generation, READY/PAINTED/PLAN barriers, deadlines, fail-closed | ✅ `actionPlanLifecycle.test.ts`, five mutations |
| 7 | Idempotency states, lease recovery and the `sectionVersion` fence designed before the endpoint is written | ✅ `PHASE0-PROOF-STATE-AND-IDEMPOTENCY.md` |
| 8 | M1–M5 have numbers | 🟡 M2's byte half measured (§3); M1, M3–M5 need a running stack or a browser |
| 9 | **`generic click` does not appear in the supported matrix** | ✅ D5 |

Criteria 1–3 and 5–9 are met, with 8 partial. **The ADR was approved while 4, 6 and most of 8 were
still open**, on the owner's explicit ruling that none of them can move a §2 decision. 6 has since
been met, and 4 is implemented in its own PR — the two-release order in D8 means it lands before
any `proof_pending` exists. What remains is M1 and M3–M5, all of which need a running stack or a
browser, and all of which are ergonomics.

---

## 7. The shape being built

```
serve-time inert bootstrap
→ versioned MessageChannel
→ semantic typed recording
→ local deterministic preview
→ authenticated IR-only endpoint
→ server-side fixed executor plan
→ fresh-document proof
→ revision CAS + atomic provenance
→ media-clock-synchronized runtime
```
