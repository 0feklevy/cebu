import { task } from '@trigger.dev/sdk/v3';
import { eq, inArray } from 'drizzle-orm';
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

async function setStatus(id: string, status: string, extra?: Record<string, unknown>) {
  await db.update(video_generation_jobs).set({ status, ...extra }).where(eq(video_generation_jobs.id, id));
}

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

export async function runVideoGenerate(job_id: string) {
  const job = await db.query.video_generation_jobs.findFirst({
    where: eq(video_generation_jobs.id, job_id),
  });
  if (!job) throw new Error(`video_generation_job ${job_id} not found`);
  if (job.status === 'ready' || job.status === 'failed') return { job_id, status: job.status };

  const storage = getStorageAdapter();
  const svc = createVideoGenerationService(storage, _llmService);

  try {
    // Resume path: a job interrupted after submit already has an external task —
    // re-submitting would generate (and bill) a second video. Skip straight to
    // polling the existing task instead.
    let externalTaskId = job.external_task_id;

    if (!externalTaskId) {
      // 1. Optionally enhance prompt
      let prompt = job.original_prompt;
      if (job.enhance_enabled) {
        await setStatus(job_id, 'enhancing');
        prompt = await withRetry(() => svc.enhancePrompt(job.original_prompt, job.target_duration_sec));
        await db.update(video_generation_jobs)
          .set({ enhanced_prompt: prompt, status: 'submitting' })
          .where(eq(video_generation_jobs.id, job_id));
      } else {
        await setStatus(job_id, 'submitting');
      }

      // 2. Submit to provider (retry on transient errors)
      externalTaskId = await withRetry(() => svc.submit(job.model as VideoModel, prompt, job.target_duration_sec));
      await db.update(video_generation_jobs)
        .set({ external_task_id: externalTaskId, status: 'generating' })
        .where(eq(video_generation_jobs.id, job_id));
      logger.info({ job_id, model: job.model, externalTaskId }, 'B-roll generation submitted');

      // Cost is incurred at submit — put it in the shared ledger so b-roll spend
      // is visible and counts against the user's generation cap (database-103).
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
      await setStatus(job_id, 'generating');
    }

    // 3. Poll until complete
    let videoUrl: string | undefined;
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const result = await svc.poll(job.model as VideoModel, externalTaskId);
      if (result.status === 'completed') { videoUrl = result.videoUrl; break; }
      if (result.status === 'failed') {
        await setStatus(job_id, 'failed', { error: result.error ?? 'Provider reported failure', finished_at: new Date() });
        return { job_id, status: 'failed', error: result.error };
      }
    }
    if (!videoUrl) {
      await setStatus(job_id, 'failed', { error: 'Timed out waiting for video generation', finished_at: new Date() });
      return { job_id, status: 'failed' };
    }

    // 4. Download and store
    await setStatus(job_id, 'downloading');
    const videoFile = await svc.downloadAndStore(videoUrl, job.project_id);
    await db.update(video_generation_jobs)
      .set({ video_file_id: videoFile.id, status: 'transcoding' })
      .where(eq(video_generation_jobs.id, job_id));

    // 5. HLS transcode
    await runVideoTranscode(videoFile.id);

    // 6. Create B-roll timeline section
    const label = job.original_prompt.length > 100
      ? `${job.original_prompt.slice(0, 97)}…`
      : job.original_prompt;

    const updatedVideo = await db.query.video_files.findFirst({
      where: eq(video_files.id, videoFile.id),
    });
    const endSec = updatedVideo?.duration_sec ?? job.target_duration_sec;

    const [section] = await db.insert(timeline_sections).values({
      project_id: job.project_id,
      video_file_id: videoFile.id,
      start_sec: 0,
      end_sec: endSec,
      type: 'broll',
      label,
      track: 'broll',
      global_offset_sec: job.target_global_offset_sec,
    }).returning();

    // 7. Finalize job
    await db.update(video_generation_jobs)
      .set({ section_id: section.id, status: 'ready', finished_at: new Date() })
      .where(eq(video_generation_jobs.id, job_id));

    logger.info({ job_id, sectionId: section.id, videoFileId: videoFile.id }, 'B-roll generation complete');
    return { job_id, status: 'ready', section_id: section.id, video_file_id: videoFile.id };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ job_id, err }, 'B-roll generation job failed');
    await setStatus(job_id, 'failed', { error, finished_at: new Date() });
    throw err;
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

/**
 * Re-drive b-roll jobs stranded by a restart. Jobs with an external task id are
 * safely re-enqueued (runVideoGenerate resumes polling instead of re-submitting);
 * 'queued' jobs never reached the provider so they re-enqueue too. Anything else
 * (enhancing/submitting without a recorded task id) may have submitted without
 * persisting the id — resubmitting would double-bill, so those are failed.
 */
export async function recoverStuckVideoGenerations(): Promise<void> {
  const nonTerminal = ['queued', 'enhancing', 'submitting', 'generating', 'downloading', 'transcoding'];
  const stuck = await db.query.video_generation_jobs.findMany({
    where: inArray(video_generation_jobs.status, nonTerminal),
    columns: { id: true, status: true, external_task_id: true },
  });
  if (stuck.length === 0) return;

  let requeued = 0;
  for (const job of stuck) {
    if (job.external_task_id || job.status === 'queued') {
      enqueueJob('video_generate', { jobId: job.id });
      requeued++;
    } else {
      await db.update(video_generation_jobs)
        .set({ status: 'failed', error: 'Interrupted by process restart', finished_at: new Date() })
        .where(eq(video_generation_jobs.id, job.id));
    }
  }
  logger.warn({ total: stuck.length, requeued }, 'Recovered stuck b-roll generations on startup');
}
