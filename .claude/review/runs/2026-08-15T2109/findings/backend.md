# Backend review — routes, services, async/error correctness

Reviewer: `backend-reviewer`. Commit `2d187e3` (main). Whole-codebase pass.

Scope swept: `podcast-saas/backend-api/src/server.ts`, all 27 `controllers/v1/*.controller.ts`,
all 7 `controllers/admin/v1/*.controller.ts`, `controllers/sim-public.controller.ts`,
`controllers/sim-rum.controller.ts`, `controllers/stubs.ts`, the unowned domain services
(`services/{project,course,avatar,ingestion,seo,secrets,security,video-generation}/**`,
`services/storage/**` correctness half, non-LLM/non-audio `services/podcast/**`, and the loose
files `collabAccess.ts`, `permalinkService.ts`, `buildPlayerConfig.ts`,
`transcriptPropagation.ts`), `src/scripts/**` (31 files), and `podcast-saas/ops/ship/**`.

Two structural checks came back clean and are worth recording as negatives:

- **Route registration is complete.** All 37 `register*Routes` functions exported under
  `controllers/**` are called exactly once from `server.ts`. No orphan registrar.
- **No route collisions.** No `method + literal path` pair is declared twice across
  `controllers/**`, including between `controllers/stubs.ts` and the real controllers that took
  over parts of the Phase-2 URL space.

---

### [P1] Any non-UUID `:id` path segment reaches a `uuid` column and 500s instead of 404ing
- id: backend-001
- location: podcast-saas/backend-api/src/controllers/v1/player.controller.ts:35
- category: bug
- confidence: high
- status: confirmed
- what: Route params are passed straight into `eq(<uuid column>, request.params.id)` with no UUID
  guard anywhere in the codebase. Postgres raises `22P02 invalid input syntax for type uuid`,
  which has no `statusCode`, so `server.ts`'s `setErrorHandler` maps it to **500 "Internal server
  error"** and logs it at `logger.error`.
- why: `GET /api/v1/projects/:id/player-config` is **public** (`firebaseAuthOptionalMiddleware`),
  so `curl /api/v1/projects/foo/player-config` is an unauthenticated 500 plus an error-level log
  line, on demand, from anyone. The same shape covers essentially every authenticated route:
  `editableProject(request.params.id, user)` (`services/collabAccess.ts:81`) throws rather than
  returning `undefined`, so `/api/v1/projects/<garbage>/videos`, `/sections`, `/simulations`,
  `/export` etc. all 500. It is also reachable from a *valid-looking* client bug: the permalink
  availability route passes an arbitrary query string into `ne(projects.id, exclude.id)`
  (`services/permalinkService.ts:71`), so `?exclude_type=project&exclude_id=new` 500s.
  The correct answer is 404 (or 400) — a truncated/stale link should not read as a server fault,
  and it should not burn the 5xx budget that alerting watches.
- evidence: Confirmed the Postgres behaviour directly against the repo's own test engine —
  `node -e` with `@electric-sql/pglite` (a devDependency of `backend-api`), `create table t (id
  uuid primary key)` then `select * from t where id = $1` with `'not-a-uuid'` →
  `ERRCODE 22P02 invalid input syntax for type uuid: "not-a-uuid"`. `projects.id` is
  `uuid('id').primaryKey()` (`db/schema.ts:155`), `project_exports.id` likewise
  (`db/schema.ts:1424`). Read `server.ts:587-601`: the error handler reads
  `(err as {statusCode?: number}).statusCode ?? 500` — a `PostgresError` carries `code`, not
  `statusCode`. Grepped for `z.string().uuid()` / `UUID_RE` across `src/`: no controller validates
  a *path* param; the only `UUID_RE` uses are in `storage/mediaAccess.ts`,
  `simulation/revisionIdentity.ts` and two scripts.
- fix: Add a shared `uuidParam` guard and apply it at the boundary. Cheapest correct version: give
  the `:id`-taking routes a Fastify param schema, e.g.
  `{ schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] } } }`
  (Fastify's ajv has `format: uuid` via `ajv-formats`; add it if absent) — Fastify then answers 400
  before the handler. If a schema per route is too invasive, add
  `export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)`
  to `services/collabAccess.ts` and return `undefined` from `editableProject`/`editablePlaylist`
  when it fails, plus an explicit check in `player.controller.ts:35`, `share.controller.ts`,
  `export.controller.ts:191`, `projects.controller.ts:582` and `permalinkService.ts` `toExclude`.
- verify: new test asserting `app.inject({url:'/api/v1/projects/foo/player-config'})` returns 404
  (red today: 500); `pnpm -C podcast-saas --filter backend-api typecheck` stays clean.
- cross: @test-quality, @observability
- effort: M

---

### [P2] `PUT /local-storage/upload/*` can never run — Fastify 415s every binary body before the handler
- id: backend-002
- location: podcast-saas/backend-api/src/server.ts:525
- category: bug
- confidence: high
- status: confirmed
- what: The local-dev "presigned upload" endpoint reads `request.body as Buffer`, but the app
  registers no content-type parser for binary payloads. Fastify 4 ships parsers only for
  `application/json` and `text/plain`; `@fastify/multipart` adds exactly one more
  (`multipart/form-data`). A `PUT` with `Content-Type: video/mp4` — which is precisely what
  `POST /api/v1/projects/:id/videos/upload-url` tells the browser to send
  (`video.controller.ts:220,225`) — is rejected with `415 FST_ERR_CTP_INVALID_MEDIA_TYPE` before
  the handler is entered.
- why: `LocalStorageAdapter.getPresignedUploadUrl` (`services/storage/LocalStorageAdapter.ts:79`)
  returns this URL, so the whole single-PUT upload path is dead in local dev: the browser gets a
  415 with no useful message and the video never lands. The `as Buffer` cast is what hides it from
  `tsc` — typecheck is green on a body that can only ever be `undefined`. Production is unaffected
  (line 529 returns 404 when `NODE_ENV === 'production'`), which is why this is P2 and not P1, but
  it silently removes a documented code path for every local-dev upload.
- evidence: Ran the real plugin stack, no server bound:
  `node --input-type=module -e "…Fastify(); await app.register(multipart,…); app.put('/u/*', …);
  await app.inject({method:'PUT', url:'/u/videos/x.mp4', headers:{'content-type':'video/mp4'},
  payload: Buffer.from('abc')})"` →
  `415 {"code":"FST_ERR_CTP_INVALID_MEDIA_TYPE","message":"Unsupported Media Type: video/mp4"}`;
  `application/octet-stream` gives the same. Confirmed the plugin's only registration:
  `grep -n addContentTypeParser backend-api/node_modules/@fastify/multipart/index.js` →
  one hit, `fastify.addContentTypeParser('multipart/form-data', setMultipart)`. Grepped
  `addContentTypeParser` across `src/`: the only call is the raw-body parser scoped to the Stripe
  webhook (`controllers/v1/stripe-webhook.controller.ts:13`).
- fix: In `build()`, before registering the route, add a binary catch-all parser scoped to dev:
  `app.addContentTypeParser(['application/octet-stream','video/mp4','video/webm','video/quicktime'],
  { parseAs: 'buffer' }, (_req, body, done) => done(null, body));` — or, better, register it with
  an explicit `bodyLimit` matching `MAX_UPLOAD_BYTES` so a dev upload cannot exhaust the heap.
  Then drop the `as Buffer` cast in favour of a `Buffer.isBuffer(request.body)` guard that 400s.
- verify: `app.inject` PUT with `content-type: video/mp4` returns 200 `{ok:true}` and the file
  exists under `LOCAL_STORAGE_BASE_DIR`; the production branch still 404s.
- effort: S

---

### [P2] `courses.controller.ts` throws its validation errors, so every bad body is a 500
- id: backend-003
- location: podcast-saas/backend-api/src/controllers/v1/courses.controller.ts:17
- category: bug
- confidence: high
- status: confirmed
- what: This controller is the one place in the v1 surface that uses `schema.parse(...)` instead of
  `safeParse`, and several routes have no schema at all. `handle()` catches only
  `CourseAuthzError` and rethrows everything else, so a `ZodError` — which carries no `statusCode`
  — reaches `server.ts`'s error handler and becomes `500 {"error_type":"server_error","message":
  "Internal server error"}`. Every other v1 controller answers 400 with the zod message.
- why: Two concrete requests: `PATCH /api/v1/courses/:id` with `{"title": 5}` →
  `contentSchema.parse` throws → 500 (line 44). `POST /api/v1/courses/:id/reorder` with `{}` →
  `req.body.orderedLessonIds` is `undefined` → `reorderLessons` dereferences
  `orderedLessonIds.length` (`services/course/CoursePublishingService.ts:149`) → `TypeError` →
  500. `POST /api/v1/courses/:id/slug` and `.../archive` read `req.body.slug` /
  `req.body.disposition` with no guard at all. The client cannot distinguish "I sent something
  wrong" from "the server is broken", and the 5xx rate is what alerting watches.
- evidence: Read `courses.controller.ts` in full. `handle` (lines 17-23) is
  `try { return reply.send((await fn()) ?? {ok:true}) } catch (err) { if (err instanceof
  CourseAuthzError) …; throw err }`. `contentSchema.parse` at line 44, `seoSchema.parse` at 50.
  Raw body reads at lines 54 (`req.body.slug`), 62 (`req.body.projectId`), 70
  (`req.body.orderedLessonIds`), 82 (`req.body.disposition`). `server.ts:587-601` has the only
  `setErrorHandler`; nothing maps `ZodError` to 400.
- fix: Switch both schemas to `safeParse` and return `reply.code(400).send({ message:
  parsed.error.message })`, matching `projects.controller.ts:73`. Add zod schemas for the four
  routes that read `req.body.X` raw. Optionally widen `handle()` to also map
  `err instanceof ZodError` → 400 so a future `.parse` cannot regress this.
- verify: `app.inject` `PATCH /api/v1/courses/<id>` with `{"title":5}` returns 400 (500 today);
  `POST /api/v1/courses/<id>/reorder` with `{}` returns 400.
- effort: S

---

### [P2] Course slug allocation dedupes per-org, but the unique index is global — cross-tenant collision 500s
- id: backend-004
- location: podcast-saas/backend-api/src/services/course/CoursePublishingService.ts:62
- category: bug
- confidence: high
- status: confirmed
- what: `createCourse` builds its taken-slug set from `CourseRepository.listByOrg(user.orgId)` —
  only this organization's courses — and then inserts. The database's uniqueness constraint is
  `uniqueIndex('uniq_courses_host_slug').on(COALESCE(canonical_host,'@platform'), slug)`
  (`db/schema.ts:898`), which spans **all** orgs. Two orgs creating a course titled "Intro" both
  allocate `intro`; the second insert raises `23505` and nothing catches it.
- why: A 500 on a first-class authoring action, triggered by another tenant's data that the user
  cannot see, cannot diagnose, and cannot work around from the UI. The service already knows how
  to do this correctly two methods down: `changeSlug` calls
  `CourseRepository.slugTaken(normalized, course.canonical_host, id)` (line 103), and the
  availability endpoint calls `slugTaken(normalized, null, excludeId)` (line 54). Only the create
  path skips the check.
- evidence: Read `CoursePublishingService.createCourse` (lines 58-71) and `CourseRepository`
  (`slugTaken`, `listByOrg`). Confirmed the index definition and its `COALESCE` host sentinel in
  `db/schema.ts:897-899`; `org_id` is not a component. `courses.controller.ts:29-32` maps
  `createCourse` straight onto `POST /api/v1/courses` with no other guard.
- fix: Replace the per-org `taken` set with the same global check the other two paths use — loop
  `allocateSlug` against `slugTaken(candidate, null)` until free, or catch `23505` around the
  insert and retry with the next `-N` suffix (bounded, e.g. 5 attempts) before surfacing a 409.
- verify: seed two courses in different orgs with the same title; the second `POST /api/v1/courses`
  returns 201 with slug `intro-2` (500 today).
- cross: @database
- effort: S

---

### [P2] Rotating a platform API key deletes the old one before inserting the new one, outside a transaction
- id: backend-005
- location: podcast-saas/backend-api/src/services/secrets/ApiKeyService.ts:76
- category: data-integrity
- confidence: high
- status: confirmed
- what: `setSystemKey` does `await db.delete(api_keys).where(provider = …)` and then
  `await db.insert(api_keys).values(…)` as two separate statements. There is no transaction. If
  the insert fails — connection reset, pool exhaustion, a constraint — the platform's encrypted
  provider key is gone and there is nothing to roll back to.
- why: `api_keys.encrypted_key` is the only copy: it is AES-GCM ciphertext derived from
  `ENCRYPTION_KEY`, and the plaintext lives only in the admin's clipboard at that moment. Losing
  it silently disables every LLM/ElevenLabs call in the product (`getSystemKey` returns `null`,
  and callers degrade or throw) until someone notices and re-pastes it. The window is small but
  the failure is unrecoverable, which is what makes it worth a transaction.
- evidence: Read `ApiKeyService.ts:68-87` — the comment on line 75 even says "Upsert: delete old
  then insert". Caller: `controllers/admin/v1/llm-config.controller.ts:82`
  (`POST` behind `firebaseAdminRequired`). The same file's `removeSystemKey` is a single delete
  and is fine. No `db.transaction` anywhere in this service.
- fix: Wrap both statements: `await db.transaction(async (tx) => { await tx.delete(api_keys)…;
  await tx.insert(api_keys).values(…); })`. Better still, make it a real upsert —
  `db.insert(api_keys).values(…).onConflictDoUpdate({ target: [...], set: { encrypted_key,
  created_by } })` — which needs a unique index on `(provider)` where `user_id is null`; if that
  index does not exist, the transaction is the minimal correct fix.
- verify: a test that makes the insert reject and asserts the pre-existing row still resolves from
  `getSystemKey` after the call throws.
- cross: @database
- effort: S

---

### [P2] SSE handlers arm a keep-alive interval, flush headers, then `await` outside the try/finally
- id: backend-006
- location: podcast-saas/backend-api/src/controllers/v1/simulations.controller.ts:735
- category: bug
- confidence: medium
- status: confirmed
- what: In both guidance SSE routes the order is: `sendEvent('connected')` (which flushes response
  headers via `reply.raw.write`) → `setInterval(…, 15_000)` → `const controller = new
  AbortController()` → **`await db.update(simulations).set({guidance_status:'analyzing'})`** →
  `try { … } finally { clearInterval(keepAlive); reply.raw.end() }`. The awaited DB write sits
  *before* the `try`, so if it rejects the `finally` never runs: the 15-second interval stays
  armed and `reply.raw.end()` is never called.
- why: The stream is left open with a keep-alive heartbeat and no terminating frame — the editor
  sits on "analyzing…" until its own timeout. The error also escapes into Fastify's error handler
  on a reply whose headers are already on the wire, so the 500 body cannot be delivered either.
  The interval is only reclaimed if/when the client disconnects and the `request.raw.on('close')`
  handler at line 737 fires; an idle-but-connected client keeps it alive indefinitely. Contrast
  `sections.controller.ts:661-682`, which does the identical job with every resource acquired
  *inside* the try and released in `finally` — the correct shape already exists in the repo.
- evidence: Read `simulations.controller.ts:713-772` (analyze) and `816-893` (publish). In both,
  `setInterval` is at line 735 / 842, the `await db.update(...)` at line 739 / 846, and the `try`
  opens at 741 / 848. Compared against `sections.controller.ts:649-683`, where `keepAlive`,
  `timeout` and the lock are all released in one `finally`. I did not reproduce a rejecting
  `db.update` end-to-end, so the exact Fastify post-headers behaviour is stated as inference; the
  leaked interval and the missing `reply.raw.end()` follow from control flow alone.
- fix: Move the `await db.update(...)` inside the `try` in both handlers (it is already followed by
  a `catch` that writes `guidance_status: 'error'`), or move the `setInterval` + status write
  after the `try` opens. Either makes the `finally` cover every acquired resource.
- verify: a test that stubs the first `db.update` to reject and asserts the response stream ends
  and `clearInterval` ran (e.g. assert the process has no pending 15s timer).
- effort: S

---

### [P2] "Already running" guards in the podcast paths are read-then-write, so a double click starts two billable jobs
- id: backend-007
- location: podcast-saas/backend-api/src/controllers/v1/podcast-studio.controller.ts:108
- category: bug
- confidence: high
- status: confirmed
- what: `POST /studio/generate` reads the mix row, checks `existing?.status === 'generating'`, then
  (in a separate statement) updates it to `generating` and calls `enqueueJob('podcast_clips')`.
  There is no CAS and no unique index. Two concurrent requests both observe a non-generating row,
  both write `generating`, and both enqueue a `podcast_clips` job for the same `mixId`.
  `POST /studio/export` (lines 269-289) and `POST /episodes/:epId/render`
  (`podcast-render.controller.ts:77-102`) have the same read-then-insert shape.
- why: These jobs spend real ElevenLabs credits and saturate the ffmpeg worker — the code's own
  comment at `podcast-render.controller.ts:76` says "double cost + seed/cache races". The
  per-user rate limit (10/hour) does not help: both halves of a double-click are inside the same
  window and both are allowed. Two `podcast_clips` runs also race each other writing
  `podcast_clips` rows for the same episode. The codebase already has the right pattern in three
  other places — the CAS claim in `simulations.controller.ts:417-424`, and the in-flight partial
  unique index behind `project_exports` / `project_duplications` — so this is an inconsistency,
  not a missing capability.
- evidence: Read `podcast-studio.controller.ts:94-130` (generate), `246-291` (export) and
  `podcast-render.controller.ts:40-105`. None of the three narrows the `where` on the claiming
  write. Compared with `simulations.controller.ts:417-424`, which does
  `.where(and(eq(id, sim.id), eq(status, sim.status))).returning()` and 409s when the claim
  returns nothing, and with `export.controller.ts:159-169`, which relies on a `23505` from the
  partial unique index.
- fix: Make the claim atomic. For `generate`:
  `const [claimed] = await db.update(podcast_mixes).set({status:'generating',…})
   .where(and(eq(podcast_mixes.id, existing.id), ne(podcast_mixes.status, 'generating')))
   .returning();  if (!claimed) return reply.code(202).send({mix_id: existing.id,
   already_running: true});` and only enqueue after a successful claim. For the two render paths,
  add a partial unique index on `(episode_id) where status in (…active…)` and handle `23505` the
  way `export.controller.ts` already does.
- verify: fire two `POST /studio/generate` in parallel against one episode; exactly one
  `podcast_clips` job is enqueued and the other response carries `already_running: true`.
- cross: @job-queue, @billing-integrity
- effort: M

---

### [P2] Corpus ingestion is in-process fire-and-forget with no timeout and no stuck-row recovery
- id: backend-008
- location: podcast-saas/backend-api/src/controllers/v1/corpus.controller.ts:98
- category: bug
- confidence: high
- status: confirmed
- what: `POST /api/v1/projects/:id/corpus` inserts a `corpora` row, calls
  `builder.ingest(corpus.id).catch(log)` without awaiting, and 202s. `CorpusBuilder.ingest` first
  writes `ingestion_status: 'processing'` (`services/ingestion/CorpusBuilder.ts:34`). Nothing
  bounds that work and nothing recovers it: a deploy, crash, or hung child process leaves the row
  at `processing` **forever**.
- why: Every other in-process async pipeline in this app has a boot-time reaper — `server.ts`
  defines `recoverStuckTranscodes`, `recoverStuckSimulations`, `recoverStuckCrops` and calls four
  more `recoverStuck*` helpers at lines 644-650, precisely because "the row sits at processing
  forever" is a failure they already had. `corpora` is the one pipeline with the same shape and no
  reaper. It is also the least bounded: the YouTube path shells out to `python3` and then `yt-dlp`
  via `execFile` with **no `timeout` and no `maxBuffer` override**
  (`services/ingestion/YouTubeIngester.ts:41,64`), so a hung `yt-dlp` pins a child process and the
  row's status for the life of the container. The web path is a bare `fetch` with no
  `AbortSignal.timeout` (`services/ingestion/WebIngester.ts:22,33`).
- evidence: Read `corpus.controller.ts:96-139` (both branches fire-and-forget identically),
  `CorpusBuilder.ts:27-142`, `YouTubeIngester.ts`, `WebIngester.ts`. Grepped
  `corpora.*processing|recover|sweep` across `src/`: the only hit is the write in
  `CorpusBuilder.ts:34` — no reaper, no sweep, no watchdog. Separately confirmed the intended
  durable path is dead: `jobs/corpus.ingest.ts` defines a Trigger.dev task with
  `maxDuration: 300` and `retry.maxAttempts: 3`, but `grep -rn "corpusIngestTask"` across `src/`
  returns only its own definition, and it is not in `queue/registry.ts`.
- fix: Three parts, smallest first. (a) Give both `execFile` calls
  `{ timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }` and the `fetch`es an
  `AbortSignal.timeout(60_000)`. (b) Add a `recoverStuckCorpora()` to `server.ts` alongside the
  existing six, flipping `ingestion_status = 'processing'` older than ~30 min to `failed` with
  "Interrupted by process restart". (c) Route the work through the real queue —
  `enqueueJob('corpus_ingest', { corpusId })` with a handler in `queue/registry.ts` — and delete
  the dead Trigger.dev task.
- verify: kill the process mid-ingest, restart, assert the row reads `failed` rather than
  `processing`; a `yt-dlp` stub that never exits causes the ingest to fail at 120s.
- cross: @job-queue
- effort: M

---

### [P2] `ops/ship` `saveRun` documents write-then-rename but performs write-then-copy
- id: backend-009
- location: podcast-saas/ops/ship/src/state.ts:70
- category: bug
- confidence: high
- status: confirmed
- what: The function comments "Write-then-rename: a reader tailing this directory never sees a
  half-written state", then does `writeFileSync(tmp, json)`, `writeFileSync(stateFile,
  readFileSync(tmp))`, `rmSync(tmp)`. The second `writeFileSync` truncates `ship.json` and rewrites
  it in place — exactly the non-atomic write the comment claims to have eliminated. No `rename` is
  ever called.
- why: `ship.json` is the resumable state of a shipment that drives merges, releases and production
  deploy approvals. `loadRun` (line 79) parses it and returns `null` on a `JSON.parse` failure,
  and `null` reads as "no run" — so a reader (`ship status`, a watcher, a resumed `ship` process)
  that samples during the write sees a truncated file and concludes the shipment does not exist.
  The state is saved after every stage transition, so the window recurs throughout a run.
- evidence: Read `ops/ship/src/state.ts:70-87`. The import list on line 19 does not include
  `renameSync`. `loadRun`'s catch (lines 84-86) returns `null`, and `cli.ts`/`conductor.ts` treat a
  `null` load as "no such run".
- fix: `import { renameSync } from 'node:fs'` and replace the body with
  `writeFileSync(tmp, …); renameSync(tmp, paths.stateFile);` — one atomic operation on the same
  filesystem, which is what the comment already promises. Drop the `readFileSync` and the `rmSync`.
- verify: existing `ops/ship` suite stays green (`pnpm -C podcast-saas --filter ops-ship test`);
  add a test that asserts no intermediate truncated `ship.json` is observable.
- cross: @release-auditor
- effort: S

---

### [P2] `scripts/fix-migration-tracking.ts` writes to `schema_migrations` with no dry-run and no confirmation
- id: backend-010
- location: podcast-saas/backend-api/src/scripts/fix-migration-tracking.ts:1
- category: data-integrity
- confidence: high
- status: confirmed
- what: The script opens a `postgres()` connection to `process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/podcast_saas'` and unconditionally inserts four
  filenames into `schema_migrations` if they are absent. It takes no flags, has no `--apply`
  gate, prints no plan, and asks for no confirmation. It is the only script in `src/scripts/`
  that mutates state destructively-by-default.
- why: Marking a migration as applied without running it is the one edit to `schema_migrations`
  that can never be detected later: `db/migrate.ts` skips any filename already recorded, so the
  DDL in `014_clip_source.sql` … `017_broll_audio.sql` is permanently unreachable on that
  database. `stack.md` §4 already records a variant of this failure as `database-003`. Twelve
  other scripts in this directory (`backfill-localhost-urls`, `rebuild-sim-bridges`,
  `classify-orphan-sim-rows`, `sim-canary-publish`, …) are all report-first with an explicit
  `--apply`; this one is not, and it is aimed at the most fragile table in the schema.
- evidence: Read the whole file (21 lines). No `process.argv` reference, no `--apply`, no
  `readline`. Compared with `backfill-localhost-urls.ts:52-54` (`const APPLY =
  argv.includes('--apply')` plus a `--approve-unsafe` blast-radius cap) and
  `sim-canary-publish.ts:12` ("DRY RUN BY DEFAULT. Nothing is written without `--apply`.").
  Confirmed the hardcoded DSN fallback on line 2.
- fix: Add the same gate the sibling scripts use: default to printing which filenames *would* be
  inserted and exit 0; require `--apply` to write. Remove the hardcoded `DATABASE_URL` fallback
  and exit non-zero when it is unset, so the script can never silently target the wrong database.
  Given `stack.md` records the runner list as verified clean on 2026-08-14, consider deleting the
  script outright — it encodes a one-off repair from an era that has passed.
- verify: running with no flags prints a plan and leaves `schema_migrations` unchanged.
- cross: @database, @migration-auditor
- effort: S

---

### [P2] An error inside the async `.catch()` of the sim upload/replace chains is an unhandled rejection
- id: backend-011
- location: podcast-saas/backend-api/src/controllers/v1/simulations.controller.ts:230
- category: bug
- confidence: medium
- status: confirmed
- what: Both async sim pipelines end with `processPromise.then(async ({…}) => { await
  db.update(...) }).catch(async (err) => { await db.update(...).set({status:'failed'}); logger.error(...) })`.
  The `.catch` is the last link in the chain: if the `db.update` *inside it* rejects, that
  rejection has no handler. Under Node 22 the default `--unhandled-rejections=throw` terminates
  the process.
- why: The trigger is exactly the moment you least want a crash — the database is already
  misbehaving (which is often *why* the sim processing failed), and the response was sent minutes
  ago, so the failure surfaces as the API restarting rather than as a failed simulation. The blast
  radius is the whole web process: every in-flight request, plus (with `WORKER_INLINE=1`) the
  in-process pg-boss worker. Same shape at line 438 in the replace handler; the podcast and avatar
  paths use `.catch(() => {})`, which is ugly but cannot do this.
- evidence: Read `simulations.controller.ts:217-241` (upload) and `427-445` (replace). In both,
  the `.catch` handler is `async` and its body is a bare `await db.update(...)` with no inner
  try/catch and no trailing `.catch`. `package.json` `engines`/`stack.md` put Node at >=22, where
  an unhandled rejection is fatal by default. I did not force a rejecting `db.update` to observe
  the process exit, so the crash itself is inferred from documented Node semantics; the missing
  handler is confirmed by reading.
- fix: Wrap the body of each `.catch` in its own `try/catch` that only logs, e.g.
  `.catch(async (err) => { try { await db.update(...) } catch (e) { logger.error({e}, 'failed to
  record sim failure') } logger.error({simId, err}, 'Simulation processing failed'); })`. Same edit
  at both sites.
- verify: unit test that stubs the failure-path `db.update` to reject and asserts no
  `unhandledRejection` is emitted.
- cross: @observability
- effort: S

---

### [P3] `/api/v1/hosts` dereferences `default_org_id!` where `POST /api/v1/projects` returns 400
- id: backend-012
- location: podcast-saas/backend-api/src/controllers/v1/projects.controller.ts:613
- category: bug
- confidence: high
- status: confirmed
- what: `GET /api/v1/hosts` does `eq(hosts.org_id, orgId!)` and `POST /api/v1/hosts` does
  `values({ ...body.data, org_id: user.default_org_id! })`. `users.default_org_id` is nullable —
  `POST /api/v1/projects` in the same file guards it explicitly at line 70 with
  `return reply.code(400).send({ message: 'User has no default org' })`. The two host routes use a
  non-null assertion instead.
- why: For a user whose `default_org_id` is null, the GET silently returns `[]` (a
  `org_id = null` predicate matches nothing) and the POST hits a `NOT NULL` violation and 500s.
  The same request against `/api/v1/projects` gets a clear 400. The `!` is what lets both past
  typecheck.
- evidence: Read `projects.controller.ts:605-641` against the guard at lines 68-70 of the same
  file. `users.default_org_id` has no `.notNull()` in `db/schema.ts`.
- fix: Extract the guard used at line 68-70 into a small helper
  (`requireOrg(user, reply): string | null`) and call it at the top of both host routes.
- verify: a user with `default_org_id = null` gets 400 from both routes.
- effort: S

---

### [P3] `LocalStorageAdapter.uploadStream` leaks the write stream and a partial file on a source error
- id: backend-013
- location: podcast-saas/backend-api/src/services/storage/LocalStorageAdapter.ts:45
- category: bug
- confidence: high
- status: confirmed
- what: The promise wires `ws.on('error', reject)` and `stream.on('error', reject)` but never
  destroys `ws` on the error path and never unlinks the half-written destination. A source-stream
  error rejects the promise while the `WriteStream`'s file descriptor stays open until GC, and a
  truncated file is left at the destination key.
- why: A truncated object under a real storage key is worse than no object: `objectExists` and
  `listObjects` both report it as present, so a retry or a later read serves a corrupt file rather
  than failing cleanly. This adapter throws in production (`constructor`, line 27), so the blast
  radius is local dev and the CI/e2e fixtures — hence P3, not P2.
- evidence: Read `LocalStorageAdapter.ts:42-53`. No `ws.destroy()`, no `unlink`, no
  `stream/promises.pipeline`. Compare `VideoGenerationService.downloadAndStore`
  (`services/video-generation/VideoGenerationService.ts:309`), which uses
  `pipeline(res.body, createWriteStream(tmpFile))` and cleans its work directory in `finally`.
- fix: Replace the hand-rolled promise with
  `import { pipeline } from 'stream/promises'; try { await pipeline(stream, createWriteStream(dest)) }
  catch (err) { await rm(dest, { force: true }); throw err }`. `pipeline` destroys both ends on
  error, which is the behaviour the hand-rolled version is missing.
- verify: a test that pipes a stream which emits `error` mid-transfer and asserts no file remains
  at `dest`.
- effort: S

---

### [P3] `yt-dlp` writes subtitle files into `/tmp` that are never cleaned up
- id: backend-014
- location: podcast-saas/backend-api/src/services/ingestion/YouTubeIngester.ts:64
- category: bug
- confidence: high
- status: confirmed
- what: `getTranscriptViaYtDlp` passes `-o /tmp/%(id)s.%(ext)s` with `--write-auto-sub`, so every
  fallback invocation writes a `.vtt` (and possibly `.info.json`) into `/tmp` keyed by video id.
  Nothing removes them — the function only reads `stdout` from `--print-json` and returns a
  title/description string.
- why: Unbounded growth in the container's writable layer, keyed by attacker-influenced input (any
  authenticated user can post arbitrary YouTube URLs to
  `POST /api/v1/projects/:id/corpus`). The files are also never read, so they buy nothing. Every
  other temp-file user in the codebase uses `mkdtemp` + `rm` in a `finally`
  (`VideoGenerationService.ts:294,334`; `capture/isolation/containerCaptureProvider.ts:400`).
- evidence: Read `YouTubeIngester.ts:63-77`. The `-o` template is a fixed `/tmp` path, not a
  `mkdtemp` directory, and there is no `rm`/`unlink` in the function or its caller
  (`CorpusBuilder.ts:51-54`).
- fix: `const dir = await mkdtemp(join(tmpdir(), 'ytdlp-'))`, pass
  `-o ${dir}/%(id)s.%(ext)s`, and `await rm(dir, { recursive: true, force: true })` in a `finally`.
  Or drop `--write-auto-sub` entirely, since the return value only uses `title` + `description`.
- verify: run the fallback path twice and assert `/tmp` gains no files.
- effort: S

---

### [P3] The local-disk upload fallback is gone from the code but still documented in three places
- id: backend-015
- location: podcast-saas/backend-api/src/controllers/v1/video.controller.ts:155
- category: maintainability
- confidence: high
- status: confirmed
- what: `uploadStreamWithFallback` is now a one-line pass-through to
  `getStorageAdapter().uploadStream` — its own docblock says "there is no longer a local-disk
  fallback" (`services/storage/uploadStreamWithFallback.ts:9-12`). Three callers still describe
  and reason about the removed behaviour: `video.controller.ts:155-159` ("Stream the upload to
  durable local disk first, then best-effort re-upload to R2"), `server.ts:339-343` and
  `server.ts:486-488` ("R2 may not have the object when a read-only token forced the upload to fall
  back to durable local disk (uploadStreamWithFallback)").
- why: The two `server.ts` sites do not just comment the dead behaviour — they *implement*
  fallbacks premised on it, redirecting to `/hls-public` and `/video-raw` for bytes that the
  current upload path can no longer have written locally. The redirect is harmless (the local
  serve route 404s), but the next person to touch the proxy will reason from a guarantee that no
  longer holds.
- evidence: Read `uploadStreamWithFallback.ts` in full (20 lines, no fallback branch), against
  `video.controller.ts:155-165`, `server.ts:336-362` and `server.ts:485-493`.
- fix: Update the three comments to state the current contract (cloud-only; a failure throws), and
  either keep the `/video-raw` redirect with a comment naming its real remaining purpose (legacy
  objects written before the change) or delete it.
- effort: S

---

### [P3] `forceLocalStorage()` is a documented startup safety valve with no call site — and could not work if it had one
- id: backend-016
- location: podcast-saas/backend-api/src/services/storage/getStorageAdapter.ts:31
- category: maintainability
- confidence: high
- status: confirmed
- what: The docblock says "Called at startup when the R2 write-probe is denied (read-only token →
  PutObject AccessDenied)". No such call exists: `grep -rn forceLocalStorage src/` returns only
  the definition and one test. Separately, seven controllers capture the adapter once at route
  registration (`const storage = getStorageAdapter()` in `video`, `simulations`, `export`,
  `audio`, `playlists`, `podcast-render`, `podcast-studio`), so a later flip would not reach them
  anyway.
- why: A documented safety valve that does not exist is worse than none — it reads as "this case is
  handled" in review and in incident triage. And if someone wires it up later on the strength of
  the docblock, seven controllers would keep writing to the old adapter with no error.
- evidence: `grep -rn "forceLocalStorage" src/` → `getStorageAdapter.ts:31,69` (definition and a
  comment) plus `services/storage/__tests__/prodStorageGuard.test.ts:2,48`. Registration-time
  captures found with `grep -rn "^  const storage = getStorageAdapter()" controllers/`.
- fix: Either delete `forceLocalStorage` and its docblock, or wire it into `start()` next to the
  existing `ensureBucketCors` probe (`server.ts:633-640`) — and in that case change the seven
  controllers to call `getStorageAdapter()` per request instead of capturing it at registration.
- effort: S

---

### [P3] Two Trigger.dev job definitions are dead code that nothing can reach
- id: backend-017
- location: podcast-saas/backend-api/src/jobs/corpus.ingest.ts:4
- category: maintainability
- confidence: high
- status: confirmed
- what: `corpusIngestTask` (`jobs/corpus.ingest.ts`) and `videoTranscodeTask`
  (`jobs/video.transcode.ts`) are `@trigger.dev/sdk/v3` `task()` definitions. Neither is imported
  anywhere, neither appears in `queue/registry.ts`, and the app's queue is pg-boss + an inline
  driver. They carry retry/`maxDuration` policy that reads as if it applies and does not.
- why: They are the reason `corpus.ingest` *looks* durable while the real path is the unbounded
  in-process call in `corpus.controller.ts:98` (backend-008). `stack.md` §2 already flags
  `@trigger.dev/sdk` as a dependency to check before asserting anything about it; these two files
  are what makes the check necessary.
- evidence: `grep -rn "corpusIngestTask|videoTranscodeTask|jobs/video.transcode" src/` → only the
  definitions themselves and a `vi.mock('@trigger.dev/sdk/v3')` in
  `jobs/__tests__/videoGenerateQueue.test.ts:52`. `queue/registry.ts` maps twelve job names, none
  of them to these tasks. (`jobs/video.generate.ts` is live — it is reached via
  `runVideoGenerateLimited` in the registry.)
- fix: Delete both files (or move them under `_archive/`) and drop `@trigger.dev/sdk` from
  `backend-api/package.json` if `jobs/video.generate.ts` can lose its `task()` wrapper too.
- cross: @job-queue, @dependency-auditor
- effort: S

---

### [P3] `migrate-sim-revisions.ts` documents dry-run as the default but defaults to writing
- id: backend-018
- location: podcast-saas/backend-api/src/scripts/migrate-sim-revisions.ts:30
- category: maintainability
- confidence: high
- status: confirmed
- what: The header says "`--dry-run` is the default posture for a first pass: it lists exactly what
  would be written … without creating a draft or moving a byte." `parseArgs` initialises
  `{ limit: 25, dryRun: false, force: false }`, so running the documented command with no flags
  copies up to 25 simulations' bytes into revision prefixes.
- why: The blast radius is bounded (the script never activates a revision, which it says loudly and
  correctly), so this is storage spend and orphan revision rows rather than a corrupted read path.
  But it is the one place where a script's stated default and its actual default disagree, and the
  eleven sibling scripts all default to report-only.
- evidence: Read `migrate-sim-revisions.ts:1-40` — the docblock at lines 18-19 against
  `parseArgs`'s initialiser at line 30.
- fix: Either flip the default (`dryRun: true`, add `--apply` to opt in, matching
  `backfill-localhost-urls.ts` and `rebuild-sim-bridges.ts`) or reword the docblock to
  "`--dry-run` is the recommended first pass". The first is better — it matches every other script
  in the directory.
- effort: S

---

### [P3] Fleet: this agent's prompt claims `middleware/**` and `lib/**`, which `stack.md` assigns elsewhere
- id: backend-019
- location: .claude/reference/stack.md:93
- category: fleet
- confidence: high
- status: confirmed
- what: The `backend-reviewer` agent prompt lists `middleware/**` and `lib/**` in its scope.
  `stack.md` §3 assigns `.../src/middleware/**` to `security-reviewer` (row at line 93) and splits
  `.../src/{lib,config}/**` between `observability-reviewer` (`logger`, `sse.ts`,
  `fetchWithRetry`) and `config-deploy-reviewer` (`trustProxy.ts`, `publicOrigins.ts`) at line 107.
  Per `stack.md`'s own preamble, the SSOT wins and the contradiction is itself a finding.
- why: Overlapping scope produces duplicate findings that the orchestrator must dedupe, and — worse
  — the *gap* it creates: `lib/rateLimit.ts` is named by neither row of line 107, so under
  `stack.md` as written it has no owner. It is a module-level unbounded-until-swept `Map` behind
  three unauthenticated endpoints, which is exactly the kind of file that should not be
  unassigned.
- evidence: Read `stack.md:86-117` (the ownership matrix) against the `backend-reviewer` prompt's
  "Scope" section. Confirmed `lib/rateLimit.ts` exists and is imported by
  `controllers/v1/avatar.controller.ts:15`, `controllers/sim-rum.controller.ts:31`,
  `controllers/v1/podcast-studio.controller.ts:27` and
  `controllers/v1/podcast-render.controller.ts:12`.
- fix: In `.claude/agents/backend-reviewer.md`, drop `middleware/**` and `lib/**` from the scope
  line and replace with "signal to `@security` / `@observability`". In `stack.md:107`, add
  `rateLimit.ts` explicitly to one of the two owners (`security-reviewer` is the better fit given
  its callers).
- cross: @fleet-maintainer
- effort: S
