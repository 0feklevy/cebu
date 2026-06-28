import { describe, it, expect, vi } from 'vitest';
import { createInlineQueue } from '../inlineDriver.js';
import type { JobHandlers } from '../types.js';

/** Flush the microtask + setImmediate queue so scheduled work has run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function stubHandlers(overrides: Partial<JobHandlers> = {}): JobHandlers {
  const noop = vi.fn(async () => {});
  return {
    transcode: overrides.transcode ?? noop,
    captions: overrides.captions ?? noop,
    crop: overrides.crop ?? noop,
    metadata: overrides.metadata ?? noop,
  };
}

describe('inline queue driver', () => {
  it('enqueue does not run the handler synchronously (fire-and-forget)', async () => {
    const crop = vi.fn(async () => {});
    const queue = createInlineQueue(stubHandlers({ crop }));

    queue.enqueue('crop', { videoFileId: 'v1' });
    expect(crop).not.toHaveBeenCalled(); // deferred to setImmediate

    await flush();
    expect(crop).toHaveBeenCalledTimes(1);
    expect(crop).toHaveBeenCalledWith({ videoFileId: 'v1' });
  });

  it('routes each job name to its handler with the given payload', async () => {
    const transcode = vi.fn(async () => {});
    const metadata = vi.fn(async () => {});
    const queue = createInlineQueue(stubHandlers({ transcode, metadata }));

    queue.enqueue('transcode', { videoFileId: 'v2' });
    queue.enqueue('metadata', { projectId: 'p1', videoFileId: 'v2', force: true });
    await flush();

    expect(transcode).toHaveBeenCalledWith({ videoFileId: 'v2' });
    expect(metadata).toHaveBeenCalledWith({ projectId: 'p1', videoFileId: 'v2', force: true });
  });

  it('swallows a rejected handler — enqueue never throws to the producer', async () => {
    const captions = vi.fn(async () => {
      throw new Error('boom');
    });
    const queue = createInlineQueue(stubHandlers({ captions }));

    expect(() => queue.enqueue('captions', { videoId: 'v3' })).not.toThrow();
    await flush();
    await flush(); // allow the rejection to be handled

    expect(captions).toHaveBeenCalledTimes(1);
    // No unhandled rejection: the driver caught and logged it.
  });
});
