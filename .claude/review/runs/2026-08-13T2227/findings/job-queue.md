# job-queue — findings

Agent: `job-queue-reviewer`. Scope: `podcast-saas/backend-api/src/queue/**`, `src/jobs/**`,
`src/worker.ts`, the worker bootstrap in `src/server.ts`, and all 14 `enqueueJob(...)` call sites.

Commands run: `pnpm -C podcast-saas --filter backend-api typecheck` (clean),
`backend-api/node_modules/.bin/vitest run src/queue/__tests__ src/jobs/__tests__`
(4 files / 15 tests, all passing).

pg-boss facts below were read from the installed library, not recalled:
`podcast-saas/node_modules/.pnpm/pg-boss@12.23.0/node_modules/pg-boss/dist/{types.d.ts,plans.js,manager.js}`.

---

## Verified negatives (do not re-report these)

- **No enqueue-after-commit race exists.** All 14 `enqueueJob` call sites sit after an
  auto-committed `db.insert(...).returning()` or `db.update(...)`. `grep -n "db.transaction"` over
  every enqueueing controller (`export`, `projects`, `broll`, `podcast-render`, `podcast-script`,
  `podcast-studio`, `video`) returns nothing — no job is ever enqueued from inside an open
  transaction.
- **The three name-sets agree, and TypeScript enforces it.** `handlers` in `registry.ts:22` is
  annotated `JobHandlers`, so all 11 `JobName` keys are mandatory; `PGBOSS_JOB_NAMES`
  (`pgBoss.ts:17`) uses `as const satisfies readonly JobName[]`, so it is a compiler-checked
  subset. There is no orphan queue and no unhandled name. The *size* of that subset is the
  problem (job-queue-002), not its membership.
- **7 of 11 handlers are genuinely idempotent and failure-visible.** `crop`, `podcast_script`,
  `podcast_render`, `podcast_clips`, `podcast_mix_export`, `project_export` and
  `project_duplicate` all take a CAS claim with a staleness window, early-return when another
  worker holds it, and write a terminal `failed` status + message before rethrowing.
  `project_export`/`project_duplicate` additionally have `sweepAbandonedExports` /
  `sweepAbandonedDuplications` + `liveExportFor` / `liveDuplicationFor` reapers, started at
  `server.ts:518` and `server.ts:522`. The inline driver's error-swallowing
  (`inlineDriver.ts:25`) therefore does *not* produce a permanent spinner for these seven.
- **`expireInSeconds` as written is adequate.** pg-boss's default is 900 s
  (`types.d.ts:136`); `QUEUE_OPTIONS` raises it to 1800 s (crop) and 2700 s (video_generate),
  both above realistic runtimes. The risk is that those values never reach an existing
  deployment (job-queue-003), not that they are too small.

---

### [P1] `video_generate` has no claim, and startup recovery re-enqueues live jobs — duplicate B-roll clips
- id: job-queue-001
- location: podcast-saas/backend-api/src/jobs/video.generate.ts:229
- category: data-integrity
- confidence: high
- status: confirmed
- what: `recoverStuckVideoGenerations` re-enqueues **every** `video_generation_jobs` row in a
  non-terminal status (`queued|enhancing|submitting|generating|downloading|transcoding`) on every
  API boot, with **no staleness cutoff**. `runVideoGenerate` (line 53) guards only on
  `status === 'ready' || 'failed'` — it takes no CAS claim and keeps no in-process dedupe set, so
  nothing stops a second run of a job that is still executing.
- why: In `deploy/docker-compose.yml` the API and the worker are separate containers, so a backend
  restart is completely independent of the worker's in-flight work. Deploy the API while a b-roll
  job is `generating` and the recovery enqueues a second pg-boss job for the same `job_id`; the
  worker (localConcurrency 2) runs it alongside the first. Both take the resume path
  (`external_task_id` is set), both poll the now-completed provider task, and both call
  `svc.downloadAndStore` — which mints a fresh `randomUUID()` storage key and unconditionally
  inserts a new `video_files` row (`VideoGenerationService.ts:293,318`). Each run then transcodes
  and inserts its own `timeline_sections` row (line 142). The user gets **two identical B-roll
  clips stacked at the same `global_offset_sec`**, two HLS trees, and two storage objects. The
  same duplication occurs without any restart once a job outlives `expireInSeconds` and pg-boss
  re-delivers it (heartbeat is disabled — `heartbeatSeconds` is never set, `types.d.ts:180-184`).
  `pgBossDriver.ts:14` asserts "Handlers are already idempotent (DB CAS claims), so pg-boss's
  at-least-once delivery is safe" — true for `crop`, false for the other durable queue.
- evidence: Read `video.generate.ts` in full: lines 53-58 are the only status guard, lines 63-104
  are the resume branch, lines 122-156 are the unguarded download → transcode → section-insert →
  finalize sequence; there is no `.returning()` CAS anywhere in the file (contrast
  `runCropAnalysis.ts:87-101`). `recoverStuckVideoGenerations` (229-249) filters on status only —
  no `lt(updated_at, cutoff)`, unlike `recoverStuckTranscodes` (`server.ts:106`). `server.ts:650`
  calls it on every boot. `downloadAndStore` read at `VideoGenerationService.ts:288-330`: new UUID
  key, unconditional insert. `src/jobs/__tests__/videoGenerateQueue.test.ts` covers only the
  concurrency semaphore — no idempotency test exists.
- fix: Give `video_generate` the CAS claim the other handlers have: add a `claimed_at` column and
  claim with `WHERE id = ? AND (claimed_at IS NULL OR claimed_at < staleThreshold)`, bailing when
  `RETURNING` is empty — the exact shape of `runPodcastRender.ts:19-33`. Additionally make the
  resume path skip completed steps: if `job.video_file_id` is set, do not re-download; if
  `job.section_id` is set, do not insert a second `timeline_sections` row. Add a staleness cutoff
  to `recoverStuckVideoGenerations` so it only re-enqueues rows untouched for > the claim window.
- verify: New unit test that invokes the handler twice concurrently for one `job_id` and asserts
  exactly one `timeline_sections` insert and one `video_files` insert — red before, green after.
  `pnpm -C podcast-saas --filter backend-api typecheck` stays clean.
- cross: @test-quality, @media-pipeline
- effort: M

### [P1] Only 2 of 11 job types are durable, so the "off-web-tier" worker container runs almost nothing
- id: job-queue-002
- location: podcast-saas/backend-api/src/queue/pgBoss.ts:17
- category: bug
- confidence: high
- status: confirmed
- what: `PGBOSS_JOB_NAMES` is `['crop', 'video_generate']`. `enqueueJob` (`index.ts:33`) routes
  only those two through pg-boss; the other nine — `transcode`, `captions`, `metadata`,
  `podcast_script`, `podcast_render`, `podcast_clips`, `podcast_mix_export`, `project_duplicate`,
  `project_export` — always run inline via `setImmediate` in whichever process enqueued them.
- why: `deploy/docker-compose.yml:38-39` sets `QUEUE_DRIVER: pgboss` / `WORKER_INLINE: 'false'` on
  the API container with the comment *"heavy jobs run in the dedicated worker container"*, and
  `worker.ts:4` says it exists *"so heavy ffmpeg work executes off the web tier"*. Neither is
  true: `startWorker` registers workers for `PGBOSS_JOB_NAMES` only (`startWorker.ts:14`), so the
  worker container handles crop and b-roll and nothing else, while the API container runs the
  linear video export (multi-minute ffmpeg assembly), HLS transcodes, podcast renders and project
  duplication in-process, competing with request handling. It also means those nine have **no
  durability and no retry at all** in production — they exist only as an in-memory promise, so
  every API deploy destroys them (compounded by job-queue-009).
- evidence: `pgBoss.ts:17` read directly. `index.ts:21-23` gates on membership. `startWorker.ts:14`
  passes `PGBOSS_JOB_NAMES`; nothing else calls `registerWorkers` (grep across `src`).
  `docker-compose.yml:38-39,61-67` read. `server.ts:663` requires `WORKER_INLINE === '1'`, so the
  API container has no pg-boss worker either — those nine jobs run on the web tier by construction.
- fix: Either promote the ffmpeg-bearing names (`transcode`, `project_export`, `podcast_render`,
  `podcast_mix_export`, `podcast_clips`, `project_duplicate`) into `PGBOSS_JOB_NAMES` with their
  own `QUEUE_OPTIONS` entries (each already has a CAS claim, so at-least-once is safe for them —
  see the verified negatives), or correct `docker-compose.yml:39` and `worker.ts:4-8` to state
  which jobs actually leave the web tier. Do not leave the comments and the code disagreeing.
- verify: With the promotion, `docker compose logs worker` shows `[pg-boss] worker registered` for
  each promoted queue and an export started via the API is picked up by the worker container.
- cross: @config-deploy, @media-pipeline
- effort: M

### [P1] `QUEUE_OPTIONS` never reach an already-created queue — retry/expiry/dead-letter tuning is inert after the first deploy
- id: job-queue-003
- location: podcast-saas/backend-api/src/queue/pgBoss.ts:74
- category: bug
- confidence: high
- status: confirmed
- what: `ensureQueues` applies `QUEUE_OPTIONS` (`pgBoss.ts:24-27`) by calling `boss.createQueue`.
  pg-boss's `create_queue` SQL function is a plain `INSERT ... ON CONFLICT DO NOTHING`, so on a
  queue that already exists it silently changes nothing and does not throw. `updateQueue` — the
  API that would apply changed options — is never called.
- why: `retryLimit`, `retryDelay`, `retryBackoff`, `expireInSeconds` and `deadLetter` are frozen
  at whatever the queue was first created with, on every environment where the queue already
  exists. Editing the carefully-reasoned block at `pgBoss.ts:24-27` produces no effect and no
  warning — the next engineer to raise `expireInSeconds` because b-roll jobs are being
  re-delivered will see the number change in git and nothing change in production. If either
  queue was created before `deadLetter` was added to the options, dead-lettering is not happening
  at all. Compounding this, the `catch` at line 80 logs at `debug`, so at the default `LOG_LEVEL`
  a genuine failure (permissions, a half-applied pg-boss migration) is invisible — and because
  both `createQueue` calls share one `try`, a failure on the dead-letter queue skips creation of
  the real queue too, after which `boss.work` throws and the worker exits 1 (`worker.ts:29`) or
  the API silently continues web-only (`server.ts:668`).
- evidence: `plans.js:399-443` — `create_queue(...)` is `INSERT INTO <schema>.queue (...) VALUES
  (...) ON CONFLICT DO NOTHING;`. `manager.js:1216-1229` — `createQueue` executes that function
  and nothing else. `index.d.ts:54,58` — `createQueue` and `updateQueue` are distinct APIs.
  `pgBoss.ts:74-85` read in full.
- fix: In `ensureQueues`, call `createQueue` then unconditionally `updateQueue(name,
  QUEUE_OPTIONS[name])` so the declared options are the source of truth on every boot. Raise the
  catch from `logger.debug` to `logger.warn` with the queue name, and put each queue's create in
  its own `try` so a dead-letter failure cannot skip the real queue.
- verify: Change `crop`'s `retryLimit` locally, restart, and confirm the `pgboss.queue` row's
  `retry_limit` follows (read-only `SELECT`; run it against a local DB only).
- cross: @observability
- effort: S

### [P2] Dead-letter queues are created but nothing ever consumes or alerts on them
- id: job-queue-004
- location: podcast-saas/backend-api/src/queue/pgBoss.ts:76
- category: bug
- confidence: high
- status: confirmed
- what: `ensureQueues` creates `crop-dead` and `video_generate-dead` and wires them as each
  queue's `deadLetter`, but `registerWorkers` is only ever called with `PGBOSS_JOB_NAMES`
  (`startWorker.ts:14`), which excludes the `-dead` names. No code path reads, works, counts or
  alerts on those queues.
- why: A job that exhausts its retries lands in a table nobody looks at and is then deleted by
  pg-boss's default `retentionSeconds` of 14 days (`types.d.ts:139`). There is no signal that a
  class of jobs is failing systematically. This is ops blindness rather than a user-facing
  spinner — both `crop` and `video_generate` do write a terminal `failed` status to the owning
  row before rethrowing (`runCropAnalysis.ts:132`, `video.generate.ts:164`), so the UI is honest.
- evidence: `pgBoss.ts:76-79`; `startWorker.ts:12-16`; `grep -rn "registerWorkers" src` returns
  only `startWorker.ts:14` and the test. `types.d.ts:136-140` for the retention default.
- fix: Register a dead-letter consumer per queue that logs at `error` with the job id, name and
  payload (and increments a counter), or explicitly document the DLQs as inspect-by-hand and add
  them to the runbook. A one-line `boss.work(`${name}-dead`, ...)` loop in `registerWorkers` is
  enough to make the failures visible.
- verify: Force a crop job to fail 4 times against a local DB and confirm an `error`-level log
  naming the dead-lettered job.
- cross: @observability
- effort: S

### [P2] `singletonKey` does nothing under the default `standard` queue policy
- id: job-queue-005
- location: podcast-saas/backend-api/src/queue/pgBossDriver.ts:30
- category: bug
- confidence: high
- status: confirmed
- what: `pgBossSend` passes `{ singletonKey: singletonKeyFor(name, payload) }` and the comments
  (lines 28-29 and 40) claim it "collapses duplicate *pending* jobs for the same target into one"
  so "repeated triggers for the same video don't pile up in the queue". `ensureQueues` never sets
  `policy`, so both queues use pg-boss's default `standard` policy — under which no uniqueness
  index on `singleton_key` exists.
- why: The dedupe is not happening. Every one of pg-boss 12's singleton-key unique indexes is
  gated on a non-`standard` policy, and the one policy-independent index (`job_i4`) additionally
  requires `singleton_on IS NOT NULL`, i.e. `singletonSeconds`, which this code never passes. So
  `enqueueCropAnalysis` — documented as "safe to call on every preview / share request"
  (`runCropAnalysis.ts:43`) and fanned out per project video by `enqueueCropForProject` — inserts
  one queue row per trigger. The CAS claim still prevents duplicate *work*, so no user-visible
  damage, but the queue table grows and each redundant row costs a fetch and a no-op run. The
  `if (!id)` dedupe-detection branch at line 32 is dead code that will never execute.
- evidence: `plans.js:604-628` — `job_i1`/`job_i2`/`job_i3`/`job_i6`/`job_i8` are each
  `WHERE ... AND policy = '<short|singleton|stately|exclusive|key_strict_fifo>'`; `job_i4`
  (line 614) is `WHERE state <> 'cancelled' AND singleton_on IS NOT NULL`. `plans.js:512-523`
  creates policy indexes only for the non-standard policies. `manager.js:1219` defaults
  `policy` to `QUEUE_POLICIES.standard`. `pgBoss.ts:79` passes no `policy`. `types.d.ts:252-272`
  documents that `singletonKey` "extends" the non-standard policies.
- fix: Set `policy: 'stately'` on the `crop` queue in `QUEUE_OPTIONS` (one job per state per
  singleton key — the semantics the comment describes), or drop `singletonKeyFor` and the `if
  (!id)` branch and rely solely on the CAS claim, correcting the comments. Note this cannot take
  effect on an existing deployment until job-queue-003 is fixed, since `createQueue` no-ops.
- verify: With `policy: 'stately'`, enqueue the same `videoFileId` three times against a local DB
  and assert one `created` row; the `logger.debug` "send deduped" line should now appear.
- effort: S

### [P2] `QUEUE_CROP_CONCURRENCY` silently sets the worker count for *every* queue, including `video_generate`
- id: job-queue-006
- location: podcast-saas/backend-api/src/queue/pgBossDriver.ts:54
- category: bug
- confidence: high
- status: confirmed
- what: `registerWorkers` passes `{ localConcurrency: cropConcurrency() }` for every queue, and
  `cropConcurrency()` (line 17) reads only `QUEUE_CROP_CONCURRENCY`. `video_generate` therefore
  gets its worker count from an env var named for crop.
- why: `localConcurrency` is "number of workers to spawn for this queue (per-node)"
  (`types.d.ts:432-436`). `video_generate` already has its own independent in-process bound,
  `VIDEO_GEN_CONCURRENCY` (default 2, `video.generate.ts:184`), enforced by a semaphore *inside*
  the handler. Raising `QUEUE_CROP_CONCURRENCY` to speed up crop spawns that many
  `video_generate` workers, each of which fetches a job — marking it **active** — and then blocks
  in `acquireInProcessSlot` waiting for one of the 2 semaphore slots. The clock on
  `expireInSeconds` (45 min) runs while the job sits in a queue inside the process, and pg-boss
  has no heartbeat configured to notice, so a backlog can push jobs past expiry and into a
  re-delivery that job-queue-001 turns into duplicated output.
- evidence: `pgBossDriver.ts:17-19,54`; `video.generate.ts:184-210` (semaphore acquired before
  `runVideoGenerate`); `types.d.ts:432-436` for `localConcurrency` semantics; `types.d.ts:180-184`
  confirms heartbeat is opt-in and unset here.
- fix: Make concurrency per-queue — e.g. a `CONCURRENCY: Record<JobName, number>` beside
  `QUEUE_OPTIONS`, with `video_generate` reading `VIDEO_GEN_CONCURRENCY` so the pg-boss worker
  count and the in-process semaphore are the same number and no job is fetched before it can run.
- verify: `QUEUE_CROP_CONCURRENCY=8` and confirm `video_generate` still registers 2 workers.
- effort: S

### [P2] The pg-boss send fallback runs heavy jobs inside the API container, which has no worker
- id: job-queue-007
- location: podcast-saas/backend-api/src/queue/pgBossDriver.ts:34
- category: bug
- confidence: high
- status: confirmed
- what: On any `getBoss()`/`boss.send()` rejection, `pgBossSend` logs and calls `inline()`, which
  runs the handler in the *producing* process via `setImmediate`.
- why: The intent ("no worse than the historical in-process behaviour") held when the producer was
  also the worker. In the shipped topology it is not: the API container is
  `QUEUE_DRIVER=pgboss` + `WORKER_INLINE: 'false'` (`docker-compose.yml:38-39`), i.e. a pure
  producer. A transient blip on the Supabase connection therefore relocates a 20-minute polling
  b-roll generation plus a download and an HLS transcode into the request-serving process — the
  exact workload the separate worker container exists to keep off it — and the fallback is silent
  to the caller because `enqueue` returns `void`. Because the blip is transient and per-call, a
  burst of enqueues during one outage window relocates the whole burst at once, bounded only by
  `VIDEO_GEN_CONCURRENCY`.
- evidence: `pgBossDriver.ts:27-38`; `index.ts:34` supplies `() => getInlineQueue().enqueue(...)`;
  `docker-compose.yml:38-39` and `server.ts:663` together confirm the API container registers no
  workers. `pgBossDriver.test.ts:35-50` asserts the fallback fires on both rejection paths.
- fix: Make the fallback conditional on this process actually being a worker — e.g. have
  `startWorker` set a module flag and only run `inline()` when it is set; otherwise log at `error`
  and leave the row in its `queued` status for the existing sweeper/recovery to re-drive. A
  bounded retry of the `send` before giving up would cover the common transient case.
- verify: Unit test asserting that with no worker registered, a rejecting `send` does **not**
  invoke the inline fallback.
- cross: @config-deploy
- effort: M

### [P2] Graceful shutdown gives inline jobs 25 s, then exits — every redeploy kills an in-flight export mid-encode
- id: job-queue-008
- location: podcast-saas/backend-api/src/server.ts:678
- category: bug
- confidence: high
- status: confirmed
- what: `drainInlineJobs(25_000)` is a `Promise.race` between the in-flight set and a 25-second
  timer (`inlineDriver.ts:43-46`). It resolves either way, and `shutdown` then runs
  `process.exit(0)` unconditionally.
- why: Nine of the eleven job types run inline in production (job-queue-002), and the slowest of
  them — `project_export`, `podcast_render`, `podcast_mix_export`, `transcode` — take minutes.
  On SIGTERM they get 25 seconds and are then killed with their ffmpeg children mid-write. There
  is no re-queue: `project_export`/`project_duplicate` are reaped to `failed` ~5 minutes later by
  `sweepAbandonedExports`/`sweepAbandonedDuplications`, and `transcode` may not be reaped at all
  (job-queue-011). The user's export dies on every deploy and has to be restarted by hand. The
  timeout is documented as a known limit at `inlineDriver.ts:36-38`; the finding is that in the
  shipped topology it applies to the *longest* jobs, not the short ones the comment names.
- evidence: `inlineDriver.ts:40-47`; `server.ts:674-686`. `stopBoss` (`pgBoss.ts:94`) separately
  uses `{ graceful: true, timeout: 30_000 }`, also far below the 30/45-minute queue expiries — for
  the two durable queues that is safe, because pg-boss re-delivers after expiry and both handlers
  re-claim, but nothing rescues the inline nine.
- fix: The durable fix is job-queue-002 (move the long jobs to pg-boss so a killed job is
  re-delivered and re-claimed). Short of that, raise the drain bound for long jobs and set the
  container's `stop_grace_period` in `docker-compose.yml` to match, so the platform does not
  SIGKILL before the drain finishes.
- verify: Start an export locally, send SIGTERM, and confirm the export either completes or is
  re-delivered rather than being reaped to `failed`.
- cross: @config-deploy, @media-pipeline
- effort: M

### [P2] `runVideoTranscode` takes no claim, so two concurrent runs for one video orphan an HLS tree
- id: job-queue-009
- location: podcast-saas/backend-api/src/services/video/runVideoTranscode.ts:32
- category: data-integrity
- confidence: medium
- status: confirmed
- what: The `transcode` handler reads the row and then unconditionally sets
  `hls_status: 'processing'`. There is no CAS claim, no in-process dedupe set, and no
  "already ready for this source" short-circuit — the two guards `runCropAnalysis` has
  (`runCropAnalysis.ts:63` and `:87-101`).
- why: `runVideoTranscode` is reachable three ways: the `transcode` queue handler
  (`registry.ts:23`, from `video.controller.ts:24` and `:552`), and a direct in-handler call from
  `runVideoGenerate` (`video.generate.ts:130`). Each run reads `oldMasterKey` *before* starting
  (line 56) and writes to a fresh `hls/<id>/<runId>` prefix. Two overlapping runs for one
  `video_file_id` therefore both compute the same `oldMasterKey`, both flip the master pointer,
  and the loser's entire tier tree is never handed to `retireHlsRun` — a storage leak, with a
  nondeterministic final pointer. job-queue-001's duplicate b-roll run is a concrete way to get
  two overlapping transcodes of the same file.
- evidence: `runVideoTranscode.ts:19-57` read in full — no `.returning()` CAS, no status guard.
  `grep -rn "runVideoTranscode(" src` gives the three call sites above.
- fix: Add the same CAS claim `runCropAnalysis.ts:87-101` uses — conditional update to
  `processing` guarded on `hls_status <> 'processing' OR hls_started_at < staleBefore`, bailing
  when `RETURNING` is empty.
- verify: Unit test invoking the handler twice concurrently for one id and asserting one
  `transcodeToHLS` call.
- cross: @media-pipeline
- effort: S

### [P2] A transcode killed by a redeploy can sit at `processing` indefinitely
- id: job-queue-010
- location: podcast-saas/backend-api/src/server.ts:97
- category: bug
- confidence: high
- status: confirmed
- what: `recoverStuckTranscodes` runs **only at boot** and only reaps rows whose `hls_started_at`
  is older than 30 minutes. There is no periodic sweeper for stuck transcodes —
  `startHlsRetentionSweep` (`hlsRetention.ts:123`) garbage-collects retired trees, it does not
  touch `hls_status`.
- why: A transcode killed two minutes after it started (job-queue-008) is not old enough to be
  reaped at the very next boot, and nothing reaps it later unless the process happens to restart
  again more than 30 minutes after that `hls_started_at`. Until then the row reads `processing`
  and the UI spins forever with no error. Compare `recoverStuckCrops` (`server.ts:132`), which
  reaps every `processing` crop unconditionally at boot precisely because a restart means no
  worker is running it — the same argument applies to transcode but the cutoff blocks it.
- evidence: `server.ts:97-111` vs `server.ts:132-141`; `hlsRetention.ts:123-138` is a retention
  sweep over retired runs only.
- fix: Either drop the cutoff (matching `recoverStuckCrops` — at boot, nothing is running any
  transcode in this process) or, better, add a periodic `sweepStuckTranscodes` on the
  `startExportSweep` pattern that reaps any `processing` row whose `hls_started_at` is older than
  the staleness window, so recovery does not depend on a restart happening at the right moment.
- verify: Kill the process mid-transcode, restart, and confirm the row reaches `failed` within
  one sweep interval.
- cross: @media-pipeline
- effort: S

### [P2] Queue tests are frozen in the 4-job world, and `tsconfig` excludes tests so nothing catches the drift
- id: job-queue-011
- location: podcast-saas/backend-api/src/queue/__tests__/routing.test.ts:34
- category: test
- confidence: high
- status: confirmed
- what: `routing.test.ts:34` declares `const PAYLOADS: { [N in JobName]: JobPayloads[N] }` with
  only 4 of the 11 keys, and `pgBossDriver.test.ts:15-18` returns a 4-key object annotated
  `JobHandlers`. Both are type errors against today's `types.ts` — but `tsconfig.json:12` excludes
  `src/**/*.test.ts`, so `pnpm --filter backend-api typecheck` never sees them and passes clean.
- why: The tests are the only thing that documents the routing matrix, and they now document a
  matrix that no longer exists. `routing.test.ts:27` mocks `PGBOSS_JOB_NAMES: ['crop']` and
  line 64 asserts *"QUEUE_DRIVER=pgboss routes **ONLY** crop to pg-boss"* — false since
  `video_generate` was added. Nothing anywhere asserts the real contents of `PGBOSS_JOB_NAMES`,
  so a job silently added to or dropped from the durable set breaks nothing. The exhaustive-map
  pattern the tests use was designed to fail when a job name is added; excluding tests from
  typecheck removed exactly that alarm.
- evidence: `tsconfig.json:12` — `"exclude": ["node_modules","dist","src/**/*.test.ts","src/_archive/**"]`.
  `pnpm -C podcast-saas --filter backend-api typecheck` → clean. Test run: 4 files / 15 tests pass
  while asserting the stale matrix.
- fix: Stop excluding `src/**/*.test.ts` from `tsconfig.json` (or add a
  `tsconfig.test.json` the `typecheck` script also runs), then complete both exhaustive maps to
  all 11 names. Add one assertion in `routing.test.ts` against the **real** `PGBOSS_JOB_NAMES`
  import rather than the mock, so changing the durable set requires updating the test.
- verify: The completed maps make `typecheck` red before the fix and green after; adding a 12th
  `JobName` must then fail the build.
- cross: @test-quality, @types-contracts
- effort: S

### [P3] `metadata` dedupes only in-process, with no cluster-safe claim
- id: job-queue-012
- location: podcast-saas/backend-api/src/services/generateVideoMetadata.ts:33
- category: bug
- confidence: high
- status: confirmed
- what: `generateVideoMetadata` guards with a module-scope `Set` keyed by `projectId` (line 50)
  plus a non-atomic read `if (project.metadata_status === 'ready') return` (line 67). Unlike every
  other multi-step handler it takes no CAS claim.
- why: The `Set` protects only one process. Two processes running this handler for the same
  project both pass the `ready` read and both do the LLM work. Down-ranked to P3 because
  `metadata` is inline-only (job-queue-002) and the compose file runs a single API container, so
  reaching it requires a rolling deploy with overlapping containers or a future replica count > 1
  — at which point it becomes duplicated LLM spend.
- evidence: `generateVideoMetadata.ts:33,50-55,67`; contrast `runCropAnalysis.ts:87-101`.
- fix: Replace the `ready` read with a conditional update to `processing` guarded on
  `metadata_status <> 'processing' OR updated_at < staleBefore`, bailing on empty `RETURNING`.
- verify: Two concurrent invocations produce one LLM call.
- cross: @llm-pipeline
- effort: S

### [P3] Three Trigger.dev tasks are declared and never triggered, and the SDK loads on every boot
- id: job-queue-013
- location: podcast-saas/backend-api/src/jobs/video.generate.ts:171
- category: maintainability
- confidence: high
- status: confirmed
- what: `videoGenerateTask` (`video.generate.ts:171`), `videoTranscodeTask`
  (`jobs/video.transcode.ts:4`) and `corpusIngestTask` (`jobs/corpus.ingest.ts:4`) are
  `task({...})` declarations from `@trigger.dev/sdk/v3`. Nothing imports or `.trigger()`s any of
  them anywhere outside `_archive/`.
- why: Two job systems are declared for the same work and a reader cannot tell which is
  authoritative — `videoGenerateTask` even carries `retry: { maxAttempts: 2, factor: 4 }`
  (line 174), a second, contradictory retry policy for a queue that already has one at
  `pgBoss.ts:26`. `corpus.ingest` is not even a `JobName`. Because `registry.ts:10` imports
  `jobs/video.generate.js`, the whole `@trigger.dev/sdk` is loaded and its `task()` evaluated at
  module-eval time in both the API and the worker container, on every boot, for nothing.
- evidence: `grep -rn "videoGenerateTask|videoTranscodeTask|corpusIngestTask|@trigger" src` returns
  only the declarations plus four `_archive/` files. `types.ts:11` has no `corpus_ingest` name.
- fix: Delete the three `task(...)` wrappers (keeping `runVideoGenerate`/`runVideoTranscode` and
  `CorpusBuilder.ingest`), and drop `@trigger.dev/sdk` from `backend-api/package.json` if nothing
  else uses it.
- verify: `pnpm -C podcast-saas --filter backend-api typecheck` and `test` stay green.
- cross: @dependency-auditor
- effort: S

### [P3] Comments across the queue describe a phase that has passed
- id: job-queue-014
- location: podcast-saas/backend-api/src/queue/index.ts:12
- category: maintainability
- confidence: high
- status: confirmed
- what: Four doc comments state things that are no longer true: `index.ts:12` and `pgBoss.ts:16`
  say the durable set is "Phase B: `crop`" though `video_generate` is in it; `types.ts:8-9` says
  "today the only driver is `inline`"; and `pgBossDriver.ts:14` asserts "Handlers are already
  idempotent (DB CAS claims), so pg-boss's at-least-once delivery is safe", which is false for
  `video_generate` — the other durable queue (job-queue-001).
- why: `pgBossDriver.ts:14` is the load-bearing one: it is the stated justification for enabling
  at-least-once delivery, and a reader auditing idempotency will take it as already-verified.
- evidence: The four lines, read against `pgBoss.ts:17` and `video.generate.ts:53-58`.
- fix: Update the four comments; make `pgBossDriver.ts:14` name which handlers are CAS-claimed
  rather than asserting all of them are.
- verify: n/a — comment change.
- effort: S

### [P3] `QUEUE_PGBOSS_LISTEN=1` enables the listener but no queue ever emits a notification
- id: job-queue-015
- location: podcast-saas/backend-api/src/queue/pgBoss.ts:59
- category: bug
- confidence: high
- status: confirmed
- what: `getBoss` sets `useListenNotify: process.env.QUEUE_PGBOSS_LISTEN === '1'`, but
  LISTEN/NOTIFY in pg-boss 12 needs **both** the instance-level flag and a per-queue `notify:
  true`. `Queue.notify` defaults to `false` (`types.d.ts:307-314`) and `QUEUE_OPTIONS` never sets
  it.
- why: Turning the documented opt-in on produces no speed-up — the producer's `pg_notify` is
  gated on the queue's `notify` column (`manager.js:741,873`) and the worker's fast-poll path is
  gated on the same (`manager.js:517`). Delivery stays on the base poll. Harmless (polling is the
  correctness floor, as the comment says) but the knob is inert, which will cost someone an
  afternoon.
- evidence: `manager.js:517` `isNotifyActive = () => !!(this.notifier?.available &&
  this.queues?.[name]?.notify)`; `manager.js:646` `#notifyEnabled`; `manager.js:741,789,873` gate
  the producer-side notify on it. `types.d.ts:307-314` for the default.
- fix: Add `notify: true` to both entries in `QUEUE_OPTIONS` (subject to job-queue-003, since
  `createQueue` will not apply it to an existing queue), or drop `QUEUE_PGBOSS_LISTEN` and the
  comment at `pgBoss.ts:11-13`.
- verify: With both flags set, `pg_stat_activity` shows a `LISTEN pgboss_<hash>` session and a
  newly sent job is picked up in well under the 2-second base poll.
- effort: S

### [P3] The batch worker loop fails a whole batch on one job's throw — latent while `batchSize` is 1
- id: job-queue-016
- location: podcast-saas/backend-api/src/queue/pgBossDriver.ts:55
- category: bug
- confidence: high
- status: confirmed
- what: The handler is `async (jobs) => { for (const job of jobs) await run(job.data); }`. Throwing
  from a batch handler fails **every** job in the batch (`types.d.ts:456-461`), including the ones
  that already completed successfully earlier in the loop, and they are all retried.
- why: Harmless today only because pg-boss's `batchSize` defaults to 1 (`types.d.ts:411`,
  destructured as `batchSize = 1` at `manager.js:510`) and the code never sets it — so `jobs`
  always has one element. The moment anyone adds `batchSize` to the options to improve throughput,
  every batch containing one poison job re-runs its healthy siblings, which for non-idempotent
  handlers (job-queue-001, job-queue-009) means duplicated output. The existing test at
  `pgBossDriver.test.ts:75` deliberately feeds a two-job batch, so the shape looks supported.
- evidence: `pgBossDriver.ts:54-58`; `types.d.ts:406-411` (`batchSize` `@default 1`);
  `manager.js:510` (`batchSize = 1` destructuring default); `types.d.ts:455-461` (`perJobResults`
  doc: "Throwing from the handler still fails the whole batch").
- fix: Opt into `perJobResults: true` and return a `JobResult[]` — settle each job individually,
  `{ id, status: 'completed' }` or `{ id, status: 'failed', output }` — so per-job outcomes stay
  per-job whatever `batchSize` becomes.
- verify: Extend `pgBossDriver.test.ts` with a two-job batch where the first succeeds and the
  second throws, asserting the first is reported completed.
- effort: S
