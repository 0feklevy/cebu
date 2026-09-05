# Welcome-project seeding — the design (verified against the code, 2026-09-05)

**One shared template project + a per-user ROW-LEVEL clone. Zero media bytes copied per user.**
(Full agent verification with ~60 file:line citations ran 2026-09-05; key facts below are the
load-bearing ones. Re-verify line numbers before building — the repo moves fast.)

## Trigger
`seedWelcomeProject(userId, orgId)` fire-and-forget right after the user INSERT in
`backend-api/src/middleware/firebase-auth.ts` (~:183) — same `.catch(() => {})` shape as the
pending-invite claim just below it (:192-202). NEVER inside the try-block that 401s
(`session_persist_failed`). Backfill for existing users: the same helper called from
`GET /api/v1/projects` beside `backfillMissingThumbnails` when `users.welcome_project_id IS NULL`.

## Idempotency (three layers)
1. New nullable `users.welcome_project_id uuid` — **migration 085** (MUST be added to the
   hardcoded list in `db/migrate.ts` or it silently never runs), set in the SAME transaction as
   the project insert.
2. Partial unique index `uniq_welcome_project_per_user ON projects(created_by) WHERE
   is_welcome_seed` (SQL-only; drizzle's builder has no WHERE) — races insert once, loser adopts.
3. Fire-and-forget everywhere; failure logs and retries on next projects list.

## Clone method — reuse ProjectDuplicationService's vocabulary, NOT its byte-copy job
- `loadSnapshot(TEMPLATE_PROJECT_ID)` unchanged; `buildPlan` with a new `shareStorage: true`
  (zero StorageCopy entries; dest keys = source keys; IdAllocator still mints fresh ids);
  `commitRows` with new opts: `orgId` (today it inherits src org — the one real cross-owner
  defect), `title` override (bypasses the `" (copy)"` suffix), `hostIds: null`.
- **KEEP `retargetCopiedPackages`** (rewrites bridge.js `__SECTIONS__` to the clone's section
  ids — without it every sim section answers SCRIPT_MISSING) but write the rewritten
  bridge/guidance/manifest to a small per-clone revision prefix; heavy assets stay shared.
- **KEEP `assertNoEscapingReferences`** — passes because every shared namespace is
  project-id-free (`blobs/<digest>`, `hls/{videoFileId}`); `simulations/{projectId}/…` is NOT
  and must not be shared by prefix.
- Do NOT use the duplication JOB: migration 056's partial unique index allows ONE in-flight
  duplication per source project — every signup would serialize behind a minutes-long copy.
  Also `POST /:id/duplicate` is owner-only; a new user can't call it on a template.

## Storage strategy per asset (bytes shared, rows per user)
- **Video**: copy `hls_master_key`/`hls_360p_key`/`hls_status='ready'`/`duration_sec`/
  `captions_vtt`(TEXT)+`captions_status='ready'` verbatim; `storage_key = null`. Proven shape:
  `scripts/seed-sim-pool-from-production….ts:130-133`. Safe: project DELETE purges only the
  clone's own (empty) `hls/{newId}`; `hls/` isn't in storage-reconcile's sweep. **Never
  re-transcode the template** (retires the shared HLS tree).
- **Images/audio**: template media pre-claimed as blobs → clones copy `blob_id` + blob URL;
  `deleteWithFallback` structurally refuses `blobs/` deletes.
- **Simulations**: template sims seeded `sim_files`-backed (import path) → clone = new
  `simulations` row + copied `sim_files` rows; `resolveSimFileKey` serves shared blobs under the
  clone's (byte-empty) prefix. ⚠️ PRE-BUILD FIX #1: `ProjectDuplicationService` doesn't carry
  `sim_files` today (latent bug for any imported-sim project) — extend it, or upload (not
  import) template sims.
- **Posters**: the only real per-user bytes — re-key per clone identity (revision × new section
  id × aspect × config), a few small images. Reuse `planPosters`.

## What the clone must satisfy for clean playback (buildPlayerConfig reads)
`hls_master_key` URL; sections with `simulation_url` carrying `?section={newSectionId}`;
`simulations.status='ready'` + `active_revision_id`+`active_revision_entry_key` (paired CHECK)
+ `requires_import_maps` NOT NULL (null = viewer spins); posters at exact identity (no
fallback); `captions_vtt` per video row → CC + avatar/voice-ask knowledge (personaBake).

## Rollout gate (two layers, ships dark by construction)
`WELCOME_SEED_ENABLED==='true'` env (read per call) overriding
`admin_settings.welcome_seed_enabled` (default false, rendered in admin feature-flags page) +
`WELCOME_TEMPLATE_PROJECT_ID` env — absent = off.

## PRE-BUILD FIX #2
Publishing the template against production storage requires a deliberate, one-time operator
bypass of `seedGuards.assertLocalDatabase/assertLocalStorageOnly` (`ALLOW_NONLOCAL_DB=1`) — an
operator action, never something the seeder does.

## Content of the template (v2 — owner steers of 2026-09-05)
The seeded artifact is a PLAYLIST ("Welcome to Flow Video"): ① the demo project (teaser film →
Murmuration-3D section → tutorial film → Solar-System-3D section → Orbit-Lab section → image
infographic → choice section; A2 ambient sting) → ② film 3 "The Heavy Simulation" → ③ film 4
"Viewer Superpowers" → ④ film 5 "One Link, Three Doors" (each its own small public project).
Seeded sims are ONLY the license-clean originals in ../sims/ (murmuration, solar-system,
orbit-lab — multi-file packages); kinesin appears in film pixels only. PRE-BUILD FIX #1
(sim_files carry-over in ProjectDuplicationService) LANDED 2026-09-05 — commit on
feat/welcome-tutorial-kit; full backend suite green.
