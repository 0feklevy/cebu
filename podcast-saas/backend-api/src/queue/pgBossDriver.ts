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
export const QUEUE_CONCURRENCY: Record<JobName, number> = {
  // CPU-bound — one at a time.
  transcode: 1,
  podcast_render: 1,
  podcast_clips: 1,
  podcast_mix_export: 1,
  project_export: 1,
  // CPU-bound like the rest of this group: it is an ffmpeg encode. Cheap per job — seconds, not
  // minutes — but a cheap encode running beside a transcode on a 2-vCPU host still contends for
  // the same cores, and "it is only audio" is exactly the reasoning that produced the twenty
  // concurrent handlers this map was written to stop.
  audio_edition: 1,
  // Crop is NOT I/O-bound, which is why it is not in the group below. It runs ffmpeg plus frame
  // analysis, so it is CPU-bound, and the production host has 2 vCPU — two crop workers there
  // contend with each other and with whatever else is encoding. The decision record has said
  // "QUEUE_CROP_CONCURRENCY=1 until measured on the 2-vCPU host" for some time; the default here
  // said 2 and no deploy config overrode it, so the documented intent was simply not in force.
  // Raising it again needs a measured RSS/runtime run on that host, not an assumption.
  crop: 1,

  // I/O- or provider-bound — two interleave happily.
  captions: 2,
  metadata: 2,
  podcast_script: 2,
  video_generate: 2,
  project_duplicate: 2,

  // Dubbing spends most of its wall clock waiting on the vendor, but its tail is an ffmpeg mux
  // plus a full HLS ladder — CPU-bound work on a 2-vCPU host. One at a time here; the number that
  // actually bounds the VENDOR side is the three-row `dubbing_slots` pool, which is cluster-wide
  // and which this per-process number cannot substitute for.
  dub: 1,
};

/**
 * The kinds whose work is CPU-BOUND, and which therefore must never run in the API container
 * (job-queue-013).
 *
 * This is the same set the concurrency table above marks `1` and explains as CPU-bound, written
 * out once so the fallback rule and the concurrency rule cannot drift apart —
 * `cpuBoundMatchesConcurrency` in the driver test asserts they stay equal.
 *
 * WHY IT MATTERS THAT THIS IS A SET AND NOT A JUDGEMENT AT THE CALL SITE. `pgBossSend` falls back
 * to running the handler inline when the durable send fails, which is a good rule for a cheap job
 * and a dangerous one for an encode: the moment the queue database is unhealthy is the moment the
 * API is most needed, and that is exactly when the fallback would start a full HLS ladder for a
 * source up to 2 GB — or a TTS-plus-ffmpeg stitch, or a dub's mux — inside the request-serving
 * process on a 2-vCPU host.
 */
export const CPU_BOUND_JOBS: ReadonlySet<JobName> = new Set<JobName>([
  'transcode', 'podcast_render', 'podcast_clips', 'podcast_mix_export', 'project_export', 'crop', 'dub',
]);

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
      // THE FALLBACK IS FOR CHEAP WORK ONLY (job-queue-013).
      //
      // Running the handler in this process is the right answer for a job that mostly waits on
      // somebody else's HTTP response. It is the wrong answer for an encode, and wrong in the
      // worst way: the send only fails when the queue database is unhealthy, which is precisely
      // when the API must keep answering — and the fallback would answer by starting a full HLS
      // ladder, a TTS-plus-ffmpeg stitch, or a dub's mux, in-process, on 2 vCPUs.
      //
      // Refusing does not lose the work. Every kind in `CPU_BOUND_JOBS` is re-drivable: the row
      // keeps its own non-terminal status, and each service claims by CAS with a staleness window
      // (`sweepStuckTranscodes` at boot, `startExportSweep`, the podcast runners' stale-claim
      // reclaim, DubbingService's `STALE_CLAIM_MS`). So the outcome is a delay that recovers,
      // instead of an API that stops serving everyone while the queue is already down.
      if (CPU_BOUND_JOBS.has(name)) {
        logger.error(
          { err, job: name, payload },
          '[queue] pg-boss send failed for a CPU-bound job — NOT running it inline. ' +
          'It stays claimable and a recovery sweep will re-drive it; running it here would put an ' +
          'encode in the request-serving process while the queue is already unhealthy.',
        );
        return;
      }
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
  // Two sends for one video_dubs row are one dub. Unlike `captions`, whose `force` flag makes a
  // second request genuinely different, `force` here only bypasses the settled-status gates for a
  // row that is already the singleton subject — collapsing two pending deliveries loses nothing.
  if (name === 'dub') return (payload as JobPayloads['dub']).dubId;
  // An edition is identified by (project, language), not by a row id — the row may not exist yet
  // on the first send. Two enqueues for the same pair are the same work, and collapsing them in
  // the queue is strictly better than letting both start and having the loser discover the claim
  // is taken: no download, no temp directory, no wasted worker slot.
  //
  // The project id is always present, so cross-project collision is not the risk here — the risk
  // is null colliding with a real language, which `'source'` rules out. (An earlier comment on
  // this line claimed `??` was preventing cross-project dedup. It was not, and a mutation to `||`
  // proved it by changing nothing: both spellings are correct. A comment that names a protection
  // it does not provide is worse than no comment, because the next reader believes it.)
  if (name === 'audio_edition') {
    const p = payload as JobPayloads['audio_edition'];
    return `${p.projectId}:${p.language ?? 'source'}`;
  }
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
 * `project_export` and nothing else.
 *
 * ── WHY AN UNKNOWN NAME IS SKIPPED RATHER THAN FATAL (job-queue-011) ─────────────────────────
 * This function used to throw on any unknown name, to catch a typo — a queue nobody consumes means
 * jobs that sit forever and a failure that surfaces days later as "my export never started".
 *
 * That is the right instinct and it was aimed at the wrong failure. `WORKER_QUEUES` is set in
 * `docker-compose.yml`, which is read from the CHECKED-OUT TREE, while the image is whatever tag
 * `APP_VERSION` names — so the config and the code can legitimately disagree in one direction:
 * **an older image being handed a queue name that was added after it was built.** That is exactly
 * what a rollback is. The throw turned it into `process.exit(1)` under `restart: unless-stopped`,
 * i.e. a crash-loop of the only container that runs background work, during an incident.
 *
 * So this is the expand/contract rule for queue names, and it has to hold in BOTH directions:
 * adding a queue must not break an older image, and removing one must not break a newer one.
 *
 *   • unknown names are DROPPED, and logged at error level naming each one — a typo is still
 *     loudly visible at startup, in the place an operator is already looking;
 *   • but if NOTHING known survives, that is thrown, because a worker consuming no queues at all
 *     does no work while looking perfectly healthy, and there is no version skew that explains it.
 */
export function resolveWorkerQueues(
  available: readonly JobName[],
  env: NodeJS.ProcessEnv = process.env,
): JobName[] {
  const raw = env.WORKER_QUEUES?.trim();
  if (!raw) return [...available];
  const named = raw.split(',').map((n) => n.trim()).filter(Boolean);
  const known = named.filter((n) => (available as readonly string[]).includes(n));
  const unknown = named.filter((n) => !(available as readonly string[]).includes(n));

  if (unknown.length > 0) {
    logger.error(
      { unknown, known, available },
      '[queue] WORKER_QUEUES names queue(s) this build does not have — skipping them. ' +
      'If this is not a rollback to an image older than the compose file, it is a typo and those jobs will never run.',
    );
  }

  if (known.length === 0) {
    throw new Error(
      `WORKER_QUEUES names no queue this build has: ${named.join(', ')}; known: ${available.join(', ')}`,
    );
  }

  return known as JobName[];
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
        try {
          await run(job.data);
        } catch (err) {
          // LOG BEFORE RE-THROWING. pg-boss records the failure and schedules the retry either
          // way, but only in its own tables — an error thrown from a handler used to leave ZERO
          // log lines, and the dubbing feature shipped broken in production for a full day with
          // its TypeError visible nowhere but `pgboss.job.output`, a table nothing watches. The
          // rethrow is what fails the job so the retry/backoff behaviour is unchanged.
          logger.warn(
            { queue: name, jobId: job.id, err: err instanceof Error ? err.message.slice(0, 400) : String(err) },
            '[pg-boss] job handler threw — job will retry with backoff (or fail permanently past its retry limit)',
          );
          throw err;
        }
      }
    });
    logger.info({ queue: name }, '[pg-boss] worker registered');
  }
}
