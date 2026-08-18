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
