import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the pg-boss singleton so the driver is exercised without a real database.
vi.mock('../pgBoss.js', () => ({
  getBoss: vi.fn(),
  PGBOSS_JOB_NAMES: ['crop'] as const,
}));

import { getBoss } from '../pgBoss.js';
import { pgBossSend, registerWorkers } from '../pgBossDriver.js';
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
