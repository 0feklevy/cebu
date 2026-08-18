## Observability findings — FlowVid backend

Scope covered: `podcast-saas/backend-api/src/lib/{logger.ts,sse.ts,fetchWithRetry.ts}`; every job
handler behind the 11 `JobName`s in `queue/types.ts` (transcode, captions, crop, metadata,
podcast_script, podcast_render, podcast_clips, podcast_mix_export, video_generate,
project_duplicate, project_export) and their status-write-on-throw paths; `server.ts` (Fastify
bootstrap, health check, graceful shutdown, stuck-job recovery); `queue/{inlineDriver,pgBossDriver,
startWorker}.ts`; `pipeline-stats.controller.ts`; `services/simulation/RumService.ts` +
`sim-rum.controller.ts`; a full sweep of `catch`/`.catch(() => {})` sites across `backend-api/src`
(excluding `_archive/`). Not covered in depth: frontend error surfacing (ui-ux's column), and the
LLM provider retry/timeout logic itself (llm-pipeline's column) — only its log-level/PII-adjacent
behaviour where it clearly falls in this column.

Headline answer to "if the export pipeline fails for one customer at 3am, what does the operator
see": for `project_export`/`project_duplicate`/every podcast job/`video_generate`/HLS transcode/crop
— **a lot**. Those paths are unusually well engineered: every one of the 11 job types writes a
terminal `failed` (or `cancelled`) status with a stored, user-showable reason inside a fenced
update, logs the classified failure with the job id, and has a startup or timer-based reaper for
the crash-mid-flight case. That is not where the gaps are. The gaps are: (1) one pipeline
(corpus ingestion) was never given the same self-healing sweep the others got, (2) a chunk of the
HTTP-layer error logging silently goes nowhere because of a `logger: false` decision nobody
propagated to two call sites, and (3) there is no way to correlate one user's request across logs,
and no metrics surface that would tell an operator *how often* this happens across users.

---

### [P1] `request.log.error(...)` is a guaranteed no-op — two real failure paths log nothing at all
- id: observability-001
- location: podcast-saas/backend-api/src/server.ts:145
- category: bug
- confidence: high
- status: confirmed
- what: Fastify is built with `logger: false` ("use pino directly"). Per `node_modules/fastify/lib/logger.js:74`, when `logger` is `false` Fastify wires `request.log`/`reply.log` to `abstract-logging`, a library whose every method is a no-op stub — it does not forward to pino, to stdout, or anywhere else. Two production call sites use `request.log.error(...)` instead of the app's own `logger`: `podcast-saas/backend-api/src/controllers/v1/projects.controller.ts:278` (`enhance-thumbnail-prompt failed`) and `:559` (`failed to start project duplication`). Neither has any other log statement in its catch block.
- why: When AI-thumbnail-prompt enhancement or project duplication kick-off throws, the request still gets a clean 502/500 response — the user sees "please try again" — but the operator sees **absolutely nothing**: not in the pino JSON stream, not in `docker logs`, nowhere. This is the worst form of silent failure this domain hunts for: the code visibly intends to log (there is a call, a message, a context object) and still produces zero bytes of evidence. It is also a proven inconsistency, not a stylistic choice: the very same file correctly calls the real `logger.error(...)` three catches away (`projects.controller.ts:339`), and imports `logger` at the top of the file (`:17`) — these two sites simply used the wrong logger.
- evidence: Read `node_modules/fastify/lib/logger.js:9,74` — `nullLogger = require('abstract-logging')`, assigned when `opts.logger` is falsy. Read `server.ts:143-146` — `Fastify({ logger: false, ... })`. Grepped `backend-api/src` for `request\.log\.|reply\.log\.` outside tests/_archive — the only two production hits are `projects.controller.ts:278` and `:559`. Read `projects.controller.ts:260-281` and `:545-563` — no `logger.*` call anywhere else in either catch block. `projects.controller.ts:339` shows the correct pattern (`logger.error({ err, projectId }, ...)`) three functions later in the same file, proving the intent was to log, not to opt out.
- fix: Replace `request.log.error(...)` with `logger.error(...)` (already imported) at `projects.controller.ts:278` and `:559`. Then grep the whole tree once more for `request.log.` / `reply.log.` and eliminate the pattern everywhere (or, if `request.log` is ever wanted for its automatic reqId binding, flip Fastify's `logger` option to the real pino instance instead of `false`, which also fixes observability-003 below for free).
- verify: After the fix, trigger a synthetic throw in each handler (or read the diff) and confirm a `logger.error` JSON line is emitted; `pnpm -C podcast-saas --filter backend-api typecheck` stays clean since the call shapes match.
- effort: S

### [P1] Corpus ingestion has no stuck-recovery sweep — a crash mid-ingest leaves the row (and the UI) permanently "processing"
- id: observability-002
- location: podcast-saas/backend-api/src/services/ingestion/CorpusBuilder.ts:34
- category: bug
- confidence: high
- status: confirmed
- what: `corpus.controller.ts` starts ingestion fire-and-forget in the web process itself (`builder.ingest(corpus.id).catch(err => logger.error(...))`, not through pg-boss/inline queue — see `controllers/v1/corpus.controller.ts:97-100,128-131`). `CorpusBuilder.ingest` sets `ingestion_status: 'processing'` at line 34 and only reaches its own `catch` (which writes `'failed'`) if the *current* process survives long enough to run it. If the process crashes, restarts, or is redeployed while a corpus sits at `'processing'` (a real scenario: PDF/YouTube/web extraction plus LLM calls can run for tens of seconds to minutes), the row is orphaned at `'processing'` forever — there is no code path that ever revisits it. `server.ts` explicitly implements this exact recovery for every sibling pipeline on boot — `recoverStuckTranscodes()` (HLS, 30 min cutoff), `recoverStuckCrops()`, `recoverStuckSimulations()` (whose comment literally says "mirrors recoverStuckCrops"), plus `recoverStuckPodcastScripts/Renders/Mixes` and `recoverStuckVideoGenerations` — but no `recoverStuckCorpusIngestion` exists anywhere in the codebase.
- why: This is the most user-visible failure mode this domain hunts for: a job throws (or the process dies) and the database row never reaches a terminal state, so the UI polling `ingestion_status` shows "Processing…" indefinitely with zero signal that anything went wrong, and no way for the user to retry short of finding some other route. Every other long-running pipeline in this exact app was already patched for this; corpus ingestion was missed.
- evidence: Read `server.ts:95-141` (the four `recoverStuck*` functions) and `:642-653` (all four called at startup, tolerant of individual failures). Grepped `ingestion_status` across `backend-api/src` — the only writers are `corpus.controller.ts` (sets `'pending'`) and `CorpusBuilder.ts:34/124/137` (`'processing'`/`'ready'`/`'failed'`); no reaper/sweep references `corpora` or `ingestion_status` anywhere. Confirmed `corpus.controller.ts:97-100` invokes ingestion directly, not via `queue/registry.ts`'s `handlers` map (which has no `corpus` entry at all — `jobs/corpus.ingest.ts`'s trigger.dev task is dead code, see observability note below).
- fix: Add a `recoverStuckCorpusIngestion()` function mirroring `recoverStuckCrops()`/`recoverStuckSimulations()` — flip any `corpora` row stuck at `ingestion_status = 'processing'` (with a staleness cutoff, since this one restarts fast unlike HLS) to `'failed'` with an operator-legible `error` message, and call it from the same startup block in `server.ts` (~line 646).
- verify: Unit test asserting a `'processing'` corpus row older than the cutoff flips to `'failed'` on the recovery call; manual: kill the process mid-ingest in dev, restart, confirm the row does not stay `'processing'`.
- effort: S

### [P2] Zero request/job correlation id exists anywhere in the backend's logs
- id: observability-003
- location: podcast-saas/backend-api/src/lib/logger.ts:3
- category: maintainability
- confidence: high
- status: confirmed
- what: `logger.ts` creates one flat `pino()` instance with no `mixin`, no default bindings, and (because `server.ts:145` sets `logger: false`) Fastify's own per-request `reqId` generation is never wired to anything that logs. Grepped the whole tree for `request.id`/`req.id` being read anywhere — zero hits. No controller, service, or job handler calls `logger.child({...})` to bind a request id, job id, or export/duplication id as a *persistent* context; every call site that wants correlation (and several do — `exportId`, `duplicationId`, `renderId` are passed as an object field on almost every call in `ProjectExportService.ts`/`ProjectDuplicationService.ts`) has to remember to pass it by hand on every single log line, and misses are silent (e.g. `corpus.controller.ts:99` logs `'Corpus ingest failed'` with only `{ err }` — no `corpus.id` — even though `CorpusBuilder.ingest`'s own internal logs a few lines away do include it).
- why: For the request-and-response HTTP layer specifically, there is no way to grep one user's failed API call's log lines out of the stream at all — not even a Fastify-generated UUID — so "which of these 200 `Unhandled server error` lines from the last hour belongs to the ticket the customer just filed" is answered by timestamp-matching against the support ticket's timezone-adjusted click time, which is exactly the "grep-and-hope" debugging this domain is asked to flag as a P2.
- evidence: Read `lib/logger.ts` in full (9 lines, no `mixin`/`redact`/bindings). `server.ts:591` (`app.setErrorHandler`) logs `logger.error({ err }, 'Unhandled server error')` with no `request.method`/`request.url`/`request.id`. Grepped for `request\.id|req\.id\b` across `backend-api/src` (excluding tests/_archive) — no results.
- fix: Turn `logger: false` back on as a real pino instance (fixes observability-001 for free) so Fastify's built-in `reqId` is generated and attach it: `Fastify({ logger: { level: ..., genReqId: () => randomUUID() } })`, then have the global error handler and every `request.log.*`/manual `logger.error(...)` call in controllers include `request.id`. For the job layer, thread the job's own id (`exportId`, `duplicationId`, `corpus.id`, etc. — already done ad hoc in most services) via `logger.child({ jobId })` once at the top of each job handler instead of repeating it per call site, so a missed field is impossible rather than a discipline problem.
- effort: M

### [P2] `firebase-auth.ts` swallows every error in the token-verify path with zero logging, misreporting real outages as "Invalid auth token"
- id: observability-004
- location: podcast-saas/backend-api/src/middleware/firebase-auth.ts:89
- category: bug
- confidence: high
- status: confirmed
- what: `firebaseAuthMiddleware`'s single `try` block (lines 35-88) covers Firebase token verification *and* the subsequent DB upsert (find-or-create user + org, collaborator-invite claim). The `catch` at line 89 is bare — `catch { return reply.code(401).send({ ..., message: 'Invalid auth token' }); }` — with no `logger.*` call of any kind. A transient Postgres error during the user upsert (pool exhaustion, a dropped connection, the `23505`/`42P01` races this codebase handles carefully elsewhere) is therefore indistinguishable, to both the caller and every log consumer, from an actually-expired/forged token.
- why: This is the pattern the domain brief calls out explicitly — "an empty catch on a storage write ... is the highest-severity form" — applied to the auth path every single request goes through. A DB blip causes every logged-in user to be told their session is invalid (misleading UX, not this domain's call) and an operator investigating a spike in 401s during a DB incident has **no log line to find** that would distinguish "real invalid tokens" from "the database was down." The middleware is called on nearly every authenticated route in the app, so this is a wide blast radius for a single missing log call.
- evidence: Read `middleware/firebase-auth.ts:22-92` in full — the `try` spans token verification (37) through org/user creation (56-87); the `catch` at 89 has one statement, no `logger` import is even present in the file (checked imports at lines 1-6).
- fix: Add `logger.warn({ err }, 'firebaseAuthMiddleware: token verification or user upsert failed')` inside the catch before the 401, and import `logger` from `../lib/logger.js`. Consider splitting the DB-upsert failure into its own catch that returns 503 rather than 401, so a DB outage doesn't read as "your login is bad" to every user simultaneously — but that split is this domain flagging it, not prescribing the UX fix (cross to backend-reviewer/ui-ux for the response-code decision).
- effort: S
- cross: backend

### [P2] `runVideoTranscode.ts` mixes raw `console.log`/`console.error` with the structured `logger` for the same job's status trail
- id: observability-005
- location: podcast-saas/backend-api/src/services/video/runVideoTranscode.ts:22
- category: maintainability
- confidence: high
- status: confirmed
- what: The HLS transcode job — the single most log-heavy pipeline in the app — logs its lifecycle through **two different, uncoordinated channels** in the same function: `console.log`/`console.error` at lines 22, 28, 36, 43, 49, 64, 72, 79, 85, 91, 105, 155, 166 (unstructured emoji-prefixed strings, no level, no JSON) interleaved with `logger.info(...)` at lines 50, 65, 73, 106, 145 (structured JSON via pino, respects `LOG_LEVEL`).
- why: In production (`NODE_ENV=production`), pino writes NDJSON to stdout with no `pino-pretty` transport (per `logger.ts:6-8`), so any log-aggregation pipeline expecting one JSON object per line will choke on, or silently drop, the interleaved plain-text `console.log` lines — meaning half of this job's status trail (including the START/DOWNLOAD/TIER progress markers, which are exactly what you'd want mid-incident) may not reach the same place as the other half, or may not be queryable/filterable the same way. It also means `LOG_LEVEL` cannot suppress or elevate these lines the way it can every other log line in the app, and `console.error` at line 155 (the terminal failure line, `STATUS → failed`) is the most important line in the whole file and is the one least likely to be captured consistently.
- evidence: Grepped `console\.(log|error|warn)` across `backend-api/src` excluding tests/_archive/scripts — `runVideoTranscode.ts` has 13 hits, more than any other production file; read the file in full and confirmed `logger` is imported (`:17`) and used elsewhere in the same function.
- fix: Replace every `console.log`/`console.error` in this file with the equivalent `logger.info`/`logger.warn`/`logger.error` call carrying `{ video_file_id }` (which the existing `logger.info` calls already do — copy that shape). No behavioural change; this is a straight substitution.
- effort: S

### [P2] `pipeline-stats` and the RUM layer expose no operational health metrics for the pipelines most likely to fail
- id: observability-006
- location: podcast-saas/backend-api/src/controllers/admin/v1/pipeline-stats.controller.ts:1
- category: maintainability
- confidence: high
- status: confirmed
- what: `/api/admin/v1/pipeline-stats` reports project/user/revenue counts, HLS status breakdown, and simulation status breakdown — but nothing for `project_exports`, `project_duplications`, `podcast_renders`, `podcast_scripts`, `podcast_mixes`/clips, or `video_generation_jobs`, despite every one of those tables carrying the same kind of `status` column the video/sim breakdowns already surface (and despite those exact pipelines being the ones with the most elaborate failure-classification code in the repo — `classifyExportFailure`, `ExportRefused`, etc.). There is also no job-duration, queue-depth (pg-boss backlog), or ffmpeg-failure-count metric anywhere in the codebase — grepped for any aggregate query against `project_exports`/`podcast_renders`/`video_generation_jobs` outside the services that write them, and against pg-boss's own tables, with no hits.
- why: This is metric gap #8 in the brief, verbatim: "the numbers that would have caught past incidents." An operator with this dashboard open during an export outage sees project/user/revenue counts ticking normally and has to go read raw DB rows or grep logs to notice `project_exports` is failing at an elevated rate — there is no single number here that would move.
- evidence: Read `pipeline-stats.controller.ts` in full (105 lines) — confirmed the query list (`videoRows`, `simRows`, plus counts/revenue) has no equivalent for exports/renders/duplications/video-generation. Grepped `project_exports|podcast_renders|video_generation_jobs` under `controllers/admin/` — no other admin endpoint aggregates them either.
- fix: Add a `by_status` group-by for `project_exports`, `podcast_renders`, and `video_generation_jobs` alongside the existing `videos`/`simulations` blocks (same `groupBy` pattern already used at lines 30-35), and a `failed_last_24h` / `avg_duration_ms` derived from `finished_at - created_at` on each. Queue depth can come from pg-boss's own job table if `QUEUE_DRIVER=pgboss` (`SELECT state, count(*) FROM pgboss.job GROUP BY state`).
- effort: M

### [P2] `fetchWithRetry` has no logging — retries and the eventual failure are both invisible
- id: observability-007
- location: podcast-saas/backend-api/src/lib/fetchWithRetry.ts:7
- category: maintainability
- confidence: high
- status: confirmed
- what: The function has no `logger` import and no log call anywhere in its retry loop (lines 15-31): a 500 that gets retried, a network exception that gets retried, and the final re-thrown error after all retries are exhausted are all silent. Its only production caller, `runVideoTranscode.ts:45` (`const response = await fetchWithRetry(downloadUrl)`), gets back either a `Response` or a thrown error with no indication anywhere in the logs that a retry sequence even ran.
- why: This function exists specifically (per its own doc comment) to paper over "transient network failures talking to object storage" — exactly the kind of intermittent problem an operator needs retry-count visibility into to tell "one blip, self-healed" apart from "storage is degraded and every download is eating 3 retries before it works." Today that distinction is unrecoverable from the logs after the fact.
- evidence: Read `fetchWithRetry.ts` in full (32 lines) — no `logger` import, no log statement. Grepped its only production caller (`runVideoTranscode.ts:45`) — the surrounding code logs the download starting/finishing but the retry attempts themselves are invisible in between.
- fix: Add `logger.warn({ attempt, status: res.status, url: input }, 'fetchWithRetry: retrying after 5xx')` and the equivalent for the caught-exception branch, plus a final `logger.error({ attempts: retries + 1, err: lastErr }, 'fetchWithRetry: all retries exhausted')` right before the `throw lastErr`.
- effort: S

### [P2] Health check proves the database is reachable; it proves nothing about the worker or the job queue
- id: observability-008
- location: podcast-saas/backend-api/src/server.ts:204
- category: maintainability
- confidence: medium
- status: confirmed
- what: `/health` (used by nginx/compose's `healthcheck` at `deploy/docker-compose.yml:55` and by `production-audit.sh` per `ops/release/PLAN.md:65`) only calls `checkDatabaseConnection()` (a real `SELECT 1`, not faked — verified in `db/index.ts:40-46`) and returns 200 if that succeeds. It says nothing about whether the worker process registered its pg-boss handlers (`startWorker.ts`) or whether jobs are actually draining. The worker container has no HTTP probe at all (`docker-compose.yml:84`'s comment: "No HTTP port to probe. The worker is PID 1, so if it crashes the container exits") — so the *only* worker-liveness signal in the whole system is "the process has not hard-crashed," which does not catch a worker that started, logged `[worker] ready`, and then wedged (e.g. a handler that never resolves/rejects and holds a `localConcurrency` slot forever, or `getBoss()` hanging on a saturated connection pool).
- why: In the exact incident this domain is asked to imagine — "the export pipeline fails for one customer at 3am" — if the *cause* is a wedged worker rather than a crashed one, every health check in the stack (web `/health`, the worker's PID1-exit check, `production-audit.sh`) reports green while every queued job silently never runs. Nothing in `pipeline-stats` (see observability-006) or anywhere else would show this either, since there is no queue-depth metric.
- evidence: Read `server.ts:202-219` (the `/health` handler) and `db/index.ts:40-46` (confirms it is a real query, not a stub — down-ranking the "health check that lies" claim from what it could have been). Read `deploy/docker-compose.yml:54-84` — confirms worker has no HTTP healthcheck, only container-exit liveness. Read `startWorker.ts` — confirms nothing after `[worker] ready` re-verifies the workers are still registered/consuming.
- fix: Either (a) add a lightweight `/health` field on the worker process itself (a tiny HTTP listener reporting last-successful-poll timestamp) that compose can probe, or (b) cheapest: have the web `/health` (or a separate `/health/queue`) query `pgboss.job` for the oldest `created` job per queue and flag degraded if any queue's oldest pending job is older than its expected processing time — this reuses the same staleness-window concept the reapers (`sweepAbandonedExports`, etc.) already apply, just read-only.
- effort: M

### [P3] `LLMService.ts` logs up to 800 chars of raw LLM output at error level with no redaction path
- id: observability-009
- location: podcast-saas/backend-api/src/services/llm/LLMService.ts:454
- category: maintainability
- confidence: medium
- status: confirmed
- what: `logger.error({ rawLen: raw.length, rawPreview: raw.slice(0, 800) }, 'All JSON repair attempts failed — raw LLM output shown')` logs a large slice of the model's raw response text whenever every JSON-repair attempt fails, and `:439` logs a 300-char preview on a schema-validation failure. `logger.ts` configures no `redact` list at all, so there is no mechanical backstop if this content happens to reflect user-supplied material (uploaded corpus text, transcript content) back through the LLM.
- why: This app ingests arbitrary user documents/transcripts/audio into `corpora.extracted_md` and feeds them into prompts (see `CorpusBuilder.ts`); a model that echoes a fragment of that source material back verbatim inside a malformed JSON response would land that fragment in the server logs at `error` level, which typically has the longest retention of any log level. This is not a proven leak of a specific secret (no `.env` value, no auth token) — it is a **content-shape** risk, which is why this is P3/medium rather than a confirmed P0/P1 — but it is exactly the "whole request/response bodies in log lines" pattern this domain is asked to flag, and the fix is one line.
- evidence: Read `LLMService.ts:404-455` in full — confirmed `raw` is the model's direct response text and the two log calls are the only place in the LLM pipeline that logs raw content rather than a `slice(...,120)`-style short excerpt used elsewhere in the same file (e.g. `:58` truncates to 120 chars).
- fix: Truncate to something closer to the 120-300 char pattern already used elsewhere in this file, and/or route this specific log line through a helper that strips anything shaped like an email/long numeric sequence before logging, since the whole point of logging it is to diagnose a JSON-shape bug, not to capture the content.
- effort: S
- cross: security

### [P3] `lib/sse.ts` is unwired dead code with two latent lifecycle bugs that will resurface the moment it is used
- id: observability-010
- location: podcast-saas/backend-api/src/lib/sse.ts:15
- category: maintainability
- confidence: high
- status: confirmed
- what: `initSSE`/`SSEEmitter` are exported but grepping the whole non-archived tree for `initSSE` or `new SSEEmitter` finds zero production call sites — the only consumer, `CorpusBuilder.ingest(corpusId, sse?: SSEEmitter)`, has an optional `sse` parameter that its one caller (`corpus.controller.ts:97-100,128-131`) never supplies. `initSSE`/`SSEEmitter` used to be wired to `_archive/v1-podcast-pipeline/controllers/stream.controller.ts` and `audio.controller.ts`, which are archived. Client-web/admin-web have no `EventSource`/`text/event-stream` usage anywhere (grepped both trees). Two lifecycle gaps sit dormant in the unused code: (1) `close()` is only ever called by the *producer*, never in response to the client disconnecting — there is no `reply.raw.on('close', ...)` or `request.raw.on('close', ...)` listener, so a client that navigates away mid-stream leaves `emit()` writing into a reply object with no reader on the other end; (2) `keepAlive()` returns a `setInterval` handle that the caller must remember to `clearInterval` — nothing in the module itself ties the interval's lifetime to `close()`.
- what/why (down-ranked): because nothing calls this code today, it cannot itself be the reason a real user's job goes unexplained right now — hence P3 rather than P2 — but the module reads as production-ready SSE progress-streaming infrastructure (it's referenced by `CorpusBuilder`'s signature) and a future engineer wiring it up for real-time export/corpus progress will inherit both bugs silently, since nothing here is covered by a test that would catch a disconnect-triggered leak.
- evidence: Grepped `initSSE|new SSEEmitter` across the whole tree outside `_archive/`/tests — zero production hits. Grepped `EventSource|text/event-stream` under `client-web/src` and `admin-web/src` — zero hits. Read `sse.ts` in full (39 lines) — confirmed no disconnect listener and no interval-to-close coupling.
- fix: If this is meant to ship, add `reply.raw.req.on('close', () => emitter.close())` inside `initSSE`, and have `keepAlive()` register its own interval with an internal `AbortController` that `close()` also clears, so callers cannot forget. If it is not on a near-term roadmap, note it as dead code for the next cleanup pass rather than leaving it looking load-bearing.
- effort: S

### [P3] `jobs/corpus.ingest.ts` and `jobs/video.transcode.ts` are unreachable trigger.dev task definitions that imply retry semantics the app doesn't actually have
- id: observability-011
- location: podcast-saas/backend-api/src/jobs/corpus.ingest.ts:4
- category: maintainability
- confidence: high
- status: confirmed
- what: Both files define a `@trigger.dev/sdk` `task(...)` with explicit `retry: { maxAttempts: N, ... }` config, but nothing in the app imports `corpusIngestTask` or `videoTranscodeTask` — the real dispatch paths are `corpus.controller.ts` calling `CorpusBuilder.ingest` directly (fire-and-forget, no retry — see observability-002) and `queue/registry.ts`'s `handlers.transcode` calling `runVideoTranscode` directly through pg-boss/inline (which does get pg-boss's at-least-once retry, just not through this file).
- why: Not a runtime bug — these files execute nothing — but they are actively misleading for anyone debugging "why didn't this job retry": reading `jobs/video.transcode.ts` suggests transcode gets 2 trigger.dev-managed attempts with backoff, when the actual retry behaviour (pg-boss's, or none at all for corpus) lives entirely elsewhere and looks nothing like this.
- evidence: Grepped `corpusIngestTask|videoTranscodeTask|@trigger.dev` across `backend-api/src` outside `jobs/` itself — no importers. Confirmed `registry.ts`'s `handlers` map calls `runVideoTranscode`/`runCaptionJobNow`/etc. directly, not these task wrappers.
- fix: Delete both files (and the `@trigger.dev/sdk` dependency if nothing else uses it — flag to dependency-auditor) or, if trigger.dev is a genuine future migration target, mark the files clearly with a `@deprecated`/`// UNUSED —` header so they stop reading as the live retry policy.
- effort: S
- cross: fleet
