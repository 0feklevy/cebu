# Scalability investigation — is Supabase the constraint?

Branch read: `fix/night-audit-2026-08-15` @ `ef651a9` (13 commits ahead of the audit commit).
Read-only. No servers started, no vendor calls, no `.env` opened.
Ground truth: `.claude/reference/stack.md`. Prior mapping skimmed:
`.claude/review/runs/2026-08-15T2109/findings/{database,performance,job-queue,backend,config-deploy}.md`
— findings already filed there are cross-referenced by id, not re-derived.

**Label key.** `BUG` = wrong today. `LIMIT` = correct today, breaks at a nameable scale.
`COST` = works and stays correct, but you pay for it.

**Headline answer (detail in §6):** Postgres is not the constraint. The 2‑vCPU app tier is.
Supabase's *transaction pooler* forces exactly one real compromise, and it is already paid for.

---

## 0. What this branch already fixed (so it is not re-litigated)

- **The migration advisory lock.** `db/migrate.ts:155-176` (`assertSessionMode`) now *refuses to
  run* when the resolved URL is port 6543 / `pgbouncer=true` / `pool_mode=transaction|statement`,
  and `resolveMigrationUrl` (`migrate.ts:201-247`) prefers `MIGRATION_DATABASE_URL` →
  `QUEUE_DATABASE_URL` → `DATABASE_URL` → local, checking every branch. The session-level
  `pg_advisory_lock` at `migrate.ts:432` is therefore now guaranteed to be on a session-mode
  endpoint. This is closed.
- **Migration atomicity.** `applyInTransaction` (`migrate.ts:296-330`) wraps the file and its
  `schema_migrations` row in one explicit `BEGIN`/`COMMIT`. `database-001` is closed.

---

## 1. THE CONNECTION MODEL

### 1.1 Census — every pool, from every process

| Process | Source | Driver | `max` | Notes |
|---|---|---|---|---|
| `backend` (API container) | `db/index.ts:28-33` | postgres-js 3.4.9 | **10** | `idle_timeout: 30`, `connect_timeout: 10` |
| `backend` (API container) | `queue/pgBoss.ts:70-76` | `pg` (via pg-boss 12.23) | **4** (`QUEUE_PGBOSS_MAX`) | lazily created — only on the first `enqueueProjectExport` (`queue/index.ts:78-81`) |
| `worker` container | `db/index.ts:28-33` | postgres-js | **10** | same module, same singleton |
| `worker` container | `queue/pgBoss.ts:70-76` | `pg` | **4** | created at boot (`worker.ts:27` → `startWorker`) |
| migration runner | `migrate.ts:477` | postgres-js | **1** | deploy-time only, session-mode endpoint |
| 31 ops scripts | e.g. `scripts/check-db.ts:94`, `scripts/backfill-avatar-circles.ts:79`, `db/backfill/030_courses.ts:257` | postgres-js | 1–4 | manual, not steady state |
| capture container | — | — | **0** | `network_mode: none` (`deploy/docker-compose.export-worker.yml:31`); it cannot reach Postgres at all |
| `client-web` / `admin-web` | — | — | **0** | no drizzle/postgres import anywhere under `client-web/` or `admin-web/` |

**Steady-state ceiling: 28 connections** (10+4 API, 10+4 worker), split across two endpoints —
`DATABASE_URL` (documented as :6543 transaction pooler) carries the two ×10 postgres-js pools;
`QUEUE_DATABASE_URL` (documented as :5432 session pooler, `deploy/.env.example:81-86`) carries the
two ×4 pg-boss pools. That is **8 real Postgres backends** on the session side and 20 pooler
clients on the transaction side.

Nothing opens a connection per request. Nothing opens a connection per job. There is no
connection-per-tenant pattern. **28 is the number, and it does not grow with users.**

### 1.2 Session-level features — what is actually used

I grepped every one of the five categories the transaction pooler cannot support.

| Feature | Used? | Where | Verdict |
|---|---|---|---|
| **Prepared statements** | **Yes, implicitly** | `db/index.ts:28-33` sets no `prepare` option; postgres-js 3.x defaults `prepare: true` | **See §1.3 — the one real open item** |
| **Session advisory locks** | Only in the migration runner | `migrate.ts:432`, `migrate.ts:437` | Closed — `assertSessionMode` refuses a pooled URL |
| **LISTEN/NOTIFY** | Opt-in, unguarded | `queue/pgBoss.ts:75` `useListenNotify: QUEUE_PGBOSS_LISTEN === '1'` | **LIMIT**, see §1.4 |
| **Temporary tables** | **No** | grep `CREATE TEMP\|TEMPORARY TABLE\|ON COMMIT` over `backend-api/src` → zero hits | Clean |
| **Session `SET` / `set_config` / `SET LOCAL`** | **No** | grep `set_config\|SET LOCAL\|SET SESSION\|statement_timeout\|search_path\|SET TIME ZONE` over `backend-api/src` → zero hits | Clean |
| **Pinned session (`sql.reserve()`)** | One backfill script | `db/backfill/030_courses.ts:209` — `reserve()` then raw `BEGIN`/`SAVEPOINT`/`COMMIT` | Safe: a transaction pooler pins the backend for the life of a transaction, and the whole sequence is inside one `BEGIN…COMMIT`. Not a finding. |
| **Cursors / `COPY`** | No | — | Clean |

**pg-boss 12 is pooler-safe, and I verified this in the installed package rather than assuming it.**
`node_modules/.pnpm/pg-boss@12.23.0/.../dist/plans.js:1867-1868` uses
`pg_advisory_xact_lock` — *transaction*-scoped, which a transaction pooler holds correctly — not
`pg_advisory_lock`. And `dist/notifier.js:8` documents its own contract: "A NOTIFY is only ever a
latency hint", with polling as the floor. So the repo's stated position ("polling is the
correctness floor") is confirmed by the library, not merely asserted by the comment.

### 1.3 [BUG — latent, config-dependent] postgres-js runs with `prepare: true` through the transaction pooler

`db/index.ts:28-33` passes `max`, `idle_timeout`, `connect_timeout` and nothing else. postgres-js
defaults `prepare: true`, which issues **named** prepared statements over the extended protocol.
Named prepared statements are the canonical thing a transaction-mode pooler cannot carry across
transactions: the name is registered on backend A and the next transaction lands on backend B.

What I can state from the repo:
- `prepare` appears nowhere in `backend-api/src` as a driver option (grepped; the only `prepare*`
  hits are `prepareOfflinePackage` and sim-fixture `prepare()` callbacks).
- The migration runner got a hard guard against a pooled URL; the *application* client did not get
  the corresponding driver setting.
- `parseDbUrl` (`db/index.ts:12-24`) **discards the URL's query string entirely** — it reads only
  `hostname`/`port`/`pathname`/`username`/`password`. So `?pgbouncer=true`, `?sslmode=…`,
  `?options=…` on `DATABASE_URL` are silently dropped, and SSL is decided purely by the hostname
  suffix test at `db/index.ts:20-22`. A separate small **BUG**: any pooler hint an operator puts on
  the URL has no effect, and a future non-`.supabase.co` host silently loses TLS.

What I **cannot** state from the repo: whether this is currently *failing*. Supabase's pooler is
Supavisor, and Supavisor has shipped named-prepared-statement support in transaction mode; whether
this project's pooler version handles it is not knowable from the checkout. The failure, if it
happens, is loud (`prepared statement "s1" does not exist` / `already exists`), not silent —
which is why I rate it latent rather than active.

**Measurement that settles it:** `SELECT count(*) FROM pg_prepared_statements` on the app's own
connection, or simply grep production logs for `prepared statement`. **Fix cost if needed:** one
line, `prepare: false`, at `db/index.ts:32`. It costs a small amount of per-query planning and
nothing else. There is no reason not to set it explicitly given `DATABASE_URL` is documented as
6543.

### 1.4 [LIMIT] `QUEUE_PGBOSS_LISTEN=1` has no session-mode guard, unlike the migration runner

`queue/pgBoss.ts:75` reads the flag and hands it to pg-boss with no check of the resolved URL —
while `migrate.ts` has an entire, well-argued `assertSessionMode` for exactly this class of
mistake and even exports `describeTransactionPooler(raw)` (`migrate.ts:136-155`) as a reusable
predicate. If someone sets `QUEUE_PGBOSS_LISTEN=1` while `QUEUE_DATABASE_URL` is unset (so it
falls back to `DATABASE_URL` at `pgBoss.ts:47-50`, i.e. the 6543 pooler), LISTEN degrades to
polling. pg-boss warns and continues (`dist/notifier.js:61`), so this is a latency regression
rather than a correctness one — hence LIMIT, not BUG. The fix is three lines: call the predicate
that already exists.

---

## 2. WHAT SATURATES FIRST, IN ORDER

The ordering below is by *how few users it takes*, and every step names the endpoint.

### #1 — CPU on the 2-vCPU box, via jobs that run inside the API process
**[LIMIT] 8 of 11 job types still execute in whichever process enqueued them, which is the API.**

`queue/pgBoss.ts:22` routes exactly three names to pg-boss: `crop`, `video_generate`,
`project_export`. `queue/index.ts:49-53` sends everything else to `getInlineQueue()`, and
`inlineDriver.ts:22` is `setImmediate(handler)` **in the current process**. The enqueue sites are
all API controllers:

- `transcode` — `video.controller.ts:24` and `:552`. This is ffmpeg HLS transcoding
  (`HLSTranscoder.ts`) of an uploaded video, in the API container.
- `captions` — `CaptionService.ts:327`, reached from the **public** `GET
  /api/v1/projects/:id/captions` (`player.controller.ts:96`). ffmpeg audio extract + a Groq
  transcription call, in the API container.
- `metadata`, `podcast_script`, `podcast_render`, `podcast_clips`, `podcast_mix_export`,
  `project_duplicate` — same shape (`registry.ts:22-42`).

`deploy/docker-compose.yml` sets `WORKER_INLINE: 'false'` on `backend` precisely so heavy jobs run
in the `worker` container — but that only redirects the *three* pg-boss names. The other eight
ignore the setting entirely. `ffmpegLimit.ts:8` caps ffmpeg at `FFMPEG_CONCURRENCY=2` **per
process**, so the API container and the worker container each get 2, i.e. up to 4 ffmpeg processes
on a 2-vCPU host, before counting the capture container.

**Scale at which it bites:** two concurrent uploads. Each triggers a `transcode` in the API
process; the pair alone claims both API ffmpeg slots and both vCPUs, and every request handler on
the same event loop queues behind the ffmpeg spawn/IO bookkeeping. There is no user count here —
it is a *concurrent-upload* count, and it is 2.

### #2 — CPU/wall clock during any export
**[LIMIT, known]** `pgBossDriver.ts:33-38` deliberately serialises `project_export` to 1, and
`docker-compose.export-worker.yml:48-50` gives each capture container `cpus: 2` and
`mem_limit: 2048m` — the whole machine. This is a correct decision given the host, and it is why
the export queue is a single-lane road. **Scale: 1 concurrent export.** Everything else is
waiting. This is the already-known ~10× capture slowness, and it is a host problem, not a database
problem.

### #3 — Fastify event loop on the public sim-asset proxy
**[COST]** See §5.2. Every text file of every simulation is `readObject`-ed from Supabase, sha1'd
and brotli-compressed **per request**, including on the 304 path. Concurrency here is bounded by
the single Node event loop and by `nginx`'s `proxy_buffering off` (`deploy/nginx/templates/
app.conf.template:76`), which keeps the upstream socket open for the whole client transfer.

### #4 — Row-level write contention on `projects.view_count`
**[LIMIT]** See §3.1. This is the first thing that is genuinely *database*-side, and it needs
tens of simultaneous viewers **of the same project**, not many users overall.

### #5 — Postgres connections
Last. 28 connections total, fixed, with pg-boss on a separate endpoint. Supabase's transaction
pooler handles hundreds of client connections; the session pooler side is 8 backends. **I cannot
name the plan's actual limits from the repo** — see §6.3 for the measurement — but 28 is not a
number that troubles any Supabase tier.

### Not on the list, and why
- **Disk I/O on the VM.** The only host disk is the `media_work` volume for ffmpeg scratch
  (`docker-compose.yml`, `volumes: media_work:/app/backend-api/.work`). Media itself never lands
  on the app server's disk in production (§5.1). Local-disk storage is fail-closed refused in
  production (`getStorageAdapter.ts:71-84`).
- **Supabase Postgres CPU.** Every hot query is index-covered (§3.6). The expensive endpoints are
  admin-only.

---

## 3. QUERY SHAPES THAT DO NOT SCALE

### 3.1 [LIMIT] `view_count` is a single hot row updated on every public playback — cost: contention quadratic in concurrent viewers of one project

`permalink.controller.ts:90-93`, `share.controller.ts:42-45`, `playlists.controller.ts:204-207`:

```ts
db.update(projects).set({ view_count: sql`${projects.view_count} + 1` })
  .where(eq(projects.id, project.id))
```

Every concurrent viewer of the *same* project takes an exclusive row lock on the *same* tuple and
serialises. `projects` carries at least 5 indexes (`projects_pkey`, `idx_projects_created_by`,
`idx_projects_org_id`, `idx_projects_share_token`, `uniq_projects_slug`), so once the page's free
space is exhausted the HOT-update optimisation stops applying and each increment writes new index
entries plus a dead tuple, driving autovacuum.

- Cost curve: **writes linear in total playbacks; latency super-linear in concurrent viewers of
  one project** (they queue on one lock).
- Scale: a video that gets 50 simultaneous viewers (one social post) is 50 serialised row updates
  per page-load burst. It will not fall over at 50; it becomes the dominant write and the dominant
  bloat source somewhere in the low hundreds.
- It is on a **public, unauthenticated, unrate-limited** path. `lib/rateLimit.ts` is applied to
  avatar/broll/podcast generation only (grep: `rateLimit(` has zero hits in
  `player.controller.ts`, `share.controller.ts`, `permalink.controller.ts`, `sim-public.controller.ts`).

### 3.2 [LIMIT] `buildPlayerConfig` — well-batched, but 3 avoidable round trips and 1 aggregate on the hot path

I read the whole function with this lens. **It is not an N+1.** `buildPlayerConfig.ts:188-236` is
one `Promise.all` of 10 queries; the follow-ups at `:258-260`, `:792-798` and `:840-843` are all
`inArray` batches; `loadProjectSimulations` (`:120-155`) selects an explicit narrow `columns` list
specifically to stay off the jsonb columns. This is careful code. Four things remain:

1. **[COST] Two uncached single-row `admin_settings` reads per call.** `resolveSimPoolMode`
   (`buildPlayerConfig.ts:19`) and `resolveSimRuntimeFlags` (`RumService.ts:380`) each hit
   `admin_settings` with no memoisation, on every player-config / share / playlist-item / course
   render. The third such read, `resolveRumSampleRate` (`RumService.ts:79-87`), **is** cached for
   10 s — and its docstring spells out exactly why ("a caller could force one query per request
   against a pool of 10 and starve every other query in the API"). The reasoning applies verbatim
   to the other two; they just didn't get it. Cost curve: **linear in requests**, 2 round trips
   each. Fix is the 8 lines already written next door.
2. **[COST] `fieldAggregates` runs a percentile aggregate on the hot read path.**
   `buildPlayerConfig.ts:401-403` calls `fieldAggregates(revisionsForField)`
   (`RumService.ts:422-469`) **outside** the `Promise.all`, serially, for any project with a
   simulation. It is `percentile_disc(0.5|0.9) … GROUP BY package_revision` over up to 14 days of
   `sim_rum_events` matching those revisions. The index `idx_sim_rum_package (package_revision,
   kind, created_at)` covers the predicate, so the scan is bounded — but the row count under that
   predicate is **linear in playbacks × RUM sample rate**, and the sort for `percentile_disc`
   happens per request. Today `rum_sample_rate` defaults to 0 (`051_sim_rum.sql`), so the table is
   empty and this is free. **The moment RUM is turned on at a meaningful rate, this becomes the
   most expensive query on the most-hit endpoint.** The code comment at `:396-400` deliberately
   refuses to gate it on the sample rate, for a good reason — but "not gated" and "not cached" are
   different decisions, and only the first was made deliberately.
3. **[COST] Nothing caches the result.** `/api/v1/projects/:id/player-config`
   (`player.controller.ts:30-67`) sets **no** `Cache-Control`. Total: **11 queries minimum, ~14
   for a project with simulations, up to 17 with branching**, per viewer, per page load, every
   time. Compare `player.controller.ts:129`, which does set `public, max-age=3600` on the VTT
   route — the pattern exists in the same file.
4. Cost curve overall: **linear in project size** (videos × sections × images × audio), **linear
   in request count**, constant in user count. That is the right shape. It is the *constant factor*
   that is high.

### 3.3 [LIMIT] Playlist play-config fans out `buildPlayerConfig` N-wide with no bound

`playlists.controller.ts:614-624`:

```ts
const items = await db.query.playlist_items.findMany({ where: eq(playlist_items.playlist_id, …) });
const [configs, projectRows] = await Promise.all([
  Promise.all(items.map((i) => buildPlayerConfig(i.project_id, viewerUserId))),
  …
]);
```

No `limit` on `items`, no concurrency cap on the fan-out. A 30-item playlist issues
**~30 × 14 ≈ 420 queries** for one request, all released onto a pool of 10 at once — so that
single request occupies the entire API pool for the duration and every other request in the
process waits behind it. Cost curve: **linear in playlist length, with a burst that saturates the
whole pool**. Scale: one 30-item playlist request is enough to stall the API's DB access for the
length of ~42 serialised query batches.

### 3.4 [LIMIT] `branch/analytics` loads a per-playback event table into memory to count it

`branch.controller.ts:494-505`: `findMany({ where: eq(branch_path_events.project_id, …) })` with no
`limit` and no date window, then `new Set()`, three JS counters and a loop. Every value computed is
`count(*)` / `count(distinct session_id)` / `count(*) … GROUP BY edge_id` in SQL. This is the same
defect as `performance-006` (admin billing overview, `admin/v1/billing.controller.ts:14`) — but on
a table that grows with **traffic**, not with transactions, so it hurts far sooner.
Cost curve: **linear in the project's lifetime playback-event count, forever** (no retention —
see §4.2). Owner-only endpoint, so it is a self-inflicted stall rather than an attack surface, but
the first project with a million path events will time the endpoint out and can OOM the API
container reading it.

### 3.5 [LIMIT] Unpaginated collection reads

- `projects.controller.ts:122-126` — `GET /api/v1/projects` returns **every** project the user can
  edit, whole rows (including the `avatar_config` jsonb at `schema.ts:194`), no `limit`, no
  `columns`. Cost: **linear in that user's project count**. A power user with 500 projects gets a
  500-row full-row payload on every dashboard load.
- `SitemapService.ts:51-60` — every published project + every non-broll video of those projects,
  no limit, served from `force-dynamic` routes (`client-web/app/sitemap*.xml/route.ts:3`).
  Cost: **linear in total published content across all tenants**, uncached, on a public URL.
- `admin/v1/billing.controller.ts:14` — already filed as `performance-006`; whole
  `billing_transactions` table into JS. Confirmed still present on this branch.
- `admin/v1/system-prompts.controller.ts:13`, `CourseRepository.ts:30,34` — org-scoped or
  small-cardinality; noted, not findings.

### 3.6 Missing indexes — I found **one** class, and it is cold-path

I enumerated all 68 `CREATE INDEX` statements across `db/migrations/*.sql` plus the 30
`index()` declarations in `db/schema.ts` and matched them against every hot filter. **Every
per-project read path in `buildPlayerConfig` is covered**: `idx_video_files_project`,
`idx_timeline_sections_project`, `idx_image_files_project`, `idx_audio_files_project` (both added
by `039_perf_indexes.sql`, which fixed exactly this), `idx_scenes_project`,
`idx_branch_sequences_project`, `idx_simulations_project`, `idx_sim_posters_revision`. Auth is
covered (`users.firebase_uid` unique, `idx_collaborators_email`). The rolling token cap is covered
(`idx_token_usage_user_occurred`). RUM is covered both ways.

The one gap:

**[LIMIT] `permalinkService.ts:113-116` does a prefix `LIKE` that no index can serve.**

```ts
or(eq(projects.slug, base), like(projects.slug, `${base}%`))
```

`uniq_projects_slug` (`043_permalink_slugs.sql:27`) is a default-collation btree. Postgres can only
use a btree for `LIKE 'x%'` when the collation is `C` or the index uses `text_pattern_ops`; Supabase
databases are `en_US.UTF-8`. So the `LIKE` arm forces a **sequential scan of `projects` and of
`playlists`** — cost linear in *total rows across all tenants*. Mitigating: `suggestPermalinkSlug`
is only reached from the owner-only permalink editor (`permalink.controller.ts:146`, `:175`), not
from any viewer path. So this is a slow authoring click at 100k projects, not an outage. Fix:
add `text_pattern_ops` companion indexes, or compute the collision set from the exact-match arm
plus a bounded numeric probe.

### 3.7 [COST] Every authenticated request writes to `users`

`middleware/firebase-auth.ts:66-119`, on **every** request through `firebaseAuthMiddleware`:
1. `SELECT` `users` by `firebase_uid` (indexed);
2. `UPDATE users SET last_seen_at = now(), email = … WHERE id = …` — **an unconditional row write**;
3. `UPDATE collaborators SET user_id = … WHERE user_id IS NULL AND invited_email = …` — a second
   write statement that matches nothing on essentially every request (it does ride
   `idx_collaborators_email`, so the *lookup* is cheap; the round trip and the transaction are not).

So the editor — which polls at 2 s, 3 s and 5 s intervals (`client-web/components/VideoEditor.tsx:451`,
`:467`, `SectionEditor.tsx:476`, `BrollPanel.tsx:96`) — costs **3 DB round trips per poll before the
handler does any work**. Cost curve: **linear in authenticated request count**, with one guaranteed
tuple version per request on `users`. `firebaseAuthOptionalMiddleware` (`:126-141`) correctly does
neither write, so the public viewer path is spared.

At 20 concurrent editors polling on the 2 s timer that is ~10 req/s × 3 = 30 round trips/s of pure
middleware overhead. Not fatal; it is the largest *avoidable* constant on the authenticated path,
and `last_seen_at` does not need per-request precision.

### 3.8 [COST] `GET /api/v1/projects/:id/captions` runs the same query twice, and the viewer polls it every 8 s

`player.controller.ts:96-97` calls `enqueueCaptionsForProject(projectId)` then
`getCaptionStatusForProject(projectId)`. Both (`CaptionService.ts:331` and `:336`) do the identical
`db.query.video_files.findMany({ where: eq(video_files.project_id, …) })`. Plus the project lookup
and the pricing read at `:77` and `:85`. So ~4 queries per call, half of them duplicated.

`client-web/components/viewer/HLSPlayerShell.tsx:316-349` polls this every **8 s** for as long as
any segment is `'none'` or `'processing'`. For a healthy video that stops once captions go `ready`.
For a video that is permanently `'none'` (captions never enqueued — no `storage_key`, or the inline
job died with the API process), **the poll never stops**, per viewer, forever. Cost curve:
**linear in concurrent viewers of an unhealthy video**, ~0.5 req/s per viewer × 4 queries.

### 3.9 N+1s found
Only one, already filed: `runPodcastClips.ts:100` (`performance-007`), one `findFirst` per script
turn inside a background job. Confirmed present. I found **no** N+1 on any request path —
`SitemapService.ts:50` and `projects.controller.ts:44` both carry comments saying an earlier N+1
was already batched out, and the code matches the comments.

---

## 4. DATA THAT GROWS WITHOUT BOUND

Verified per table: is there a delete path, a retention window, or a partition?

| Table | Growth driven by | Retention | Verdict |
|---|---|---|---|
| `sim_rum_events` | per playback × sample rate | **Yes** — `reapRumEvents` (`RumService.ts:239-263`), batched 5 000/statement, hourly sweep started at `server.ts:509`, window is `admin_settings.rum_retention_days` (default 30, CHECK-bounded 1–365, `051_sim_rum.sql`) | **Clean.** The usual suspect is the one table that got this right. |
| `token_usage` | per LLM/TTS/image call | **None** | **[LIMIT]** §4.1 |
| `branch_path_events` | **per viewer interaction** | **None** | **[LIMIT]** §4.2 — the fastest grower |
| `jobs` | per job row written | **None**; `schema.ts:327-337` has `finished_at` and `idx_jobs_status` but no reaper | **[LIMIT]**, small — grep shows no writer for this table on the current job paths; it looks vestigial. Verify before acting. |
| `video_generation_jobs` | per b-roll generation | Only `broll.controller.ts:144` (user-initiated delete) | **[LIMIT]**, slow |
| `project_exports` | per export | Row: none. Object: none either — `058_project_exports.sql:43-44` says masters are "reaped by the project-delete storage GC", i.e. only when the project dies | **[COST]** §5.4 |
| `avatar_conversations` | **per avatar chat turn** | **None** | **[LIMIT]** §4.3 |
| `billing_transactions` | per checkout | None (correct — financial record) | Fine; but see §3.5 |
| `podcast_chunk_audio`, `podcast_clips`, `podcast_mix_snapshots` | per turn / per revoice / per snapshot | None | **[COST]**, linear in podcast authoring activity |
| `sim_revisions` | per publish | `idx_sim_revisions_status_created` exists and the code refers to a `gc()`; I did not verify the sweep runs | Unverified — see §6.3 |

### 4.1 [LIMIT] `token_usage` — driven by **generations**, not by users
`schema.ts:308-325`, written by `UsageTrackingService.ts:19` on every provider call. No delete
anywhere (grep `db.delete(` → the only hits are `RumService.ts:250` and `broll.controller.ts:144`).
Row is ~150 bytes. It is read on the hot generation path by `LLMService.ts:146-150` and
`RateLimitService.ts:20-25` — both windowed and both riding `idx_token_usage_user_occurred`, so
**query cost stays constant** as the table grows. This is a *storage* problem, not a *latency*
problem: at 1 000 generations/day it is ~55 MB/year. Ranks below `branch_path_events`.

### 4.2 [LIMIT] `branch_path_events` — driven by **playbacks**, so it grows fastest of all
`schema.ts:1120-1138`; written by the **public, optional-auth, unrate-limited**
`POST /api/v1/projects/:id/branch/events` (`branch.controller.ts:458-484`) — one row per
`sequence_enter` / `choice` / `complete`, one INSERT per event, no batching (contrast `RumService.
ingestBatch` at `:222`, which explicitly batches "so a measurement system does not become the
reason the database is busy"). Each request also does a `projects.findFirst` first. No retention,
no partition, and §3.4's analytics endpoint reads the whole thing into Node.

**This is the one that hurts first**, because its rate is `viewers × interactions-per-view` while
every other unbounded table's rate is `authors × actions`. A branching video with 3 choice points
watched 10 000 times is 30 000+ rows from one video.

### 4.3 [LIMIT] `avatar_conversations` — driven by **avatar chat turns**
`schema.ts:862-870`. One row per user message and per persona reply, `content: text` unbounded.
Indexed on `(session_key, created_at)` (`028_avatar.sql:47`) so reads stay fast; nothing ever
deletes. Growth rate is `avatar sessions × turns × 2`, and the payload is free text, so it will
out-mass `token_usage` per row by an order of magnitude.

**Nothing in this repo is partitioned.** The only table with a real retention story is
`sim_rum_events`, and its migration header (`051_sim_rum.sql:22-27`) states the principle the
other four tables violate: *"An events table with no enforced retention grows without bound and
quietly becomes the largest thing in the database."*

---

## 5. STORAGE

### 5.1 Media bytes do **not** cross the app server in production — with two exceptions
Production is `STORAGE_BACKEND: supabase` (`deploy/docker-compose.yml`, backend and worker), and
local disk is fail-closed refused (`getStorageAdapter.ts:71-84`, `forceLocalStorage` throws at
`:34-38`). So:
- **HLS playback** — `buildPlayerConfig.ts:505-509` emits `storage.getPublicUrl(hls_master_key)`,
  which for Supabase is `{origin}/storage/v1/object/public/{bucket}/{key}`
  (`SupabaseStorageAdapter.ts:91`, `:428-430`). Segments are uploaded with
  `HLS_IMMUTABLE_CACHE_CONTROL` (`HLSTranscoder.ts:366-368`, `:482-484`), so the bucket's CDN can
  cache them. **Correct, and the single most important thing to get right — it is right.**
- **Raw video / exports / podcast masters** — presigned GETs
  (`video.controller.ts:105`, `export.controller.ts:460`, `podcast-render.controller.ts:29-31`).
  Bytes go browser↔bucket.
- `/hls-proxy/*` (`server.ts:320-364`) **is** a byte proxy through the API, but it is only reachable
  from `R2StorageAdapter.getPublicUrl` (`R2StorageAdapter.ts:322-323`). With `STORAGE_BACKEND=supabase`
  it is dead code in production. Worth knowing before anyone switches to R2: flipping the backend
  silently routes every HLS segment through the 2-vCPU box.
- `/local-storage/*`, `/hls-public/*`, `/video-raw/*` (`server.ts:255`, `:300`, `:370`) are
  local-adapter routes and cannot be reached in production for the same reason.

### 5.2 [COST — the real storage finding] Every simulation **text** asset is proxied through the API, per request, with no caching

`SupabaseStorageAdapter.getSimPublicUrl` (`:434-441`) returns
`{publicApiOrigin()}/sim-public/{path}` — **not** a bucket URL — with an honest comment explaining
why (Supabase's public endpoint downgrades `text/html` → `text/plain`). So every sim asset URL in
every player config points at the app server.

`sim-public.controller.ts` then splits:
- **Binary** (`!PROXIED_TEXT_EXTS.has(ext)`, `:234-243`): 302 redirect to the bucket. Bytes bypass
  the box. Good.
- **Text** — `.html .htm .js .mjs .css .json .txt .md .xml .svg .vtt .csv` (`:21-23`) — the full
  path at `:247-288`:
  1. `isVerifiedRevisionKey(key)` (`:151`) — a DB lookup, but correctly memoised 60 s / 5 000
     entries (`revisionIdentity.ts:64-81`). Not a problem.
  2. `await storage.readObject(key)` (`:248`) — **a full S3 GET from Supabase, on every request**.
  3. `injectSimBootSnippet` on HTML (`:251`).
  4. `createHash('sha1').update(buf)` (`:255`) — hash the whole body.
  5. **Only then** the `if-none-match` check at `:274`. **A 304 costs the entire fetch + hash.**
  6. `reply.compress(buf)` (`:284`) — brotli quality 4 (`:106`) in the Node process.
  7. `Cache-Control: no-cache` unless the key is a verified revision key (`:154`).

Cost per sim, per viewer, per load = (number of text files) × (1 Supabase S3 GET + 1 sha1 + 1
brotli) **on the 2-vCPU app server**, and `no-cache` means the browser re-validates all of them on
every subsequent load — which re-pays steps 2–4 in full for a 304. A sim package may hold up to
**1 000 files / 250 MB** (`simulations.controller.ts:67-68`).

Cost curve: **linear in (viewers × text files per package)**, with a constant that includes a
network round trip to Supabase and a CPU-bound compress. There is **no `proxy_cache` anywhere in
nginx** (grepped `deploy/nginx/nginx.conf` and `templates/app.conf.template` — zero hits) and no
CDN in front of the API origin. This is the single highest-leverage thing on the list.

Mitigating, and it matters: the revision path (`sim-public.controller.ts:154`,
`cacheControlForKey` in `shared/src/sim/simRevision.ts:308-311`) already serves verified revision
keys `immutable` for non-entry documents. So **packages published through the revision pipeline
are already mostly fixed**; legacy/replaced packages are not. I cannot tell from the repo what
fraction of live packages are revisioned — see §6.3.

### 5.3 [COST] Uploads go **through** the API, buffered, with a 10 GB ceiling
`server.ts:198` registers multipart at 10 GB globally; nginx allows 2 GB
(`deploy/.env.example`, `MAX_UPLOAD_SIZE=2g`). `video.controller.ts:161` streams correctly.
`audio.controller.ts:67`, `corpus.controller.ts:69`, `podcast.controller.ts:397` do
`await data.toBuffer()` — already filed as `performance-001/002/003/010`, all confirmed present on
this branch. Presigned **upload** URLs exist in the adapter
(`SupabaseStorageAdapter.getPresignedUploadUrl`, `createMultipartUpload`,
`getPresignedUploadPartUrl`) — the direct-to-bucket capability is built and the browser upload path
does not use it for these routes. That is the structural fix, and it is already half-written.

### 5.4 [COST] Export masters and sim packages are never reaped
`058_project_exports.sql:43-44` is explicit: export output objects die only with the project.
`ProjectExportService.ts:775-812` reaps abandoned *rows*, not *objects*. An MP4 master per export
per project, kept forever. Similarly, replaced sim packages: `SimulationService.ts:2622-2628`
deletes stale keys on replace (good), but retired *revisions* accumulate under
`simulations/{p}/{s}/revisions/{id}/`.

### 5.5 Egress and request-count exposure
- **HLS**: immutable + public bucket URL → cacheable at Supabase's storage CDN. Egress is
  `unique viewers × video bytes`, then near-zero for repeat views of the same tier.
- **Sim binary assets**: initial upload sets `public, max-age=3600`
  (`SimulationService.ts:2485-2490`); the **replace** path
  (`SimulationService.ts:2613-2617`) passes **no** `cacheControl`, so Supabase serves those objects
  `no-cache` and the CDN cannot hold them → origin egress on every request for every replaced
  package. Small **[COST]**, one argument to fix, and the deliberate reasoning at `:2606-2608` is
  about *immutable*, not about *cacheable at all*.
- **Sim text assets**: served from the API, so the egress is **VM egress**, not Supabase egress —
  and it is the one that costs the 2 vCPU.
- Request counts: Supabase S3 GETs scale as `viewers × sim text files`. That is the metric to watch
  on the Storage bill.

---

## 6. THE ACTUAL QUESTION

### 6.1 Verdict: the 2-vCPU host is the constraint. Supabase is not.

Replacing Supabase Postgres would fix **nothing** on this list. Concretely:

- The connection model is **28 connections, fixed, not user-scaling** (§1.1). No managed-Postgres
  connection limit is in play.
- Every hot read path is index-covered (§3.6). The one missing-index finding is an owner-only
  authoring click.
- The database-side problems that *do* exist — the `view_count` hot row (§3.1), the per-request
  `users` write (§3.7), the four unretained tables (§4) — are **application design**, and they
  would arrive unchanged on RDS, Neon, or self-hosted Postgres.
- Meanwhile the first four things to saturate (§2) are all app-tier: ffmpeg in the API process,
  serialised exports, the sim-asset proxy, and per-request Node CPU.

If the owner spends the migration budget on Postgres, they will have moved the database and still
have a 2-vCPU box running ffmpeg inside the request-serving process.

### 6.2 The compromises the transaction pooler *is* forcing, and what session mode would recover

Being fair to the pooler question — here is the complete list, and it is short:

| Compromise | Recovered by session/direct mode? | Actually costing anything? |
|---|---|---|
| Migration runner needs a second URL (`MIGRATION_DATABASE_URL`) | Yes | **No.** It is one env var and the runner fails loudly if it is wrong (`migrate.ts:155-176`). This is good engineering, not a tax. |
| pg-boss must poll instead of LISTEN/NOTIFY | Yes | **Marginally.** pg-boss 12 treats NOTIFY as a latency hint only (`pg-boss/dist/notifier.js:8`); polling adds job-pickup latency measured in seconds. For a queue whose jobs run for minutes, this is noise. |
| `prepare: true` is unset and may be wrong (§1.3) | Yes | **Unknown — measure.** Fix is one line either way; it does not justify moving. |
| No session-scoped `SET`, temp tables, or session advisory locks in app code | N/A | **Nothing to recover — the app uses none of them** (§1.2). |

So: **the pooler costs one env var and a few seconds of queue latency.** That is not an
architectural compromise; it is the correct trade for a deployment that wants headroom on
connection count. `deploy/.env.example:81-86` already documents exactly the right split
(`DATABASE_URL` → 6543 for the web tier, `QUEUE_DATABASE_URL` → 5432 for pg-boss).

**If you moved off Supabase anyway**, the honest migration cost: 52 tables, 62 forward migrations
in a hardcoded ordered list (`migrate.ts:66`), plus Supabase **Storage** — which is a *separate*
migration from Postgres and the harder one, because `SupabaseStorageAdapter.getSimPublicUrl`
(`:434-441`) exists specifically to work around a Supabase Storage behaviour, and
`publicUrlKeys.ts` / `keyFromPublicUrl` reverse-engineer Supabase's public URL shape. Object keys
are stored as full URLs in several columns (`SupabaseStorageAdapter.ts:446-455` names
`corpora.storage_url`), so a bucket move means a data rewrite, not just a config change. And
Firebase Auth is already separate, so no auth migration — that is the one thing that would have
made it painful and it is already decoupled.

### 6.3 What I could **not** determine from the repo — and the measurement that settles each

1. **Is `prepare: true` actually failing through the pooler?**
   → grep production logs for `prepared statement`, or run
   `SELECT count(*) FROM pg_prepared_statements` on an app connection.
2. **Supabase plan limits (pooler pool size, max client connections, DB size cap, egress
   allowance).** Not in the repo; `deploy/.env.example` deliberately keeps DB config out.
   → Supabase dashboard → Settings → Database (pool size, max connections) and Usage (DB size,
   storage egress).
3. **Which table is actually largest today.**
   → `SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)), n_live_tup
      FROM pg_class c JOIN pg_stat_user_tables s ON s.relid=c.oid ORDER BY 2 DESC LIMIT 20;`
   That one query decides whether §4 is urgent or theoretical.
4. **Sim package composition** — how many *text* files a typical published package has, and what
   fraction of live packages are revision-keyed (and therefore already `immutable`).
   → `SELECT count(*) FROM sim_revisions WHERE status='active'` against
   `SELECT count(*) FROM simulations WHERE status='ready'`; and one `listObjects` over a
   representative prefix. This decides how big §5.2 really is.
5. **The VM's actual memory.** `deploy/docker-compose.export-worker.yml:48` gives the capture
   container a 2 GB hard cap; if the host has 4 GB total, one export plus the API plus two Next.js
   servers plus nginx is tight. → `free -m` / instance type.
6. **Is `sim_revisions` GC actually scheduled?** `revisionIdentity.ts:58-59` refers to a `gc()`
   that can delete a revision; I found no timer starting it in `server.ts` or `worker.ts`.
   → grep for the scheduler, or check whether retired revision rows accumulate.
7. **Per-query latency through the pooler.** Every "N round trips per request" figure in §3 is a
   *count*, not a *time*. → `pg_stat_statements` on `mean_exec_time` for the top 20 calls, or
   `EXPLAIN ANALYZE` on the `buildPlayerConfig` batch.

---

## 7. RANKED FIX LIST (cheapest leverage first) — not decisions, just ordering

1. Move `transcode` / `captions` / `podcast_*` out of the API process (add them to
   `PGBOSS_JOB_NAMES`, `pgBoss.ts:22`). Biggest single win; the mechanism already exists.
2. Cache `resolveSimPoolMode` + `resolveSimRuntimeFlags` for 10 s (copy `resolveRumSampleRate`).
   −2 round trips on the hottest endpoint, ~8 lines.
3. Give `/sim-public/*` text responses an in-process byte+ETag cache, or an nginx `proxy_cache`
   zone. Removes an S3 GET + sha1 + brotli per asset per viewer.
4. Debounce `last_seen_at` (`firebase-auth.ts:79`) to once per N minutes.
5. `prepare: false` at `db/index.ts:32` — one line, removes a whole class of pooler failure.
6. Aggregate `branch/analytics` in SQL (`branch.controller.ts:494`), and give
   `branch_path_events` a retention sweep modelled on `reapRumEvents`.
7. Bound the playlist fan-out (`playlists.controller.ts:620`) and paginate
   `GET /api/v1/projects`.
8. Guard `QUEUE_PGBOSS_LISTEN` with `describeTransactionPooler` (`pgBoss.ts:75`).

---

# DILEMMAS — for a reviewer, not resolved here

Each states the problem, what I verified, the real options, what I lean toward and why, and the
evidence that would decide it. None of these should be actioned from this document alone.

---

## D1. Where does the app tier get its headroom: move the inline jobs, or buy vCPUs?

**Problem.** Eight of eleven job types run inside the API process (`queue/index.ts:49-53`,
`inlineDriver.ts:22`, enqueue sites listed in §2 #1). The obvious fix is to add them to
`PGBOSS_JOB_NAMES` (`pgBoss.ts:22`) so they land in the `worker` container. But the worker runs on
the *same 2-vCPU VM*. Moving ffmpeg from the API container to the worker container does not create
CPU; it relocates contention.

**What I verified.** `FFMPEG_CONCURRENCY` defaults to 2 **per process** (`ffmpegLimit.ts:8`), so
the current layout permits 4 concurrent ffmpeg processes on 2 vCPUs, plus a capture container that
is granted `cpus: 2` (`docker-compose.export-worker.yml:50`). `project_export` is deliberately
serialised to 1 (`pgBossDriver.ts:33-38`) with a written rationale about exactly this contention.
`crop` defaults to 2 (`pgBossDriver.ts:17-19`).

**Options.**
- **(a) Move the jobs, don't add hardware.** The API's event loop stops competing with ffmpeg, so
  request latency becomes predictable and an OOM in a transcode no longer takes down every
  in-flight request (the 2026‑08‑13 incident named at `pgBoss.ts:18-20`). But transcodes and
  captions now queue behind exports in the same worker, so *upload → playable* latency gets worse
  and more variable. Total throughput is unchanged.
- **(b) Add vCPUs first (2 → 4 or 8), change nothing.** Buys real headroom for everything at once,
  including the ~10× capture problem. But it leaves the API process still able to OOM itself on a
  large transcode, and it is recurring cost.
- **(c) Both, in order: move the jobs, then size the VM from the resulting queue depth.**
- **(d) Move the jobs *and* split the worker into two queues** (`WORKER_QUEUES` already supports
  this — `pgBossDriver.ts:99-113`): one process for `project_export`, one for media jobs. Costs a
  third Node process's RSS on a box whose memory I could not measure.

**I lean toward (c), starting with (a).** The isolation argument is about *blast radius*, not
throughput, and blast radius is the thing that produces incidents. Sizing decisions made before
the jobs are isolated will be sized against a noisy signal.

**Evidence that decides it.** (1) The VM's actual memory and current CPU steal/idle under real
traffic — `free -m`, and 24 h of `docker stats` or host CPU. (2) Measured p50/p95 of
*upload → HLS ready* today; if it is already minutes, (a)'s latency cost is irrelevant. (3) Whether
the export capture's ~10× slowness is CPU-bound at all — if it is memory- or IO-bound, adding vCPUs
buys less than it looks.

---

## D2. What replaces the `/sim-public` proxy — and does it change the storage vendor?

**Problem.** `SupabaseStorageAdapter.getSimPublicUrl` (`:434-441`) routes **every** simulation
asset URL through the app server, and the text half of them pay a Supabase S3 GET + sha1 + brotli
per request with `Cache-Control: no-cache` (§5.2). The proxy exists for one concrete reason,
documented in that method: Supabase's public bucket serves `text/html` as `text/plain`, so an
iframe pointed at the bucket renders source.

**What I verified.** Binary assets already 302 to the bucket (`sim-public.controller.ts:234-243`).
Verified revision keys already get `immutable` (`:154`, `shared/src/sim/simRevision.ts:308-311`) —
so the modern publish path is largely fixed and the exposure is legacy/replaced packages. There is
**no** `proxy_cache` in nginx (grepped both config files) and no CDN in front of the API origin.
R2's adapter returns bucket URLs directly for sims (`R2StorageAdapter.ts:329`), i.e. R2 does not
have the MIME problem.

**Options.**
- **(a) Cache in front of the existing proxy.** An nginx `proxy_cache` zone keyed on the sim path,
  or an in-process LRU of `{bytes, etag}`. Cheapest; removes the S3 GET and the sha1 from the
  repeat path. Leaves the app server on the byte path, so it does not fix the *bandwidth* ceiling.
- **(b) Put a CDN (Cloudflare) in front of `api.flowvidco.com`.** Fixes bandwidth and repeat
  requests globally without touching code — but it caches *the API origin*, so every non-sim route
  needs explicit `Cache-Control: no-store` discipline or you will cache an authenticated response.
  That is a real footgun on a codebase where most routes set no cache headers at all.
- **(c) Move sim packages (only) to R2, keep media on Supabase Storage.** Removes the proxy
  entirely for sims because R2 serves correct MIME. Cost: two live storage backends, and
  `getStorageAdapter()` is a **single process-wide singleton** (`getStorageAdapter.ts:7,55-108`) —
  it cannot currently return different adapters for different prefixes. That is a real refactor,
  and `keyFromPublicUrl` / `publicUrlKeys.ts` would need to reverse two URL shapes at once.
- **(d) Supabase Pro + a custom storage domain**, which lifts the HTML downgrade, then point sims
  straight at the bucket. Smallest code change of all; a plan/vendor decision I cannot price.

**I lean toward (a) now and (d) if the plan allows it** — (a) is hours of work and removes the
per-request S3 GET immediately; (d) deletes the proxy rather than optimising it. I would treat (b)
as attractive but gated on an explicit cache-header audit of every route, and (c) as the largest
change for a benefit (d) may deliver for free.

**Evidence that decides it.** (1) How many *text* files a representative published package has,
and what fraction of live `simulations` rows have an active `sim_revisions` row (§6.3 item 4) —
if most packages are revisioned, the `immutable` path already covers them and this drops in
priority. (2) Whether the Supabase plan already includes the custom-domain storage feature. (3)
Current Supabase Storage request counts on the dashboard: `viewers × text files` is the number to
compare against the plan's included requests.

---

## D3. `view_count`: exact and contended, or cheap and approximate?

**Problem.** Three public paths do `UPDATE … SET view_count = view_count + 1` on a single
`projects`/`playlists` row (`permalink.controller.ts:91`, `:108`, `share.controller.ts:43`,
`playlists.controller.ts:205`). Concurrent viewers of the same project serialise on that tuple, and
each increment bloats a table carrying five indexes (§3.1).

**What I verified.** It is fire-and-forget (`.catch(() => {})`), so a failed increment is already
silently tolerated — the code has *already* decided this number need not be exact. It is read by
`admin/v1/pipeline-stats.controller.ts:28-29` as a `sum(view_count)` and surfaced in the player
config. No rate limit guards any of the three paths.

**Options.**
- **(a) Leave it.** Correct today; the ceiling is "one popular video".
- **(b) Insert-only counter table + periodic rollup** (`project_view_events` → hourly `SUM` into
  `projects.view_count`). No contention, but a new unbounded table — exactly the §4 problem this
  document argues against creating more of, unless it ships with retention from day one.
- **(c) In-process buffered increment**: accumulate in a `Map`, flush every N seconds. Almost free,
  loses at most N seconds of counts on a crash, no new table. Works because there is exactly one
  API container today — and stops being sufficient the moment there are two.
- **(d) Sampled counting** (increment with probability p, multiply on read). Cheapest; the number
  becomes visibly approximate, which is a product decision, not an engineering one.
- **(e) Derive views from `branch_path_events` / `sim_rum_events`** rather than maintaining a
  counter — folds into D4.

**I lean toward (c).** It matches what the code already believes (the count is best-effort), needs
no schema change, and is ~30 lines. But it is explicitly a bet that the deployment stays
single-API-container, and that bet should be made consciously rather than inherited.

**Evidence that decides it.** (1) Is a view count shown to creators as a *product* number they
would dispute? (2) Peak simultaneous viewers of a single project — from access logs, `host=` and
path, over the busiest hour. Below ~20 this whole dilemma is theoretical; above ~100 it is the
first DB-side wall.

---

## D4. Retention on the analytics tables — what promise is being made to creators?

**Problem.** `branch_path_events` (per viewer interaction), `token_usage` (per generation),
`avatar_conversations` (per chat turn) have no retention, no archival, no partition (§4). The
codebase has one worked example of the right answer — `sim_rum_events`, with a CHECK-bounded
window, a batched sweep and an hourly timer (`RumService.ts:239-263`, `server.ts:509`) — and its
migration header argues the general principle. Nobody applied it to the other three.

**What I verified.** `branch_path_events` grows at `viewers × interactions`, which is faster than
anything else in the schema. The `branch/analytics` endpoint reads the whole table for a project
into Node (`branch.controller.ts:494`). `token_usage` reads are windowed and index-covered
(`LLMService.ts:146-150`, `RateLimitService.ts:20-25`), so its growth is a *size* problem only.
`avatar_conversations` is the memory backing an avatar persona, so deleting it changes product
behaviour, not just storage.

**Options.**
- **(a) Retention window only** (copy `reapRumEvents`). Simplest; destroys lifetime totals.
- **(b) Retention + a rollup table** (daily per-project/per-edge counts kept forever, raw events
  aged out). Preserves the analytics product; one more table and one more job.
- **(c) Partition by month** and detach old partitions. Best for very large volumes; the migration
  runner cannot express `CREATE INDEX CONCURRENTLY` (`migrate.ts:79-95`) but partitioning itself is
  fine — still, this is the heaviest option and premature without §6.3 item 3.
- **(d) Nothing for `token_usage`** (it is a cost ledger; people want history) and (a)/(b) for the
  other two.

**I lean toward (b) for `branch_path_events`, (d) for `token_usage`, and a separate product
conversation for `avatar_conversations`** — because that last one is not telemetry, it is the
avatar's memory, and truncating it changes what the feature does.

**Evidence that decides it.** (1) `pg_total_relation_size` per table today (§6.3 item 3) — if
`branch_path_events` is 40 MB this can wait a year. (2) Whether branching analytics is a shipped,
promised feature or an internal debug endpoint. (3) Whether `avatar_profiles.facts`
(`schema.ts:872-876`) already carries the durable memory, in which case the raw turn log *is*
disposable.

---

## D5. `prepare: false`, or move the web tier onto the session pooler?

**Problem.** `db/index.ts:28-33` leaves postgres-js at its default `prepare: true` while
`DATABASE_URL` is documented as the 6543 transaction pooler (§1.3). Two different fixes exist and
they pull in opposite directions.

**What I verified.** No `prepare` option anywhere in `backend-api/src`. `parseDbUrl`
(`db/index.ts:12-24`) discards the URL query string, so no `?pgbouncer=true`-style hint can reach
the driver. The app is round-trip-heavy: 11–17 queries per player-config request (§3.2), 3 per
authenticated request before the handler runs (§3.7). pg-boss already has its own session-mode
endpoint, so the two concerns are separable.

**Options.**
- **(a) `prepare: false`.** One line. Removes the failure class entirely and keeps the transaction
  pooler's connection headroom. Cost: Postgres re-plans every statement. On a workload of many
  small, simple, index-covered queries that is a small per-query cost — but it is paid 11–17 times
  per player-config request, so it is not zero.
- **(b) Point `DATABASE_URL` at the 5432 session pooler and keep prepared statements.** Recovers
  plan caching and every other session feature. Cost: each app connection becomes a real Postgres
  backend, so the two ×10 pools become 20 backends instead of 20 pooler clients — which is fine at
  today's size and is exactly the headroom you give up first when you grow.
- **(c) `prepare: false` now, revisit if `pg_stat_statements` shows planning time is material.**

**I lean toward (c).** The failure mode of (a) being wrong is a small latency cost you can measure;
the failure mode of leaving it unset is a class of errors that appears under load and looks like a
database outage. But I will not assert that Supavisor is currently *failing* on this — I could not
verify it from the checkout, and asserting it would be exactly the kind of guess this review is
supposed to avoid.

**Evidence that decides it.** (1) Production logs: any occurrence of `prepared statement`.
(2) `pg_stat_statements`: compare `total_plan_time` to `total_exec_time` for the top queries
before and after — if planning is under a few percent, (a) is free and the dilemma dissolves.

---

## D6. Uploads: keep them streaming through the API, or move to presigned direct-to-bucket?

**Problem.** Three upload routes buffer whole files into the Node heap
(`audio.controller.ts:67`, `corpus.controller.ts:69`, `podcast.controller.ts:397`) under a 10 GB
global multipart ceiling (`server.ts:198`) — already filed as `performance-001/002/003/010`. The
straightforward fix is to make them stream, matching `video.controller.ts:161`. The *structural*
fix is to stop uploading through the app server at all.

**What I verified.** The adapter already implements the full direct-upload surface —
`getPresignedUploadUrl`, `createMultipartUpload`, `getPresignedUploadPartUrl`,
`completeMultipartUpload` (`SupabaseStorageAdapter.ts:205-265`) — so the capability is built. The
audio route needs the bytes on local disk anyway to run `ffprobe` for duration, and the routes
enforce mime/size server-side today.

**Options.**
- **(a) Stream (the filed fix) + per-route size caps.** Small, safe, keeps every current
  invariant. Bytes still cross the 2-vCPU box, so the bandwidth ceiling is unchanged.
- **(b) Presigned direct-to-bucket for large media, keeping (a) for small files.** Removes the app
  server from the byte path entirely — the single biggest structural win available in §5. Cost:
  validation moves *after* the upload (a job probes the object and can reject it), the client
  gains a multi-step upload flow, and the trust boundary changes — a presigned PUT is a capability
  handed to the browser, so key derivation and prefix scoping must be airtight
  (`storage/prefixScope.ts` and `pathSafety.ts` exist and would be load-bearing).
- **(c) (a) now, (b) only for raw video.** Raw video is the only genuinely multi-GB content.

**I lean toward (c).** (a) is already scoped and reviewed; (b) is worth doing exactly once, for
the one content type whose size justifies the trust-boundary change.

**Evidence that decides it.** (1) Actual p95 upload size per route from the `video_files.file_size`
and `audio_files` columns. (2) Whether uploads and playback contend in practice — do upload spikes
correlate with player-config latency in the nginx access log (`rt=` / `urt=` are already logged,
`deploy/nginx/nginx.conf:15-18`)? If they do not, (b)'s urgency drops sharply.
