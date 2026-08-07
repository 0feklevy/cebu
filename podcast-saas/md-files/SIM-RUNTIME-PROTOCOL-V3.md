# Simulation Runtime Protocol v3 — specification

Status: implemented on `feat/sim-pipeline-hardening`. Additive to the shipped v2 protocol; no stored
package changes behaviour until it is regenerated **and** canary-proven.

---

## 1. Why a second protocol

Every wrong-frame incident in this pipeline's history has the same shape: a message that was *true
about some past state* arrived and was applied to the present. The v2 protocol has no way to tell
those apart, and three successive attempts to close the gap by narrowing the comparison each left a
hole:

| Attempt | What it compared | Why it was insufficient |
|---|---|---|
| section name | `SCRIPT_APPLIED.script === pendingScript` | A → B → A produces two activations with the same name |
| + activation token | `token === activationToken` | Unique only within one parent's lifetime; means nothing after a reload |
| + `contentWindow` | `e.source === frame.contentWindow` | `contentWindow` belongs to the **element**, and survives navigation |

A name is not an identity, a counter is not an identity, and an element is not a document. v3
replaces all three with an explicit identity carried on every message, and a transport where a
dead document *cannot* send at all.

**v2 is not removed.** It still ships, still works, and is still what every stored package speaks.
v3 rides a separate transport, so the two can never be confused for one another.

---

## 2. Identity model

Six axes, each independently able to go stale.

| Field | Scope | Changes when |
|---|---|---|
| `playerSessionId` | one viewer/player session | the player is torn down and rebuilt |
| `packageRevision` | the stored package bytes | the package is republished or replaced |
| `documentId` | one iframe **document epoch** | navigation, reload, crash-and-recreate |
| `activationId` | one section entry | entry, re-entry, seek, or configuration change |
| `variantKey` | the sub-simulation | a different section is requested |
| `configHash` | the intended picture | Minimal-UI, hidden controls, auto-script, quality, aspect, transparency or initial state changes |

`seq` is transport bookkeeping, not identity.

`documentId` is deliberately **not** the iframe element identity — that is precisely the mistake
`contentWindow` comparison made. `activationId` is what makes A → B → A safe: the two A activations
agree on package, document, variant and config, and differ only there.

### configHash

`computeConfigHash` is `sha256(canonical(config)).slice(0, 16)` over a canonical form that sorts
object keys and treats `hideSelectors` as a **set** (sorted, deduplicated) — a selector list that
differs only in order describes the same picture, and hashing it as a sequence would mint a second
poster and a second canary run for an identical presentation.

SHA-256 is implemented in pure TypeScript (`shared/src/sim/sha256.ts`) because the same hash must be
computed in three places that share no crypto API: the backend (has `node:crypto`), the browser
player (has WebCrypto, but only asynchronously, and the hash is needed synchronously inside an
activation) and the generated child bridge (has neither). It is verified against the FIPS 180-4
vectors and cross-checked against `node:crypto`.

### packageRevision before immutable publication

Immutable revisions are Priority 7. Until then `derivePackageRevision(simulationId, bridgeHash)`
hashes the simulation row id together with the bridge hash the entry document loads — stable while
nothing changes, changing whenever the bridge is regenerated or the package replaced. The backend
reads `bridgeHash` out of the stored section URL's existing `?v=` parameter, so this costs no extra
query. Every consumer treats the value as opaque, so the migration to real revisions touches one
function.

---

## 3. Envelope and validation

```ts
interface SimRuntimeEnvelope<TType extends string, TPayload> {
  namespace: 'flowvid.sim';
  protocolVersion: 3;
  type: TType;
  playerSessionId: string;
  packageRevision: string;
  documentId: string;
  activationId?: string;
  variantKey?: string;
  configHash?: string;
  seq: number;          // monotonic per transport DIRECTION, starts at 1
  payload: TPayload;
}
```

`validateEnvelope` returns a **reason**, never a bare boolean — a rejection that cannot say why is
indistinguishable from a rejection that is itself the bug. Every reason below has at least one test
asserting on the reason string, not merely that validation failed.

`not-an-object` · `wrong-namespace` · `wrong-protocol-version` · `missing-type` · `unknown-type` ·
`missing-player-session` · `wrong-player-session` · `missing-package-revision` ·
`missing-document-id` · `unknown-document` · `tombstoned-document` · `missing-activation-id` ·
`missing-variant-key` · `missing-config-hash` · `bad-seq` · `duplicate-seq` · `out-of-order-seq` ·
`malformed-payload`

Ordering is deliberate. Namespace and version are checked first so unrelated page traffic produces
`wrong-namespace` rather than a confusing complaint about a field it never had. Tombstone is checked
**before** sequence, because a message from a dead document must be rejected for being from a dead
document — reporting it as out-of-order would be true but useless.

Direction is enforced: `PARENT_INBOUND_TYPES` excludes every parent→child command, which closes the
reflection trick where a child replays a command it was sent so it looks like an acknowledgement.

**A rejected message never changes visible state.** It is counted and reported.

---

## 4. Transport and origin validation

```
child boot ──hello('*')──▶ parent
parent ──offer + MessagePort (targetOrigin = exact child origin)──▶ child
child validates ──▶ adopts port ──▶ accept ON THE PORT
                                    everything after this is port-only
```

**Parent side** (`client-web/lib/sim/SimTransport.ts`)

1. Derives the child's exact origin from the assigned `src`. Non-http(s) schemes yield `null`.
2. Refuses the modern path when the frame's sandbox lacks `allow-same-origin`, or for `srcDoc` —
   those documents have opaque origins, so the offer would have to go to `'*'`, which is the thing
   this transport exists to stop doing. Those surfaces stay on v2 and are classified legacy. That
   is an honest outcome, not a security exception carved out for convenience.
3. Offers on the child's hello **and** on a bounded retry timer (a child that booted before the
   parent attached has already sent its only hello). Each offer mints a fresh channel; whichever
   channel the child answers on wins and the losers are closed. No offer id is needed — the port
   that speaks is by construction the port the child took. Outstanding channels are capped at 12.
4. On a new document epoch, tombstones the previous `documentId` **before** the new offer goes out.

**Child side** (`backend-api/src/services/simulation/simRuntimeChild.ts`)

Refuses an offer unless *all* hold:

- `event.source === window.parent` — only the real parent
- `event.origin === offer.parentOrigin` — self-consistency; a parent lying about its origin fails
- `kind === 'flowvid.sim.bootstrap'` and `protocolVersion === 3`
- all three identity fields present
- `event.ports.length === 1`

After adoption, later offers are refused **and their ports closed**, so a second channel cannot be
left open. Post-bootstrap traffic never uses `'*'`; the port is capability-based, so there is no
target origin to get wrong.

The one message sent with `'*'` is the child's hello, which carries no identity and no secret and is
sent before any origin has been negotiated.

---

## 5. Document lifecycle

```
UNMOUNTED → QUEUED → MOUNTING → DOCUMENT_READY → SUSPENDED
                                       ↓              ↓
                                   DISPOSING ──→ EVICTED
   any active state ──→ FAILED
   NAVIGATE (any state) → tombstone old epoch, back to MOUNTING
```

`documentReducer` is a pure transition table. Illegal transitions are **recorded** (bounded to 32)
rather than silently ignored, so a surface driving the machine wrongly is visible in telemetry
instead of appearing to work.

**`DOCUMENT_READY` means the runtime can receive commands. It never authorises reveal.**
`documentAuthorizesReveal()` exists, always returns `false`, and carries that comment — so a future
edit that tries to make a document state authorise reveal has to change a function that says not to.

Messages: `INIT_DOCUMENT`, `DOCUMENT_READY`, `SUSPEND_DOCUMENT`, `DOCUMENT_SUSPENDED`,
`RESUME_DOCUMENT`, `DOCUMENT_RESUMED`, `SET_AUDIBLE`, `SET_QUALITY`, `QUALITY_APPLIED`,
`DISPOSE_DOCUMENT`, `DISPOSED`, `CONTEXT_LOST`, `CONTEXT_RESTORED`, `DOCUMENT_ERROR`.

---

## 6. Activation lifecycle

```
IDLE → PREPARING → APPLIED → RENDERING → PRESENTED → VISIBLE ⇄ COVERED
                                              ↓         ↓        ↓
                                          RELEASED ←────┴────────┘
  any non-terminal → FAILED
  CONTEXT_LOST from PRESENTED/VISIBLE/COVERED → back to RENDERING, presentation proof discarded
```

`ACTIVATE` is the **only** edge into `VISIBLE`, and `PRESENTED` is its only source state. There is no
timeout edge into `PRESENTED`, no edge from `APPLIED`, and no edge a document-scope event can take.

| Message | Meaning |
|---|---|
| `PREPARE_SECTION` | install section state and UI **while covered** |
| `SECTION_APPLIED` | the exact section and configuration are installed |
| `PRESENT_SECTION` | submit the first target render |
| `SECTION_PRESENTED` | **this exact activation** has submitted its render and may be revealed |
| `ACTIVATE_SECTION` | start public animation, automation, audio, interaction |
| `PAUSE_AUTOMATION` / `RESUME_AUTOMATION` | stop/start automation without touching the scene |
| `RELEASE_SECTION` | dispose section-owned resources, keep reusable document resources |
| `SECTION_ERROR`, `DOMAIN_EVENT` | activation-scoped |

The child **echoes** the `variantKey` and `configHash` it was asked to install rather than
recomputing them. A child computing its own hash could disagree with the parent for a reason neither
side can see, and the invariant would start rejecting healthy acknowledgements.

`SECTION_PRESENTED` carries `framesSubmitted`, and the parent refuses any acknowledgement claiming
zero. Accepting one would make `SECTION_PRESENTED` mean "the child got the message" — exactly the
readiness/presentation conflation the protocol exists to end.

`markPresented` is idempotent per activation **and** refuses to fire from a stale closure: a section
calling it after being superseded would otherwise mint an acknowledgement carrying the *current*
identity for a render belonging to a previous one — a forged match.

---

## 7. The reveal invariant

A live iframe may have effective visible opacity only when

```ts
ack.packageRevision === current.packageRevision &&
ack.documentId      === current.documentId      &&
ack.activationId    === current.activationId    &&
ack.variantKey      === current.variantKey      &&
ack.configHash      === current.configHash
```

`identityRefusal` compares the five axes as **separate statements**, not a loop over field names. A
loop reads fields dynamically, so adding a sixth axis and forgetting to compare it would still
typecheck *and* still pass a loop-based test. Here it fails to compile, because the function
destructures every field it must compare.

Reveal is **not** authorised by: `SIM_READY`; a document-lifetime `SIM_PAINTED`; a timeout; a
previous activation; a matching section name alone; a matching `contentWindow` alone. Each of those
was, at some point, the thing that authorised a reveal here, and each in turn was shown to authorise
a wrong one.

On the modern path **there is no `force`**. `force` exists on the v2 path as the escape hatch for
packages that never promised anything; a v3 package promised `SECTION_PRESENTED` by completing the
handshake, so a timeout produces a bounded failure, never a frame nothing vouched for.

---

## 8. Failure handling

Modern packages: never force-revealed. On `prepare-timeout`, `present-timeout`, `section-error`,
`document-error`, `context-lost-unrecovered`, `transport-closed` or `handshake-failed`, the player
retains the outgoing valid content or the target cover and exposes a **bounded** failure state
offering, in preference order: `poster-only` (when a poster exists — the only option that shows the
right picture immediately, at no cost), `retry`, `skip`, `back-to-video`. A failure with no
applicable action still offers `skip`, because a dead end the user cannot leave is worse than
advancing.

The circuit breaker is **per package, per player session**, opening after 3 consecutive failures. A
package that failed because the device ran out of GPU memory will fail again this session; the same
package on the next visit deserves a fresh chance, because the condition that broke it was
environmental. A success resets it completely — half-open states and decay windows were rejected
because they make behaviour depend on wall-clock timing, which is what made the previous generation
of reveal bugs irreproducible.

Legacy packages keep the existing bounded compatibility behaviour, are classified honestly, and are
never described as satisfying modern guarantees. No silent fallback to another section; no permanent
spinner; no known-wrong state shown to avoid waiting.

---

## 9. Classification gates the protocol

Capability is what a package **can** do (its `DOCUMENT_READY` report). Classification is what it has
been **observed** doing (the publish-time canary verdict). **Only classification changes how the
player behaves.**

| Class | Meaning | Aggressive prep + live reveal |
|---|---|---|
| `managed-presentable` | every canary case passed every step, full capabilities, no leaks | ✅ |
| `managed-partial` | speaks v3, missing at least one guarantee | ❌ |
| `legacy-cooperative` | no v3, but acknowledges applies and can emit a paint | ❌ |
| `legacy-opaque` | no v3 and no usable acknowledgement | ❌ |
| `failed` | the canary could not bring it up | never presented |

`enableModern` refuses to offer a bootstrap for anything below `managed-presentable`, and a package
with a `null` class (never canaried) is treated exactly as legacy. An aborted canary run yields
`failed`, never a downgrade to a legacy class — `legacy-cooperative` is a statement that the package
was *observed* behaving cooperatively, and an aborted run observed nothing.

---

## 10. Where it lives

| Concern | File |
|---|---|
| envelope, types, validation, bootstrap shapes | `shared/src/sim/runtimeProtocol.ts` |
| identities, config canonicalisation, hashing | `shared/src/sim/simIdentity.ts` |
| pure SHA-256 | `shared/src/sim/sha256.ts` |
| document state machine | `shared/src/sim/documentMachine.ts` |
| activation state machine + reveal invariant | `shared/src/sim/activationMachine.ts` |
| failure policy, breaker, classification | `shared/src/sim/simFailurePolicy.ts` |
| poster identity and paths | `shared/src/sim/posterIdentity.ts` |
| canary contract and judging | `shared/src/sim/canaryContract.ts` |
| managed lifecycle contract, leak judging | `shared/src/sim/managedLifecycle.ts` |
| parent transport | `client-web/lib/sim/SimTransport.ts` |
| parent runtime (both protocols) | `client-web/lib/sim/SimRuntimeClient.ts` |
| child runtime + managed scope (generated) | `backend-api/src/services/simulation/simRuntimeChild.ts` |

`shared` has no test runner of its own, so its pure modules are tested from client-web's vitest
project, which already resolves `shared/src/*` and runs under `pnpm -r test`.
