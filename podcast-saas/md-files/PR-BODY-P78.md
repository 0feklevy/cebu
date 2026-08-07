# Simulation pipeline — Priorities 7–8

Immutable package revisions, atomic publication with verified rollback, and the measurement
foundation for predictive scheduling.

Separate from the Priorities 4–6 PR (`feat/sim-pipeline-hardening`), which this branch builds on
and does not modify.

---

## Priority 7 — immutable revisions

**A revision fixes half-updated packages by construction, not by timing.** Publication used to
overwrite one mutable prefix in place: `bridge.js` and the entry HTML are two separate writes, and
a viewer landing between them received new bridge bytes under the old cache key. Every file of a
publication now lands under a prefix containing a never-reused revision id, so a concurrent reader
cannot observe a partial write at all — it is reading a different prefix. Going live is one row
update.

**No in-process lock, deliberately.** `withBridgeLock` is per-instance and three call sites each
build their own service with an empty lock map, so it serialises nothing across the cluster.
Correctness here comes from never-reused prefixes plus three compare-and-sets backed by
`uniq_sim_revisions_active`, a partial unique index, which is cluster-wide.

**The canary verdict is re-projected, not cleared.** Activation and rollback change which bytes are
served without touching `bridge_hash` — the thing that clears the row-level verdict. Because the
verdict now lives on the revision, activate and rollback are the same operation: both copy the
target's own columns onto the row inside the pointer-flip transaction. Clearing would be safe on
activate and wrong on rollback, discarding a verdict valid for exactly those bytes.

**Verification that admits what it cannot see.** Every published file is read back and re-hashed —
an upload that resolves is not proof the object landed. Object metadata is different: `objectExists`
already sent a HEAD on both cloud adapters and threw the response away, so `contentType` and
`cacheControl` in a manifest were claims about an upload call wearing the clothes of observations.
Added `headObject`; where an adapter cannot report metadata the report counts it `metadataUnverified`
and never folds it into verified.

**Publication and activation are separate on purpose.** Activation flips the identity axis, and every
`sim_posters` row is keyed on the old value with no fallback in the lookup — activating before a
poster re-capture blanks every poster on the package. `migrate-sim-revisions.ts` publishes and stops.

Migrations 050 and 051 are strictly additive; every existing simulation gets `active_revision_id =
NULL`, which is precisely the state the fallback handles.

## Priority 8 — measurement first

**Nothing in this pipeline had ever measured a transition.** `SimRuntimeClient` read no clock, and
the child's own numbers — `applyMs`, `framesSubmitted`, `canvas` — were computed, put on the wire,
validated on arrival and dropped. This was plumbing, not instrumentation.

Durations are **null when unknown, never zero** (zero is achievable, so it makes "never observed"
indistinguishable from "instantaneous"). Percentiles are **nearest-rank**, so every value reported
actually occurred. `deriveLeadMs` returns its source, so nobody can mistake a constant for evidence.

**Lead time comes from measurement or from the package's own canary — never a compiled-in constant.**
`BUDGET_STEPS` spans exactly what the field measurement spans; including document load made the two
incomparable, and the budget would have *shrunk* once field samples arrived, at the moment the
planner uses it as the lead window for loading a package.

**RUM is off at every layer.** An unparseable env var is 0, a missing column is 0, a DB error is 0 —
and ingestion checks the rate server-side, because on an unauthenticated endpoint "no honest client
sends" is not "nothing is stored". Rate-limited per IP, retention enforced by a running reaper,
nothing identifying stored.

**Every module has a production caller, and every caller is off by default.** The planner, the rVFC
sentinel and adaptive quality are wired into `useProjectPlayer` behind the migration-052 switches,
which all default to today's behaviour; weight analysis runs at publication and is advisory. With
the defaults, merging changes viewer behaviour in exactly two ways: timings recorded in memory, and
new config fields.

**"Wired" is a checkable claim, and it claims reachability — not effect.** Each call site emits its
own evidence, `P8a`–`P8e` assert on that evidence with the switch on, and one mutation per call site
(five, all killed) proves deleting any one turns its test red.

What that does *not* prove is that each feature changes what a viewer sees, and for adaptive quality
it does not: the decision reaches the activation identity, but the child runtime never reads
`quality`, so the only observable effect is a changed `configHash` — poster invalidation for no
benefit. Its switch exists to stay off until the child applies it, which means republishing
packages. The per-feature table in `md-files/P8-ROLLOUT-AND-DEVICE-VALIDATION.md` §1 states this for
all three.

## Bugs found and fixed in review

- **The backend could not boot from its emitted JavaScript.** Ten files imported `shared/src/sim/*`,
  which resolves to raw TypeScript; `node dist/server.js` died with `ERR_MODULE_NOT_FOUND`. Nothing
  in the pipeline executes `dist`, so vitest and `tsc --noEmit` were both green. Fixed with a
  runtime-correct subpath, and guarded by a test that imports every shared specifier.
- **`rawActivation` was a string coincidence.** `SimulationService` mints `?section=<the row's own
  id>`, so the comparison was true for almost every section — disabling the `SCRIPT_MISSING`
  protection product-wide. Now structural, with fixtures using the production URL shape that every
  existing fixture avoided.
- **`sim_prepare_budget_ms` was always empty** — it read `canary_report.steps`, and steps live under
  `cases[]`. A cast let it compile. Its test asserted on its own invented fixture shape.
- **Backend tests were running against stale built `shared`.** A mutation of a shared source file
  survived a test that should have killed it. vitest now aliases to source.
- Three pre-existing viewer flakes, diagnosed to a real product race: `revealSim` drops a reveal if
  the warm generation moves before its double-rAF, and nothing retries.

## Verification

Final commit: `feat/sim-immutable-revisions` HEAD (see the PR's commit list). Prompt 1 (`8eeea47`) is an ancestor.

### Local gates (clean `git worktree` checkout of the final commit)

| | shared | backend-api | client-web |
|---|---|---|---|
| `tsc --noEmit` | ✅ | ✅ | ✅ |
| lint errors | 0 | 0 | 0 |
| unit + integration tests | 805 | 1420 | 827 |

(`admin-web` typechecks and lints clean; it has no tests in this area.)

Also run from that clean checkout, each with its real exit code: `pnpm install --frozen-lockfile`;
`shared` and `backend-api` builds; **the emitted backend booted under plain `node dist/server.js`**
and answered `/health` 200 (no `tsx`, no vitest aliases); `shared/sim/*` resolved from an emitted
consumer to `shared/dist/...` and not to source; migrations 049–052 applied to a **fresh** database
with `sim_revisions` and `sim_rum_events` present afterwards; and the synthetic fixture seeded and
deleted against that database.

### Browser matrix

Nine suites × chromium/firefox/webkit, `workers=1`, `retries=0`, **zero skips**, against an isolated
local stack (local Postgres, local disk storage, locally encoded HLS, local Firebase Auth Emulator).
CORS was verified returning `http://localhost:3010` *before* the run started — a previous matrix was
discarded for having run without it, and is not counted here.

| suite | chromium | firefox | webkit |
|---|---|---|---|
| sim-transport | ✅ | ✅ | ✅ |
| sim-protocol | ✅ | ✅ | ✅ |
| sim-leak | ✅ | ✅ | ✅ |
| sim-canary | ✅ | ✅ | ✅ |
| sim-transitions | ✅ | ✅ | ✅ |
| rebuilt-packages | ✅ | ✅ | ✅ |
| viewer-e2e | ✅ 38 | ✅ 38 | ✅ 38 |
| sim-pool | ✅ 8 | ✅ 8 | ✅ 8 |
| sim-perf | ✅ | ✅ | ✅ |

**27 of 27 suite-engine runs exit 0, zero skips.**

Every sim-pool test reports the hosts it contacted. Observed across the whole run: `localhost`,
`127.0.0.1` — plus `198.51.100.1` in exactly one test, the guard's own self-test, which fires a
deliberate request at an RFC 5737 TEST-NET address (non-routable, DNS-free) and requires the guard to
have **blocked and recorded** it. That is the one test a disabled guard cannot pass; without it, a
no-op guard reports the same empty violation list as a passing run.

### Mutation matrix

**59 mutations at the final commit: 56 individually KILLED; 3 formally classified as
equivalent/redundant, with the combined-removal mutation KILLED.** That is deliberately not written
as "59/59 killed", because it is not literally true — three mutants cannot be killed individually,
and the reason is a property of the code, not a gap in the tests. Each is documented below.

Harness rules: a private byte
snapshot per mutated file, SHA-256 verified byte-identical restoration, a *named* expected assertion
(a suite that fails for any other reason is AMBIGUOUS, never KILLED), a transform/syntax failure is
AMBIGUOUS, and the working tree is verified clean after every mutation.

Three process notes, recorded rather than smoothed over:

- **Two mutations SURVIVED the first full run**, and both were my own test-adequacy failures of the
  same kind: the predicate was pinned, the *call site* was not. Deleting `isSystemOwnedKey(k, prefix)`
  from the replace sweep left the shared predicate suite green while `processReplace` went back to
  deleting revisions; and removing the reaper's `LIMIT` still drained the backlog and still totalled
  correctly, because asserting the total cannot observe a per-statement bound. Both now have killing
  tests (a source-scrape wiring test, and a `db.delete` wrapper that records each pass), and both
  re-run KILLED. A survivor is the harness working.
- One run was **discarded** because I edited a file while it was in flight; the harness's clean-tree
  check caught it, and the interrupted mutation was restored from its byte snapshot (verified equal
  to the committed blob) before re-running.
- Three specs initially reported AMBIGUOUS ("original snippet not found") because they were written
  against an older HEAD, and one reported AMBIGUOUS because the mutation was killed by a *different*
  named assertion than predicted. All four were re-anchored and re-run rather than counted.

### The three equivalent/redundant mutants, in full

All three target the refused-activation fix. They share one root cause: that fix deliberately places
the same invariant behind **two independent guards**, so removing either one alone leaves the other
enforcing it. No production code was changed to make these die — changing code to kill an equivalent
mutant would be optimising the score rather than the software.

The two guards:

- **Guard A** — `SimRuntimeClient.ts`, `SECTION_APPLIED`: reduces first and returns if the reducer
  refused (`applied.state !== 'APPLIED'`), so `sendPresent()` is never reached in a refused state.
- **Guard B** — `SimRuntimeClient.ts`, `sendPresent()`: reduces first and returns if the reducer
  refused (`advanced.state !== 'RENDERING'`), so `PRESENT_SECTION` is never posted and the terminal
  present bound is never armed in a refused state.

| # | Mutation | Removes | Redundant because | Made redundant by |
|---|---|---|---|---|
| 1 | `present-arms-behind-refusal` | Guard B | `sendPresent()` has exactly **one** call site, and Guard A returns before it whenever the reducer refused. The mutated line is therefore unreachable in a refused state. | Guard A |
| 2 | `present-timer-not-cleared` | The leading `clearPresentTimer()` in `sendPresent()` | `APPLIED` is legal only from `PREPARING`. After the first entry the state is `RENDERING`, so a repeat `SECTION_APPLIED` is refused by Guard A and never re-enters `sendPresent()`. There is never a stale timer to clear. | Guard A |
| 3 | `presented-refusal-leaks-timer` | `clearPresentTimer()` on the `SECTION_PRESENTED` refusal path | The bound is armed only in `RENDERING` (Guard B). Every edge out of `RENDERING` already clears it: `PRESENTED` is legal (no refusal), `RELEASE` runs through `deactivate()` which clears before releasing, and `FAIL` runs through `failModern()` which clears first. When a refusal is reached the timer is already `null`. | Guard B + the clears in `deactivate()` / `failModern()` |

**Proof that this is redundancy and not uncovered behaviour.** Removing all three targets in one
mutation — the true pre-fix state — fails all three named regression tests:

```
× FAILED: one real fault is not counted twice, and keeps its true failure kind
× RELEASED: scrubbing away mid-apply does not fail the package afterwards
× VISIBLE: a re-ack cannot hide a simulation that is already on screen
Tests  3 failed | 55 passed (58)
```

Restoration verified byte-identical by SHA-256, working tree clean afterwards. The behaviour is
therefore covered; only the individual mutants are unkillable, which is the definition of an
equivalent mutant. Guard B and the two `clearPresentTimer()` calls are kept as defence in depth: the
reducer's edge table is the kind of thing a future change edits, and the cost of keeping them is a
branch that never fires.

## What the independent review found — after the work looked finished

Four reviewers read the full `origin/main..HEAD` diff against the frozen commit. Every finding below
was verified against the source before being fixed; the list is what survived that check.

- **The replace flow deleted published revision bytes.** Revisions live under the simulation prefix
  and `processReplace` deletes everything under that prefix the new bundle does not contain, so an
  ordinary "replace simulation" swept every published revision — while the `sim_revisions` row
  survived and still activated, because the promote CAS checks `manifest_hash`/`entry_path` and never
  that the bytes exist. The pointer then resolved to nothing and every section 404'd; rollback died
  with it. Worse than total: a revision's own `bridge.js` matched the existing filename rule and
  survived while its `index.html` and `manifest.json` did not.
- **A bundle could write *into* a revision.** `normalizeSimulationPath` rejects traversal but not
  in-bounds paths, and revision ids are public (they appear in `simulation_url` in every player
  config) while revision bytes are served `max-age=31536000, immutable`.
- **The raw-reset reload armed nothing.** `rawNeedsNav` triggers a document reload but was omitted
  from the guard that arms polling, the paint deadline, the poster/spinner and the stall bound.
- **A successful raw presentation was reported as a failure**, tearing down the affordance and
  writing a RUM `failure` row for a working simulation.
- **`sendPresent` armed a second timer without clearing the first**, so a duplicate `SECTION_APPLIED`
  could later hide a simulation that had already presented.
- **The retention sweep was one unbounded `DELETE … RETURNING`** in the web process.
- **Three guards were unfalsifiable**: the seeder's storage refusal, the network guard's admission
  rule, and the bridge-write predicate were each pinned only as isolated behaviour, so deleting the
  *call site* left the repo green. All three now have wiring tests.
- **The retention sweep threw on every tick against the real driver, and no test could see it.**
  Found by BOOTING the emitted backend against real Postgres — not by any suite. The bounded-reaper
  change interpolated the cutoff `Date` straight into a raw `sql` fragment, where there is no column
  for the driver to infer a type from; postgres.js throws `ERR_INVALID_ARG_TYPE` before the
  statement is sent, so retention silently stopped being enforced while the table grew. PGlite,
  which the unit suite runs on, serialises a `Date` happily, so all 1,420 backend tests stayed
  green. Same class as the stale-`dist` and copied-SQL findings below: a test that cannot fail for
  the reason it claims to cover. The regression test now captures parameters at the driver boundary
  and asserts no `Date` is ever bound.
- **A refused activation transition still armed the terminal present bound.** Found by the LAST
  review, after the branch was believed final. `matchesActivation` compares identity only — never
  state — so a `SECTION_APPLIED` arriving once the activation is FAILED, RELEASED or VISIBLE is
  refused by the reducer, which signals that by returning the *same state object*. Both call sites
  assigned it back unchecked, so the refusal read as success: `sendPresent()` posted
  `PRESENT_SECTION` for a section that was failed, released or already on screen and armed the
  terminal bound behind it, guarded only by `(generation, activationId)` — neither changed by a
  refusal. It then fired `failModern('present-timeout')`: a second breaker failure for one real
  fault, the true failure kind overwritten by a fabricated one, and in the VISIBLE case a working
  simulation hidden behind the recovery surface mid-section. The `SECTION_PRESENTED` refusal path
  also returned one line above `clearPresentTimer()`, leaving the same bound armed on an activation
  that had in fact rendered.
- **A test pinned a hand-copied transcription of production SQL.** `bridgeVerdictClear.test.ts`
  drove its own `UPDATE` string and never imported `SimulationService`, so dropping
  `isNull(simulations.active_revision_id)` from the real predicate left every assertion green while
  production stomped the projected canary verdict of every revisioned simulation — demoting proven
  packages to the legacy path. The suite now also asserts against the production statement itself.

Corrected claims from earlier revisions of this document are listed under "Not done, and not
claimed" below rather than deleted.

## Not done, and not claimed

- **No physical device has run any of this.** Desktop WebKit is not Safari on iOS. This remains the
  one blocker to rollout that no further work in this repository can clear.
- **An earlier `6/6 sim-pool` result was retracted**, not amended: two of those tests were vacuous
  and the fixture did not exercise revision resolution as its own comment claimed. The fixture was
  rebuilt revision-backed (bytes written *only* under the revision prefix, active pointer set
  separately, legacy prefix deliberately empty) and the tests made falsifiable before any result was
  counted again.
- **An earlier browser matrix was discarded** for running without `PUBLIC_SITE_URL`/
  `NEXT_PUBLIC_APP_URL`, so CORS blocked the app origin. A later matrix was discarded for running
  against a tree I had since modified. Neither is counted.
- **Every browser measurement taken before the machine was rebuilt is void.** The development Mac
  was running an XMRig cryptominer at a load average near 190; any timing, cadence or resource
  figure recorded under that load says nothing about this code, and none of it is reported here.
  Every number in this document comes from the rebuilt machine at the final commit.
- **Three mutations of the final fix survived individually**, and are formally classified as
  equivalent/redundant in "The three equivalent/redundant mutants" above rather than counted as
  kills. The same investigation found the test could not tell "the guard refused the envelope" from
  "the harness dropped it", so it now asserts the refusal telemetry is actually emitted.
- **One mutation is recorded as an equivalent mutant, not as killed.** Removing the inner `catch` in
  the RUM transport's `send()` survives the suite because the `catch` in its only caller already
  covers it. Kept because the disable point is more precise there, and deleting error handling to
  raise a mutation score optimises the wrong thing.
- **`currentSrc.includes('/branch/')` can never match** — hls.js plays through MSE, so `currentSrc`
  is a `blob:` URL. Recorded because it was a wrong intermediate fix, not silently dropped.
- **rVFC field support is unknown**; the sentinel records which mechanism armed, but through
  `simTelemetry`, which is inert without `?simdebug=1` and transmitted nowhere.
- **No feature here has run with its switch on outside the test suite.** Every switch defaults off.
- **The concurrency tests are not races.** PGlite serialises transactions, so they prove the SQL is
  correct under both serial orderings — not row-lock behaviour under true concurrency.
- **`RevisionService.activate` / `rollback` / `gc` / `recordCanary` have no production callers yet.**
  The read side IS wired, so anything that sets the pointer is served immediately.

## Status classification

- **Implemented and invoked:** revision resolution in `buildPlayerConfig`, the legacy→revision
  migration, pool residency and eviction, transition marks, the hermetic browser gates.
- **Implemented but default-off:** RUM ingestion (`rum_sample_rate` 0), predictive scheduling,
  adaptive quality, the boundary sentinel.
- **Tested locally:** all of the above (unit, integration, PGlite migrations, synthetic fixture).
- **Verified in desktop browsers:** chromium, firefox, webkit.
- **Not validated on physical devices:** iPhone, constrained Android, older integrated GPUs.
- **Rollout-only limitation:** staged enablement of the default-off switches.

## Operational

Nothing merged. No production database, storage, publication, activation, migration, rebuild or
rollout was touched. All work ran against a disposable local Postgres, local disk storage, locally
generated packages and media, and a local Firebase Auth Emulator.
