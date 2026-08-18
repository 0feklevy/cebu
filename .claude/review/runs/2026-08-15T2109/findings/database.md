# database-reviewer — findings

Commit under review: `2d187e3` (main). Engine: **PostgreSQL** via `drizzle-orm/postgres-js` +
`pg-core`. Reasoned in Postgres semantics throughout (partial indexes, `jsonb`, enforced `CHECK`,
expression-index matching rules, `CREATE INDEX CONCURRENTLY` transaction rule).

## Runner drift check — CLEAN (re-verified)

- `migrations/` holds 71 files: 58 forward `.sql`, 12 `.rollback.sql`, `phase2-schema.sql`
  (fully commented out).
- The hardcoded list in `db/migrate.ts:25` has exactly 58 entries.
- Set-diff of forward files on disk vs the list: **empty in both directions**.
- List order == filename sort order: **true**.
- No `.rollback.sql` and no `phase2-schema.sql` is in the runner list (correct — they are manual).
- **No `CREATE INDEX CONCURRENTLY` anywhere.** The two grep hits (`056_project_duplication.sql:48`,
  `058_project_exports.sql:69`) are the English word "concurrently" inside comment prose.
- No `DROP COLUMN`, `DROP TABLE`, or column `RENAME` in any forward migration. The only type change
  is `046:6` (`integer -> double precision` on `token_usage.cost_cents`), which is widening and
  expand-safe for the previous image.

---

### [P1] Migration runner marks a file applied after its transaction rolled back
- id: database-001
- location: podcast-saas/backend-api/src/db/migrate.ts:58
- category: data-integrity
- confidence: high
- status: confirmed
- what: When `sql.unsafe(sql_text)` fails with `42701` / `42P07` / `23505`, the catch at lines 49-53
  logs and swallows. Execution then falls through to line 58, which inserts the filename into
  `schema_migrations`. Because Postgres runs a multi-statement `simple` query as ONE implicit
  transaction, that error rolled back the **entire file**, including any statement that had not been
  applied before.
- why: A migration file that mixes already-present DDL with genuinely-new DDL is recorded as applied
  while none of it landed. The runner skips it forever afterwards (lines 28-34), so the new columns
  never exist and the app 500s on `42703` at runtime with no way to retry short of manual SQL. This
  is not hypothetical — commit `081c883` documents exactly this class of divergence causing
  "the player-config endpoint began returning 500 and the viewer showed no simulations at all".
- evidence: Read `migrate.ts:38-59`. The `catch` has no `continue`/`return`; the `INSERT INTO
  schema_migrations` on line 58 is unconditional. The in-file comment at lines 44-48 acknowledges
  the exact defect and asks the operator to verify manually rather than fixing it.
- fix: Do not record the file as applied when a tolerated error was caught. Concretely: in the
  tolerated branch, `logger.error(...)` then `continue` (skip the INSERT) so the next run retries,
  and make the remaining non-idempotent migrations idempotent (`ADD COLUMN IF NOT EXISTS`,
  `CREATE ... IF NOT EXISTS`, `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$` — the
  pattern 036/043/049-058 already use) so the tolerance is never needed. Every forward migration
  from 036 onward is already written this way; only 001-035 would need the sweep.
- verify: add a vitest case over the PGlite helper (`db/__tests__/pgliteHelper.ts`) that applies a
  file mixing an existing column with a new one and asserts `schema_migrations` does NOT contain it.
- effort: M

### [P1] The migration runner parses DATABASE_URL differently from the app
- id: database-002
- location: podcast-saas/backend-api/src/db/migrate.ts:12
- category: bug
- confidence: medium
- status: confirmed
- what: `migrate.ts` calls `postgres(connectionString, { max: 1 })`, handing the raw URL to
  postgres.js's own parser and setting no `ssl` option. `db/index.ts:11-27` deliberately does NOT do
  this: it has a `parseDbUrl()` helper whose comment states "postgres.js URL parser truncates
  usernames that contain a dot (e.g. the Supabase pooler format `postgres.project-ref`). Parse the
  URL manually and pass individual options so the full username is preserved", and it additionally
  forces `ssl: 'require'` for `*.supabase.com` / `*.supabase.co` hosts.
- why: `podcast-saas/deploy/README.md:101` says production `DATABASE_URL` is the Supabase pooler —
  the exact URL shape the workaround exists for — and `deploy/scripts/deploy.sh:153` runs
  `node dist/db/migrate.js` against it as a hard deploy gate. The runner therefore connects with a
  different username (and different TLS posture) from the app it is migrating for. If the repo's own
  documented postgres.js behaviour holds, migrations fail to authenticate on the production URL that
  the app connects with fine — and the deploy aborts (or, worse, succeeds against a different role).
- evidence: `migrate.ts:10-12` vs `db/index.ts:11-36`; `deploy/scripts/deploy.sh:149-156`;
  `deploy/README.md:98-136`. The divergence between the two connection paths is unambiguous from
  code reading. The underlying postgres.js truncation behaviour is asserted by this repo's own
  comment and by the existence of the workaround, not independently re-tested here (the guard
  forbids connecting to a database).
- fix: Export the parsed options from `db/index.ts` (e.g. `export const connectionOptions =
  parseDbUrl(connectionString)`) or move `parseDbUrl` into a new `db/connection.ts`, and have
  `migrate.ts` do `postgres({ ...connectionOptions, max: 1 })`. One shared parser, one behaviour.
- verify: `pnpm -C podcast-saas --filter backend-api typecheck` stays clean; a unit test asserting
  `parseDbUrl('postgresql://postgres.abc:pw@aws-0-x.pooler.supabase.com:5432/postgres').username ===
  'postgres.abc'` covers the contract for both callers.
- cross: @config-deploy
- effort: S

### [P1] Startup recovery fails every queued-but-unclaimed podcast job on every restart
- id: database-003
- location: podcast-saas/backend-api/src/services/podcast/audio/runPodcastRender.ts:62
- category: data-integrity
- confidence: high
- status: confirmed
- what: `recoverStuckPodcastRenders` runs `UPDATE podcast_renders SET status='failed' WHERE status
  NOT IN ('ready','failed') AND (claimed_at IS NULL OR claimed_at < now()-30min)`. The
  `claimed_at IS NULL` arm has **no age condition**, and a render row is inserted with
  `status='queued'`, `claimed_at` NULL (`controllers/v1/podcast-render.controller.ts:91-96`) before
  `enqueueJob('podcast_render', …)`. The identical shape exists in
  `services/podcast/runPodcastScript.ts:92` (podcast_scripts) and
  `services/podcast/audio/runPodcastClips.ts:196` (podcast_mixes).
- why: The function is called unconditionally at boot (`server.ts:648`). Any backend restart —
  a deploy, an OOM, a container recreate — flips **every** queued podcast render/script/mix in the
  whole database to `failed`, across all tenants, regardless of how young the row is. The work is
  then unrecoverable: the pg-boss job is still queued and will be delivered, but the CAS claim at
  `runPodcastRender.ts:25` excludes `status IN ('ready','failed')`, so the job bows out with
  "already claimed or terminal — skipping". The user sees "Render was interrupted — please try
  again" for a render that never started. `deploy.sh` restarts the backend on every release, so this
  fires on every deploy that overlaps a queued render.
- evidence: Read `runPodcastRender.ts:15-72` (claim + recovery share the predicate; the claim is
  supposed to accept NULL because it IS the first claim — the recovery is not).
  `podcast-render.controller.ts:91-99` inserts `status:'queued'` then enqueues.
  `server.ts:644-650` calls all three recoveries at boot. Contrast
  `jobs/video.generate.ts:229-249`, which for the same situation **re-enqueues** `queued` rows and
  only fails rows that may have already spent money — the correct pattern already exists in-repo.
- fix: In all three recovery functions, require a non-null stale claim:
  `and(isNotNull(x.claimed_at), lt(x.claimed_at, staleThreshold))`; and for rows that never started
  (`status='queued'` / `claimed_at IS NULL`), re-enqueue instead of failing, mirroring
  `recoverStuckVideoGenerations`. If a belt-and-braces sweep of never-claimed rows is still wanted,
  gate it on row age (`lt(created_at, staleThreshold)`), not on `claimed_at IS NULL`.
- verify: a vitest case that inserts a `queued` render with `claimed_at = null, created_at = now()`,
  calls `recoverStuckPodcastRenders()`, and asserts the row is still `queued` — red before, green
  after.
- cross: @job-queue
- effort: S

### [P2] Course-by-slug lookup cannot use any index (expression index does not match)
- id: database-004
- location: podcast-saas/backend-api/src/services/course/CourseRepository.ts:16
- category: perf
- confidence: high
- status: confirmed
- what: `findByPlatformSlug` filters `and(eq(courses.slug, slug), isNull(courses.canonical_host))`.
  The only index that mentions `slug` is `uniq_courses_host_slug ON courses (COALESCE(canonical_host,
  '@platform'), slug)` (`030_course_publishing.sql:111-112`). Postgres can only use an expression
  index when the query's predicate contains the **same expression**; `canonical_host IS NULL` is not
  `COALESCE(canonical_host,'@platform') = '@platform'`, so the planner cannot match it, and there is
  no plain `(slug)` index. `CourseRepository.slugTaken(slug, null, …)` at line 54 has the same shape.
- why: `findByPlatformSlug` is on the public course landing page and lesson page
  (`controllers/v1/public-courses.controller.ts:17,25`; `services/course/PublicCourseQueryService.ts:73,142`)
  — an unauthenticated, cacheable-but-uncached read that runs on every course view. It is a
  sequential scan whose cost grows with the total number of courses in the platform.
- evidence: Read `CourseRepository.ts:14-19,51-59`; read `030_course_publishing.sql:105-122` (full
  index list for `courses`: the expression unique, two partial uniques on `legacy_*_id`, `org_id`,
  `publish_state` — no `slug`). Confirmed against the full `CREATE INDEX` inventory of all 58
  forward migrations.
- fix: No migration needed — make the predicate match the index:
  `where: and(sql\`coalesce(${courses.canonical_host}, '@platform') = '@platform'\`, eq(courses.slug, slug))`
  in both `findByPlatformSlug` and the `canonicalHost === null` branch of `slugTaken`. (Alternative,
  if you prefer readability: add `CREATE INDEX idx_courses_slug ON courses (slug);` in a new
  migration **and add the filename to the hardcoded list in `migrate.ts:25`**.)
- verify: `pnpm -C podcast-saas --filter backend-api test` stays green; the existing
  `db/__tests__/courseSchema.constraints.test.ts` covers the uniqueness semantics the rewrite must
  preserve.
- effort: S

### [P2] The hottest read path selects every `scenes` column to use four scalars
- id: database-005
- location: podcast-saas/backend-api/src/services/buildPlayerConfig.ts:195
- category: perf
- confidence: high
- status: confirmed
- what: `db.query.scenes.findMany({ where: eq(scenes.project_id, project.id) })` has no `columns`
  list, so it selects all of `scenes` — including `aligned_words` (a `jsonb` of word-level
  alignment) and `transcript` (full text per scene). The only consumer is
  `normalizeSpeakerTimeline(allScenes)` at line 683, whose input type is
  `SceneRow { speaker, start_ms, end_ms, script_version }`
  (`services/avatarCircles/normalizeAvatarCircles.ts:19`).
- why: `buildPlayerConfig` is, by this file's own comment (lines 180-183), "the hottest read path
  (every player-config / share / playlist-item / course render)". The same file goes to considerable
  length at lines 118-140 to add an explicit `columns` list to the `simulations` read precisely so
  that path never pulls JSONB — and then pulls the whole `scenes` table for the project one query
  later. A scripted project has one scene per dialogue turn, each carrying its own word alignment.
- evidence: Read `buildPlayerConfig.ts:184-205` (the `Promise.all`) and line 683 (the only use of
  `allScenes`); read `normalizeAvatarCircles.ts:19,47-54` for the four fields actually read.
- fix: `db.query.scenes.findMany({ where: eq(scenes.project_id, project.id), columns: { speaker:
  true, start_ms: true, end_ms: true, script_version: true } })`. (The rows are also only used when
  `avatarConfigObj?.avatarCircles` is set, so a follow-up could skip the query entirely — but the
  `columns` list alone is the safe, behaviour-preserving change.)
- verify: `pnpm -C podcast-saas --filter backend-api test`; `normalizeSpeakerTimeline`'s existing
  suite (`services/avatarCircles/__tests__/normalizeAvatarCircles.test.ts`) already pins the shape.
- cross: @performance
- effort: S

### [P2] Branch analytics loads an unbounded event table into Node and aggregates in JS
- id: database-006
- location: podcast-saas/backend-api/src/controllers/v1/branch.controller.ts:494
- category: perf
- confidence: high
- status: confirmed
- what: `GET /api/v1/projects/:id/branch/analytics` runs
  `db.query.branch_path_events.findMany({ where: eq(branch_path_events.project_id, project.id) })`
  with no limit and no aggregation, then counts distinct sessions and groups by edge/sequence in a
  JS loop (lines 496-503).
- why: `branch_path_events` is written by `POST /api/v1/projects/:id/branch/events`
  (line 474), which uses `firebaseAuthOptionalMiddleware` and accepts anonymous viewers of any
  public/unlisted project — one row per `sequence_enter` / `choice` / `complete` per viewer session.
  It is the only event table in the schema with **no retention sweep** (`sim_rum_events` has
  `reapRumEvents` in `services/simulation/RumService.ts:239`, and migration 051's header explicitly
  argues "an events table with no enforced retention grows without bound and quietly becomes the
  largest thing in the database"). For a video that gets real traffic, this endpoint materialises
  every row ever recorded into the web process's heap.
- evidence: Read `branch.controller.ts:455-511`. Read `037_branching.sql` /`038_branch_analytics.sql`
  index list: only `idx_branch_events_project` and `idx_branch_events_edge`, no `created_at` index
  and no reaper anywhere in `src` (grep for `branch_path_events` shows insert + this select only).
- fix: (a) replace the JS loop with one SQL statement —
  `count(*) FILTER (WHERE event_type='complete')`, `count(DISTINCT session_id)`, and two
  `GROUP BY` selects for edge/sequence counts; (b) add a retention sweep modelled on
  `reapRumEvents` (bounded `ctid IN (… LIMIT n)` delete) plus
  `CREATE INDEX idx_branch_events_created ON branch_path_events (created_at);` in a new migration —
  **remembering to add that filename to the list in `migrate.ts:25`**.
- verify: new unit test asserting the aggregate numbers match the current JS implementation for a
  seeded fixture; `pnpm -C podcast-saas --filter backend-api test` green.
- cross: @performance
- effort: M

### [P2] Admin billing overview loads the entire `billing_transactions` table
- id: database-007
- location: podcast-saas/backend-api/src/controllers/admin/v1/billing.controller.ts:14
- category: perf
- confidence: high
- status: confirmed
- what: `const all = await db.query.billing_transactions.findMany();` — no `where`, no `limit`, no
  `columns`. Six aggregates (two sums, two counts, two distinct-counts) are then computed in JS over
  the full result (lines 15-21).
- why: `billing_transactions` gets a row per checkout attempt and is never pruned. Every load of the
  admin dashboard pulls the whole ledger into the API process. The neighbouring route at line 49
  already does the right thing (`limit: 200`), so this is an oversight rather than a design.
- evidence: Read `controllers/admin/v1/billing.controller.ts:8-46`. Read `024_billing.sql:19-41` —
  no partitioning, no archival, three plain indexes.
- fix: one query:
  `db.select({ txs: sql\`count(*) FILTER (WHERE status='succeeded')::int\`, volume: sql\`coalesce(sum(amount_cents) FILTER (WHERE status='succeeded'),0)::int\`, fees: …, pending: sql\`count(*) FILTER (WHERE status='pending')::int\`, creators: sql\`count(DISTINCT creator_user_id) FILTER (WHERE status='succeeded')::int\`, buyers: … }).from(billing_transactions)`.
  `pipeline-stats.controller.ts:46-52` already uses exactly this idiom in this repo.
- verify: assert the endpoint's JSON is byte-identical for a seeded fixture before/after.
- cross: @billing-integrity
- effort: S

### [P2] Two concurrent render requests can start two paid renders for one episode
- id: database-008
- location: podcast-saas/backend-api/src/controllers/v1/podcast-render.controller.ts:77
- category: data-integrity
- confidence: high
- status: confirmed
- what: The single-render guard is a read-then-insert: `findFirst` for a row whose status is in
  `ACTIVE_RENDER` (line 77-80), then `insert(podcast_renders)` at line 91. There is no uniqueness
  behind it — `podcast_renders` has only `idx_podcast_renders_episode ON podcast_renders(episode_id)`
  (`044_podcast_studio.sql`), a plain index.
- why: Two requests interleaved between the read and the insert both see no in-flight row and both
  insert. Each then runs a full ElevenLabs synthesis plus ffmpeg encode of the same episode: real
  money spent twice, plus a seed/cache race the controller comment itself warns about
  ("double cost + seed/cache races"). The per-user rate limit (10/hour) does not serialise a
  double-click. This repo already solved exactly this problem twice, in the database, and wrote down
  why: `058_project_exports.sql:67-73` ("Enforced by the database rather than by a read-then-insert
  in the handler, because the failure mode of a double-click is two multi-minute ffmpeg encodes")
  and `056_project_duplication.sql:46-52`.
- evidence: Read `podcast-render.controller.ts:36-105`. Grep of every `CREATE UNIQUE INDEX` /
  `UNIQUE (` across all 58 forward migrations shows no uniqueness on `podcast_renders`.
- fix: New migration (and add the filename to `migrate.ts:25`):
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_podcast_renders_inflight ON podcast_renders (episode_id)
   WHERE status IN ('queued','synthesizing','stitching','encoding');`
  then in the controller catch `23505` from the insert and return the existing in-flight row's id
  with `already_running: true`, exactly as the pre-check does today.
- verify: a test that fires two `POST …/render` concurrently and asserts exactly one
  `podcast_renders` row in a non-terminal status.
- cross: @billing-integrity
- effort: M

### [P2] `schema_migrations` has no checksum, so an edited applied migration is undetectable
- id: database-009
- location: podcast-saas/backend-api/src/db/migrate.ts:19
- category: data-integrity
- confidence: high
- status: confirmed
- what: The tracking table is `schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ)`
  and the skip check at line 28-30 is `SELECT filename … WHERE filename = $1`. Content is never
  hashed or compared. Editing a `.sql` file that a given database has already applied is therefore
  invisible: fresh databases get the new content, existing ones silently never do.
- why: This has already caused a production incident in this repo. Commit `081c883`
  ("fix(db): move the dropped column out of an already-applied migration") states: "`dropped` was
  added to 051 after 051 had already been applied. The runner records a migration by FILENAME and
  never re-runs it, so the column was created on fresh databases and silently absent on every
  existing one — a divergence that surfaces only as a 42703 in production, which is exactly what
  happened". `git log` confirms `051_sim_rum.sql` has four commits and `050_sim_revisions.sql` two.
  `ops/release/src/migration-audit.ts:183` does detect history rewrites, but only by diffing the
  working tree against a git base ref at release time — it cannot see what a given database actually
  applied, and it does not run for out-of-band `db:migrate` invocations.
- fix: `ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT;` in the bootstrap DDL
  at `migrate.ts:18-23`; record `sha256(sql_text)` alongside the filename on insert; and on the skip
  path, when a stored checksum exists and differs from the file on disk, `throw` with the filename
  and both hashes rather than skipping. Backfill of NULL checksums is a no-op (treat NULL as
  "unknown, do not enforce").
- verify: unit test over the PGlite helper — apply a file, mutate its bytes, re-run, assert the
  runner throws.
- cross: @release-auditor
- effort: M

### [P2] `DATABASE_URL` query parameters are silently discarded; TLS is host-name-gated
- id: database-010
- location: podcast-saas/backend-api/src/db/index.ts:14
- category: security
- confidence: high
- status: confirmed
- what: `parseDbUrl` builds the postgres.js options from `u.hostname`, `u.port`, `u.pathname`,
  `u.username`, `u.password` only. `u.search` is never read, so `?sslmode=require`,
  `?sslmode=verify-full`, `?options=…`, `?connect_timeout=…` are all dropped. `ssl` is then set to
  `'require'` **only** when the hostname ends in `.supabase.com` / `.supabase.co`, and left
  `undefined` otherwise. The database name is also not URI-decoded (`u.pathname.replace(/^\//,'')`).
- why: Today production is Supabase (`deploy/README.md:126`) so TLS happens to be on. The moment
  `DATABASE_URL` points anywhere else — Neon, RDS, a Supabase custom domain, a read replica behind a
  different hostname — an operator who wrote `?sslmode=require` in the URL gets a **cleartext**
  connection carrying the database password and every row, with no error and no log line. The
  security property depends on a hostname suffix match, which is exactly the kind of thing that
  silently stops being true.
- evidence: Read `db/index.ts:11-36`. `u.search` / `searchParams` appear nowhere in the file.
  `.env.example:3` shows the bare URL form with no parameters, so nothing in the repo forces the
  parameters to be honoured.
- fix: Parse `u.searchParams` and map at minimum `sslmode` onto postgres.js's `ssl` option; default
  `ssl: 'require'` for any host that is not `localhost`/`127.0.0.1`/`::1` rather than for a specific
  vendor suffix; and `decodeURIComponent` the database name. Then reuse the same helper from
  `migrate.ts` (see database-002).
- verify: unit tests on the exported `parseDbUrl` for `sslmode=require`, `sslmode=disable`, a
  localhost URL, and a dotted username.
- cross: @security @config-deploy
- effort: S

### [P2] Sitemap still issues one lessons query per published course
- id: database-011
- location: podcast-saas/backend-api/src/services/course/SitemapService.ts:39
- category: perf
- confidence: high
- status: confirmed
- what: `videoEntries()` loops over every published course and awaits
  `CourseLessonRepository.listByCourse(c.id)` inside the loop (lines 38-44). The comment two lines
  below (49-50) says "Batch-fetch projects and their non-broll videos in one query each (was a
  findFirst + findMany per lesson — N+1)" — the projects/videos N+1 was fixed, this one was not.
  `CourseRepository.listPublished` (line 26-31) has no `limit`, so the loop count grows with the
  platform's course catalogue.
- why: Sitemap generation is a public, uncached, sequential fan-out of N round-trips. At 500
  published courses that is 501 queries plus two batch queries per request, each awaiting the
  previous one.
- evidence: Read `SitemapService.ts:28-91` and `CourseLessonRepository.ts:9-14`.
- fix: replace the loop with one query —
  `db.query.course_lessons.findMany({ where: inArray(course_lessons.course_id, courses.map(c => c.id)), orderBy: [asc(course_lessons.course_id), asc(course_lessons.position)] })`
  (`idx_course_lessons_course` already supports it), then group into a `Map<courseId, Lesson[]>` and
  build `pairs` from that. Separately, give `listPublished` a bounded `limit` and paginate the
  sitemap, since a sitemap file is capped at 50k URLs anyway.
- effort: S

### [P2] No index behind the Stripe-webhook lookups by payment-intent id
- id: database-012
- location: podcast-saas/backend-api/src/services/billing/BillingService.ts:235
- category: perf
- confidence: high
- status: confirmed
- what: `markFailed` (line 235), `handleRefund` (line 250) and `handleDispute` (line 259) all filter
  `eq(billing_transactions.stripe_payment_intent_id, …)`. `024_billing.sql:39-41` creates indexes on
  `payer_user_id`, `creator_user_id` and `stripe_checkout_session_id` — but not on
  `stripe_payment_intent_id`. No later migration adds one (verified against the full `CREATE INDEX`
  inventory).
- why: Every `payment_intent.payment_failed`, `charge.refunded` and `charge.dispute.created` webhook
  performs a sequential scan of the whole transactions ledger, and does it inside Stripe's webhook
  timeout budget. The cost grows with lifetime sales.
- evidence: Read `BillingService.ts:222-262` and `024_billing.sql:19-41`.
- fix: new migration `CREATE INDEX IF NOT EXISTS idx_billing_tx_pi ON billing_transactions
  (stripe_payment_intent_id);` — and **add the filename to the hardcoded list in `migrate.ts:25`**,
  otherwise it silently never runs.
- cross: @billing-integrity
- effort: S

### [P3] `episode_number` is allocated with `max()+1` and no uniqueness behind it
- id: database-013
- location: podcast-saas/backend-api/src/controllers/v1/podcast.controller.ts:255
- category: data-integrity
- confidence: high
- status: confirmed
- what: `db.select({ next_num: sql\`coalesce(max(${podcast_episodes.episode_number}), 0) + 1\` })`
  followed by an insert. There is no unique constraint on `(show_id, episode_number)` in
  `044_podcast_studio.sql` or anywhere later.
- why: Two concurrent "new episode" clicks both read the same max and both insert the same episode
  number, silently. The sibling path got this right: `podcast_scripts` has
  `unique().on(episode_id, version)` (`schema.ts:1177`) and the controller wraps the allocate+insert
  in a 5-attempt retry on conflict (`podcast-script.controller.ts:42-60`). Impact is cosmetic
  (duplicate "Episode 3") rather than data loss, hence P3.
- evidence: Read `podcast.controller.ts:250-275` and `podcast-script.controller.ts:40-62` for the
  correct pattern; grep of all `UNIQUE`/`CREATE UNIQUE INDEX` shows nothing on `podcast_episodes`.
- fix: new migration adding
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_podcast_episodes_show_number ON podcast_episodes (show_id,
   episode_number) WHERE episode_number IS NOT NULL;` (filename added to `migrate.ts:25`), plus the
  same retry-on-23505 loop the scripts controller already uses.
- effort: S

### [P3] Per-user weekly/monthly token limits are stored and edited but never enforced
- id: database-014
- location: podcast-saas/backend-api/src/services/usage/RateLimitService.ts:9
- category: bug
- confidence: high
- status: confirmed
- what: `RateLimitService.checkTokenBudget` is the only consumer of
  `users.weekly_token_limit` / `users.monthly_token_limit`, and it has **no callers**. The admin API
  writes those columns (`controllers/admin/v1/users.controller.ts:32-46`, `PUT /api/admin/v1/users/
  :id/limits`), so an operator can set a per-user budget that does nothing.
- why: A quota an operator believes is active but is not is worse than no quota — it is the
  difference between "we capped that abusive account" and "we thought we did". The only quota
  actually enforced is the rolling-24h *call count* cap in `services/llm/systemAi.ts:72-89` and
  `services/llm/LLMService.ts:144-152`, which is a different measure (calls, not tokens) and is off
  by default.
- evidence: `grep -rn "checkTokenBudget" src` returns exactly one hit — the definition at
  `RateLimitService.ts:9`. Read `admin/v1/users.controller.ts:30-50` for the write path.
- fix: either call `checkTokenBudget(userId, user.weekly_token_limit, user.monthly_token_limit)`
  from the same guard block in `LLMService.callWithRetry` that already runs the daily-call cap, or
  delete `RateLimitService` and the two admin fields so nothing claims a limit that is not enforced.
  Note the query is well-indexed either way (`idx_token_usage_user_occurred`, migration 046).
- cross: @billing-integrity
- effort: S

### [P3] Project/playlist delete and its polymorphic collaborator cleanup are not atomic
- id: database-015
- location: podcast-saas/backend-api/src/controllers/v1/projects.controller.ts:436
- category: data-integrity
- confidence: high
- status: confirmed
- what: `DELETE /api/v1/projects/:id` issues `db.delete(projects)` (line 436) and then a separate
  `db.delete(collaborators)` (line 438) outside any transaction. `collaborators` is polymorphic
  (`content_type` + `content_id`, no FK), so nothing else reaps those rows.
  `controllers/v1/playlists.controller.ts:467-471` is the same shape.
- why: A crash, connection reset or deploy between the two statements leaves collaborator invite
  rows pointing at content that no longer exists, permanently. Impact is limited to accumulating
  dead rows — a new project gets a fresh random UUID, so an orphan never grants access to anything —
  which is why this is P3 rather than a security finding. The rest of the same handler is careful
  about ordering (see its "DB delete FIRST" comment at 434-435), so this is an inconsistency.
- evidence: Read `projects.controller.ts:414-460` and `playlists.controller.ts:456-474`. `grep` for
  `content_type` shows no reaper for orphaned `collaborators` rows.
- fix: wrap both deletes in `await db.transaction(async (tx) => { … })`, as
  `playlists.controller.ts:509` already does for the items replace-all.
- effort: S

### [P3] `maxPosition` loads every lesson row to compute one integer
- id: database-016
- location: podcast-saas/backend-api/src/services/course/CourseLessonRepository.ts:52
- category: perf
- confidence: high
- status: confirmed
- what: `maxPosition(courseId)` selects `{ position: true }` for all lessons of a course and reduces
  with `Math.max` in JS. `slugTaken` (line 44-50) has the same shape — it selects all matching rows
  and then filters in JS instead of adding the `excludeId` to the predicate.
- why: Correct today (a course has few lessons) but it is the pattern that becomes the problem, and
  the SQL form is shorter than the JS one.
- evidence: Read `CourseLessonRepository.ts:44-58`.
- fix: `const [r] = await db.select({ m: sql<number>\`coalesce(max(${course_lessons.position}), -1)::int\` }).from(course_lessons).where(eq(course_lessons.course_id, courseId)); return r.m;`
  and push `excludeId` into `slugTaken`'s `where` with `ne(course_lessons.id, excludeId)`.
- effort: S

### [P3] Avatar basic-library sync can duplicate rows across processes
- id: database-017
- location: podcast-saas/backend-api/src/services/avatar/libraryService.ts:323
- category: data-integrity
- confidence: medium
- status: confirmed
- what: `syncBasicLibrary` de-duplicates against `avatar_visuals` by reading existing rows and
  comparing `image_key` / `sim_entry_url` in JS (lines 344-366), guarded only by an **in-process**
  `lastSyncAt` Map (lines 320-326). `avatar_visuals` has no unique constraint — `028_avatar.sql`
  creates five plain indexes (`project`, `character_id`, `lookup_key`, `scope`, `visual_type`) and
  no uniqueness.
- why: The deployment runs a `backend` and a separate `worker` container (`deploy/docker-compose.yml`),
  so the throttle map does not span processes. Two concurrent syncs of the same project both see the
  same "existing" set and both insert, producing duplicate library entries that the avatar then
  offers twice. Impact is cosmetic, hence P3.
- evidence: Read `libraryService.ts:320-378`; read `028_avatar.sql` index list; `docker-compose.yml`
  runs `backend` and `worker` as separate services from the same image.
- fix: new migration adding
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_avatar_visuals_basic_image ON avatar_visuals (project_id,
   image_key) WHERE scope='basic' AND source='editor' AND image_key IS NOT NULL;` and the
  `sim_entry_url` equivalent (filenames added to `migrate.ts:25`), then use
  `.onConflictDoNothing()` on the two `insertVisual` paths.
- effort: M

---

## Areas swept and found clean (stated so the absence is evidence, not an omission)

- **Missing `where` on `update`/`delete`:** none. Every `db.delete(…)` / `db.update(…)` /
  `tx.delete(…)` / `tx.update(…)` call site in `src/**` (excluding `_archive`) was enumerated
  programmatically and each carries a `.where()`. The two large sweeps
  (`RumService.reapRumEvents:250`, `ProjectDuplicationService.sweepAbandonedDuplications:1872`,
  `ProjectExportService.sweepAbandonedExports:590`) are additionally **bounded per statement** via
  `ctid IN (… LIMIT n)` / `id IN (… LIMIT n)` subqueries.
- **Raw SQL injection:** every `sql\`\`` fragment in the reviewed scope interpolates through
  Drizzle/postgres.js parameter binding (`${}` inside a tagged template is a bind, not a splice).
  There is no `sql.raw(` anywhere in `src/**`. `db/jsonb.ts` builds `jsonb_build_array(…::text)`
  from bound parameters and is the correct fix for the double-encoding hazard it documents.
- **`timestamp` vs `timestamptz`:** every timestamp column in `schema.ts` uses
  `{ withTimezone: true }`, and every `TIMESTAMP` in the 58 forward migrations is `TIMESTAMPTZ`.
  Zero naive timestamps.
- **`jsonb` validation:** not "untyped". The studio timeline is validated with `MixTimelineSchema`
  before write (`podcast-studio.controller.ts:140`), `courses.learning_outcomes` is constrained by
  `courses_outcomes_array_chk` (`jsonb_typeof(...) = 'array'`), and the RUM ingest is bounded by
  `sim_rum_events_len_chk` at the DDL level.
- **Expand/contract:** no forward migration drops a column, drops a table, or renames anything; the
  single type change (046) widens `integer -> double precision`. `deploy.sh:153` runs migrations
  before swapping containers, which is the correct ordering for an expand-only policy.
- **Partial/expression indexes:** used correctly and deliberately, with the Drizzle limitation
  documented in-line each time (`schema.ts:571-574`, `1401-1404`, `1445-1448`, `468-471`).
- **`ON DELETE` coverage for `projects`:** every FK referencing `projects(id)` across all 58
  migrations has an explicit rule; the three that lacked one were fixed by `035`.
- **Rollback files:** 12 `.rollback.sql` exist and are correctly absent from the runner list.
