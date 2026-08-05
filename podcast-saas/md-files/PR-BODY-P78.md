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

**Four modules ship as libraries with no caller** — planner, rVFC sentinel, adaptive quality, weight
analysis. Merging changes viewer behaviour in exactly two ways: timings recorded in memory, and two
new config fields. See `md-files/P8-ROLLOUT-AND-DEVICE-VALIDATION.md`.

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

Clean worktree at `32691ce`, all exit codes `0`:

| | shared | backend | client-web | admin-web |
|---|---|---|---|---|
| tsc | 0 | 0 | 0 | 0 |
| lint errors | — | 0 | 0 | 0 |
| unit tests | 762 | 1333 | 763 | 34 |

**2,892 unit tests.** Browser matrix on **chromium, firefox and webkit** (`workers=1`, `retries=0`):
sim-transport 9, sim-protocol 16, sim-leak 12, sim-canary 11, sim-transitions 12, rebuilt-packages 4,
viewer-e2e 33 — each, per engine. `sim-pool` 6 skipped (env-gated, needs a live app).

**~130 mutations across Priorities 7–8, all killed.** Several survived a first pass and each one
taught something: predicates that killed only pairs, a refused-reveal test whose distortion never
reached the mutated line, guards that were genuinely unreachable and were deleted rather than
defended.

## Not done, and not claimed

- **No physical device has run any of this.** Desktop WebKit is not Safari on iOS, and the WebKit
  build on this host is frozen for `mac14-arm64`.
- **rVFC field support is unknown** — no browserslist, no analytics. That is why it is not wired.
- The planner, sentinel, adaptive quality and weight analysis have **no callers** in the viewer.
- Closed-loop adaptation is a tested controller with no RUM feeding it.

## Operational

Nothing merged. No production storage, publication, rebuild or rollout performed. Migrations 049,
050 and 051 were applied to the **development** database at the owner's explicit request after the
missing-migration `42703` failures were reported; all three are additive and idempotent, and
`db:check` reports OK.
