import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the pg-boss singleton so the driver is exercised without a real database.
vi.mock('../pgBoss.js', () => ({
  getBoss: vi.fn(),
  PGBOSS_JOB_NAMES: ['crop'] as const,
}));

import { getBoss } from '../pgBoss.js';
import {
  CPU_BOUND_JOBS, QUEUE_CONCURRENCY, pgBossSend, registerWorkers, resolveWorkerQueues,
} from '../pgBossDriver.js';
import type { JobHandlers } from '../types.js';

const mockGetBoss = vi.mocked(getBoss);

function handlersWith(crop: JobHandlers['crop']): JobHandlers {
  const noop = vi.fn(async () => {});
  return { transcode: noop, captions: noop, crop, metadata: noop };
}

describe('pgBossSend', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the job with a per-video singletonKey and does NOT run the inline fallback', async () => {
    const send = vi.fn().mockResolvedValue('job-id-1');
    mockGetBoss.mockResolvedValue({ send } as never);
    const inline = vi.fn();

    pgBossSend('crop', { videoFileId: 'v1' }, inline);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    expect(send).toHaveBeenCalledWith('crop', { videoFileId: 'v1' }, { singletonKey: 'v1' });
    expect(inline).not.toHaveBeenCalled();
  });

  it('runs the inline fallback for a PROVIDER-BOUND job when the send rejects', async () => {
    // The fallback's whole point: a job that waits on somebody else's HTTP response is cheap to
    // run here, and losing it would be worse than borrowing the API's event loop for it.
    const send = vi.fn().mockRejectedValue(new Error('db down'));
    mockGetBoss.mockResolvedValue({ send } as never);
    const inline = vi.fn();

    pgBossSend('captions', { videoFileId: 'v2' } as never, inline);
    await vi.waitFor(() => expect(inline).toHaveBeenCalledTimes(1));
  });

  it('runs the inline fallback for a provider-bound job when pg-boss itself fails to start', async () => {
    mockGetBoss.mockRejectedValue(new Error('cannot connect'));
    const inline = vi.fn();

    pgBossSend('captions', { videoFileId: 'v3' } as never, inline);
    await vi.waitFor(() => expect(inline).toHaveBeenCalledTimes(1));
  });

  /**
   * job-queue-013 — and this pair used to assert the OPPOSITE, with `crop`.
   *
   * "The job is never lost" was the right instinct applied to the wrong kind. A send only fails
   * when the queue database is unhealthy — the moment the API is most needed — and answering that
   * by starting ffmpeg plus frame analysis inside the request-serving process trades a recoverable
   * delay for an unavailable product. Crop's row keeps its non-terminal status and is re-claimable,
   * so refusing costs a delay, not the work.
   */
  it('REFUSES to run a CPU-bound job inline when the send rejects', async () => {
    const send = vi.fn().mockRejectedValue(new Error('db down'));
    mockGetBoss.mockResolvedValue({ send } as never);
    const inline = vi.fn();

    pgBossSend('crop', { videoFileId: 'v2' }, inline);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(inline, 'an encode must never run in the API container').not.toHaveBeenCalled();
  });

  it('REFUSES to run a CPU-bound job inline when pg-boss fails to start', async () => {
    mockGetBoss.mockRejectedValue(new Error('cannot connect'));
    const inline = vi.fn();

    pgBossSend('crop', { videoFileId: 'v3' }, inline);
    await new Promise((r) => setTimeout(r, 10));
    expect(inline).not.toHaveBeenCalled();
  });

  it('never throws synchronously to the producer', () => {
    mockGetBoss.mockRejectedValue(new Error('boom'));
    expect(() => pgBossSend('crop', { videoFileId: 'v4' }, vi.fn())).not.toThrow();
  });

  /**
   * `video_generate` gets a singleton key too — and it is worth being precise about what that key
   * is and is not for.
   *
   * IT IS NOT THE FIX for duplicate b-roll sections. pg-boss collapses jobs that are still WAITING
   * to start; it has nothing to say about a RETRY of a job that already ran, which is the delivery
   * that appended the second section. That guarantee lives in the database
   * (`uniq_timeline_sections_generation_job`, migration 062) and in the runner's CAS lease.
   *
   * WHAT IT IS FOR is cost. Startup recovery re-drives every in-flight row on every boot, and a
   * restart loop would otherwise pile one queued job per boot onto the same generation. Each of
   * those wakes a worker that polls a provider before the lease refuses it. Collapsing them is
   * cheap and strictly better than not — but it is an optimisation on top of a guarantee, which is
   * exactly the order these two tests assert.
   */
  it('gives video_generate a per-job singletonKey so a restart loop cannot pile up deliveries', async () => {
    const send = vi.fn().mockResolvedValue('job-id-2');
    mockGetBoss.mockResolvedValue({ send } as never);

    pgBossSend('video_generate', { jobId: 'gen-1' }, vi.fn());
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    expect(send).toHaveBeenCalledWith('video_generate', { jobId: 'gen-1' }, { singletonKey: 'gen-1' });
  });

  it('a deduped send is NOT an error — the work is already queued exactly once', async () => {
    // pg-boss answers null when the key already has a job waiting. The producer must treat that as
    // success: the inline fallback exists for a LOST job, and this job is not lost.
    const send = vi.fn().mockResolvedValue(null);
    mockGetBoss.mockResolvedValue({ send } as never);
    const inline = vi.fn();

    pgBossSend('video_generate', { jobId: 'gen-2' }, inline);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    expect(inline).not.toHaveBeenCalled();
  });

  it('a job kind with no natural key still sends, unkeyed', async () => {
    // A singleton key is only correct where two sends genuinely mean one piece of work. Inventing
    // one for `metadata` would silently drop a legitimate second request.
    const send = vi.fn().mockResolvedValue('job-id-3');
    mockGetBoss.mockResolvedValue({ send } as never);

    pgBossSend('metadata', { projectId: 'p1', videoFileId: 'v1' }, vi.fn());
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    expect(send).toHaveBeenCalledWith('metadata', { projectId: 'p1', videoFileId: 'v1' },
      { singletonKey: undefined });
  });
});

describe('registerWorkers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers a worker per queue and dispatches each job in the batch to its handler', async () => {
    let captured: ((jobs: Array<{ data: unknown }>) => Promise<unknown>) | undefined;
    const work = vi.fn(async (_name: string, _opts: unknown, handler: typeof captured) => {
      captured = handler;
      return 'worker-id';
    });
    const crop = vi.fn(async () => {});

    await registerWorkers({ work } as never, ['crop'], handlersWith(crop));

    expect(work).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledWith('crop', expect.objectContaining({ localConcurrency: expect.any(Number) }), expect.any(Function));

    // Simulate pg-boss delivering a batch of two jobs.
    await captured!([{ data: { videoFileId: 'a' } }, { data: { videoFileId: 'b' } }]);
    expect(crop).toHaveBeenNthCalledWith(1, { videoFileId: 'a' });
    expect(crop).toHaveBeenNthCalledWith(2, { videoFileId: 'b' });
  });

  it('lets a handler rejection propagate so pg-boss fails+retries the job', async () => {
    let captured: ((jobs: Array<{ data: unknown }>) => Promise<unknown>) | undefined;
    const work = vi.fn(async (_n: string, _o: unknown, handler: typeof captured) => {
      captured = handler;
      return 'worker-id';
    });
    const crop = vi.fn(async () => {
      throw new Error('crop failed');
    });

    await registerWorkers({ work } as never, ['crop'], handlersWith(crop));
    await expect(captured!([{ data: { videoFileId: 'x' } }])).rejects.toThrow('crop failed');
  });
});

/**
 * Concurrency is per job KIND, not one number for the whole worker. An export with a simulation
 * section runs a capture container allowed `--cpus 2`; on the 2-vCPU worker host that is the entire
 * machine, so two concurrent exports contend rather than parallelise and both move closer to their
 * wall-clock kill. Crop is CPU-bound too — ffmpeg plus frame analysis — so it is serialised as
 * well; only the genuinely I/O-bound queues keep their 2.
 */
describe('the CPU-bound queues run serially', () => {
  const noopHandlers = { crop: async () => {}, project_export: async () => {} } as never;

  it('registers both project_export and crop with localConcurrency 1', async () => {
    const work = vi.fn(async () => 'worker-id');
    delete process.env.QUEUE_EXPORT_CONCURRENCY;
    delete process.env.QUEUE_CROP_CONCURRENCY;

    await registerWorkers({ work } as never, ['crop', 'project_export'], noopHandlers);

    const byName = Object.fromEntries(work.mock.calls.map((c) => [c[0] as string, c[1] as { localConcurrency: number }]));
    expect(byName.project_export.localConcurrency).toBe(1);
    expect(byName.crop.localConcurrency).toBe(1);
  });

  it('an operator with real cores can raise it', async () => {
    const work = vi.fn(async () => 'worker-id');
    process.env.QUEUE_EXPORT_CONCURRENCY = '3';
    try {
      await registerWorkers({ work } as never, ['project_export'], noopHandlers);
      expect((work.mock.calls[0][1] as { localConcurrency: number }).localConcurrency).toBe(3);
    } finally {
      delete process.env.QUEUE_EXPORT_CONCURRENCY;
    }
  });
});

/**
 * WORKER_QUEUES. Without an allowlist every process that starts a worker consumes every queue, so
 * the API — which has no Docker socket and no business rendering video — would pick up an export.
 * Splitting the pool is not a deployment detail; it is what keeps Docker access out of the
 * request-serving process.
 */
/**
 * job-queue-013 — the inline fallback must not run an encode in the API container.
 *
 * `pgBossSend` falls back to the inline handler when the durable send fails. That is right for a
 * job that waits on somebody else's HTTP response and badly wrong for an encode: the send only
 * fails when the queue database is unhealthy, which is exactly when the API is most needed — and
 * the fallback would answer by starting a full HLS ladder for a source up to 2 GB, in-process, on
 * a 2-vCPU host.
 */
describe('the inline fallback, by job kind', () => {
  it('runs every CPU-bound kind SERIALLY, which is the same judgement the fallback rule reads', () => {
    // Deliberately one-directional. A CPU-bound job may not quietly acquire concurrency > 1 on a
    // 2-vCPU host — that is the thing the concurrency comments warn about — so raising one has to
    // fail here and be argued for. The reverse is NOT asserted: a queue can be serial for reasons
    // that have nothing to do with the CPU, and forcing it into this set would be a false coupling.
    for (const name of CPU_BOUND_JOBS) {
      expect(QUEUE_CONCURRENCY[name], `${name} is CPU-bound and must stay serial`).toBe(1);
    }
  });

  it('covers the kinds that actually run ffmpeg or a TTS stitch', () => {
    // Stated by name, because this is the list a reader needs to be able to check against reality
    // rather than against another list.
    for (const name of ['transcode', 'crop', 'dub', 'project_export', 'podcast_render'] as const) {
      expect(CPU_BOUND_JOBS.has(name), name).toBe(true);
    }
  });

  it('leaves the provider-bound kinds free to fall back inline', () => {
    // These wait on somebody else's HTTP response. Running one in the API process while the queue
    // is down is exactly the cheap insurance the fallback was written for.
    for (const name of ['captions', 'metadata', 'podcast_script', 'video_generate'] as const) {
      expect(CPU_BOUND_JOBS.has(name), name).toBe(false);
    }
  });
});

describe('resolveWorkerQueues', () => {
  const ALL = ['crop', 'video_generate', 'project_export'] as const;

  it('unset means every queue — right for a single-process dev box', () => {
    expect(resolveWorkerQueues(ALL, {} as NodeJS.ProcessEnv)).toEqual([...ALL]);
  });

  it('a general worker takes crop and video_generate, and NOT project_export', () => {
    expect(resolveWorkerQueues(ALL, { WORKER_QUEUES: 'crop,video_generate' } as NodeJS.ProcessEnv))
      .toEqual(['crop', 'video_generate']);
  });

  it('a dedicated export orchestrator takes project_export and nothing else', () => {
    expect(resolveWorkerQueues(ALL, { WORKER_QUEUES: 'project_export' } as NodeJS.ProcessEnv))
      .toEqual(['project_export']);
  });

  it('tolerates whitespace and empty entries', () => {
    expect(resolveWorkerQueues(ALL, { WORKER_QUEUES: ' crop , , video_generate ' } as NodeJS.ProcessEnv))
      .toEqual(['crop', 'video_generate']);
  });

  /**
   * THE EXPAND/CONTRACT RULE FOR QUEUE NAMES (job-queue-011).
   *
   * `WORKER_QUEUES` comes from the checked-out `docker-compose.yml`; the code comes from whatever
   * image tag `APP_VERSION` names. A rollback re-points the tag without moving the tree, so an old
   * image is handed the new file's queue list — and this function used to throw, which under
   * `restart: unless-stopped` crash-loops the only container running background work, during an
   * incident. Skipping the name it does not know is what makes a rollback survivable.
   */
  it('skips a queue this build does not have, so an old image survives a newer compose file', () => {
    expect(resolveWorkerQueues(ALL, { WORKER_QUEUES: 'crop,video_generate,dub' } as NodeJS.ProcessEnv))
      .toEqual(['crop', 'video_generate']);
  });

  it('still refuses a list where NOTHING is known — that is a typo, not version skew', () => {
    // A worker consuming no queues does no work while looking perfectly healthy, and no rollback
    // explains it. This is the case the old throw was really protecting against.
    expect(() => resolveWorkerQueues(ALL, { WORKER_QUEUES: 'projectexport' } as NodeJS.ProcessEnv))
      .toThrow(/no queue this build has: projectexport/);
  });

  it('a partial typo is dropped rather than fatal, and the surviving queues still run', () => {
    // The tradeoff, stated plainly: this used to throw. The typo is now visible as a startup ERROR
    // log naming the unknown queue, and the worker keeps doing the work it CAN do.
    expect(resolveWorkerQueues(ALL, { WORKER_QUEUES: 'crop,projectexport' } as NodeJS.ProcessEnv))
      .toEqual(['crop']);
  });
});

describe('project_export can never run inline', () => {
  it('enqueueJob refuses it outright, whatever the driver says', async () => {
    // The inline fallback exists so "a job is never lost". For this job, losing it is the better
    // outcome: the user gets a truthful 503, instead of an API that stops answering while it
    // renders someone's video in the request-serving process.
    const { enqueueJob } = await import('../index.js');
    expect(() => enqueueJob('project_export', { exportId: 'e-1' }))
      .toThrow(/must be enqueued durably/);
  });
});
