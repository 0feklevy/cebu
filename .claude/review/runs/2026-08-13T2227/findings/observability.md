# Observability findings

Scope: `backend-api/src/lib/{logger,sse,fetchWithRetry}.ts`, every `catch` in `backend-api/src`,
the 11 job types' failure paths, `pipeline-stats.controller.ts`, `RumService.ts`,
`sim-rum.controller.ts`, and the `/health` endpoint in `server.ts`.

**Positive baseline (context, not a finding):** all 11 job handlers reachable from
`queue/registry.ts` (`transcode`, `captions`, `crop`, `metadata`, `podcast_script`,
`podcast_render`, `podcast_clips`, `podcast_mix_export`, `video_generate`, `project_duplicate`,
`project_export`) write a terminal `failed` status with a user-showable reason on throw, and most
have startup-recovery sweeps for rows stranded by a crash mid-job. This is the single biggest thing
this review checked for and it is solid — the gaps below are elsewhere.

---

### [P1] Every Firebase auth failure — real token or systemic outage — collapses into the same silent 401
- id: observability-001
- location: podcast-saas/backend-api/src/middleware/firebase-auth.ts:89, podcast-saas/backend-api/src/middleware/firebase-auth.ts:109
- category: bug
- confidence: high
- status: confirmed
- what: `firebaseAuthMiddleware`'s catch-all (line 89) and `firebaseAuthOptionalMiddleware`'s
  catch-all (line 109) swallow every exception — a genuinely invalid token, a Firebase Admin SDK
  failure (expired service-account key, clock skew, network partition to Google), or a Postgres
  error during the user upsert (lines 41-87) — and answer with the same generic 401
  `{ error_type: 'connection_error', message: 'Invalid auth token' }`. Neither catch block, nor
  any other line in the file, calls `logger` or `console` (verified: `grep -n
  "logger\|console\." middleware/firebase-auth.ts` returns nothing).
- why: This is every authenticated request in the product. If Firebase Admin starts failing
  broadly — the exact class of failure that happens (expired keys, clock skew, an outage) — every
  login and every authenticated API call in the system starts 401ing with a message that says
  "invalid token," which is actively misleading, and there is zero log line anywhere to tell an
  operator this is a systemic auth-provider failure rather than a wave of users mistyping
  passwords. This is the textbook "3am, no trace" failure this review is built to catch, and it
  sits in front of nearly the whole API surface.
- evidence: Read the full file (112 lines). Confirmed via grep that `logger`/`console` appear
  zero times. The DB upsert path (lines 41-87) can itself throw (connection error, constraint
  violation) and would be caught by the same silent handler.
- fix: In both catch blocks, log the real error before responding — e.g.
  `logger.error({ err }, 'firebase-auth: token verification or user upsert failed')` — and keep the
  client-facing 401 message as-is (don't leak internals to the client, just stop discarding the
  cause server-side). Optionally distinguish "token verification failed" (log at `warn`, expected
  traffic) from "upsert/DB failed after a valid token" (log at `error`, a real infra problem) so
  alerting can tell the two apart.
- verify: Force a DB error during the upsert path in a test (or manually break
  `FIREBASE_PROJECT_ID` locally) and confirm a log line appears; `pnpm -C podcast-saas --filter
  backend-api typecheck` stays clean.
- effort: S

---

### [P1] `/health` has no worker-liveness signal, and a failed in-process worker start is caught, logged, and ignored
- id: observability-002
- location: podcast-saas/backend-api/src/server.ts:204-219, podcast-saas/backend-api/src/server.ts:663-670
- category: bug
- confidence: high
- status: confirmed
- what: `/health` (lines 204-219) checks only `checkDatabaseConnection()`; it says nothing about
  whether background jobs are being processed. In the single-process deployment shape
  (`QUEUE_DRIVER=pgboss` + `WORKER_INLINE=1`), `startWorker()` is called at boot inside a
  try/catch (lines 663-670) that on failure does `logger.error({ err }, 'In-process worker failed
  to start (continuing web-only)')` and **keeps serving traffic** — `/health` still returns 200
  `ok` forever, while zero pg-boss jobs will ever run. In the production docker-compose shape the
  worker is a **separate container** whose healthcheck is, per `deploy/README.md:210`, "PID-1
  liveness via restart policy" — i.e. "is the process alive," not "is it connected to Postgres and
  pulling jobs." Neither health surface can detect "the worker process exists but does nothing."
- why: This is exactly the health-check-that-lies pattern called out in this project's own ops
  history (`podcast-saas/ops/release/PLAN.md` treats "worker liveness" as a thing
  `production-audit.sh` has to check independently, precisely because the app-level `/health`
  doesn't). A load balancer or uptime probe watching `/health` would show green while every
  transcode/export/render/script job silently queues (pg-boss) or is dropped (inline) and every
  user sees permanent "processing" spinners with no operator alert.
- evidence: Read server.ts lines 190-219 (health handler) and 655-670 (worker boot). Read
  deploy/README.md:207-217 confirming the worker container's healthcheck is process-liveness only,
  and `deploy/docker-compose.yml:54-55` confirming `backend`'s healthcheck is exactly `curl
  http://localhost:8080/health`.
- fix: Track worker state in-process (e.g. a module-level flag/timestamp set by `startWorker()`
  on success and updated by a lightweight periodic beat from the registered pg-boss workers), and
  either (a) have `/health` report it as a `worker` field the LB doesn't have to fail on but an
  operator dashboard can alert on, or (b) for the `WORKER_INLINE=1` shape specifically, fail
  `/health` (503) when the in-process worker never started — since in that topology there is no
  separate worker to catch the gap. This is `config-deploy-reviewer` territory for the
  docker-compose worker healthcheck specifically; signalled below.
- verify: Locally force `startWorker()` to reject (e.g. bad `QUEUE_DATABASE_URL`) with
  `WORKER_INLINE=1` set, confirm `/health` (or the new field) reflects the failure instead of
  staying green.
- cross: config-deploy
- effort: M

---

### [P2] No request/job correlation anywhere: zero `logger.child()` calls, and Fastify's own request logger is disabled with nothing replacing it
- id: observability-003
- location: podcast-saas/backend-api/src/server.ts:145, podcast-saas/backend-api/src/lib/logger.ts:1-9
- category: maintainability
- confidence: high
- status: confirmed
- what: `Fastify({ logger: false, ... })` (server.ts:145) disables Fastify's built-in per-request
  logger (which would otherwise auto-generate a `reqId` and log method/path/status/latency per
  request), and nothing replaces it — there is no `genReqId`, no request-scoped child logger, no
  HTTP access log at all. `grep -rn "logger.child(" backend-api/src` (excluding `_archive` and
  tests) returns **zero** matches anywhere in the active codebase.
- why: There is no way to answer "what did this specific HTTP request cause?" from logs — no
  record of inbound requests, their status codes, or latency, and no correlation id that a
  handler could pass down into an enqueued job so a support ticket ("my export from 10 minutes
  ago failed") could be traced from the request that started it through to the worker log lines.
  Per-domain correlation (passing `videoFileId`/`renderId`/`exportId` through a job's own log
  lines) is done well and consistently by hand — that part of this repo's logging discipline is
  good — but there is nothing tying an HTTP request to the async work it triggered, or an access
  log to know what hit the API at all.
- evidence: Read server.ts:143-183 (Fastify constructor, no `genReqId`). Read lib/logger.ts in
  full (9 lines, no `.child` usage, no per-request wiring anywhere it's imported from). Grep for
  `logger.child(` across `backend-api/src` returned 0 results.
- fix: Re-enable a request id at minimum — either turn Fastify's logger back on for access
  logging only, or add `genReqId` plus a `preHandler` that stashes
  `request.log = logger.child({ reqId: request.id })` (or an app-level `onRequest` hook) and pass
  that id into `enqueueJob` payload logging so a job's log lines can be grepped back to the
  request that created it. This does not require new infrastructure — pino already supports
  `.child()`, it's just unused.
- verify: `pnpm -C podcast-saas --filter backend-api typecheck` and `test` stay green; manually
  hit an endpoint and confirm a request id shows up both in the access log and in the enqueued
  job's first log line.
- effort: M

---

### [P2] SSE-driven LLM generation failures (sim-script + guidance) are never logged — only shown to a client that may already be gone
- id: observability-004
- location: podcast-saas/backend-api/src/controllers/v1/sections.controller.ts:670-676, podcast-saas/backend-api/src/controllers/v1/simulations.controller.ts:759-766, podcast-saas/backend-api/src/controllers/v1/simulations.controller.ts:880-887
- category: bug
- confidence: high
- status: confirmed
- what: Three SSE handlers — section sim-script generation (`sections.controller.ts`'s
  `runSseGeneration`, catch at 670-676), and simulation guidance generate/publish
  (`simulations.controller.ts`, catches at 759-766 and 880-887) — catch generation failures and
  either send an `error` SSE frame to the client (sections.controller.ts) or send the SSE frame
  **and** write a DB status column (simulations.controller.ts's `guidance_status: 'error'`), but
  none of the three catch blocks calls `logger.error`/`logger.warn`. `sections.controller.ts` has
  exactly one `logger.error` call in the entire file, and it is unrelated to this path (a revision
  pointer warning at line 127).
- why: If the browser tab is closed or the connection drops before the `error` frame arrives —
  routine for a long LLM generation — the failure leaves literally no trace: no SSE frame reaches
  anyone, and (for sections.controller.ts) no DB row records it either. Even when the frame does
  arrive, operators watching server logs (rather than polling every simulation row) get zero
  signal. An LLM-provider outage affecting sim-script or guidance generation would be invisible in
  the logs while every affected user sees a failed generation with nothing server-side to
  correlate it to.
- evidence: Read sections.controller.ts:616-683 in full (the whole `runSseGeneration` function);
  grepped the file for `logger\.` (2 hits total, only one is `logger.error`, at line 127,
  unrelated). Read simulations.controller.ts:711-893 in full (both guidance SSE handlers); grepped
  that byte range for `logger\.` — zero hits.
- fix: Add `logger.error({ err, exportId: ..., errorType }, '<handler>: generation failed')` (or
  the section/sim id) inside each of the three catch blocks, before or alongside the existing
  SSE/DB writes. This is a one-line addition per site — no new infrastructure.
- verify: Force `generateOrReuseSection`/`GuidanceService` to throw in a test and assert a
  `logger.error` call (or grep test-run stdout for the new log line).
- effort: S

---

### [P2] Pipeline-stats has no metric that would have caught a past incident — no job success rate, duration, queue depth, or ffmpeg failure count
- id: observability-005
- location: podcast-saas/backend-api/src/controllers/admin/v1/pipeline-stats.controller.ts:1-105
- category: maintainability
- confidence: high
- status: confirmed
- what: The only pipeline-health endpoint in the admin API reports project/user/revenue counts and
  a snapshot `GROUP BY` of `video_files.hls_status` and `simulations.status`. It has no visibility
  into any of the 11 background job types beyond those two tables — no
  `podcast_render`/`podcast_clips`/`podcast_mix_export`/`project_export`/`project_duplicate`/
  `video_generate` status breakdown, no job duration, no queue depth (pg-boss backlog), and no
  ffmpeg failure count, despite ffmpeg being the thing that has actually broken production on this
  branch (see `3631479 fix(deploy): pin static ffmpeg 8...` in recent history).
- why: This is the one endpoint whose whole job is "would an operator have seen this coming." An
  export success-rate collapse, a podcast render backlog, or a spike in ffmpeg exit failures would
  currently be invisible here — an operator would have to query each status column across 6+
  tables by hand to notice a regression that this dashboard exists to surface.
- evidence: Read the full file (105 lines) — every query enumerated above is the complete list of
  what it reports.
- fix: Add `GROUP BY status` counts for `podcast_renders`, `podcast_mixes`, `project_exports`, and
  `video_generation_jobs` (mirroring the existing `video_files`/`simulations` pattern — same
  cheap, index-backed aggregate query shape), and, if pg-boss exposes a queue-depth read (it
  persists to Postgres so a `SELECT count(*) FROM pgboss.job WHERE state = 'created'`-style query
  is available), surface that too. Don't add new instrumentation infra — this is the same query
  shape already used twice in this file, applied to the tables that are missing.
- verify: `pnpm -C podcast-saas --filter backend-api typecheck`; manually hit the endpoint locally
  and confirm the new fields populate against seeded data.
- effort: M

---

### [P2] A failed collaborator-invite claim during signup is silently dropped, with no log and no user-visible signal
- id: observability-006
- location: podcast-saas/backend-api/src/middleware/firebase-auth.ts:77-86
- category: bug
- confidence: medium
- status: confirmed
- what: On first login, `firebaseAuthMiddleware` claims pending collaboration invites sent to the
  new user's email (lines 77-86) with `.catch(() => {})` — no logging, no retry, no surfacing.
- why: If this update fails (a transient DB error at exactly the moment of first login), the user
  who was invited to a shared project never gets linked to that invite, and nothing — not a log
  line, not the invite row, not the user — records that the claim was attempted and lost. The
  invited user simply doesn't see the project they were told they'd have access to, and there is
  no operator-visible trail to explain why. Unlike the many other `.catch(() => {})` in this
  codebase (cache warms, view-count increments, best-effort cleanup), this one has a durable,
  user-visible consequence: permanently missing collaborator access with no automatic retry path
  (the claim only runs once, at the moment the user row is first created).
- evidence: Read firebase-auth.ts:55-88 (the new-user branch). This is a one-shot operation — a
  later login re-checks `existing` and skips the claim entirely.
- fix: At minimum log the failure —
  `logger.warn({ err, userId: newUser.id, email: newUser.email }, 'firebase-auth: failed to claim pending collaborator invites')`
  — so it's discoverable and can be re-run manually. If this needs to be more robust, consider
  retrying the claim on subsequent logins too (not just user creation), since it's idempotent
  (`WHERE user_id IS NULL AND invited_email = ...`).
- verify: Force the update to reject in a test and assert a log line; confirm the claim is safe to
  re-attempt (it already is, by construction of the `WHERE` clause).
- effort: S

---

### [P3] `console.log`/`console.error` mixed with `logger.*` in the transcode job and two other runtime files, bypassing pino entirely
- id: observability-007
- location: podcast-saas/backend-api/src/services/video/runVideoTranscode.ts:22,28,36,43,49,64,72,79,85,91,105,155,166
- category: maintainability
- confidence: high
- status: confirmed
- what: `runVideoTranscode.ts` — the HLS transcode job handler, one of the most frequently
  executed jobs in the system — has 13 `console.log`/`console.error` calls interleaved with
  `logger.info`/`logger.error` calls for the *same* events (e.g. line 155
  `console.error(...)` immediately followed by line 156 `logger.error(...)` for the identical
  failure). The same pattern appears at smaller scale in
  `controllers/v1/video.controller.ts:551` and `services/storage/R2StorageAdapter.ts:428,431`.
- why: `console.*` output bypasses pino completely — no JSON structure, no `LOG_LEVEL` filtering,
  no redaction, and (once a request-id/job-id correlation scheme exists, see observability-003) no
  correlation fields. It duplicates the adjacent `logger` call's information in an
  un-structured, un-filterable side channel that any log-processing pipeline consuming pino's JSON
  output won't see at all.
- evidence: Read runVideoTranscode.ts in full; every `console.*` line has an adjacent or
  equivalent `logger.*` call carrying the same information (e.g. lines 105-106, 155-156).
- fix: Delete the `console.*` calls and keep the existing `logger.*` calls, which already cover
  the same events with structured fields (`video_file_id`, etc.).
- verify: `pnpm -C podcast-saas --filter backend-api typecheck`; `pnpm -C podcast-saas --filter
  backend-api test` (existing transcode tests should be unaffected since they don't assert on
  console output).
- effort: S

---

### [P3] `lib/sse.ts` is dead code — every live SSE endpoint reimplements its own emitter/heartbeat instead
- id: observability-008
- location: podcast-saas/backend-api/src/lib/sse.ts:1-38
- category: maintainability
- confidence: high
- status: confirmed
- what: `SSEEmitter`/`initSSE` in `lib/sse.ts` are imported only from `_archive/v1-podcast-pipeline/**`
  (excluded from review scope). Every active SSE endpoint —
  `controllers/v1/sections.controller.ts` (2 handlers) and
  `controllers/v1/simulations.controller.ts` (2 handlers) — hand-rolls the identical
  header-setup/heartbeat/abort-on-close pattern independently rather than sharing this module.
- why: Not a live bug — the four hand-rolled implementations were all read in this review and are
  individually correct (heartbeat cleared on both success and error paths, `request.raw.on('close')`
  aborts the in-flight work). But it means any future fix to SSE lifecycle behavior (e.g. a
  keep-alive interval change, or fixing a disconnect-detection edge case) has to be applied in up
  to four places by hand, and a fifth SSE endpoint added later has no shared module to reach for.
- evidence: `grep -rn "initSSE\|SSEEmitter" backend-api/src` — every non-`_archive` hit in
  `sections.controller.ts`/`simulations.controller.ts` is a hand-written `setInterval`/
  `reply.raw.write` block, not an import from `lib/sse.ts`.
- fix: No urgent action needed. If another SSE endpoint is added, consider extracting the shared
  pattern from the four existing handlers into `lib/sse.ts` (or a router-integrated equivalent)
  and migrating the existing four onto it, rather than writing a fifth copy.
- effort: M (only if/when acted on — no correctness impact today)
