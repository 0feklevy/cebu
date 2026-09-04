# signals — 2026-09-04T1507

[from:simulation → to:security] podcast-saas/backend-api/src/services/storage/R2StorageAdapter.ts:335
`getSimPublicUrl` returns the raw R2 bucket URL, unlike the Local and Supabase adapters which route
through `/sim-public/*`. On the staged R2 cutover this removes the sim CSP (`frame-ancestors`), the
`nosniff`/CORP headers and the revision publication gate (`revisionIdentity.ts:72`), so an
unpublished revision's bytes become world-readable at a guessable-from-any-player-config URL.
(ref simulation-001)

[from:simulation → to:security] podcast-saas/backend-api/src/services/storage/mediaAccess.ts:70
The `simulations/` branch's comment reads as though `/sim-public/*` now calls `canServeMediaKey`. It
does not — commit 7231bb7 deliberately deferred it ("would BREAK AUTHORING… three of the seven
simulations in production belong to private projects"). security-005 is still open; please confirm
it is still tracked, and consider correcting the comment so it does not read as closed.
(ref simulation-013)

[from:simulation → to:database] podcast-saas/backend-api/src/services/project/ProjectDuplicationService.ts:2170
`jsonbScanExpression` applies `jsonb - 'duplicatedFrom'` to `sim_revisions.metadata` with no
`jsonb_typeof` guard, while `residualExpression` in the mirrored script guards every case and
explains why (22023 on a scalar). Production is known to hold jsonb string scalars in columns
written through the drizzle codec (`timeline_sections.sim_meta`, verified by the owner
2026-09-04; `db/jsonb.ts:5-11` documents the mechanism). (ref simulation-005)

[from:simulation → to:database] podcast-saas/backend-api/src/services/simulation/PosterService.ts:167
`variants` is written through the drizzle jsonb codec against
`sim_posters_variants_array_chk` (`049_sim_posters.sql:41`, `jsonb_typeof = 'array'`). If the codec
produces a string scalar, every poster insert violates the constraint. One read-only query settles
it: `SELECT jsonb_typeof(variants), count(*) FROM sim_posters GROUP BY 1`. (ref simulation-006)

[from:simulation → to:media-pipeline] podcast-saas/backend-api/src/services/export/capture/isolation/containerCaptureProvider.ts:89
`parseServedSimUrl` requires a `/sim-public/` segment; under R2 no served sim URL has one, so
`CaptureUnavailable` fires for every section and every sim window degrades to a poster. The
degradation is correctly recorded (`quality_state: 'degraded'`), so this is a total, labelled loss
of motion triggered by an env change rather than a silent one. (ref simulation-008)

[from:simulation → to:performance] podcast-saas/client-web/components/viewer/useProjectPlayer.ts:462
Pool tier is `canWarmUnpaused()` (deviceMemory/cores/saveData/coarse-pointer) only; at tier `all`
four packages mount up front regardless of bytes. With a 35 MB package that is ~140 MB of downloads
at t=0 contending with the HLS start. `analyzeWeight` already measures the bytes at publication
(`RevisionService.ts:475`) and nothing consumes the number. (ref simulation-004, simulation-010)

[from:simulation → to:fleet-maintainer] .claude/reference/stack.md:193
`SimBridgeContract.ts` is described as the host↔child message protocol. It is the static
replace-compatibility checker and declares no message types. The wire protocol is
`shared/src/sim/*` + `services/simulation/simRuntimeChild.ts` +
`client-web/lib/sim/SimRuntimeClient.ts`. (ref simulation-014)
