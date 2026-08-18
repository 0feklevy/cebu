import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the pg-boss singleton so the driver is exercised without a real database.
vi.mock('../pgBoss.js', () => ({
  getBoss: vi.fn(),
  PGBOSS_JOB_NAMES: ['crop'] as const,
}));

import { getBoss } from '../pgBoss.js';
import { pgBossSend, registerWorkers, resolveWorkerQueues } from '../pgBossDriver.js';
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

  it('runs the inline fallback when the send rejects (job never lost)', async () => {
    const send = vi.fn().mockRejectedValue(new Error('db down'));
    mockGetBoss.mockResolvedValue({ send } as never);
    const inline = vi.fn();

    pgBossSend('crop', { videoFileId: 'v2' }, inline);
    await vi.waitFor(() => expect(inline).toHaveBeenCalledTimes(1));
  });

  it('runs the inline fallback when pg-boss itself fails to start', async () => {
    mockGetBoss.mockRejectedValue(new Error('cannot connect'));
    const inline = vi.fn();

    pgBossSend('crop', { videoFileId: 'v3' }, inline);
    await vi.waitFor(() => expect(inline).toHaveBeenCalledTimes(1));
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
 * wall-clock kill. Crops are I/O-bound and keep their 2.
 */
describe('project_export runs serially, crops do not', () => {
  const noopHandlers = { crop: async () => {}, project_export: async () => {} } as never;

  it('registers project_export with localConcurrency 1 and crop with 2', async () => {
    const work = vi.fn(async () => 'worker-id');
    delete process.env.QUEUE_EXPORT_CONCURRENCY;
    delete process.env.QUEUE_CROP_CONCURRENCY;

    await registerWorkers({ work } as never, ['crop', 'project_export'], noopHandlers);

    const byName = Object.fromEntries(work.mock.calls.map((c) => [c[0] as string, c[1] as { localConcurrency: number }]));
    expect(byName.project_export.localConcurrency).toBe(1);
    expect(byName.crop.localConcurrency).toBe(2);
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

  it('an unknown name is a STARTUP ERROR, not a silent omission', () => {
    // A typo would otherwise mean a queue nobody consumes and jobs that sit forever — the failure
    // shows up as "my export never started", days later, with nothing in the logs.
    expect(() => resolveWorkerQueues(ALL, { WORKER_QUEUES: 'crop,projectexport' } as NodeJS.ProcessEnv))
      .toThrow(/unknown queue\(s\): projectexport/);
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
