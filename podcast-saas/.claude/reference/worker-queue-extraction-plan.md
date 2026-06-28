# Planned project — Worker / durable-queue extraction (NOT started)

> Status: **planning only.** Do not implement until opened as its own project.
> This is the "big remaining piece" of Phase 5; the cluster-safe CAS claims (shipped) are
> the prerequisite that makes it safe.

## Goal
Move heavy ffmpeg work (HLS transcode, captions, smart-crop, metadata) off the web request
tier into a **durable queue + worker**, so that:
- the API stays responsive (no CPU contention from ffmpeg on web instances),
- jobs **survive restarts/crashes** (today an in-flight `setImmediate` job is lost on deploy),
- jobs get **retry/backoff + dead-lettering**, and
- web and worker capacity can scale independently.

## Current state (post-Phase-5 core)
Jobs run in-process via `setImmediate(runX)` directly on the web instances. Phase 5 added
**cluster-safe CAS claims** (caption + crop) so multiple instances don't double-process —
but the work still executes on the web tier and doesn't survive a restart.

## In scope
- A durable queue and a worker entrypoint.
- Replace `setImmediate(runX)` producers with `queue.send(...)`.
- Job handlers wrap the existing `runVideoTranscode` / `CaptionService` / `runCropAnalysis` /
  `generateVideoMetadata` (keep their CAS claims — handlers stay idempotent).
- Retry/backoff, per-queue concurrency limits, graceful shutdown.

## Out of scope (later)
Worker autoscaling, a separate job database, live progress streaming to the editor.

## Suggested design
- **Queue: pg-boss** (Postgres-backed — reuses `DATABASE_URL`, **no Redis/new infra**).
  BullMQ is the alternative if a Redis dependency is acceptable; pg-boss is preferred here
  to avoid new infrastructure on the managed host.
- **Queues:** `transcode`, `captions`, `crop`, `metadata`.
- **Producer:** swap `setImmediate(runVideoTranscode(id))` → `boss.send('transcode', { id })`.
  The CAS claim stays *inside* the handler, so at-least-once delivery is safe (idempotent).
- **Worker:** `src/worker.ts` registering `boss.work('transcode', { teamConcurrency: 1-2 }, h)`
  etc. Reuse `ffmpegLimit` for CPU bounding. Generous job timeouts (ffmpeg is slow).
- **Deployment shape (platform-aware — see CLAUDE.md "single app per upload"):**
  Node.js Hosting runs a single `npm start`, so a separate worker *dyno* isn't deployable
  there. Realistic first step: an **in-process worker behind a flag** — the web process also
  runs `boss.work(...)` unless `WORKER_DEDICATED=1`. This gives durability + retries on the
  managed host today, and clean separation later on a host that supports multiple processes.

## Risks / watch-items
- **Single-process platform:** true web/worker separation needs a host that runs >1 process;
  on Node.js Hosting the in-process-worker-with-durable-queue is the achievable form.
- **pg-boss schema:** it creates its own tables — reconcile with the hand-rolled migration list.
- **Long jobs vs visibility timeout:** set timeouts well above worst-case transcode time.
- **Pool pressure:** worker + web share the Postgres pool; size accordingly.
- **Idempotency:** relies on the existing status+hash CAS — keep handlers idempotent.

## Rollout
Feature-flag (`QUEUE_ENABLED`) with fallback to `setImmediate`; enable per-queue; verify jobs
survive a forced web restart (re-delivered) and that the CAS still prevents double-processing.

## Acceptance
Jobs survive a web restart, retry with backoff on failure, don't double-process, and API
latency is unaffected under upload load. **Effort: medium-large — its own project.**
