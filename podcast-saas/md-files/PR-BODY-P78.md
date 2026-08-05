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

See the Verification section below for the exact final numbers.

**On the mutation claim:** mutations here are run by hand — applying a change, running the targeted
suite, reverting — with no config or artifact in the tree, so the count is a process assertion and
nothing in CI reproduces it. Treat the specific mutations named in this document as the checkable
part; the total is not independently verifiable and is stated as such.

That method also produced a false result once, worth recording: the harness restored files with
`git checkout --`, which discarded uncommitted edits along with each mutation, so four mutations
reported as "killed" by tests that were failing for an unrelated reason. The harness now snapshots
the working tree.

## What an independent review found, after the work looked finished

An adversarial review of the complete diff ran after this branch was believed done. It found real
defects, and the pattern in them is worth stating: **every one was invisible to a green test suite,
because the tests were structurally unable to see it.**

- **Field refinement had never worked.** `= ANY(${array})` renders as `= ANY(($1,$2))`, which
  Postgres refuses. `tsc` was happy, the caller's test mocked the function wholesale, and its own
  `catch` returned an empty map — which is exactly what "no samples yet" looks like. The new suite
  EXECUTES the statement against a real engine; all 7 of its tests fail against the old query.
- **Adaptive quality was fed by its own output.** `resolveBudget` prefers a measured p90 and returns
  `p90 x 1.25`, so the controller asked whether `p90 > 1.25 x p90` — false always. Pinned to `high`
  for a device six times over budget. Both modules were individually correct; only the join was
  wrong, which is why nothing caught it. The join now lives in one tested function.
- **The boundary sentinel never armed.** It latched its target before arming, and arming refuses
  beyond a 0.35 s horizon — every tick but the last. Its own test accepted `mode: 'none'`, so it
  passed while the feature had never run once.
- **The RUM rate limit was keyed on `request.ip`** under `trustProxy: true` — the caller's own
  header. Its test built a bare Fastify with no `trustProxy`, so it passed on a stack that does not
  exist in production.
- **`dropped` fanned out across every row of a batch and was then summed**, so one drop in a hundred
  read back as a hundred and disabled field budgets for that package for the whole window.

Full list, and the two findings declined with reasons, in the commit
`fix: close the confirmed findings from the independent review`.

## Not done, and not claimed

- **No physical device has run any of this.** Desktop WebKit is not Safari on iOS, and the WebKit
  build on this host is frozen for `mac14-arm64`. This is the one blocker to a rollout that no
  amount of further work in this repository can clear.
- **rVFC field support is unknown, and this branch does not measure it.** The sentinel records which
  mechanism armed, but through `simTelemetry` — inert without `?simdebug=1`, and transmitted
  nowhere. Routing it through RUM is a follow-up.
- **No feature here has run with its switch on outside the test suite.** Every switch defaults off,
  and staged enablement is the rollout plan's job, not this PR's.
- **No GPU or per-simulation CPU attribution.** Neither is exposed in a way attributable to one
  iframe; resident-document count is reported instead. See `md-files/P8-MEASURED-EVIDENCE.md`.
- **The concurrency tests are not races.** PGlite serialises transactions, so they prove the SQL is
  correct under both serial orderings — not row-lock blocking or unique-index waiter behaviour under
  true concurrency. That rests on the design argument, not on anything that runs.
- **`RevisionService.activate` / `rollback` / `gc` / `recordCanary` have no production callers yet.**
  The read side IS wired, so anything that sets the pointer is served immediately.

## Operational

Nothing merged. No production storage, publication, rebuild or rollout performed. Migrations 049,
050, 051 and **052** were applied to the **development** database at the owner's explicit request
after the missing-migration `42703` failures were reported; all are additive and idempotent, and
`db:check` reports OK on all four.

**Deploy ordering is mandatory and not automatic: migrate, then deploy.** Nothing applies migrations
at boot, and eight call sites read `admin_settings` with no explicit `columns` list — two of them on
public or rate-limited paths — so an image deployed ahead of its migration raises `42703` there.
Rollback is the reverse, and 051/052 are coupled. Both directions are written out in
`md-files/P8-ROLLOUT-AND-DEVICE-VALIDATION.md` §4 and §7.
