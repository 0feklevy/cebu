# Deploy & QA notes — visibility + statelessness batch

Covers commits `164e5f3` (skip-if-similar) → `05f2b52` (avatar library gate + audit):
media replace pipeline, Phase 4a/4b (visibility), Phase 5 core (cluster-safe job claims).

## Migration 036 — project visibility

**What it does** (`backend-api/src/db/migrations/036_project_visibility.sql`):
1. `CREATE TYPE project_visibility AS ENUM ('private','unlisted','public')` (guarded — re-run safe).
2. `ADD COLUMN visibility` (nullable first) — `ADD COLUMN IF NOT EXISTS`.
3. `UPDATE projects SET visibility='public' WHERE visibility IS NULL` — **existing rows → public** (preserves current by-id access; no retroactive lock-out).
4. `SET DEFAULT 'private'` then `SET NOT NULL` — **new projects → private**.

**Status:** already applied to the live Supabase DB (`pnpm --filter backend-api db:migrate`).
Idempotent, so re-running on deploy is a no-op ("Migration already applied — skipping").

### Deployment order (important)
The new code **reads `visibility`**, so 036 must be applied **before/with** the new code, or
project queries fail. Preview and production share one Supabase DB, and 036 is already applied,
so deploying the code is safe. If a fresh DB is ever introduced, run `db:migrate` first.

### Rollback
- **Code-only rollback (safe, preferred):** revert to before `3b6a542`. The `visibility` column
  is additive and ignored by old code — **no DB change needed**. Effective access for existing
  (public) projects is unchanged. Caveat: projects created under the new code as `private`
  become openly accessible again under old code (old code has no gate).
- **Full DB rollback (only if truly removing the feature):**
  `ALTER TABLE projects DROP COLUMN visibility; DROP TYPE project_visibility;` — destructive
  (loses visibility settings). Not required for a code rollback.

## Phase 5 claims — no migration
Caption/crop cluster-safe CAS claims use existing columns. Nothing to migrate or roll back;
reverting the commit restores the in-process `inFlight` behavior.

---

## QA checklist (run in browser before publish)

| # | Flow | Expected |
|---|------|----------|
| 1 | **Large video upload** (>40 MB) | Multipart path; uploads, transcodes, plays. No 413. |
| 2 | **Replace broken/any video** (Library ↻) | New media swaps onto same id; existing timeline clips stay attached; transcodes + plays. |
| 3 | **Transcode + playback** | New upload → HLS `ready`; viewer plays; old versioned HLS tree GC'd. |
| 4 | **Captions** | Generated on the write path; appear in viewer; replacing with *similar* media does **not** re-run them; replacing with *different* media **does**. |
| 5 | **Avatar circles (b-roll)** | Circles still render/generate on the timeline as before (unchanged by this batch). |
| 6 | **Visibility: private** | Owner (logged in) views fine. Anonymous / other user hitting `/projects/:id/view` → 404 (no leak). |
| 7 | **Visibility: unlisted** | Not openly viewable by raw id when anonymous; reachable via share link. |
| 8 | **Visibility: public** | Anyone with the link plays it (anonymous OK). |
| 9 | **Share link** (`/v/:token` → `/share/:token`) | Works regardless of visibility (token = access). |
| 10 | **Public course page** (`/c/:course/:lesson`) | Plays even if the underlying project is private (course publish gate is independent). |
| 11 | **Avatar Ask — public/unlisted** | Avatar starts + library loads for anonymous viewers. |
| 12 | **Avatar Ask — private** | Anonymous → avatar `/start` + `/library` return 404; owner (logged in) works. |
| 13 | **Set visibility** (Settings → Access) | Dropdown changes private/unlisted/public; persists; takes effect immediately. |

### Known residual (next Phase 4 hardening, not in this batch)
Avatar **conversation-memory** endpoints (`/api/v1/avatar/memory`) still trust a client
`sessionKey` with no project/owner binding. The session id is crypto-random (unguessable),
so practical risk is low, but the proper fix is a **server-issued capability token** bound to
the project — tracked as the next explicit Phase 4 task. Not started.
