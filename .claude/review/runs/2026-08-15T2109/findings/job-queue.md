# job-queue — findings (run 2026-08-15T2109, commit 2d187e3)

Scope swept: `podcast-saas/backend-api/src/queue/**` (types, index, registry, pgBoss, pgBossDriver,
inlineDriver, startWorker, `__tests__`), `src/jobs/**`, `src/worker.ts`, the worker bootstrap +
stuck-job recovery in `src/server.ts`, all 13 `enqueueJob(` call sites, and the queue-relevant parts
of `podcast-saas/deploy/` (compose, deploy.sh, rollback.sh).

Verified against the **installed** pg-boss 12.23.0 (`node_modules/.pnpm/pg-boss@12.23.0/.../dist/{types.d.ts,plans.js,manager.js}`),
not from memory. Test run: `pnpm --filter backend-api exec vitest run src/queue src/jobs` → 4 files,
15 tests, all pass.

**Things that are genuinely right and I am not reporting:** the three-set agreement
(`PGBOSS_JOB_NAMES` ⊆ `JobName`, `handlers: JobHandlers` total over `JobName`) is enforced at the
type level by `as const satisfies readonly JobName[]` + the mapped type, so no queue can exist
without a handler. No `enqueueJob(...)` is inside a `db.transaction(...)` — I checked all 13 call
sites; every one follows a committed autocommit `insert().returning()`, so there is **no**
enqueue-before-commit race. `ProjectExportService.run` (CAS claim + 15 s heartbeat + fenced status
writes + terminal `failed`) and `runCropAnalysis` (source-hash skip + stale-claim CAS + terminal
`failed`) are correctly idempotent under at-least-once delivery. `runVideoGenerate`'s resume path
correctly refuses to re-submit (and therefore re-bill) an external task. `registry.ts`'s per-job
construction of `ProjectDuplicationService`/`ProjectExportService` is the only place a singleton
would have frozen an adapter, and it is handled.

---

### [P1] A retried or restart-recovered b-roll job re-downloads and appends a SECOND timeline section
- id: job-queue-001
- location: podcast-saas/backend-api/src/jobs/video.generate.ts:58
- category: data-integrity
- confidence: high
- status: confirmed
- what: `runVideoGenerate`'s only re-entry guard is `if (job.status === 'ready' || job.status === 'failed') return`.
  It never looks at `job.video_file_id`, which is written at step 4 (line 125). A job that dies
  *hard* between step 4 and step 7 — SIGKILL, OOM, worker restart — leaves `status='transcoding'`
  and `video_file_id` set. The `catch` at line 161 does not run for a hard kill, so the row is not
  flipped to `failed`. On the next delivery the guard passes, `externalTaskId` is set so it skips
  submit, re-enters the poll loop (line 108), gets the same `completed` result, and re-runs
  `svc.downloadAndStore(...)` → a second storage object and a second `video_files` row → a second
  `runVideoTranscode` → a second `timeline_sections` insert (line 142) at the same
  `global_offset_sec`.
- why: pg-boss is at-least-once by design and `video_generate` is configured `retryLimit: 2,
  expireInSeconds: 45*60` (`queue/pgBoss.ts:34`) with **no** `heartbeatSeconds`, so a killed job is
  redelivered as a matter of course. The user's timeline silently gains a duplicate b-roll clip they
  did not ask for, plus a duplicate paid asset in storage. This is work duplication, not just a
  retry cost.
- evidence: Read `video.generate.ts` lines 53-167 in full. The guard at 58 and the resume branch at
  101-104 are the only re-entry checks; `job.video_file_id` is read nowhere. Confirmed from
  `pg-boss@12.23.0/dist/types.d.ts:180-184` that `heartbeatSeconds` defaults to NULL (heartbeat
  disabled), so redelivery is driven purely by `expireInSeconds` and will happen. Schema confirms
  `video_generation_jobs.video_file_id` exists and is nullable (`db/schema.ts:684`).
- fix: In `runVideoGenerate`, after the terminal-status guard, add a resume-from-download branch:
  `if (job.video_file_id) { /* skip poll+download */ const videoFileId = job.video_file_id; ... }`
  jumping straight to step 5, and make the step-6 section insert conditional on
  `job.section_id == null` (query `timeline_sections` by `video_file_id` as the belt-and-braces
  check). Add a unit test that calls `runVideoGenerate` twice with a row already at
  `status='transcoding', video_file_id=<id>` and asserts `db.insert(timeline_sections)` is called
  exactly once.
- verify: new test red before the change, green after; `pnpm -C podcast-saas --filter backend-api test` stays green.
- effort: M

### [P1] Startup recovery re-enqueues b-roll jobs the worker is still running, with no claim to stop the second copy
- id: job-queue-002
- location: podcast-saas/backend-api/src/jobs/video.generate.ts:239
- category: data-integrity
- confidence: high
- status: confirmed
- what: `recoverStuckVideoGenerations()` selects **every** row whose status is in
  `['queued','enhancing','submitting','generating','downloading','transcoding']` with **no age
  cutoff**, and re-enqueues each one that has an `external_task_id` or is `queued`. It runs in the
  web tier at every boot (`server.ts:650`). In the production topology (compose runs a separate
  `worker` container, `docker-compose.yml:62`), a b-roll job legitimately in progress in the worker
  is in exactly those states — a routine `backend` restart therefore enqueues a *duplicate* of a
  live job.
- why: nothing stops the duplicate from running concurrently. `runVideoGenerate` has no CAS claim
  (unlike `runCropAnalysis`, `runPodcastRenderJob`, `ProjectExportService`), and
  `singletonKeyFor()` returns `undefined` for `video_generate` (`pgBossDriver.ts:41-44`) so pg-boss
  will not collapse it either — and even for `crop` that dedupe does not work (see job-queue-006).
  `localConcurrency` is 2, so both copies run at once, both poll the same external task, both
  download, both insert a `timeline_sections` row. Same user-visible damage as job-queue-001 but
  triggered by an ordinary deploy rather than a crash.
- evidence: Read `video.generate.ts:229-249` and `server.ts:642-653`. Compared with every other
  `recoverStuck*`: `recoverStuckTranscodes` (`server.ts:106`) and `recoverStuckPodcastRenders`
  (`runPodcastRender.ts:55`) both gate on a 30-minute staleness cutoff; this one has none. Read
  `runVideoGenerate` lines 53-167 — no claim, no `claimed_at`/`updated_at` column exists on
  `video_generation_jobs` (`db/schema.ts:680-697`).
- fix: Two parts. (1) Add a CAS claim to `runVideoGenerate` — this needs a migration adding
  `claimed_at timestamptz` to `video_generation_jobs`; claim with
  `UPDATE ... SET claimed_at=now() WHERE id=$1 AND (claimed_at IS NULL OR claimed_at < now()-interval '45 min')`
  and bow out on an empty `RETURNING`, mirroring `runPodcastRenderJob`. (2) Gate
  `recoverStuckVideoGenerations` on the same staleness window so a live job is never re-enqueued.
  Until the migration lands, (2) alone (using `created_at` as the age proxy) removes the
  deploy-triggered duplication.
- verify: test that seeds a `generating` row with a fresh `claimed_at` and asserts
  `recoverStuckVideoGenerations` enqueues nothing.
- cross: @database (new column/migration)
- effort: M

### [P1] A job interrupted by a deploy is never recovered — the recovery pass only runs at boot and only for rows already 30 minutes stale
- id: job-queue-003
- location: podcast-saas/backend-api/src/server.ts:98
- category: bug
- confidence: high
- status: confirmed
- what: `recoverStuckTranscodes()` fails rows matching
  `hls_status='processing' AND hls_started_at < now() - 30 min`, and it is called **once**, inside
  `start()` at line 644. There is no timer. A container restart kills an in-flight transcode whose
  `hls_started_at` is seconds-to-minutes old; the recovery pass that runs immediately afterwards
  skips it because it is not yet 30 minutes stale, and nothing ever looks again.
- why: the row stays at `hls_status='processing'` **forever** — the exact permanent-spinner failure
  mode this function exists to prevent. It is only cleared if the process happens to restart again
  more than 30 minutes later, which on a stable deployment it does not. The same shape applies to
  `recoverStuckPodcastRenders` (`services/podcast/audio/runPodcastRender.ts:55-66`, `STALE_MS = 30
  min`, boot-only) and `recoverStuckPodcastMixes`. Note `transcode` is *not* a durable queue name
  (`queue/pgBoss.ts:22`), so there is no pg-boss retry to save it either.
- evidence: Read `server.ts:97-111` (cutoff + single call site at 644) and confirmed via
  `grep -rn "recoverStuck"` that no `setInterval` schedules any of them — unlike
  `startExportSweep` (`ProjectExportService.ts:647`) and `startDuplicationSweep`, which *are*
  timers and are correctly wired at `server.ts:518,522`. Verified `deploy/scripts/deploy.sh:160`
  does `compose up -d` (immediate recreate), so the restart is seconds after the kill.
- fix: give the transcode and podcast-render recovery the same shape as the export/duplication
  reapers: export `sweepStuckTranscodes()` and start it on a 60 s unref'd `setInterval` from
  `server.ts` next to `startExportSweep()`. Keep the 30-minute staleness rule — with a timer it
  becomes correct instead of unreachable.
- verify: unit test that seeds a `processing` row with `hls_started_at = now()-31min` and asserts
  one sweep pass flips it; integration check that the sweeper is registered in `build()`.
- effort: M

### [P1] Every deploy SIGKILLs in-flight jobs: neither container sets `stop_grace_period`, so Docker's 10 s default fires long before the 25 s/30 s drains
- id: job-queue-004
- location: podcast-saas/deploy/docker-compose.yml:62
- category: bug
- confidence: high
- status: confirmed
- what: the `worker` service (line 62) and the `backend` service (line 24) set no
  `stop_grace_period`, so Compose's default of **10 seconds** applies. The worker's SIGTERM handler
  calls `stopBoss()`, which asks pg-boss for a **30 s** graceful drain (`queue/pgBoss.ts:103`); the
  backend's handler runs `app.close()` → `drainInlineJobs()` with a **25 s** budget
  (`queue/inlineDriver.ts:40`) → `stopBoss()` (another 30 s), i.e. up to 55 s sequentially. Both
  budgets are strictly larger than the kill window, so the drain can essentially never complete and
  the process is SIGKILLed mid-job.
- why: this is the failure mode the whole graceful-shutdown path was written for, and it is defeated
  by a missing one-line compose key. Downstream consequences are concrete: a SIGKILLed durable job
  stays `active` in pg-boss until `expireInSeconds` elapses (30 min crop / 45 min video_generate /
  60 min project_export — `queue/pgBoss.ts:33-35`) because **no `heartbeatSeconds` is configured**,
  so the user watches a dead job for up to an hour before it is even retried; a SIGKILLed *inline*
  job (8 of the 11 names, see job-queue-005) has no retry at all and lands in job-queue-003's
  never-recovered state. The sibling file already knows the fix —
  `deploy/docker-compose.export-worker.yml:51` sets `stop_grace_period: 10s` explicitly.
- evidence: `grep -n "stop_grace_period" deploy/docker-compose.yml` → no match; the only hit in the
  deploy tree is `docker-compose.export-worker.yml:51`. Read `worker.ts:32-38`, `pgBoss.ts:97-108`
  (`boss.stop({ graceful: true, timeout: 30_000 })`), `inlineDriver.ts:40-47`
  (`drainInlineJobs(timeoutMs = 25_000)`), `server.ts:674-686`. Confirmed from
  `pg-boss@12.23.0/dist/types.d.ts:180-184` that `heartbeatSeconds` is NULL by default, so expiry
  is the only liveness signal.
- fix: add `stop_grace_period: 120s` to the `worker` service and `stop_grace_period: 60s` to
  `backend` in `deploy/docker-compose.yml`, and set `heartbeatSeconds: 60` in `QUEUE_OPTIONS`
  (`queue/pgBoss.ts:32-36`) so a killed job is detected in ~1 minute instead of 30-60. Note the
  heartbeat change only takes effect on queues created *after* it (see job-queue-007).
- verify: `docker compose config | grep stop_grace_period` shows both; on a staging deploy, a
  running export survives `compose up -d` long enough to log `[pg-boss] stopped`.
- cross: @config-deploy
- effort: S

### [P2] Only 3 of 11 job types are durable — transcode, podcast render and project duplication still run in the API container despite the compose comment
- id: job-queue-005
- location: podcast-saas/backend-api/src/queue/pgBoss.ts:22
- category: bug
- confidence: high
- status: confirmed
- what: `PGBOSS_JOB_NAMES = ['crop','video_generate','project_export']`. `enqueueJob`
  (`queue/index.ts:32-38`) routes every other name to the inline driver, which runs the handler in
  the *calling* process. In production `backend` has `QUEUE_DRIVER: pgboss` and
  `WORKER_INLINE: 'false'`, so `transcode` (full HLS ffmpeg), `captions`, `metadata`,
  `podcast_script`, `podcast_render` (ffmpeg audio render), `podcast_clips`, `podcast_mix_export`
  and `project_duplicate` (copies gigabytes of objects) all execute **inside the web tier**.
- why: `docker-compose.yml:39` states `WORKER_INLINE: 'false'  # heavy jobs run in the dedicated
  worker container`, which is untrue for 8 of 11 names — and the header comment at `pgBoss.ts:17-21`
  records that the 2026-08-13 incident was "the kernel OOM-killing the API container mid-assembly,
  taking every in-flight request down with it". The same exposure remains for HLS transcode and
  project duplication. It is also why job-queue-003 and job-queue-004 bite: inline jobs are
  non-durable, so a deploy loses them outright.
- evidence: Read `queue/index.ts:18-38`, `queue/pgBoss.ts:22`, `deploy/docker-compose.yml:24-60`.
  Cross-checked each of the 13 `enqueueJob(` call sites — none of the 8 inline names is reachable
  only from the worker.
- fix: this is staged work (Phases B/C/D), so the immediate fix is truthfulness plus the next
  phase: correct the `WORKER_INLINE` comment in `docker-compose.yml:39` to name which jobs actually
  move, and promote `transcode`, `podcast_render` and `project_duplicate` into `PGBOSS_JOB_NAMES`
  with `QUEUE_OPTIONS` entries — all three already have CAS claims/idempotent re-entry
  (`runVideoTranscode` hls_status, `runPodcastRenderJob` `claimed_at`,
  `ProjectDuplicationService.claim`), so at-least-once is safe for them. Note `runPodcastRenderJob`
  swallows its error rather than rethrowing (`runPodcastRender.ts:39-50`), so it must be changed to
  rethrow after writing the failed status or pg-boss will never retry it.
- verify: extend `queue/__tests__/routing.test.ts` (after fixing job-queue-014) to assert the new
  durable set; a staging export/transcode shows up in the worker container's logs, not the API's.
- effort: L

### [P2] `singletonKey` does nothing: the queues use pg-boss's `standard` policy, which has no unique index on `singleton_key`
- id: job-queue-006
- location: podcast-saas/backend-api/src/queue/pgBossDriver.ts:30
- category: bug
- confidence: high
- status: confirmed
- what: `pgBossSend` passes `{ singletonKey: singletonKeyFor(name, payload) }` and its comment
  claims this "collapses duplicate *pending* jobs for the same target into one". `ensureQueues`
  (`pgBoss.ts:88`) never passes a `policy`, so `manager.createQueue` defaults to
  `QUEUE_POLICIES.standard`. In pg-boss 12.23.0 the unique indexes that make `singleton_key`
  deduplicate are **policy-scoped**: `job_i1` requires `policy='short'`, `job_i2` `'singleton'`,
  `job_i3` `'stately'`, `job_i6` `'exclusive'`, `job_i8` `'key_strict_fifo'`; `job_i4` requires
  `singleton_on IS NOT NULL`, which needs `singletonSeconds` (never passed). Under `standard` no
  index matches, the insert's `ON CONFLICT DO NOTHING` never fires, and every send inserts a new row.
- why: the stated queue invariant is false, and the `if (!id) logger.debug(... 'send deduped')`
  branch at line 32 is dead code that will never execute. `crop` is enqueued per video from
  `enqueueCropForProject` on every transcode completion and from the `/recrop` route, so a project
  with N videos re-uploaded twice produces 2N queued crop jobs rather than N. Each duplicate is
  claimed and mostly no-ops thanks to `runCropAnalysis`'s DB CAS — so this is wasted worker slots
  and table growth rather than corruption — but the queue is relying on a guarantee it does not have.
- evidence: read `pg-boss@12.23.0/dist/plans.js:605-631` (the five policy-scoped unique indexes),
  `plans.js:1261-1264` (`JOIN queue q ... ON CONFLICT DO NOTHING`), and `manager.js:1216-1229`
  (`const policy = options.policy || plans.QUEUE_POLICIES.standard`). `ensureQueues`
  (`pgBoss.ts:83-94`) passes only `{...QUEUE_OPTIONS[name], deadLetter}` — no `policy`.
- fix: create the `crop` queue with `policy: 'short'` (dedupe on `created`, which is exactly the
  "collapse duplicate pending jobs" semantics the comment describes) in
  `ensureQueues`/`QUEUE_OPTIONS`. Because `create_queue` is `ON CONFLICT DO NOTHING`
  (job-queue-007), applying it to the existing production queue requires an explicit
  `boss.deleteQueue('crop')`/re-create or a one-off `UPDATE pgboss.queue SET policy='short'`; say so
  in the deploy note. If that is not wanted, delete the `singletonKey` argument and the dead
  `if (!id)` branch so the code stops claiming a guarantee it does not provide.
- verify: after the change, sending the same `crop` payload twice with the first still `created`
  returns `null` for the second send.
- effort: M

### [P2] Queue options are frozen at first creation — retry/expiry/dead-letter tuning silently no-ops on an existing deployment
- id: job-queue-007
- location: podcast-saas/backend-api/src/queue/pgBoss.ts:88
- category: bug
- confidence: high
- status: confirmed
- what: `ensureQueues` calls `boss.createQueue(name, {...QUEUE_OPTIONS[name], deadLetter})` on every
  boot, which lands in `pgboss.create_queue(...)` — an `INSERT ... ON CONFLICT DO NOTHING`. Once the
  queue row exists, **every** later change to `retryLimit`, `retryDelay`, `retryBackoff`,
  `expireInSeconds`, `heartbeatSeconds`, `policy` or `deadLetter` in `QUEUE_OPTIONS` is discarded in
  silence. The `catch` around it logs at `debug` with the message "createQueue (already exists?)",
  which also hides a genuinely failed creation (bad grant, wrong schema) behind a log level that is
  off in production.
- why: the file's own comments treat `expireInSeconds` as a tuned safety property ("must exceed the
  worst-case job runtime"). The next person who raises `project_export`'s 60 minutes because
  captures got slower will ship a no-op and believe it took effect. It also blocks the fixes in
  job-queue-004 (`heartbeatSeconds`) and job-queue-006 (`policy`).
- evidence: `pg-boss@12.23.0/dist/plans.js:399-443` — the `create_queue` function body ends
  `ON CONFLICT DO NOTHING`. `manager.js:1216-1229` shows no update path. Confirmed the current
  values have never changed since first creation (`git log -p --follow` on `pgBoss.ts` shows each
  queue's options added once, alongside its name), so today's production values match the code —
  this is a trap, not yet a divergence.
- fix: after `createQueue`, reconcile: call `boss.updateQueue(name, {...QUEUE_OPTIONS[name],
  deadLetter: dead})` (pg-boss 12 exposes it) so the code is the source of truth on every boot; and
  raise the `catch` from `logger.debug` to `logger.warn` including `queue` and the error code so a
  real failure is visible.
- verify: change `crop`'s `retryLimit` locally, restart, and confirm `SELECT retry_limit FROM
  pgboss.queue WHERE name='crop'` follows the code.
- effort: S

### [P2] One knob named `cropConcurrency` sets the worker concurrency of every durable queue
- id: job-queue-008
- location: podcast-saas/backend-api/src/queue/pgBossDriver.ts:54
- category: perf
- confidence: high
- status: confirmed
- what: `registerWorkers` passes `{ localConcurrency: cropConcurrency() }` for **all** queues, and
  `cropConcurrency()` reads `QUEUE_CROP_CONCURRENCY ?? 2`. So the worker will run up to 2 crops **+
  2 video generations + 2 project exports = 6 heavy jobs concurrently**, and the only lever to
  change any of them is an env var named after crop.
- why: two concrete problems. (1) Discoverability: raising `QUEUE_CROP_CONCURRENCY` to speed up crop
  silently doubles concurrent ffmpeg exports on the same VM. (2) Expiry pressure: ffmpeg is globally
  capped at 2 per process (`services/ffmpegLimit.ts:8`, `FFMPEG_CONCURRENCY ?? 2`), so up to 6
  jobs contend for 2 ffmpeg slots while each holds a pg-boss job slot and burns its
  `expireInSeconds` clock — an export queued behind two crops and a b-roll transcode can spend much
  of its 60-minute window waiting, after which pg-boss redelivers it. (`ProjectExportService`'s
  claim prevents the second *encode*, so this costs a retry budget rather than correctness.)
- evidence: read `pgBossDriver.ts:17-19` and `:47-61`; the same `cropConcurrency()` value is used
  for every `name` in the loop. Read `services/ffmpegLimit.ts:8`. `queue/pgBoss.ts:32-36` for the
  expiry values. `pg-boss@12.23.0/dist/types.d.ts:437` confirms `localConcurrency` is per-queue,
  per-node.
- fix: move concurrency into `QUEUE_OPTIONS`-style per-queue config —
  `const WORKER_CONCURRENCY: Record<name, number> = { crop: env('QUEUE_CROP_CONCURRENCY', 2),
  video_generate: env('QUEUE_VIDEO_GEN_CONCURRENCY', 2), project_export: env('QUEUE_EXPORT_CONCURRENCY', 1) }`
  and pass `WORKER_CONCURRENCY[name]`. Default `project_export` to 1: an export already fans out
  internally and is the OOM-sensitive one.
- verify: `registerWorkers` unit test asserting a different `localConcurrency` per queue name.
- effort: S

### [P2] Dead-letter queues are created but nothing ever reads them — a poison job disappears with no alert
- id: job-queue-009
- location: podcast-saas/backend-api/src/queue/pgBoss.ts:85
- category: bug
- confidence: high
- status: confirmed
- what: `ensureQueues` creates `crop-dead`, `video_generate-dead` and `project_export-dead` and
  attaches them via `deadLetter`. No code anywhere subscribes to, queries, counts or alerts on them,
  and no code reads the pg-boss `job`/`queue` tables at all. A job that exhausts `retryLimit` has
  its payload copied into `<name>-dead`, sits there, and is deleted after the default
  `retentionSeconds` (14 days, `pg-boss@12.23.0/dist/types.d.ts:142`).
- why: the DLQ exists to make poison jobs *visible*, and here it only makes them quiet. There is
  also no backlog signal: `boss.on('error', ...)` at `pgBoss.ts:70` only logs, and the worker
  container deliberately has no health probe (`docker-compose.yml:78-79` — "the worker is PID 1, so
  if it crashes the container exits ... that IS the liveness guarantee"), which is true for a crash
  but not for a worker that is alive and not draining. The saving grace is that all three durable
  handlers write a terminal `failed` status on the owning row, so the *user* sees a failure — but
  the operator sees nothing.
- evidence: `grep -rn "pgboss|pg-boss|getBoss" src --exclude-dir=queue` returns only comments and
  the two bootstrap call sites; there is no admin route, no metric, no query against the pg-boss
  schema. Read `pgBoss.ts:83-94` and the admin controllers list in `stack.md` §3.
- fix: add a small periodic probe in `startWorker` (unref'd 60 s interval) that calls
  `boss.getQueueStats(name)` for each durable queue plus its `-dead` twin and logs
  `{queue, queued, active, deadLettered}` at `warn` when `deadLettered > 0` or `queued` exceeds a
  threshold. Surface the same numbers on the existing admin pipeline-stats endpoint so there is one
  place to look.
- cross: @observability
- effort: M

### [P2] Crop has no heartbeat, so pg-boss's 30-minute expiry can start a second concurrent crop of the same video
- id: job-queue-010
- location: podcast-saas/backend-api/src/queue/pgBoss.ts:33
- category: bug
- confidence: medium
- status: confirmed
- what: `crop` is configured `expireInSeconds: 30*60`. `runCropAnalysis`'s claim treats a
  `processing` row as reclaimable once `crop_updated_at` is older than `STALE_CLAIM_MS = 20 min`
  (`runCropAnalysis.ts:40, 79-97`), and `crop_updated_at` is written **once, at claim time** — there
  is no heartbeat refreshing it while the job runs. So for a crop that genuinely runs longer than 20
  minutes the claim is already stale; at 30 minutes pg-boss expires the still-running job and
  redelivers it, the redelivery's claim succeeds, and two `processVideoCrop` runs execute
  concurrently on the same video, both writing `crop/<videoFileId>.json`.
- why: two ffmpeg-heavy analyses of the same file on a 2-vCPU host, competing for the same 2 global
  ffmpeg slots, plus a last-writer-wins race on the crop object and the row. The comment at
  `pgBoss.ts:27-28` explicitly reasons "crop's stale-claim window is 20 min, so 30 min is a safe
  ceiling" — the inequality is backwards: the expiry must be *shorter* than the stale window for
  redelivery never to race a live run, or the claim needs a heartbeat.
- evidence: read `runCropAnalysis.ts:36-101` — `crop_updated_at` is set in the claim (line 88) and
  then not again until the terminal write (line 125/133). Confirmed `heartbeatSeconds` is NULL by
  default (`pg-boss@12.23.0/dist/types.d.ts:180-184`), so pg-boss expiry is purely wall-clock from
  `started_on`. Marked medium confidence only because it requires a >20-minute crop; the code path
  is unconditional once that holds.
- fix: give `runCropAnalysisInner` the same unref'd 15 s heartbeat `ProjectExportService` uses
  (`UPDATE video_files SET crop_updated_at = now() WHERE id = $1 AND crop_status='processing'`),
  which makes the 20-minute stale window a real death test. Belt-and-braces: set
  `heartbeatSeconds: 60` on the queue so pg-boss's own liveness matches.
- verify: a test that advances fake timers past 20 min with the heartbeat running and asserts a
  second `runCropAnalysis` bows out.
- effort: M

### [P2] Rolling back the image strands durable jobs whose queue the older image has never heard of
- id: job-queue-011
- location: podcast-saas/backend-api/src/queue/pgBoss.ts:22
- category: data-integrity
- confidence: high
- status: confirmed
- what: `PGBOSS_JOB_NAMES` is simultaneously the producer routing set and the consumer subscription
  set, and it has grown twice (`['crop']` → `+video_generate` → `+project_export`). `rollback.sh` is
  a supported one-command operation that re-launches the previous image tag for `backend` **and**
  `worker` (`deploy/scripts/rollback.sh:19-21`). The previous image (1838bbf) does not have
  `project_export` in `JobName` at all — so any `project_export` rows already persisted in
  `pgboss.job` have no subscriber, no handler, and no code path that will ever look at them. They
  sit in `created` until pg-boss's 14-day retention deletes them.
- why: this is the queue's version of the expand/contract rule that `stack.md` §4 already applies to
  migrations, and it is not being followed. Nothing detects or reports the orphans (job-queue-009),
  so the only signal is users' exports never completing. The `project_exports` rows themselves are
  saved by `sweepAbandonedExports` flipping them to `failed` after ~5 minutes, which turns a silent
  hang into a visible failure — but only because that reaper exists; a future durable job without
  one would hang forever.
- evidence: `git show 1838bbf:podcast-saas/backend-api/src/queue/types.ts` — `JobName` ends at
  `video_generate`. `git log -p --follow` on `pgBoss.ts` shows `PGBOSS_JOB_NAMES` growing at
  8afb6e9 → 1838bbf → d7cbff5. Read `deploy/scripts/rollback.sh:1-40`.
- fix: adopt expand/contract for queue names: (a) document in `pgBoss.ts` that a name may only be
  *added* in a release and only *removed* one release after the last producer stopped; (b) have
  `startWorker` subscribe to a superset — a `RETIRED_PGBOSS_JOB_NAMES` list kept for one release —
  so a rollback target still drains the newer queue; (c) add a queue-depth check for unknown queues
  to `deploy/scripts/production-audit.sh` so an orphaned backlog is caught by the release audit.
- cross: @release-auditor
- effort: M

### [P2] Web-tier crop recovery has no staleness cutoff, so an API restart cancels the worker's live crop and releases its claim
- id: job-queue-012
- location: podcast-saas/backend-api/src/server.ts:132
- category: bug
- confidence: high
- status: confirmed
- what: `recoverStuckCrops()` runs at every `backend` boot and sets `crop_status='failed'` on
  **every** row where `crop_status='processing'` — no age condition at all. `crop` is a durable job
  that runs in the separate `worker` container, so those rows include crops that are running
  perfectly well right now. Its comment justifies the unconditional sweep with "On the single-process
  managed host there is no live crop worker after a restart", which stopped being true when the
  `worker` service was introduced.
- why: it destroys the claim the worker holds. `runCropAnalysis`'s CAS admits any row whose status
  is not `processing` (`runCropAnalysis.ts:89-96`), so immediately after the sweep a second
  enqueue — e.g. from a transcode completing in the same deploy window — starts a **second
  concurrent crop** of a video already being cropped. It also flashes a spurious `failed` state to
  the UI, which the still-running job then overwrites with `ready`, so the user sees the crop fail
  and then un-fail.
- evidence: read `server.ts:128-141` (no cutoff) and compare with `recoverStuckTranscodes`
  (`server.ts:106`, has one). Read `runCropAnalysis.ts:79-101` for the claim condition.
  `deploy/docker-compose.yml:62-79` confirms crop executes in a different container from the one
  running this recovery.
- fix: add the staleness predicate the crop claim already defines —
  `lt(video_files.crop_updated_at, new Date(Date.now() - STALE_CLAIM_MS))` — to the `where` in
  `recoverStuckCrops`, exporting `STALE_CLAIM_MS` from `runCropAnalysis.ts` so the two rules cannot
  drift. Combine with job-queue-003's fix (run it on a timer) so a genuinely stuck crop is still
  cleaned up.
- verify: test seeding a `processing` crop with `crop_updated_at = now()` and asserting
  `recoverStuckCrops()` reaps nothing.
- effort: S

### [P2] The pg-boss send fallback runs the durable handler in the API container — including the export assembly that OOM-killed it
- id: job-queue-013
- location: podcast-saas/backend-api/src/queue/pgBossDriver.ts:36
- category: bug
- confidence: high
- status: confirmed
- what: on any failure to persist the job — `getBoss()` rejecting (DB unreachable, wrong
  `QUEUE_DATABASE_URL`, pooler in transaction mode) or `boss.send` throwing — `pgBossSend` calls the
  supplied `inline()` closure, which is `getInlineQueue().enqueue(name, payload)`
  (`queue/index.ts:34`). That executes the handler **in the process that produced the job**, i.e.
  the `backend` web container. For `project_export` that means `ProjectExportService.run` — plan,
  capture, ffmpeg assembly, upload — inside the API.
- why: `queue/pgBoss.ts:17-21` records why `project_export` was moved off the web tier: "the
  2026-08-13 incident was the kernel OOM-killing the API container mid-assembly, taking every
  in-flight request down with it". The fallback silently reinstates exactly that, and it triggers
  precisely when the database is unhealthy — the worst moment to start a multi-GB encode on the tier
  serving user traffic. The fallback is right for `crop` (cheap, bounded) and wrong for
  `project_export`; it is currently unconditional.
- evidence: read `pgBossDriver.ts:21-38` and `queue/index.ts:31-38`. `deploy/docker-compose.yml:24-60`
  shows `backend` has no separate memory reservation and shares the VM.
  `queue/__tests__/pgBossDriver.test.ts:35-50` confirms both failure paths invoke the fallback and
  that this is tested behaviour, i.e. deliberate.
- fix: make the fallback per-job rather than universal. Add
  `const INLINE_FALLBACK_OK: ReadonlySet<JobName> = new Set(['crop'])` and in `enqueueJob` pass a
  no-op-plus-error closure for the others: log at `error` and write the owning row to a terminal
  `failed` status with a retryable message ("Could not queue the export — please try again"), so the
  user gets a real answer instead of a spinner and the API does not start an encode. `project_export`
  and `video_generate` both already have terminal-failure writers to reuse.
- verify: unit test that a rejecting `getBoss()` for `project_export` does **not** call the inline
  queue and does mark the export row failed.
- effort: M

### [P2] Queue tests are frozen at the 4-name era and cannot fail, because tsconfig excludes test files from typecheck
- id: job-queue-014
- location: podcast-saas/backend-api/src/queue/__tests__/routing.test.ts:34
- category: test
- confidence: high
- status: confirmed
- what: `routing.test.ts`'s `PAYLOADS` is declared `{ [N in JobName]: JobPayloads[N] }` but lists
  only `transcode`, `captions`, `crop`, `metadata` — 4 of the 11 names. `stubHandlers`
  (`inlineDriver.test.ts:10-18`) and `handlersWith` (`pgBossDriver.test.ts:15-18`) likewise return
  4-key objects annotated `JobHandlers`. Those are type errors, invisible because
  `backend-api/tsconfig.json` excludes `src/**/*.test.ts` and `typecheck` is `tsc --noEmit`.
- why: the mapped type was supposed to be the tripwire that forces the routing test to cover every
  new job name, and it has been silently defeated through seven additions. The practical gap: the
  routing matrix for `video_generate` and `project_export` — the two heaviest durable jobs, and the
  two whose mis-routing would put ffmpeg back on the web tier — is **untested**. The test named
  "default (driver unset) routes every job inline" asserts 4 calls, not 11.
- evidence: read all three test files and `backend-api/tsconfig.json`
  (`"exclude": [..., "src/**/*.test.ts", ...]`). Ran
  `pnpm --filter backend-api exec vitest run src/queue src/jobs` → 15 tests pass, confirming the
  suite is green while incomplete.
- fix: complete `PAYLOADS` and the handler stubs to all 11 names (a `Record<JobName, ...>` built
  from `Object.fromEntries` keeps it honest), assert `inlineEnqueue` is called 11 times in the
  default case and that exactly `crop`/`video_generate`/`project_export` route to pg-boss under
  `pgboss`. Separately, add a `typecheck:test` script (`tsc --noEmit -p tsconfig.test.json`
  including test files) to CI so this class of drift cannot recur.
- cross: @test-quality
- effort: S

### [P2] Corpus ingestion has no queue entry at all — it is a floating promise with no recovery, and `jobs/corpus.ingest.ts` is dead Trigger.dev code
- id: job-queue-015
- location: podcast-saas/backend-api/src/jobs/corpus.ingest.ts:4
- category: bug
- confidence: high
- status: confirmed
- what: `corpus.ingest.ts` declares a `@trigger.dev/sdk/v3` task, but there is no
  `trigger.config.ts` anywhere and nothing imports `corpusIngestTask` (same for
  `videoTranscodeTask` in `jobs/video.transcode.ts`). `corpus` is not in `JobName` and not in
  `handlers`. The only live path is `corpus.controller.ts:99` (and `:131`):
  `builder.ingest(corpus.id).catch(err => logger.error(...))` — an unmanaged promise on the request
  path, with no queue, no retry, no claim, and no cap.
- why: `CorpusBuilder.ingest` sets `ingestion_status='processing'` (`CorpusBuilder.ts:34`) and only
  reaches `'ready'`/`'failed'` at the end (lines 124/137). There is **no** `recoverStuckCorpora` —
  the startup recovery list in `server.ts:644-650` covers transcodes, crops, simulations, podcast
  scripts/renders/mixes and video generations, but not corpora. So a corpus being ingested when the
  API container is recreated is stranded at `processing` permanently with no error anywhere.
  `ProjectDuplicationService.ts:1437` already carries the comment "Nothing is ingesting", which is
  the same observation from the other side.
- evidence: `grep -rn "corpusIngestTask|videoTranscodeTask|@trigger.dev" src` → only the three
  `jobs/*.ts` definitions and one test mock. `ls backend-api/trigger.config.*` → no match.
  `queue/types.ts:11` — no `corpus` name. `grep -rn "recoverStuck" src` — no corpus entry.
- fix: add `corpus_ingest: { corpusId: string }` to `JobName`/`JobPayloads`, register
  `corpus_ingest: (p) => new CorpusBuilder().ingest(p.corpusId)` in `registry.ts`, and replace both
  controller call sites with `enqueueJob('corpus_ingest', { corpusId: corpus.id })`. Add a
  staleness-gated recovery/sweep for `ingestion_status='processing'` alongside the others. Delete
  `jobs/corpus.ingest.ts` and `jobs/video.transcode.ts` — they are unreachable duplicates of queue
  handlers and they are the only reason `@trigger.dev/sdk` is in the worker's import graph.
- cross: @dependency-auditor (`@trigger.dev/sdk` becomes removable once the three task files go)
- effort: M

### [P3] `QUEUE_PGBOSS_LISTEN=1` is inert — no queue is created with `notify: true`
- id: job-queue-016
- location: podcast-saas/backend-api/src/queue/pgBoss.ts:68
- category: bug
- confidence: high
- status: confirmed
- what: `useListenNotify: process.env.QUEUE_PGBOSS_LISTEN === '1'` enables the instance-level
  LISTEN/NOTIFY *listener*, but in pg-boss 12 the NOTIFY is emitted only for queues created with
  `notify: true` (`pg-boss@12.23.0/dist/types.d.ts:305-314`, and `plans.js:1266-1283` where the
  `pg_notify` CTE is appended only when `notify` is set). `ensureQueues` never passes it, so setting
  the env var buys nothing.
- why: harmless today — polling at the default `pollingIntervalSeconds: 2` is the correctness floor
  and jobs here are minutes long — but the file's header documents LISTEN/NOTIFY as an available
  opt-in, so an operator who enables it (and pins a session-mode connection to make it work) gets no
  behaviour change and no warning.
- evidence: read `pgBoss.ts:63-72` and `:83-94`; read the two pg-boss sources cited above.
- fix: pass `notify: process.env.QUEUE_PGBOSS_LISTEN === '1'` in the `createQueue` options in
  `ensureQueues`, and note in the header comment that it only applies to queues created after the
  change (job-queue-007). Or drop `useListenNotify` and the env var and state that polling is the
  only mode.
- effort: S

### [P3] `startWorker()` is not idempotent — a second call silently doubles worker concurrency
- id: job-queue-017
- location: podcast-saas/backend-api/src/queue/startWorker.ts:12
- category: maintainability
- confidence: high
- status: confirmed
- what: `startWorker` calls `registerWorkers` unconditionally, which calls `boss.work(name, ...)`
  once per queue. `getBoss()` is memoised but `boss.work` is not — pg-boss registers an additional
  independent worker set per call, so two invocations give `2 × localConcurrency` pollers per queue.
  Nothing guards it.
- why: only one call site exists in each process today (`worker.ts:27` or `server.ts:665`), so this
  is latent rather than live. It becomes live the moment anything retries the bootstrap — e.g.
  wrapping the `server.ts:664-669` try/catch in a retry loop after a transient DB outage, which is
  the obvious next change to that block since it currently just logs and continues web-only.
- evidence: read `startWorker.ts:12-16`, `pgBossDriver.ts:47-61`, `pgBoss.ts:55-80` (only the boss
  promise is memoised).
- fix: memoise the same way `getBoss` does —
  `let started: Promise<void> | null = null; export function startWorker() { started ??= (async () => {...})(); return started; }`
  — and log at `warn` if called again.
- effort: S

### [P3] The worker process has no last-resort error handlers and no shutdown timeout
- id: job-queue-018
- location: podcast-saas/backend-api/src/worker.ts:32
- category: bug
- confidence: high
- status: confirmed
- what: `worker.ts` registers `SIGTERM`/`SIGINT` handlers that `await stopBoss()` then
  `process.exit(0)`, with no timeout around the await and no `process.on('unhandledRejection')` or
  `'uncaughtException')`. It also does not de-duplicate signals: a second SIGTERM starts a second
  concurrent shutdown.
- why: if `stopBoss()` hangs (its own `boss.stop` timeout is 30 s but the awaited promise can still
  stall on a wedged connection) the process never exits on its own and relies on Docker's SIGKILL —
  which, per job-queue-004, arrives at 10 s anyway. An unhandled rejection in a handler that escapes
  `registerWorkers` terminates the process under Node 22's default, which `restart: unless-stopped`
  papers over, but with no log line saying why.
- evidence: read `worker.ts:1-38`. Compare `server.ts:674-688`, which has the same signal shape but
  at least wraps everything in try/catch with a distinct exit code.
- fix: add `let stopping = false;` guard at the top of `shutdown`, wrap the `stopBoss()` await in
  `Promise.race([stopBoss(), delay(45_000)])`, and register
  `process.on('unhandledRejection'|'uncaughtException', err => { logger.fatal({err}); process.exit(1); })`
  so the reason is always logged before the restart.
- effort: S
