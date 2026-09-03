---
name: flowvid-2026-09-03-next-phase-4-5-6-audit
description: audit of NEXT-PHASE-2026-09-03.md §4/§5/§6 against their local unmerged branches — 2 clean, 1 real gap (course slug field)
metadata:
  type: project
---

Audited three built-not-yet-merged items from `.claude/review/NEXT-PHASE-2026-09-03.md` against
their local branches (none pushed to origin, no PRs opened as of 2026-09-03 ~12:30 local):
`ops/storage-reconcile` (§4), `feat/r2-readiness` (§5, stacked on §4), `feat/publish-playlist-as-course`
(§6). All three built on the SAME merge base (after PR #174).

**§4 storage reconciliation — DONE, no real gaps.** `listMultipartUploads` on all three adapters
(`R2StorageAdapter.ts:181`, `SupabaseStorageAdapter.ts:277`, `LocalStorageAdapter.ts:101` returns
`[]`); `reconcile.ts` pure classifier + `parseAge` + `NEVER_DELETE_PREFIXES`; `storage-reconcile.ts`
CLI with the 10 families + multipart, dry-run default, deletes only via `deleteWithFallback` (the
chokepoint); `multipartSweeper.ts` wired at `server.ts:622`; `projectGcPrefixes` (projects.controller.ts:79)
now includes `editions/{projectId}` and `dubs/{videoId}` per video, called in the real DELETE route
at `:528`. The script's `podcasts` family refs exactly match census SQL's F8 "live set" definition
(`storage-census.sql:256-277`) — sources, chunk_audio (all, not just kind=preview), render masters,
clips.storage_key. All 5 specified test files pass (22 tests). Only cosmetic deviation: plan text
says `--abort-older-than=7d`, shipped CLI reuses `--older-than=` for both dry-run and multipart
apply — functionally fine, just a different flag name than the plan literally states, undocumented.

**§5 R2 readiness — DONE, no real gaps.** `storage-probe.ts` capability matrix covers every plan
capability (public-fetch step folds in cache-header observation as a note; CORS preflight is its
own step). Confirmed via a real test assertion (`migratingResolution.test.ts:54-60`) that R2's
`getSimPublicUrl` is unconditionally bucket-direct — so the "poster branch" Supabase needs is
correctly NOT added to R2 (would be redundant); `keyFromPublicUrl` reverses both the custom-domain
and legacy r2.dev shapes. `MigratingStorageAdapter` semantics match the plan exactly (writes
primary, reads primary-then-secondary, deletes both, pull-through copy, URLs primary,
`keyFromPublicUrl` both). `getStorageAdapter.ts` resolution: prod guard evaluated first, `migrating`
exempted from the blanket cloud-config check but its own `buildMigratingAdapter` still demands real
creds for both named providers. `urlRewrite.ts` / `storage-rewrite-urls.ts` column list matches the
plan's "survey E" list exactly (including `simulations.guidance`/`guidance_meta` JSONB walk for the
mdUrl/audioUrl case). `.env.example` documents all new vars. All 4 specified test files pass (22
tests). Minor undocumented deviations, both trivial: probe prefix is `_probe/<ts>/` not `probe/<ts>/`
as the plan literally says; and the OLDER `.claude/review/NIGHT-RUN-2026-09-03.md` §7 Phase-2
runbook (still says "Flip STORAGE_BACKEND=r2 in a release" with no mention of the staged `migrating`
adapter) was not updated to match — the actual runbook lives correctly in NEXT-PHASE §5 itself, but
the plan's own phrase "§5 of the night-run doc updated" implies that older doc should also change
and it didn't (verified via `git show 5899f72 5a2c75d -- .claude/review/` = no diff).

**§6 playlist→course — one real gap: the "slug field with availability" from the plan's own Design
AND Tests bullets was never built.** `PlaylistCourseSection.tsx` has the state line, public address
+ copy button, readiness reasons, and the three buttons — but no slug input, no availability check
exposed to the creator, and no test for it (`playlistCourseSection.test.tsx` has 4 tests, none touch
slug). Backend `createCourse` auto-allocates a unique slug from the title with a `-2/-3/…` retry
ladder (`CoursePublishingService.ts:89-105`) so publish never fails on a collision — severity is
low (no broken flow, just no vanity-slug UX) — but it is a plan requirement that shipped silently
dropped, not recorded in the ledger (`.audit-ledger/ledger.jsonl` has zero entries mentioning
playlist/course) or anywhere else. Everything else in §6 (3 routes, `PlaylistCourseService`
create-once/link/sync/readiness/org-gate, `PUT /items` → `syncIfCourse` → reorder confirmed live,
client-v1 methods/types, tour wording naming the button) is DONE and wired into the real route/dialog.
Both specified test commands pass (9 + 17 tests).

**Method note:** all three branches were local-only (no origin refs, no PRs) — used
`git worktree add <sha> --detach` into the scratchpad, pinned to SHAs captured at audit start, to
read/test without racing the primary worktree's HEAD (which moved under this session at least once,
per [[reverify-live-state-before-flagging-stale]]). `pnpm --filter shared build` is required before
`vitest run` in a fresh worktree checkout or every backend-api test file fails on
`Failed to resolve entry for package "shared"` — not a real test failure, just a missing build step.
