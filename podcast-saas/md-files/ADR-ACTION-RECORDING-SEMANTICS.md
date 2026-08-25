# ADR — Action recording: execution, reset and clock semantics

**Status:** proposed — Phase 0 exit gate. Not approved until the golden fixtures pass and the five
Phase-0 measurements below have numbers.
**Date:** 2026-08-25
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

## 3. What this ADR deliberately does not decide

These are Phase-0 **measurements**, not opinions. Each needs a number before the ADR is approved.

| # | Measurement | Decides |
|---|---|---|
| M1 | p95 latency of isolated fresh-document proof | whether Apply is synchronous or returns `202` + status URL |
| M2 | dormant + active bootstrap cost on a low-end device | whether capture code is inlined or lazily fetched after ARM |
| M3 | draft-recording TTL and deletion policy on section delete | the retention row in the privacy section |
| M4 | `reload-document` cost, prewarm viability, re-entry latency | whether D3's restart is acceptable UX or needs pooling |
| M5 | the source-content hash that excludes the platform bridge | whether a future single rebase is possible instead of a hard 409 |

M2 and M4 can move D3 and D5's *ergonomics*. They cannot move D1, D2, D5, D8 or D9.

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

1. This ADR approved.
2. Golden fixtures pass: vanilla controls, React controlled inputs, DOM replacement, special and
   duplicate ids, radio groups, a hidden Advanced panel, and an unsupported canvas.
3. Serve-time bootstrap proven on an **old** revision and a **new** one, on both the local and cloud
   storage paths, with no rebuild and no stored-byte change.
4. `isRevisionStatusPublic` is an explicit allow-list, so an unrecognised status is refused rather
   than served. The `proof_pending` / `proof_passed` statuses follow in the *next* release, not this
   one — see D8 for why the order is not negotiable.
5. The scheduler is proven against a fake clock: pause, resume, rate, restart-on-seek, adapter seek
   both directions.
6. The full lifecycle is proven: single reset generation, READY/PAINTED/PLAN barriers, deadlines,
   fail-closed.
7. Idempotency states, lease recovery and the `sectionVersion` fence are designed before the endpoint
   is written.
8. M1–M5 have numbers.
9. **`generic click` does not appear in the supported matrix.**

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
