import type { PgBoss as PgBossType } from 'pg-boss';
import type { JobHandlers, JobName, JobPayloads } from './types.js';
import { getBoss } from './pgBoss.js';
import { logger } from '../lib/logger.js';

/**
 * Producer + consumer glue for the pg-boss driver.
 *
 * Producer (`pgBossSend`): persists the job to Postgres. Fire-and-forget — on any send
 * failure it runs the supplied inline fallback so a job is never silently lost when pg-boss
 * is misconfigured or down (no worse than the historical in-process behaviour).
 *
 * Consumer (`registerWorkers`): registers a batched worker per durable queue. Handlers are
 * already idempotent (DB CAS claims), so pg-boss's at-least-once delivery is safe.
 */

/**
 * How many jobs of a given kind this worker runs at once — declared per queue, because the answer
 * is a property of the WORK, not of the worker.
 *
 * SERIAL (1) is for anything that wants the CPU: an ffmpeg encode, a TTS-then-stitch render, or an
 * export's capture container (allowed `--cpus 2`, which on the 2-vCPU worker host is the whole
 * machine). Two of those do not finish in the same total time as one after the other; they contend,
 * each takes longer than the pair would have taken in sequence, and both move closer to their
 * wall-clock kill. `ffmpegLimit` bounds the ffmpeg PROCESSES globally, but it does not stop this
 * worker from holding several half-finished jobs — each with its temp files, its downloaded source
 * and its claim — while none of them progresses.
 *
 * TWO is for the I/O-bound kinds: a crop, a byte copy, or a job that spends its life waiting on
 * someone else's HTTP response (Groq, OpenAI, the writers' room). Serialising those would idle the
 * box for no gain.
 *
 * Before Phase E every queue except project_export silently inherited crop's number; with eight
 * more queues that would have meant up to twenty concurrent handlers on a two-core host.
 */
const QUEUE_CONCURRENCY: Record<JobName, number> = {
  // CPU-bound — one at a time.
  transcode: 1,
  podcast_render: 1,
  podcast_clips: 1,
  podcast_mix_export: 1,
  project_export: 1,
  // I/O- or provider-bound — two interleave happily.
  crop: 2,
  captions: 2,
  metadata: 2,
  podcast_script: 2,
  video_generate: 2,
  project_duplicate: 2,
};

/** Per-queue env overrides, kept for the two knobs that already shipped. */
const CONCURRENCY_ENV: Partial<Record<JobName, string>> = {
  crop: 'QUEUE_CROP_CONCURRENCY',
  project_export: 'QUEUE_EXPORT_CONCURRENCY',
};

function concurrencyFor(name: JobName): number {
  const envKey = CONCURRENCY_ENV[name];
  const raw = envKey ? process.env[envKey] : undefined;
  return Math.max(1, Number(raw ?? QUEUE_CONCURRENCY[name]));
}

/** Enqueue a durable job. Never throws; falls back to `inline()` if the send fails. */
export function pgBossSend<N extends JobName>(
  name: N,
  payload: JobPayloads[N],
  inline: () => void,
): void {
  getBoss()
    // singletonKey collapses duplicate *pending* jobs for the same target into one; the DB
    // CAS claim remains the authoritative guard against double *processing*.
    .then((boss) => boss.send(name, payload, { singletonKey: singletonKeyFor(name, payload) }))
    .then((id) => {
      if (!id) logger.debug({ job: name }, '[queue] pg-boss send deduped (existing pending job)');
    })
    .catch((err) => {
      logger.error({ err, job: name }, '[queue] pg-boss send failed — running inline as fallback');
      inline();
    });
}

/**
 * A stable per-target key so repeated triggers for the same target don't pile up in the queue.
 *
 * WHAT THIS KEY IS, AND WHAT IT IS NOT.
 * It collapses jobs that are still WAITING to start. It says nothing about a RETRY of a job that
 * already ran, and nothing about two workers in different processes — which is exactly the pair of
 * deliveries that used to append a second b-roll section. So this is NOT the idempotency guarantee
 * for `video_generate`, and it is deliberately not written as though it were: that guarantee is
 * `uniq_timeline_sections_generation_job` (migration 062) plus the runner's CAS lease, both of
 * which hold whether or not this key exists, and both of which would still hold if pg-boss were
 * swapped out tomorrow.
 *
 * It earns its place on COST. Startup recovery re-drives every in-flight generation on every boot,
 * so a crash-looping worker otherwise queues one job per boot against the same row; each of those
 * wakes a worker and starts a provider poll before the lease turns it away. One key per generation
 * removes that pile-up for free.
 *
 * Only for job kinds where two sends genuinely mean ONE piece of work. `metadata`, `captions`,
 * `podcast_script`, `podcast_clips` and `project_duplicate` get no key: a second request there is a
 * second request — `captions` even carries a `force` flag a collapse would discard — and silently
 * swallowing it would be a bug wearing a deduplication costume. Those queues stay on the `standard`
 * policy, so there is no index to swallow anything either.
 */
export function singletonKeyFor<N extends JobName>(name: N, payload: JobPayloads[N]): string | undefined {
  if (name === 'crop') return (payload as JobPayloads['crop']).videoFileId;
  if (name === 'video_generate') return (payload as JobPayloads['video_generate']).jobId;
  // Two sends for one video file mean one HLS ladder, and `runVideoTranscode` has no CAS claim of
  // its own, so a queued duplicate would genuinely double-encode rather than bow out.
  if (name === 'transcode') return (payload as JobPayloads['transcode']).videoFileId;
  // `recoverStuckPodcastRenders` re-drives every untouched queued render on EVERY boot, so a
  // restart loop stacks one delivery per boot on the same row. Same cost argument as
  // video_generate: the key removes the pile-up, the CAS claim remains the correctness guard.
  if (name === 'podcast_render') return (payload as JobPayloads['podcast_render']).renderId;
  if (name === 'podcast_mix_export') return (payload as JobPayloads['podcast_mix_export']).renderId;
  return undefined;
}

/** Register a batched worker for each durable queue. ffmpeg stays globally bounded by ffmpegLimit. */
/**
 * Which queues THIS process may consume, from `WORKER_QUEUES`.
 *
 * Without an allowlist every process that starts a worker consumes every queue, so the API — which
 * has no Docker socket and no business rendering video — would pick up an export and run a capture
 * container it cannot launch, or worse, could. Splitting the pool is not a deployment detail: it is
 * what keeps Docker access out of the request-serving process.
 *
 * A general worker gets `crop,video_generate`. A dedicated export orchestrator gets
 * `project_export` and nothing else. An unknown name is a startup error rather than a silent
 * omission, because a typo would otherwise mean a queue nobody consumes and jobs that sit forever.
 */
export function resolveWorkerQueues(
  available: readonly JobName[],
  env: NodeJS.ProcessEnv = process.env,
): JobName[] {
  const raw = env.WORKER_QUEUES?.trim();
  if (!raw) return [...available];
  const named = raw.split(',').map((n) => n.trim()).filter(Boolean);
  const unknown = named.filter((n) => !(available as readonly string[]).includes(n));
  if (unknown.length > 0) {
    throw new Error(
      `WORKER_QUEUES names unknown queue(s): ${unknown.join(', ')}; known: ${available.join(', ')}`,
    );
  }
  return named as JobName[];
}

export async function registerWorkers(
  boss: PgBossType,
  names: readonly JobName[],
  handlers: JobHandlers,
): Promise<void> {
  for (const name of names) {
    const run = handlers[name] as (payload: unknown) => Promise<unknown>;
    await boss.work(name, { localConcurrency: concurrencyFor(name) }, async (jobs) => {
      for (const job of jobs) {
        await run(job.data); // throwing fails the job → pg-boss retries with backoff
      }
    });
    logger.info({ queue: name }, '[pg-boss] worker registered');
  }
}
