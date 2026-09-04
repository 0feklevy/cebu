---
name: flowvid-2026-09-04-sim-review-fix-round-audit
description: audit of fix/sim-review-findings (commit 8682135) — all 5 sim-review findings verified DONE, wired, and tested
metadata:
  type: project
---

On 2026-09-04, branch `fix/sim-review-findings` (HEAD `8682135`) closed all five findings from
the `.claude/review/runs/2026-09-04T1507` sim-review. Audited each of 7 checklist items against
current code + ran the actual tests (not trusted the commit message) — **all 7 DONE**, no partial
or missing wiring found. This is a rare fully-clean round; worth remembering as a positive
baseline for "what thorough sim-subsystem work looks like" rather than another gap list.

Evidence anchors (podcast-saas/):
- P0 R2 `/sim-public` bypass: `R2StorageAdapter.getSimPublicUrl` routes through the proxy,
  `getSimAssetRedirectUrl` optional interface member + R2 direct-bucket impl,
  `MigratingStorageAdapter.ts:119-120` delegates with `getPublicUrl` fallback,
  `sim-public.controller.ts:378` uses `?? getPublicUrl`. Tests: `simP0Urls.test.ts` (new, 10
  assertions) + `migratingResolution.test.ts` updated off its old pinned-wrong assertion. Ran both: 10/10 pass.
- Poster live bug: `db/jsonb.ts jsonbValue()` used in BOTH insert values and onConflict set
  (`PosterService.ts:172,184`); `posterService.test.ts` has a real pglite-DDL test
  (`jsonb_typeof(variants) = 'array'`) that would fail on the naive `.values()` write. 56/56 pass.
- Duplication 22023: `jsonbScanExpression` (ProjectDuplicationService.ts:2168) and its
  `diagnose-duplication.ts` mirror both typeof-guard + parse before subtracting
  `duplicatedFrom`; two new pglite tests (scalar survives, escape-inside-scalar still caught).
  71/71 pass (~73s).
- P1 timeout: `shared/src/sim/simFailurePolicy.ts` `prepareTimeoutMsFor` used at BOTH
  `SimRuntimeClient.ts` arming sites (line ~968 handshake-deferred, ~1513 sendPrepare);
  `useProjectPlayer.ts` sets `rt.packageCost` from `packageCostByKeyRef`. 44/44 shared tests pass.
- P1 weight: `packageWeight.ts` has `'model'` in `WeightCategory` + categorize + `EMPTY()`;
  `buildPlayerConfig.ts:1155` emits `sim_weight_bytes` (double-encoding tolerance at line ~534,
  `Promise.resolve().then().catch` guard at ~527); `types.ts:285` declares the field;
  `useProjectPlayer.ts` builds `packageCostByKeyRef`, demotes tier via
  `poolWithinWeightBudget(collectSimPool(...), weightByKey)`; `lib/simPool.ts` exports
  `SIM_POOL_WEIGHT_BUDGET_BYTES` + `poolWithinWeightBudget`. 49/49 client tests pass.
- `runtimeValidated`: zero real hits anywhere (only comments referencing its removal);
  `simMetaShape.test.ts` field deleted from fixture. 6/6 pass.
- Ledger: `.claude/review/DECISIONS.md` line 70 — item 5 flipped to "✅ CLOSED", poster finding
  correctly upgraded from filed-P2 to "LIVE BUG", and line 77 honestly names the un-fixed residue
  (the double-encoding WRITE path itself — readers now tolerate it, root cause is a separate
  scheduled item).

No scope creep beyond the 7 claims; no false-green wiring gaps found. See [[flowvid-decisions-process]].
