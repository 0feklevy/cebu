/**
 * Tests for the in-process video-generation queue (runVideoGenerateInProcess).
 *
 * The fallback caps concurrency at VIDEO_GEN_CONCURRENCY (default 2) so a burst of
 * enqueues doesn't fan out the whole download+HLS pipeline at once. We drive the
 * concurrency by making db.query.video_generation_jobs.findFirst — the first thing
 * runVideoGenerate awaits — return a per-call deferred promise we resolve on demand.
 * The number of findFirst calls therefore equals the number of jobs that have
 * actually started, which lets us assert the cap and slot handoff.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Deferred = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

const mocks = vi.hoisted(() => {
  // Default concurrency (2) is read at module load — make sure the env is unset.
  delete process.env.VIDEO_GEN_CONCURRENCY;

  const deferreds: Deferred[] = [];
  const findFirst = vi.fn(() => {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
    deferreds.push({ resolve, reject });
    return promise;
  });
  return { deferreds, findFirst };
});

// The only DB call reached on the controllable path — everything after the early
// return (status ready/failed) or the "not found" throw is never touched.
vi.mock('../../db/index.js', () => ({
  db: {
    query: {
      video_generation_jobs: { findFirst: mocks.findFirst },
      video_files: { findFirst: vi.fn() },
    },
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: 's1' }]) })) })),
  },
}));

vi.mock('../../db/schema.js', () => ({
  video_generation_jobs: { id: 'id' },
  timeline_sections: {},
  video_files: { id: 'id' },
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => ({ type: 'eq' })) }));

// Keep the heavy imports cheap so loading the module is instant.
vi.mock('@trigger.dev/sdk/v3', () => ({ task: (o: unknown) => o }));
vi.mock('../../services/storage/getStorageAdapter.js', () => ({ getStorageAdapter: vi.fn() }));
vi.mock('../../services/video-generation/VideoGenerationService.js', () => ({
  createVideoGenerationService: vi.fn(),
}));
vi.mock('../../services/llm/LLMService.js', () => ({ LLMService: class {} }));
vi.mock('../../services/secrets/ApiKeyService.js', () => ({ ApiKeyService: class {} }));
vi.mock('../../services/usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));
vi.mock('../../services/video/runVideoTranscode.js', () => ({ runVideoTranscode: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runVideoGenerateInProcess } from '../video.generate.js';

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('runVideoGenerateInProcess concurrency', () => {
  beforeEach(() => {
    mocks.deferreds.length = 0;
    mocks.findFirst.mockClear();
  });

  it('runs at most 2 concurrently (default) and starts the next as each resolves', async () => {
    let finished = 0;
    const active = () => mocks.deferreds.length - finished;

    // Enqueue 4 jobs. Only 2 may start; the other 2 wait for a slot.
    runVideoGenerateInProcess('j0');
    runVideoGenerateInProcess('j1');
    runVideoGenerateInProcess('j2');
    runVideoGenerateInProcess('j3');

    await flush();
    expect(mocks.deferreds.length).toBe(2); // exactly 2 started
    expect(active()).toBe(2);

    // Resolve j0 as an already-terminal job → runVideoGenerate returns early and
    // releases its slot, letting the first queued job start.
    mocks.deferreds[0].resolve({ id: 'j0', status: 'ready' });
    finished++;
    await flush();
    expect(mocks.deferreds.length).toBe(3); // next job started
    expect(active()).toBe(2);               // still capped at 2

    mocks.deferreds[1].resolve({ id: 'j1', status: 'ready' });
    finished++;
    await flush();
    expect(mocks.deferreds.length).toBe(4);
    expect(active()).toBe(2);

    // Drain the rest so module state returns to idle for the next test.
    mocks.deferreds[2].resolve({ id: 'j2', status: 'ready' });
    mocks.deferreds[3].resolve({ id: 'j3', status: 'ready' });
    await flush();
  });

  it('releases the slot even when a running job rejects', async () => {
    runVideoGenerateInProcess('r0');
    runVideoGenerateInProcess('r1');
    runVideoGenerateInProcess('r2'); // queued

    await flush();
    expect(mocks.deferreds.length).toBe(2);

    // findFirst resolves to undefined → runVideoGenerate throws "not found" and
    // rejects. The slot must still be released so the queued job runs.
    mocks.deferreds[0].resolve(undefined);
    await flush();
    expect(mocks.deferreds.length).toBe(3); // queued job started despite the reject

    // Drain.
    mocks.deferreds[1].resolve({ id: 'r1', status: 'ready' });
    mocks.deferreds[2].resolve({ id: 'r2', status: 'ready' });
    await flush();
  });
});
