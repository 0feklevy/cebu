# Simulation pipeline — Priorities 4–6

Continues the Priority 1–3 work already on this branch. Nothing here changes how any package
behaves in production until an explicit, reversible rollout step is taken (see
`md-files/SIM-P456-ROLLOUT.md`).

- **Priority 4** — a full activation-scoped runtime protocol (v3): explicit identities, a private
  `MessageChannel` transport, document and activation state machines, and a reveal invariant.
- **Priority 5** — posters keyed by presentation identity, a safe layered presentation surface, and
  a publish-time browser canary that classifies packages.
- **Priority 6** — a managed section lifecycle in the generated child bridge, with a real resource
  scope and honest automation, audio, WebGL and suspension contracts.

Specification: **`md-files/SIM-RUNTIME-PROTOCOL-V3.md`**.
Rollout and rollback: **`md-files/SIM-P456-ROLLOUT.md`**.

---

## Why a second protocol at all

Every wrong-frame incident in this pipeline's history has the same shape: a message that was *true
about some past state* arrived and was applied to the present. Three successive attempts to close
that by narrowing the comparison each left a hole:

| Attempt | Compared | Why it was insufficient |
|---|---|---|
| section name | `SCRIPT_APPLIED.script === pendingScript` | A → B → A produces two activations with the same name |
| + activation token | `token === activationToken` | Unique only within one parent's lifetime; meaningless after a reload |
| + `contentWindow` | `e.source === frame.contentWindow` | `contentWindow` belongs to the **element**, and survives navigation |

A name is not an identity, a counter is not an identity, and an element is not a document. v3 puts
an explicit identity on every message and moves protocol traffic onto a transport a dead document
cannot reach.

**v2 is not removed.** It still ships, still works, and is still what every stored package speaks.

---

## Priority 4 — the protocol

### Identity model

Six axes, each independently able to go stale: `playerSessionId`, `packageRevision`, `documentId`,
`activationId`, `variantKey`, `configHash`. `seq` is transport bookkeeping, not identity.

`documentId` is deliberately **not** the iframe element identity — that is exactly the mistake
`contentWindow` comparison made. `activationId` is what makes A → B → A safe: the two A activations
agree on package, document, variant and config and differ only there.

`configHash` uses a pure-TypeScript SHA-256 (`shared/src/sim/sha256.ts`) because the same hash must
be computed in three places that share no crypto API: the backend (has `node:crypto`), the browser
player (has WebCrypto, but only asynchronously, and the hash is needed synchronously inside an
activation) and the generated child bridge (has neither). Verified against the FIPS 180-4 vectors
and differentially against `node:crypto`.

### Transport

```
child boot ──hello('*')──▶ parent
parent ──offer + MessagePort (targetOrigin = exact child origin)──▶ child
child validates ──▶ adopts port ──▶ accept ON THE PORT
                                    everything after this is port-only
```

The child refuses an offer unless *all* hold: `event.source === window.parent`;
`event.origin === offer.parentOrigin`; correct kind and protocol version; all three identity fields
present; exactly one port.

A later **valid** offer from the real parent *replaces* the current port and closes the old one; it
is not refused. Latching permanently on the first adoption was a wedge, not a defence: the parent
gives up after a bounded deadline, so a package whose listener installs after that would latch onto
a port the parent had already abandoned, post into a dead channel forever, and refuse every
re-offer — running v2 for its whole life while certified modern, with no signal in either direction.
Only `window.parent` can reach that path, so replacing is exactly as private as latching was, and it
is the only recovery.

A `srcDoc` frame, or one sandboxed without `allow-same-origin`, has an opaque origin — there is no
exact origin to address, so the offer would have to go to `'*'`. Those surfaces stay on v2 and are
classified legacy. That is an honest outcome, not a security exception carved out for convenience.

### The reveal invariant

A live iframe may have effective visible opacity only when the acknowledgement matches on all five
axes. `identityRefusal` compares them as **separate statements**, not a loop over field names — a
loop reads fields dynamically, so adding a sixth axis and forgetting to compare it would still
typecheck *and* still pass a loop-based test.

On the modern path **there is no `force`**. A v3 package promised `SECTION_PRESENTED` by completing
the handshake, so a timeout produces a bounded failure, never a frame nothing vouched for.

`SECTION_PRESENTED` carries `framesSubmitted`, and the parent refuses any acknowledgement claiming
zero — accepting one would make the message mean "the child got the message".

### Classification gates the protocol

Capability is what a package **can** do (its `DOCUMENT_READY` report). Classification is what it has
been **observed** doing (the canary verdict). Only classification changes player behaviour:
`enableModern` refuses to offer a bootstrap below `managed-presentable`, and a `null` class (never
canaried — i.e. every package in production today) is treated exactly as legacy.

---

## Priority 5 — posters, layers, canaries

Posters are keyed by `packageRevision + variantKey + configHash + aspectProfile + qualityProfile`
and stored under the simulation's own prefix, so deleting a simulation removes its posters with it.
There is **no** fallback to another identity's poster — a generic package screenshot shown for a
specific variant is worse than no poster, because the user sees one picture and then a visibly
different one.

The layered surface is `top: poster/cover/recovery · middle: incoming · bottom: outgoing`. The
incoming frame is reachable only from a matched `SECTION_PRESENTED`; there is no timer in either
the policy or the component.

The canary drives a staged package through the full protocol in a real browser, captures posters at
each size, and classifies. An aborted run yields `failed`, never a downgrade to a legacy class —
`legacy-cooperative` is a statement that the package was *observed* behaving cooperatively, and an
aborted run observed nothing.

`sim-canary-publish.ts` is the gate. Dry-run by default; refuses an incomplete report, a stamped
classification the report's own steps do not support, and a modern grant whose posters are missing
(a modern package's failure policy offers `poster-only` as its *first* recovery action).

---

## Priority 6 — managed lifecycle

`ManagedSectionLifecycle` replaces the single cleanup closure, which could not answer any of the
questions the player actually needs answered — has your first frame been submitted, stop automating
but keep the scene, go quiescent, release your GPU memory, you are muted now. Each of those had at
some point been answered by the player *guessing*.

The managed scope tracks rAF, timers, listeners, AbortControllers, fetches, Workers, ports, media,
Web Animations, AudioContexts/nodes, object URLs, ImageBitmaps, observers and Three.js resources,
with pause / resume / release / dispose, real counters and a leak report.

A body returning a plain cleanup function is wrapped and classified **legacy** — `__managed` stays
false, so the capability report and the classification both tell the truth about it.

---

## Defects found and fixed during this work

Every one of these was found by a test or an independent reviewer, not by inspection.

| # | Defect | How it was found | Fix |
|---|---|---|---|
| 1 | `capabilities()` derived the report from the *installed* lifecycle, which is necessarily `null` at `INIT_DOCUMENT` — so `managedLifecycle` and `onDemandRender` were **false for every package that could ever exist**. The modern path would have been dead code in production while every test passed. | canary track review | derive from the static generation-time descriptor; added the assertion that would have caught it |
| 2 | `DISPOSED.leaked` could never be non-empty — `disposeAll` zeroed every counter unconditionally, so the message meant to *prove* no leak proved nothing (a reviewer replaced the payload with a hardcoded `[]` and every test still passed) | fixture track review | release per-resource; an entry stays counted and named when its dispose throws |
| 3 | **`resume()` never re-requested animation frames.** A suspended-then-resumed document's render loop was permanently dead — and the stranded record was silently dropped at dispose, so the leak report could not reveal it either. Reached directly by the resident pool's own `freeze()`/`thaw()`. | leak suite, all 3 engines | retain the wrapped callback and re-schedule exactly one frame on resume |
| 4 | **`AUTOMATION_PAUSED` was acknowledged for automation that kept running.** `registerAutomation` stored the native handle; `pause`/`resume`/`resumeAutomation` all re-assign it, so after one round trip the lookup found nothing, cleared nothing, and acknowledged anyway. | leak suite, all 3 engines | track the record, not the handle; report how many were actually stopped |
| 5 | The fixture freshness check stat'd only `gen-sim-fixture.ts`, but the emitted bridge embeds the child runtime — so a child-runtime change silently tested **stale bytes**. Two real fixes were re-run against pre-fix bytes and reported as still-failing. | investigating #3/#4 | freshness considers every source the bytes come from |
| 6 | Wrapping the resident pool in the layered surface re-parents it, and React rebuilds a subtree whose parent changes — **every warm iframe destroyed on each hand-back to video**, the exact cost the pool exists to avoid | wiring agent flagged it | pool stays in one fixed slot; layers render as a sibling and drive visibility through `onDecision`. Pinned by a DOM node-identity assertion across a real flip |
| 7 | A frame attached *after* `enableModern` under the same document key never opened a transport — the package would silently run v2 while reporting itself canary-proven | self-review | open the transport when the element arrives |
| 8 | A late `SECTION_PRESENTED` for a *released* activation still matched identity, and reported success and reset the breaker even though the machine refused it | self-review | only report success when the reducer actually advanced |
| 9 | `pause()` cannot stop a Worker (only terminate can, which would destroy the state being returned to), yet `unstoppable` never mentioned one — a document could report quiescence with a Worker computing | leak suite inspection | a tracked Worker is reported as unstoppable |
| 10 | The scope's leak callback discarded `where` and hardcoded `stage: 'automation'`, so a throwing *dispose* surfaced as an automation error with no resource name | leak suite inspection | carry the location and the correct stage |

---

## Verification

All numbers below were produced by running the command, not inferred.

### Unit and static

| Suite | Result |
|---|---|
| `shared` typecheck | clean |
| `backend-api` typecheck | clean |
| `client-web` typecheck | clean |
| `admin-web` typecheck | clean |
| backend vitest | **1076 passed**, 69 files |
| client vitest | **657 passed**, 24 files (stable across 3 consecutive runs) |
| ops/release vitest | **237 passed**, 21 files |
| eslint × 3 packages | 0 errors |

### Browser, all with `--retries=0`

| Suite | Chromium | Firefox | WebKit |
|---|---|---|---|
| `viewer-e2e` (the Priority 1–3 regression gate) | 25 | 25 | 25 — **75 total, 0 failed, 0 flaky, 0 skipped** |
| `sim-leak` (100× A→B→A = 300 activations, 100× suspend/resume, 20 document epochs) | 12 | 12 | 12 — **36 total** |
| `sim-canary` | 11 | — | — (all-engine mode behind `CANARY_ALL_ENGINES`) |

Leak plateaus, identical in all three engines, every kind `ok` with **zero drift**: `rafCallbacks`
1/4, `intervals` 1/4, `listeners` 1/64 (7/64 on the independent native observer), `abortControllers`
1/4, `objectUrls` 1/2, `glTextures` 1/256.

### The canary actually discriminates

Run for real, not listed:

| Package | Verdict | Why |
|---|---|---|
| `v3allmanaged` | **`managed-presentable`** — modern path granted | every case passed every step, full capabilities, no leaks |
| `v3managed` | **`managed-partial`** — withheld | carries one legacy-bodied section, so it cannot honestly claim the suspension guarantee for every variant |

16 poster renditions captured (4 identities × 2 sizes × 2 packages). A gate only ever observed
saying *yes* has not been observed working.

### Production builds

`shared`, `backend-api`, `client-web`, `admin-web` — **4/4 exit 0**. Viewer route
`/projects/[id]/view`: 2.5 kB route, 364 kB First Load JS.

### Additivity, checked at the byte level

The generated fixtures for `modern`, `legacy`, `nopaint`, `delayedack` and `noraf` contain **zero**
occurrences of the v3 runtime marker; only `v3managed` and `v3allmanaged` carry it. `wrapBridgeCombined`
emits it only when explicitly asked, and only the production generation path asks.

---

## Remaining work for Priorities 7–8

Not implemented here, deliberately:

- **immutable revisions** — `packageRevision` is currently *derived* from the simulation id plus the
  bridge hash in the section URL. That invalidates posters and canary verdicts correctly whenever a
  bridge changes, but it is derivation, not publication.
- **atomic publication** and **rollback pointers** — publication is currently per-object with an
  ordering discipline (objects before rows), not an atomic pointer switch.
- **manifest serving** — no canonical manifest exists yet; the bridge hash stands in for one.
- **predictive scheduling** — preparation is still driven by the existing pool warm/stagger logic,
  not by measured stage latency.
- **video-frame clock** — section boundaries still come from `timeupdate`, not
  `requestVideoFrameCallback`.
- **production RUM** — telemetry events exist and are named, but there is no correlated pipeline,
  sampling policy, retention policy or dashboard.
- **adaptive quality** — `SET_QUALITY`/`QUALITY_APPLIED` are implemented end to end, but nothing
  decides *when* to change profile.
- **package-level performance optimization** — no package has been profiled or optimised.
- **physical-device validation** — untested; no device access. WebKit is the closest available
  proxy and runs on every gate. This remains a prerequisite for a broad rollout.


---

## One known test sensitivity, stated rather than hidden

`viewer-e2e` S5 failed once across four full runs, on the slowest (13.6 min vs a 10.9–11.2 min
baseline — i.e. the run competing with other work). It passes 3/3 in isolation on WebKit and the
other three full runs were 75/75.

The mechanism is in the test, not the product: S5 samples from `startBad.receivedAt + SIM_FADE_MS`
— a **child** clock timestamp — to `+2500 ms`, while the runtime's terminal apply-stall bound is
`SIM_APPLY_STALL_MS = 3000 ms` measured from the **parent's** activate. Those are two clocks with a
500 ms margin between them. Under saturation the skew can exceed it, letting the terminal bound —
correct, designed behaviour — land inside the window the test asserts nothing may be presented in.

The `delayedack` package is byte-identical (10306 bytes, no v3 runtime, `BADTOKEN` and `tokenDelta`
intact), so nothing in this change reaches it. The fix is to re-anchor the window to the parent's
activate plus the real constant; it is deliberately **not** done here, because changing a Priority 3
acceptance test to make a red run green is the wrong move to take on a hunch mid-verification.
