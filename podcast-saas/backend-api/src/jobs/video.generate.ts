/**
 * B-roll generation — the job body.
 *
 * WHAT THIS JOB HAS TO SURVIVE
 * `video_generate` is a durable pg-boss queue with retries, and every boot re-drives whatever was
 * in flight. So the body is delivered AT LEAST ONCE, sometimes while a previous delivery is still
 * running, and it spends up to ~25 minutes between its first and last durable write. Until
 * migration 062 it ended with an unkeyed `INSERT` of a timeline section — so a retry, a recovery
 * delivery, or a second worker simply APPENDED A SECOND b-roll overlay at the same global offset.
 * The player resolves an overlay with a first-match `.find()` over one concatenated array, which is
 * why the symptom was "a clip plays where I never put one", intermittently.
 *
 * THE THREE THINGS THAT FIX IT, IN ORDER OF AUTHORITY
 *   1. THE JOB ROW ITSELF. Finalisation locks `video_generation_jobs` with SELECT ... FOR UPDATE,
 *      re-checks the claim and `section_id` AFTER the wait, and commits behind a fence requiring
 *      both. A second delivery blocks on that lock and then observes the result instead of racing
 *      it; a run that lost its lease rolls its INSERT back. An earlier draft put a partial unique
 *      index on `timeline_sections` instead. Dropped, for three reasons: the product lets a user
 *      manually re-insert a previously generated asset, so "this asset appears once in the
 *      timeline" is simply not true and enforcing it would break a supported action; every section
 *      predating the change carries no provenance, so the constraint could never have fixed an
 *      existing row; and it cost a write lock on a hot table. The invariant is a property of THIS
 *      JOB, so it belongs on this job’s row.
 *   2. A LEASE. `claim()` is a conditional UPDATE from an in-flight status whose claim is absent or
 *      whose heartbeat has gone `VIDEO_GEN_STALE_AFTER_MS` quiet — the `ProjectExportService`
 *      discipline, which itself copies `ProjectDuplicationService`. A live run beats `updated_at`
 *      on a timer, which is what makes staleness a sound death test across a 20-minute poll. Every
 *      write after the claim is FENCED on `claimed_by`, so a reclaimed run's writes become no-ops
 *      instead of races — and a run that discovers it lost the lease stops, quietly, without
 *      dragging a terminal row back to life.
 *   3. RESUMABILITY. Each stage's output is durable and each stage is skipped when its output is
 *      already there: a stored `enhanced_prompt` is not re-billed, a stored `external_task_id` is
 *      polled rather than re-submitted, a stored `video_file_id` is not re-downloaded, a video
 *      whose HLS ladder is `ready` is not re-encoded, and the section + the job's terminal write
 *      are ONE TRANSACTION, so finalisation is all-or-nothing.
 *
 * THE ONE STEP THAT CANNOT RESUME, AND WHAT IS DONE ABOUT IT
 * Between `svc.submit()` returning a provider task id and that id reaching the row there is a
 * window in which a crash leaves a PAID generation nobody can find again. Re-submitting bills it
 * twice. `attempts` is incremented by the claim itself, in the same UPDATE, so the runner can tell
 * a first attempt from a re-drive with no race and REFUSE to re-submit — converging to zero
 * sections and one honest `failed` row. The old code guarded this only on the startup path, so a
 * pg-boss retry of a row sitting in `submitting` re-submitted and double-billed.
 */

import { task } from '@trigger.dev/sdk/v3';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { video_generation_jobs, timeline_sections, video_files, projects } from '../db/schema.js';
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';
import { createVideoGenerationService, type VideoModel } from '../services/video-generation/VideoGenerationService.js';
import { LLMService } from '../services/llm/LLMService.js';
import { ApiKeyService } from '../services/secrets/ApiKeyService.js';
import { UsageTrackingService } from '../services/usage/UsageTrackingService.js';
import { recordVideoUsage } from '../services/llm/systemAi.js';
import { runVideoTranscode } from '../services/video/runVideoTranscode.js';
import { enqueueJob } from '../queue/index.js';
import { logger } from '../lib/logger.js';

const _llmService = new LLMService(new ApiKeyService(), new UsageTrackingService());

const POLL_INTERVAL_MS  = 15_000;
const MAX_POLL_ATTEMPTS = 80;   // 80 × 15 s = 20 min
const MAX_RETRY_ATTEMPTS = 3;   // for transient API errors

// ── Liveness ─────────────────────────────────────────────────────────────────

/**
 * Same numbers and same argument as exports and duplications: the heartbeat is what makes
 * staleness a sound liveness test, because this job's durable writes can legitimately be twenty
 * minutes apart while it polls a provider. Twenty missed beats before a row is declared dead.
 */
export const VIDEO_GEN_HEARTBEAT_MS = 15_000;
export const VIDEO_GEN_STALE_AFTER_MS = 20 * VIDEO_GEN_HEARTBEAT_MS;

/** The moment before which an in-flight generation row is no longer believed to be running. */
export function videoGenStaleBefore(now: Date = new Date()): Date {
  return new Date(now.getTime() - VIDEO_GEN_STALE_AFTER_MS);
}

/** Everything that is not `ready` or `failed`. Also the predicate of `idx_vgj_inflight`. */
export const VIDEO_GEN_IN_FLIGHT_STATUSES = [
  'queued', 'enhancing', 'submitting', 'generating', 'downloading', 'transcoding',
] as const;

/**
 * What a job killed mid-submit tells the user. It names the trade-off rather than hiding it: we
 * would rather ask for one more click than silently buy a second video.
 */
export const VIDEO_GEN_POISONED_SUBMIT_MESSAGE =
  'The generation was interrupted while it was being sent to the video provider, so we cannot tell '
  + 'whether it started. It was not sent again (that would be charged twice) — please generate again.';

/**
 * A per-process prefix on the fencing token, so `claimed_by` is legible to an operator staring at
 * a stuck row. The uniqueness that matters is the per-RUN suffix.
 */
const INSTANCE_TAG = `${process.pid}-${randomUUID().slice(0, 8)}`;

/** Raised when a write finds the lease has moved on. Caught at the top; never a failure. */
export class LostVideoGenerationClaim extends Error {
  constructor(readonly jobId: string) {
    super(`video generation ${jobId} was reclaimed by another run`);
    this.name = 'LostVideoGenerationClaim';
  }
}

export type VideoGenerateOutcome =
  | { job_id: string; status: 'ready'; section_id: string | null; video_file_id: string | null }
  | { job_id: string; status: 'failed'; error?: string }
  | { job_id: string; status: 'skipped'; reason: 'already_running' | 'superseded' };

export interface VideoGenerateOptions {
  /** Provider poll cadence. Injectable so tests do not wait real minutes; production uses 15 s. */
  pollIntervalMs?: number;
  /** Liveness cadence. Injectable for the same reason. */
  heartbeatMs?: number;
}

// ── The lease ────────────────────────────────────────────────────────────────

/**
 * Take exclusive ownership of a generation row for this run, or refuse to run.
 *
 * A conditional UPDATE, not a read-then-write: the row is taken only if it is in flight AND either
 * unclaimed or quiet for longer than the stale window. Zero rows updated means somebody else holds
 * it and this delivery must do nothing — the durable driver is at-least-once, and a second delivery
 * must not spend twenty minutes polling the same provider task.
 *
 * `attempts` is incremented HERE, atomically with the claim, because the poisoned-submit check
 * below has to distinguish a first attempt from a re-drive without a read-then-write of its own.
 */
async function claim(jobId: string, token: string, now: Date) {
  const [claimed] = await db.update(video_generation_jobs)
    .set({
      claimed_by: token,
      attempts: sql`${video_generation_jobs.attempts} + 1`,
      updated_at: now,
    })
    .where(and(
      eq(video_generation_jobs.id, jobId),
      inArray(video_generation_jobs.status, [...VIDEO_GEN_IN_FLIGHT_STATUSES]),
      or(
        isNull(video_generation_jobs.claimed_by),
        lt(video_generation_jobs.updated_at, videoGenStaleBefore(now)),
      ),
    ))
    .returning();
  return claimed ?? null;
}

/**
 * A write that must not resurrect a row this run no longer owns.
 *
 * Fenced on the RUN token rather than on a status set (which is what the export service could
 * afford): a generation can legitimately pass through the same status twice on a resume, so
 * "status is still in flight" would let a reclaimed run keep writing. Losing the fence is a lost
 * lease, which is not a failure — it means a healthier run took over — so it throws a sentinel the
 * top level turns into `skipped`.
 */
async function fencedSet(
  jobId: string,
  token: string,
  values: Partial<typeof video_generation_jobs.$inferInsert>,
): Promise<void> {
  const [row] = await db.update(video_generation_jobs)
    .set({ ...values, updated_at: new Date() })
    .where(and(eq(video_generation_jobs.id, jobId), eq(video_generation_jobs.claimed_by, token)))
    .returning({ id: video_generation_jobs.id });
  if (!row) throw new LostVideoGenerationClaim(jobId);
}

// ── Transient-error retry ────────────────────────────────────────────────────

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('etimedout') || msg.includes('econnreset') || msg.includes('enotfound') ||
    msg.includes('429')       || msg.includes('rate_limit')  || msg.includes('timeout')  ||
    msg.includes('overloaded')
  );
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === MAX_RETRY_ATTEMPTS - 1) throw err;
      const delayMs = 2_000 * Math.pow(4, attempt); // 2 s, 8 s, 32 s
      logger.warn({ attempt, delayMs, errMsg: (err as Error).message }, 'Transient error — retrying');
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// ── Core generation logic ────────────────────────────────────────────────────

export async function runVideoGenerate(
  job_id: string,
  opts: VideoGenerateOptions = {},
): Promise<VideoGenerateOutcome> {
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const heartbeatMs = opts.heartbeatMs ?? VIDEO_GEN_HEARTBEAT_MS;

  const existing = await db.query.video_generation_jobs.findFirst({
    where: eq(video_generation_jobs.id, job_id),
  });
  if (!existing) throw new Error(`video_generation_job ${job_id} not found`);
  if (existing.status === 'ready') {
    // Nullable rather than a placeholder: `section_id` is SET NULL when the user deletes the b-roll
    // this job made, and answering an empty string would invent a section that is gone.
    return {
      job_id,
      status: 'ready',
      section_id: existing.section_id,
      video_file_id: existing.video_file_id,
    };
  }
  if (existing.status === 'failed') return { job_id, status: 'failed', error: existing.error ?? undefined };

  const token = `${INSTANCE_TAG}:${randomUUID()}`;
  const job = await claim(job_id, token, new Date());
  if (!job) {
    logger.warn(
      { job_id, status: existing.status },
      'B-roll generation is already running elsewhere — not starting a second run',
    );
    return { job_id, status: 'skipped', reason: 'already_running' };
  }

  // The un-resumable window. A previous run held this row while it was `submitting` and did not
  // live to store a task id: the provider may or may not have accepted a (billed) generation, and
  // there is no handle to find out. Fail honestly rather than buy a second video.
  if (job.attempts > 1 && job.status === 'submitting' && !job.external_task_id) {
    logger.error({ job_id, attempts: job.attempts }, 'B-roll generation died mid-submit — not resubmitting');
    await fencedSet(job_id, token, {
      status: 'failed', error: VIDEO_GEN_POISONED_SUBMIT_MESSAGE, finished_at: new Date(),
    }).catch(() => undefined);
    return { job_id, status: 'failed', error: VIDEO_GEN_POISONED_SUBMIT_MESSAGE };
  }

  // Resolved BEFORE the heartbeat starts: a misconfigured storage adapter throws here, and a
  // heartbeat created first would outlive the throw with nothing left to clear it.
  const storage = getStorageAdapter();
  const svc = createVideoGenerationService(storage, _llmService);

  // Liveness on a TIMER, not only per stage: this job polls a provider for up to twenty minutes
  // between durable writes, and without a beat every one of those runs looks abandoned halfway
  // through. Unref'd — a pending beat must never hold the process open.
  const heartbeat = setInterval(() => {
    void db.update(video_generation_jobs)
      .set({ updated_at: new Date() })
      .where(and(eq(video_generation_jobs.id, job_id), eq(video_generation_jobs.claimed_by, token)))
      .catch((err: unknown) => logger.debug({ err, job_id }, 'b-roll: heartbeat failed'));
  }, heartbeatMs);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  try {
    // ── 1–2. Enhance + submit, both skipped when their output is already durable ─────────────
    let externalTaskId = job.external_task_id;

    if (!externalTaskId) {
      // A stored enhancement is reused: it was paid for, and re-running it would also change the
      // prompt under a job the user already saw.
      let prompt = job.enhanced_prompt ?? job.original_prompt;
      if (job.enhance_enabled && !job.enhanced_prompt) {
        await fencedSet(job_id, token, { status: 'enhancing' });
        prompt = await withRetry(() => svc.enhancePrompt(job.original_prompt, job.target_duration_sec));
        await fencedSet(job_id, token, { enhanced_prompt: prompt, status: 'submitting' });
      } else {
        await fencedSet(job_id, token, { status: 'submitting' });
      }

      externalTaskId = await withRetry(() => svc.submit(job.model as VideoModel, prompt, job.target_duration_sec));
      await fencedSet(job_id, token, { external_task_id: externalTaskId, status: 'generating' });
      logger.info({ job_id, model: job.model, externalTaskId }, 'B-roll generation submitted');

      // Cost is incurred at submit — put it in the shared ledger so b-roll spend is visible and
      // counts against the user's generation cap (database-103).
      const proj = await db.query.projects.findFirst({
        where: eq(projects.id, job.project_id),
        columns: { created_by: true },
      });
      await recordVideoUsage({
        userId: proj?.created_by ?? null,
        projectId: job.project_id,
        model: job.model,
        task: 'broll_video',
      });
    } else {
      logger.info({ job_id, model: job.model, externalTaskId }, 'B-roll generation resuming existing external task');
      await fencedSet(job_id, token, { status: 'generating' });
    }

    // ── 3–4. Poll + download, both skipped once the file is stored ──────────────────────────
    let videoFileId = job.video_file_id;

    if (!videoFileId) {
      let videoUrl: string | undefined;
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        const result = await svc.poll(job.model as VideoModel, externalTaskId);
        if (result.status === 'completed') { videoUrl = result.videoUrl; break; }
        if (result.status === 'failed') {
          const error = result.error ?? 'Provider reported failure';
          await fencedSet(job_id, token, { status: 'failed', error, finished_at: new Date() });
          return { job_id, status: 'failed', error };
        }
      }
      if (!videoUrl) {
        const error = 'Timed out waiting for video generation';
        await fencedSet(job_id, token, { status: 'failed', error, finished_at: new Date() });
        return { job_id, status: 'failed', error };
      }

      await fencedSet(job_id, token, { status: 'downloading' });
      const videoFile = await svc.downloadAndStore(videoUrl, job.project_id);
      videoFileId = videoFile.id;
      await fencedSet(job_id, token, { video_file_id: videoFileId, status: 'transcoding' });
    } else {
      logger.info({ job_id, videoFileId }, 'B-roll generation resuming with the already-downloaded file');
      await fencedSet(job_id, token, { status: 'transcoding' });
    }

    // ── 5. HLS transcode, skipped when the ladder is already published ──────────────────────
    const stored = await db.query.video_files.findFirst({ where: eq(video_files.id, videoFileId) });
    if (stored?.hls_status !== 'ready') {
      await runVideoTranscode(videoFileId);
    } else {
      logger.info({ job_id, videoFileId }, 'B-roll HLS ladder already published — not re-encoding');
    }

    // ── 6–7. The section and the job's terminal write, ATOMICALLY ───────────────────────────
    //
    // One transaction, for a reason the crash matrix names: if these are two writes, a death
    // between them leaves a section whose job never finished, and the retry that follows inserts
    // its twin. The unique index would refuse that twin — but only because the section carries the
    // job id, and only the transaction makes "the section exists" and "the job says so" the same
    // fact. The fenced UPDATE is INSIDE the transaction so a lost lease rolls the section back with
    // it: a run that has been superseded must publish nothing at all.
    const updatedVideo = await db.query.video_files.findFirst({ where: eq(video_files.id, videoFileId) });
    const endSec = updatedVideo?.duration_sec ?? job.target_duration_sec;
    const label = job.original_prompt.length > 100
      ? `${job.original_prompt.slice(0, 97)}…`
      : job.original_prompt;

    const sectionId = await db.transaction(async (tx) => {
      // THE JOB ROW IS THE SERIALISATION POINT, not a unique index on timeline_sections.
      //
      // Locking it first is what closes the window a bare read-then-insert leaves open: a second
      // delivery blocks here until the first commits, and then observes its result instead of
      // racing it. The transaction is deliberately short — it holds this row and nothing else.
      //
      // A unique key on the SECTION would be the wrong invariant anyway. The product lets a user
      // manually re-insert a previously generated asset, so `this asset appears once in the
      // timeline` is not true and must not be enforced. What must hold is narrower: ONE AUTOMATIC
      // FINALISATION PUBLISHES AT MOST ONE ROW. That is a property of this job, so it belongs on
      // this job's row. It also would not have helped the rows that already exist: every section
      // written before this change carries no provenance at all, so it could never have collided.
      const [locked] = await tx.select({
        id: video_generation_jobs.id,
        status: video_generation_jobs.status,
        claimed_by: video_generation_jobs.claimed_by,
        section_id: video_generation_jobs.section_id,
      })
        .from(video_generation_jobs)
        .where(eq(video_generation_jobs.id, job_id))
        .for('update');

      // Re-checked AFTER the wait, never before it: the row we blocked on may have been finished,
      // reclaimed, or deleted by whoever held the lock.
      if (!locked) throw new Error(`b-roll generation ${job_id} vanished before finalisation`);
      if (locked.claimed_by !== token) throw new LostVideoGenerationClaim(job_id);

      // A predecessor already published. Adopt its section rather than making a second one — the
      // user may have moved or trimmed it since, and overwriting would discard that.
      //
      // ADOPTION STILL HAS TO TERMINATE THE JOB. Returning here without the terminal UPDATE left
      // the row in-flight while this function reported {status:'ready'} in memory — so startup
      // recovery could reclaim it, forever. The two paths differ only in WHICH section they name;
      // both must end the row.
      if (locked.section_id) {
        const adopted = locked.section_id;
        const [stillOursAdopting] = await tx.update(video_generation_jobs)
          .set({ status: 'ready', finished_at: new Date(), updated_at: new Date() })
          .where(and(
            eq(video_generation_jobs.id, job_id),
            eq(video_generation_jobs.claimed_by, token),
            // Fenced on the section we actually observed under the lock: if anything moved it
            // between the SELECT and here, this run is not the one entitled to finish the row.
            eq(video_generation_jobs.section_id, adopted),
          ))
          .returning({ id: video_generation_jobs.id });
        if (!stillOursAdopting) throw new LostVideoGenerationClaim(job_id);
        return adopted;
      }

      // THE ANCHOR IS THE ONE CAPTURED AT ENQUEUE, copied across verbatim (D-01).
      //
      // Not re-derived here, and that is the point. This code runs up to twenty-five minutes after
      // the author chose the spot, on a timeline they may have re-cut since; asking "which segment
      // is second 47 in?" NOW would answer about a timeline the author never saw, which is the same
      // race the anchor exists to end, just moved later. `target_global_offset_sec` still rides
      // along as the legacy fallback, so a job enqueued before this column existed — or one for a
      // project that had no main video at the time — publishes exactly the row it used to.
      const anchored = job.target_anchor_video_file_id != null && job.target_anchor_offset_sec != null;
      const [inserted] = await tx.insert(timeline_sections).values({
        project_id: job.project_id,
        video_file_id: videoFileId,
        start_sec: 0,
        end_sec: endSec,
        type: 'broll',
        label,
        track: 'broll',
        global_offset_sec: job.target_global_offset_sec,
        anchor_video_file_id: job.target_anchor_video_file_id ?? null,
        anchor_offset_sec: job.target_anchor_offset_sec ?? null,
        placement_mode: anchored ? 'segment' : 'legacy_absolute',
      }).returning({ id: timeline_sections.id });

      // Fenced on BOTH the claim and section_id IS NULL. The second clause is not redundant with
      // the lock: it makes the guarantee a property the database enforces rather than one that
      // depends on this function having taken the lock. If it fails, the INSERT above rolls back
      // with it, so a run that lost its lease publishes nothing at all.
      const [stillOurs] = await tx.update(video_generation_jobs)
        .set({
          section_id: inserted.id,
          status: 'ready',
          finished_at: new Date(),
          updated_at: new Date(),
        })
        .where(and(
          eq(video_generation_jobs.id, job_id),
          eq(video_generation_jobs.claimed_by, token),
          isNull(video_generation_jobs.section_id),
        ))
        .returning({ id: video_generation_jobs.id });
      if (!stillOurs) throw new LostVideoGenerationClaim(job_id);

      return inserted.id;
    });

    logger.info({ job_id, sectionId, videoFileId }, 'B-roll generation complete');
    return { job_id, status: 'ready', section_id: sectionId, video_file_id: videoFileId };

  } catch (err) {
    if (err instanceof LostVideoGenerationClaim) {
      // Not a failure: a healthier run owns this row now. Writing anything here — including
      // `failed` — would corrupt the successor's record of its own work.
      logger.warn({ job_id }, 'B-roll generation lost its lease mid-run — leaving the row to its new owner');
      return { job_id, status: 'skipped', reason: 'superseded' };
    }
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ job_id, err }, 'B-roll generation job failed');
    // A lost lease while recording the failure is itself not worth reporting — and must never
    // replace the real error, which is about to be rethrown for the queue's retry.
    await fencedSet(job_id, token, { status: 'failed', error, finished_at: new Date() })
      .catch(() => undefined);
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

// ── Trigger.dev task wrapper ─────────────────────────────────────────────────

export const videoGenerateTask = task({
  id: 'video.generate',
  maxDuration: 1380,
  retry: { maxAttempts: 2, minTimeoutInMs: 5_000, factor: 4 },
  run: ({ job_id }: { job_id: string }) => runVideoGenerate(job_id),
});

// ── In-process execution (inline queue driver / no Trigger.dev) ─────────────

// Bounded like ffmpegLimit: each run polls an external API for up to 20 min and
// then downloads + HLS-transcodes, so an unbounded burst would fan out the whole
// pipeline. pg-boss workers have their own concurrency; this bound protects the
// inline path.
const MAX_INPROCESS = Math.max(1, Number(process.env.VIDEO_GEN_CONCURRENCY ?? '2'));
let inProcessActive = 0;
const inProcessQueue: Array<() => void> = [];

function acquireInProcessSlot(): Promise<void> {
  if (inProcessActive < MAX_INPROCESS) {
    inProcessActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => inProcessQueue.push(resolve));
}

function releaseInProcessSlot(): void {
  const next = inProcessQueue.shift();
  if (next) next(); // hand the slot directly to the next waiter
  else inProcessActive = Math.max(0, inProcessActive - 1);
}

/** Queue-handler entrypoint: run one generation under the process-wide bound. */
export async function runVideoGenerateLimited(job_id: string): Promise<unknown> {
  await acquireInProcessSlot();
  try {
    return await runVideoGenerate(job_id);
  } finally {
    releaseInProcessSlot();
  }
}

export function runVideoGenerateInProcess(job_id: string): void {
  setImmediate(() => {
    runVideoGenerateLimited(job_id).catch((err) => {
      logger.error({ job_id, err }, 'In-process B-roll generation failed');
    });
  });
}

// ── Startup recovery ─────────────────────────────────────────────────────────

export interface VideoGenerationRecovery {
  /** In-flight rows re-delivered immediately. */
  requeued: number;
  /** Rows whose lease had not expired yet, so the immediate delivery will be refused. */
  deferred: number;
  /** When the second delivery for those rows fires, or null if none was needed. */
  deferredMs: number | null;
}

/**
 * Re-drive b-roll jobs stranded by a restart.
 *
 * This used to decide, per row, whether resuming was safe — and got it wrong in both directions.
 * It wrote `failed` over any `enhancing`/`submitting` row without a task id, INCLUDING one another
 * process was actively working, which then carried on and overwrote the verdict; and it re-enqueued
 * everything else with no way for the runner to refuse, which is how one crash became two sections.
 * Both decisions now live where they can be made correctly: the CAS claim refuses a row somebody
 * holds, and the `attempts` check refuses to re-submit a paid generation. Recovery's whole job is
 * to make sure a delivery arrives.
 *
 * THE DEFERRED PASS. A process that dies ten seconds after claiming leaves a lease that still looks
 * live, and the immediate re-delivery is (correctly) refused — nothing can tell that heartbeat from
 * one still beating. Those rows become claimable when the lease expires, so exactly one more
 * delivery is scheduled for then. Unref'd, single-shot, and bounded by the rows this pass actually
 * saw: a pending re-drive must never hold the process open or turn into a poll.
 */
export async function recoverStuckVideoGenerations(
  now: Date = new Date(),
): Promise<VideoGenerationRecovery> {
  const stuck = await db.query.video_generation_jobs.findMany({
    where: inArray(video_generation_jobs.status, [...VIDEO_GEN_IN_FLIGHT_STATUSES]),
    columns: { id: true, status: true, claimed_by: true, updated_at: true },
  });
  if (stuck.length === 0) return { requeued: 0, deferred: 0, deferredMs: null };

  for (const job of stuck) enqueueJob('video_generate', { jobId: job.id });

  const staleBefore = videoGenStaleBefore(now);
  const heldElsewhere = stuck.filter(
    (j) => j.claimed_by !== null && j.updated_at.getTime() >= staleBefore.getTime(),
  );
  logger.warn(
    { total: stuck.length, deferred: heldElsewhere.length },
    'Re-drove stranded b-roll generations on startup',
  );
  if (heldElsewhere.length === 0) {
    return { requeued: stuck.length, deferred: 0, deferredMs: null };
  }

  // Wait for the LAST of those leases to expire, plus a second of slack for clock skew between
  // the row's `now()` and ours.
  const newestBeat = Math.max(...heldElsewhere.map((j) => j.updated_at.getTime()));
  const deferredMs = Math.max(0, newestBeat - staleBefore.getTime()) + 1_000;
  const timer = setTimeout(() => {
    for (const job of heldElsewhere) enqueueJob('video_generate', { jobId: job.id });
    logger.warn({ total: heldElsewhere.length }, 'Re-drove b-roll generations whose lease has now expired');
  }, deferredMs);
  if (typeof timer.unref === 'function') timer.unref();

  return { requeued: stuck.length, deferred: heldElsewhere.length, deferredMs };
}
