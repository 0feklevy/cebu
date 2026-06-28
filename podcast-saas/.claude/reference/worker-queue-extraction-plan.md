# Architecture Plan — Worker / Queue Extraction

> Status: **Phase A + B shipped (code).** Phase B (crop → pg-boss) is flag-gated off by default
> (`QUEUE_DRIVER=inline`); its live durability QA against a session-mode Postgres is still pending.
> Phases C–D not started.
> Prereq already shipped: cluster-safe CAS claims on captions + crop (Phase 5 core).

## 1. Goal

Move heavy background work off the web (Fastify) tier into a durable queue + worker process so that:
- the API stays responsive (no ffmpeg CPU contention on web instances),
- jobs **survive restarts/crashes** (today an in-flight `setImmediate` job is lost on deploy),
- jobs get **retry/backoff + dead-lettering**,
- web and worker capacity scale independently,
- **local development stays a single `npm run dev`** with breakpoints intact.

Non-goals (later): worker autoscaling, separate job DB, live progress streaming to the editor.

## 2. Current state (what we're extracting)

| Job | Entry | Trigger sites | Status fields | Idempotency today |
|-----|-------|---------------|---------------|-------------------|
| **transcode** | `runVideoTranscode` (video/) | `video.controller` upload + retranscode; `jobs/video.generate` | `video_files.hls_status` (enum), `hls_started/finished_at`, `hls_error`, `hls_current_tier` | startup `recoverStuckTranscodes`; no source hash (always re-runs); cascades to the 3 below |
| **captions** | `runCaptionJob` (captions/) | post-transcode cascade; `player.controller` | `captions_status`, `captions_source_hash`, `captions_updated_at`, `captions_error` | **CAS claim ✓** + source hash + in-proc `inFlight` Set; stale reclaim 20m, failed retry 10m |
| **crop** | `runCropAnalysis` (crop/) | post-transcode cascade; `video.controller` recrop | `crop_status`, `crop_source_hash`, `crop_updated_at`, `crop_error` | **CAS claim ✓** + source hash; stale reclaim 20m |
| **metadata/thumbnail** | `generateVideoMetadata` | post-transcode cascade; `projects.controller` backfill | `projects.metadata_status` | **no CAS** — in-proc `_inFlight` Set + naive `status==='ready'` skip ⚠️ |

All producers are `setImmediate(runX(...))` fire-and-forget. CPU is bounded only by the in-process
`ffmpegLimit` semaphore (`FFMPEG_CONCURRENCY=2`). `@trigger.dev/sdk` is a dependency but its
`src/jobs/*.ts` `task()` defs are **never invoked** — dead scaffolding to remove or ignore.

## 3. Queue choice — **pg-boss** (recommended)

| Option | Infra | Retry/backoff/DLQ | Local dev | Verdict |
|--------|-------|-------------------|-----------|---------|
| **pg-boss** | reuses `DATABASE_URL`, **no Redis** | built-in | zero extra services | ✅ **chosen** |
| BullMQ | needs Redis addon (Railway/Render) + local Redis/docker | best-in-class | extra service to run locally | ❌ new infra; outbound-port/Redis cost |
| hand-rolled PG queue (`FOR UPDATE SKIP LOCKED`) | none | we build it | simple | viable fallback — but we'd reimplement retry/DLQ/cron; we already have CAS, so this is the "do nothing new" floor |

**Why pg-boss:** Postgres-backed → one fewer moving part on every host (managed GoDaddy, Railway,
Render, local); gives retry/backoff/dead-letter/archival for free; works identically across all
environments with only `DATABASE_URL`. BullMQ's Redis requirement conflicts with the single-app
managed host and adds a local dependency. The hand-rolled option is only attractive because CAS
already exists — but maintaining retry/DLQ ourselves isn't worth it.

⚠️ **pg-boss needs a session-mode Postgres connection** (uses LISTEN/NOTIFY + advisory locks).
It must **not** run over the Supabase *transaction* pooler (6543). Use the direct/session
connection (5432 or session pooler) for the worker — this is the same pooler caveat already noted
for deploy. pg-boss installs its own schema (`pgboss`); keep it in a dedicated schema, out of the
hand-rolled numbered migration list.

## 4. Phased migration path

### Phase A — Queue abstraction, **no behavior change** ✅ SHIPPED
Introduce a `Queue` interface; the **default driver is `inline`** = today's `setImmediate`. Route the
existing `enqueueX` helpers through it so all call sites are unchanged and behavior is byte-identical.
- NEW `src/queue/types.ts` — `Queue { enqueue(name, payload, opts?) }`, job-name union.
- NEW `src/queue/inlineDriver.ts` — `setImmediate` + the existing run fns (current behavior).
- NEW `src/queue/registry.ts` — name→handler map: `transcode|captions|crop|metadata`.
- NEW `src/queue/index.ts` — selects driver from `QUEUE_DRIVER` (default `inline`).
- EDIT the **internals** of the existing helpers to call `queue.enqueue(...)` (signatures unchanged):
  `runVideoTranscode` cascade, `enqueueCaptionsForVideo/Project`, `enqueueCropAnalysis/ForProject`,
  `enqueueVideoMetadata`, and the `setImmediate(runVideoTranscode)` in `video.controller`.
- Net: zero functional change; full suite stays green.

### Phase B — Move **one low-risk job: crop** to pg-boss ✅ SHIPPED (code) · ⏳ live-QA pending
Crop is the safest first mover: already CAS-protected, no external API, not on the playback path,
failure-tolerant. **Default behaviour is unchanged** — pg-boss only engages when `QUEUE_DRIVER=pgboss`.
- `package.json`: added `pg-boss@12`; scripts `worker` + `dev:worker` (in-process `WORKER_INLINE=1`
  used for the single-process/local story instead of a `concurrently` dep).
- NEW `src/queue/pgBoss.ts` — lazy boss singleton (dynamic `import('pg-boss')`, so it never loads on
  the inline/test path), `createQueue` + dead-letter (`crop-dead`), retry/backoff config, graceful `stopBoss`.
- NEW `src/queue/pgBossDriver.ts` — `pgBossSend` (singletonKey dedup + inline fallback on send failure)
  and `registerWorkers` (batched `boss.work`, `localConcurrency`, ffmpeg still bounded by `ffmpegLimit`).
- NEW `src/queue/startWorker.ts` + `src/worker.ts` — shared starter + dedicated entrypoint.
- EDIT `src/queue/index.ts` — routes only `crop` through pg-boss when enabled; everything else inline.
- EDIT `src/server.ts` — opt-in in-process worker (`WORKER_INLINE=1`) + `stopBoss()` on shutdown.

**Env flags:** `QUEUE_DRIVER=pgboss` (default `inline`), `QUEUE_DATABASE_URL` (point at a DIRECT/session
endpoint; falls back to `DATABASE_URL`), `WORKER_INLINE=1` (web runs the worker), `QUEUE_PGBOSS_LISTEN=1`
(opt-in LISTEN/NOTIFY — needs a session connection; polling is the default floor), `QUEUE_CROP_CONCURRENCY`
(default 2), `QUEUE_PGBOSS_SCHEMA` (default `pgboss`), `QUEUE_PGBOSS_MAX` (pool, default 4).

**Static verification done:** typecheck (validates usage vs pg-boss types), lint (0 errors), full suite
(401 pass — inline default unchanged), worker boots + fails gracefully against an unreachable DB.

**Live-QA still required (needs a session-mode Postgres):**
1. `QUEUE_DRIVER=pgboss WORKER_INLINE=1` → upload/recrop → crop job appears in `pgboss.job` and completes.
2. Kill the web mid-crop → on restart the job is re-delivered and finishes (durability).
3. Two workers + same video → CAS lets only one process it (no double-run).
4. Force a handler failure → retry with backoff, then lands in `crop-dead` after `retryLimit`.
5. `QUEUE_DRIVER=inline` (or unset) → behaviour identical to before (rollback path).

### Phase C — Move **transcode + captions** (the heavy ffmpeg jobs)
- Add `transcode` + `captions` handlers to `src/worker.ts`; generous job timeouts (> worst-case
  transcode); per-queue concurrency tuned against `FFMPEG_CONCURRENCY`.
- Verify the **post-transcode cascade** (captions/crop/metadata) now enqueues across the process
  boundary, and `recoverStuckTranscodes` still complements (or is superseded by) queue re-delivery.
- **metadata**: add a CAS claim on `projects.metadata_status` *before* moving it (currently unsafe
  under at-least-once delivery → could double-run GPT vision). Move it with transcode or just after.

### Phase D — Dedicated worker deployment
- `WORKER_DEDICATED=1`: web enqueues but does **not** `boss.work`; a separate worker service does.
- Deployable on Railway/Render (separate worker process). On the single-app managed host, the
  achievable form is `WORKER_INLINE` (web also runs `boss.work`) — still durable + retried, just not
  physically separated. Document both shapes.

## 5. Local development (must stay simple)

- **Default (`QUEUE_DRIVER=inline`)**: identical to today — one `npm run dev`, single process,
  breakpoints work, no pg-boss tables touched.
- **Inline-worker (`QUEUE_DRIVER=pgboss WORKER_INLINE=1`)**: durability locally in one terminal.
- **Two-process (`npm run dev:all`)**: web + `dev:worker` together to mirror prod via `concurrently`.
- No new local service is ever required (Postgres is already running).

## 6. Rollback

- **Instant, env-only:** set `QUEUE_DRIVER=inline` → every producer reverts to `setImmediate`,
  no redeploy of code. Per-queue rollback by routing one queue back to inline.
- pg-boss tables are **additive** (own schema) — disabling the driver leaves them dormant; drop the
  `pgboss` schema to fully remove.
- CAS claims guarantee re-enabling can't double-process in-flight work.

## 7. Risks / watch-items

- **Supabase pooler vs pg-boss** — worker must use a session-mode connection (not 6543 transaction
  pooler); LISTEN/NOTIFY + advisory locks require it.
- **Single-app managed host** can't run a 2nd process → in-process-worker-behind-flag is the form
  there; true separation needs Railway/Render.
- **pg-boss schema vs numbered migrations** — keep it isolated; don't let it collide with migration
  bookkeeping.
- **Pool pressure** — worker + web share Postgres; size `max` (currently 10) per process accordingly.
- **metadata has no CAS** — must add before Phase C move.
- **Long ffmpeg jobs vs visibility/timeout** — set job timeouts well above worst-case transcode.
- **Vestigial trigger.dev tasks** — decide: delete `src/jobs/*.ts` + drop the dep, or leave as-is.

## 8. What to test per phase

- **A:** full suite green; unit-test inline driver enqueues+runs; assert `enqueueX` still
  fire-and-forget; no behavior diff (snapshot the cascade).
- **B:** crop survives a forced web restart (re-delivered); two workers + CAS = no double-run;
  induced failure → retry/backoff → dead-letter; idle/up-to-date path unaffected (no spurious runs).
- **C:** transcode timeout > worst case; ffmpeg concurrency bound respected with worker active;
  cascade fires across process boundary; `recoverStuckTranscodes` interplay; metadata CAS prevents
  double vision calls.
- **D:** web-without-worker enqueues but doesn't process; worker-only drains the queue; pool sizing
  under upload load; graceful shutdown finishes/returns in-flight jobs.

## 9. Acceptance

Jobs survive a web restart, retry with backoff on failure, never double-process, and API latency is
unaffected under upload load. Local dev unchanged by default. **Effort: medium-large.**
