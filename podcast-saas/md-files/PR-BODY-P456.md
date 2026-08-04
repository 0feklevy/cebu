# Simulation pipeline — Priorities 4–6

Scope of this PR is **Priorities 4, 5 and 6 only**. Priorities 7–8 (immutable revisions, atomic
publication, predictive scheduling, RUM, adaptive quality, package optimisation) are **not** in this
branch and are not claimed anywhere below.

Builds on the Priority 1–3 work already on this branch.

- **Priority 4** — an activation-scoped runtime protocol (v3): explicit identities, a private
  `MessageChannel` transport, document and activation state machines, and a reveal invariant.
- **Priority 5** — posters keyed by presentation identity, a layered presentation surface, and a
  publish-time browser canary that classifies packages.
- **Priority 6** — a managed section lifecycle in the generated child bridge, with a real resource
  scope and honest automation, audio, WebGL and suspension contracts.

Specification: `md-files/SIM-RUNTIME-PROTOCOL-V3.md` · Rollout and rollback:
`md-files/SIM-P456-ROLLOUT.md`

**Nothing here changes how any package behaves in production until an explicit, reversible rollout
step is taken.** A package must be regenerated *and* classified `managed-presentable` by a real
browser canary before the player will use the modern path. Every package in storage today has a
null classification, which is treated exactly as legacy.

### The v3 reveal path is not yet reachable for a generated package — stated up front

The generation prompt produces **cleanup-closure** section bodies. The child runtime wraps those as
legacy (`toLifecycle`), so `capabilities()` honestly reports `managedLifecycle: false` and
`onDemandRender: false`, `classifyCanaryReport` caps the package at **`managed-partial`**, and
`enableModern` declines. Following the rollout in `SIM-P456-ROLLOUT.md` end to end therefore lands a
real package on `managed-partial` and leaves it on the v2 path.

That is the protocol refusing to accept a promise the package cannot keep — the behaviour is
correct — but it means **Priority 4's reveal path and Priority 5's layered presentation are, today,
exercised only by the v3 fixture packages and not by any customer package.** Reaching
`managed-presentable` requires teaching the generator to emit `ManagedSectionLifecycle` bodies that
call `markPresented()` and allocate through `ctx.scope`. That work is **not in this PR** and is
named as the next step in the rollout doc.

What this PR does deliver for real packages: the v3 runtime is embedded in every regenerated bridge
(so a package can be canaried at all), the canary classifies honestly, the v2 path is unchanged, and
the whole modern path is proven end to end against fixture packages in three browsers.

---

## Why a second protocol

Every wrong-frame incident in this pipeline has the same shape: a message that was *true about some
past state* arrived and was applied to the present. Three successive attempts to close that by
narrowing the comparison each left a hole:

| Attempt | Compared | Why it was insufficient |
|---|---|---|
| section name | `SCRIPT_APPLIED.script === pendingScript` | A → B → A produces two activations with the same name |
| + activation token | `token === activationToken` | Unique only within one parent's lifetime; meaningless after a reload |
| + `contentWindow` | `e.source === frame.contentWindow` | `contentWindow` belongs to the **element** and survives navigation |

A name is not an identity, a counter is not an identity, and an element is not a document. v3 puts
an explicit identity on every message and moves protocol traffic onto a transport a dead document
cannot reach. **v2 is not removed** — it still ships and is what every stored package speaks.

---

## Priority 4 — the protocol

**Identity.** Six axes, each independently able to go stale: `playerSessionId`, `packageRevision`,
`documentId`, `activationId`, `variantKey`, `configHash`. `seq` is transport bookkeeping, not
identity. `documentId` is deliberately not the iframe element identity — that is precisely the
mistake `contentWindow` comparison made. `activationId` is what makes A → B → A safe.

`configHash` uses a pure-TypeScript SHA-256 because the same hash must be computed in three places
that share no crypto API: the backend (`node:crypto`), the browser player (WebCrypto, but async —
and the hash is needed synchronously inside an activation) and the generated child bridge (neither).
Verified against the FIPS 180-4 vectors and differentially against `node:crypto`.

**Transport.** `child hello → parent offer + MessagePort (exact origin) → child validates → adopts →
accept on the port`. Everything after bootstrap is port-only. The child refuses an offer unless all
hold: `event.source === window.parent`; `event.origin === offer.parentOrigin`; correct kind and
version; all three identity fields; exactly one port. A later valid offer carrying a **new document
epoch** replaces the port (the only recovery from an abandoned handshake); a repeat offer for the
epoch already adopted is refused and its port closed, because adopting it would race the parent's
own offer loop.

A `srcDoc` frame, or one sandboxed without `allow-same-origin`, has an opaque origin — there is no
exact origin to address, so those surfaces stay on v2 and are classified legacy. That is an honest
outcome, not a security exception.

**The reveal invariant.** A live iframe may have effective visible opacity only when the
acknowledgement matches on all five identity axes. The comparison is written as separate statements,
not a loop over field names — a loop reads fields dynamically, so adding a sixth axis and forgetting
to compare it would still typecheck *and* still pass a loop-based test.

On the modern path **there is no force**. A v3 package promised `SECTION_PRESENTED` by completing
the handshake, so a timeout produces a bounded failure, never a frame nothing vouched for.
`SECTION_PRESENTED` carries `framesSubmitted` and the parent refuses any acknowledgement claiming
zero. Every wait on this path is bounded and every bound leads somewhere: prepare and present have
their own timeouts, and the handshake window — including the gap between a child adopting the port
and reporting readiness — is bounded into the same failure rather than held open.

---

## Priority 5 — posters, layers, canaries

Posters are keyed by `packageRevision + variantKey + configHash + aspectProfile + qualityProfile`,
stored under the simulation's own prefix so deleting a simulation removes them with it. There is no
fallback to another identity's poster.

The layered surface is `top: poster/cover/recovery · middle: incoming · bottom: outgoing`. The
incoming frame is reachable only from a matched `SECTION_PRESENTED`; there is no timer in either the
policy or the component. The resident pool is rendered in one fixed slot and never re-parented —
React rebuilds a subtree whose parent changes, which would destroy every warm iframe on each
hand-back to video.

The canary drives a staged package through the full protocol in a real browser, captures posters at
each size, and classifies. An aborted run yields `failed`, never a downgrade to a legacy class —
`legacy-cooperative` is a statement that the package was *observed* behaving cooperatively, and an
aborted run observed nothing. `sim-canary-publish.ts` is the gate: dry-run by default, refusing an
incomplete report, a stamped classification the report's own steps do not support, and a modern
grant whose posters are missing.

---

## Priority 6 — managed lifecycle

`ManagedSectionLifecycle` replaces the single cleanup closure, which could not answer any of the
questions the player actually needs answered — has your first frame been submitted, stop automating
but keep the scene, go quiescent, release your GPU memory, you are muted now. Each of those had at
some point been answered by the player *guessing*.

The managed scope tracks rAF, timers, listeners, AbortControllers, fetches, Workers, ports, media,
Web Animations, AudioContexts/nodes, object URLs, ImageBitmaps, observers and Three.js resources,
with pause / resume / release / dispose, real counters and a leak report that can genuinely be
non-empty. A body returning a plain cleanup function is wrapped and classified **legacy**.

---

## Defects found and fixed

Every one was found by a test or an independent reviewer, not by inspection. Four were
unreachable-by-construction — code that was tested, passing, and enforcing nothing:

| Defect | Consequence had it shipped |
|---|---|
| `capabilities()` read the *installed* lifecycle, necessarily null at `INIT_DOCUMENT` | `managedLifecycle`/`onDemandRender` false for **every package that could exist** — the modern path dead code in production while every test passed |
| `mayReveal` compared the same object on both sides | all five mismatch branches unreachable from production |
| `enableModern()` starts a 5-hop async handshake; `activate()` ran synchronously after it | the modern path never activated on first entry, then nothing could satisfy it and no timer was armed to fail |
| `DISPOSED.leaked` could never be non-empty | a reviewer replaced the payload with a hardcoded `[]` and nothing failed |

An independent release-readiness review by two reviewers who did not author the work then found four
more, from a clean checkout:

| Defect | Consequence had it shipped |
|---|---|
| the viewer composited on `modern-section-presented`, emitted *before* the reveal gate runs, and ignored `modern-reveal-refused` | a context lost before `markPresented` left a dead-context iframe at full opacity for the rest of the section, with nothing to clear it |
| `sim-canary-publish` defaulted to a poster directory the canary never writes | the documented Stage 2→3 rollout hit `EXIT.POSTERS_MISSING` on every `managed-presentable` package — Stage 3's outcome was unreachable |
| a context lost *after* reveal had no bound | the activation parked in `RENDERING` with no failure, no recovery surface and no retry; `SIM_CONTEXT_RESTORE_TIMEOUT_MS` existed and was referenced by nothing |
| `shared`'s typecheck passed only because TypeScript's `@types` walk escaped the repository into the developer's home directory | `pnpm --filter shared typecheck` would have failed on CI's first run |

Two genuine flakes were also found by rerunning the gates from a clean worktree several times
(2-in-5 and 1-in-6): both were real races on asynchronous render pipelines, both now wait for the
condition with a bounded timeout that still fails if it never arrives. Neither assertion was
weakened. Confirmed by eight consecutive clean full-suite runs.

Also fixed: the port offer was addressed to the pre-rebase origin (silently discarded on any
environment but the one the row was saved under); `packageRevision` split *within* one package;
`undefined < 1` let a frameless acknowledgement authorise a reveal; the child accepted an array
payload the parent rejects; suspended documents never resumed their render loop;
`AUTOMATION_PAUSED` was acknowledged for automation that kept ticking; a leaked `MessagePort` pair
per navigation; and wrapping the resident pool in the layered surface destroyed every warm iframe on
each exit to video.

Four were introduced by earlier fixes **in this same change** and caught before merge: a
port-replacement rule that raced the parent's own offer loop; an opaque cover that painted over the
frame it was meant to stand in for; a deferral that returned without holding, leaving the v2 paint
path free to present a document with nothing applied; and a reveal gate keyed on `modernActive()`,
which goes false on a confirmed suspend — so the entire five-axis invariant was bypassable via the
legacy branch, and the fix for it initially left a legitimately-legacy package permanently invisible.

The last of those exposed a **blocking** defect underneath: `DOCUMENT_RESUMED` had no handler at
all. The child sends it, the protocol accepts it, and the document machine's only edge out of
`SUSPENDED` is `RESUMED` — but nothing dispatched it, so one confirmed suspend left the document
suspended for the rest of the session. The resident pool suspends frames routinely while warming
them, so an ordinary scrub-away-and-return reached it.

---

## Corrections to earlier claims in this PR's history

Stated plainly because they were reported as green and were not:

- **"lint ×3: 0 errors"** was false — real exit codes were `1, 1, 0`. The measurement piped ESLint
  through `tail` and counted summary lines instead of reading the exit code. Backend had 567 parse
  errors from ESLint reading `.local-storage/hls/**/*.ts` — MPEG-TS **video segments**, not
  TypeScript. Fixed by ignoring that gitignored dev-only path; client had two genuine
  `no-useless-assignment` errors, fixed by asserting the discarded transitions.
- **"rebuilt-package 12/12 ×3 engines"** was stale — the suite had regressed to **12 skipped**
  because it depended on a dump that required production storage.
- **"all shared tests / all admin tests"** were never run — neither package had a test runner.
- **Protocol browser coverage** was overstated: `sim-protocol`, `sim-canary` and `sim-leak`
  *re-express* `SimTransport` rather than importing it, so the shipping parent transport had no
  browser coverage at all. `e2e/sim-transport.spec.ts` now bundles and drives the real module.

---

## Verification

Every number below is a real exit code from a run against a frozen tree (no concurrent edits,
`--retries=0`, `--workers=1`). Zero failed, zero flaky, zero skipped, zero `fixme` anywhere.

| Gate | Exit | Result |
|---|---|---|
| `tsc --noEmit` — shared / backend / client / admin | 0,0,0,0 | 0 errors |
| `eslint` — backend / client / admin | 0,0,0 | 0 errors |
| **shared** vitest (new runner) | 0 | **547** |
| **backend-api** vitest | 0 | **1125** |
| **client-web** vitest | 0 | **700** |
| **admin-web** vitest (new runner) | 0 | **34** |
| ops/release vitest | 0 | **237** |
| `sim-transport` — the REAL SimTransport, ×3 engines | 0 | **27** |
| `sim-protocol` ×3 engines | 0 | **48** |
| `sim-leak` ×3 engines | 0 | **36** |
| `sim-canary` | 0 | **11** |
| `sim-transitions` ×3 engines | 0 | **36** |
| `rebuilt-packages` ×3 engines | 0 | **12** (previously 12 *skipped*) |
| `viewer-e2e` chromium / firefox / webkit | 0,0,0 | **25 / 25 / 25** |

Isolated production builds (copied tree, symlinked `node_modules`, so no dev server's `.next` is
touched): shared, backend-api, client-web, admin-web — all exit 0.

### Mutation testing

Protections are proven load-bearing, not assumed. Every mutation was applied to the real source, the
protecting suite run, and the file restored byte-for-byte (verified by sha256 and `git diff`).

| Target | Mutations | Killed |
|---|---|---|
| protocol / poster / canary modules | 10 | 10 |
| `SimTransport` (real module, in-browser) | 4 | 4 |
| `SimRuntimeClient` v3 integration | 6 | 6 |
| reveal gate · `DOCUMENT_RESUMED` handler | 2 | 2 |
| migration 049 SQL | 4 | 4 |
| poster/canary destructive guards | 4 | 4 |
| viewer compositing authority | 1 | 1 |

Two scopes stated honestly rather than rounded up:

- Deleting `holding = true` from the handshake deferral kills no test. An independent reviewer
  showed my original explanation for this was **wrong** — I had called it redundant, but the
  deferral's own bound read that same field, so it was load-bearing for a reason its comment denied.
  The bound now has its own flag (`handshakeDeferred`), which is what made the line genuinely
  narrow in scope, and the comments say what is true.
- The viewer-compositing regression kills the original **pair** (composite on the acknowledgement
  *and* ignore the refusal), not either half alone — either half is sufficient to fix it, so neither
  is individually observable. Verified by mutation rather than assumed.

### Migration 049 — verified without touching the shared database

`backend-api/src/db/__tests__/migration049.test.ts` replays the real migrations 001–048 into PGlite
(an in-process Postgres), then applies the real 049 on top — replay rather than hand-built ancestor
tables, because a hand-written `simulations` would inevitably be written from the post-049 schema,
which is the assumption under test. **23 tests**: applies cleanly, idempotent, pre-existing rows
survive with the four new columns NULL, the real Drizzle query shapes work afterwards, every
constraint and the CASCADE hold, and the rollback round-trip restores the exact pre-049 catalog.

It also asserts the **failure mode**: before the migration those same queries raise `42703`
(`42P01` for `sim_posters`). That is the regression test for the deployment-ordering hazard — the
one thing that would have caught it.

---

## Data safety

No production database, storage, rebuild or merge occurred at any point. Migration 049 was **not**
applied to the shared preview/production database (per `CLAUDE.md`, preview and production share
one). It is proven instead against an isolated PGlite database, including the pre-migration `42703`
failure mode that makes the deployment ordering explicit.

---

## Remaining rollout requirement

**Physical-device validation is outstanding and is not claimed anywhere in this PR.** Safari on a
physical iPhone, at least one constrained Android device, and one older/integrated-GPU desktop
remain prerequisites for a broad rollout. Desktop WebKit is the closest available proxy and runs on
every gate, but it is not a substitute and is not reported as one.
