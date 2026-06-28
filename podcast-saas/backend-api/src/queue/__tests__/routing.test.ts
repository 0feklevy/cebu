import { describe, it, expect, vi, afterEach } from 'vitest';
import type { JobName, JobPayloads } from '../types.js';

/**
 * Verifies the Phase B driver-routing matrix in `index.ts`:
 *  - QUEUE_DRIVER=inline  → every job runs inline.
 *  - QUEUE_DRIVER=pgboss  → only `crop` goes to pg-boss; the rest stay inline.
 *
 * The whole module graph (registry → services → db, pg-boss) is mocked so the test is
 * hermetic and never touches a database. QUEUE_DRIVER is read at module-eval time, so each
 * case re-imports `index.ts` fresh via resetModules.
 */
async function loadIndex(driver: string | undefined) {
  vi.resetModules();
  if (driver === undefined) delete process.env.QUEUE_DRIVER;
  else process.env.QUEUE_DRIVER = driver;

  const inlineEnqueue = vi.fn();
  const pgBossSend = vi.fn();

  vi.doMock('../registry.js', () => ({
    handlers: { transcode: vi.fn(), captions: vi.fn(), crop: vi.fn(), metadata: vi.fn() },
  }));
  vi.doMock('../inlineDriver.js', () => ({
    createInlineQueue: () => ({ enqueue: inlineEnqueue }),
  }));
  vi.doMock('../pgBoss.js', () => ({ PGBOSS_JOB_NAMES: ['crop'] as const }));
  vi.doMock('../pgBossDriver.js', () => ({ pgBossSend }));

  const mod = await import('../index.js');
  return { enqueueJob: mod.enqueueJob, inlineEnqueue, pgBossSend };
}

const PAYLOADS: { [N in JobName]: JobPayloads[N] } = {
  transcode: { videoFileId: 'v' },
  captions: { videoId: 'v' },
  crop: { videoFileId: 'v' },
  metadata: { projectId: 'p', videoFileId: 'v' },
};

afterEach(() => {
  delete process.env.QUEUE_DRIVER;
  vi.resetModules();
  vi.clearAllMocks();
});

describe('enqueueJob routing', () => {
  it('default (driver unset) routes every job inline, never to pg-boss', async () => {
    const { enqueueJob, inlineEnqueue, pgBossSend } = await loadIndex(undefined);
    for (const name of Object.keys(PAYLOADS) as JobName[]) {
      enqueueJob(name, PAYLOADS[name]);
    }
    expect(pgBossSend).not.toHaveBeenCalled();
    expect(inlineEnqueue).toHaveBeenCalledTimes(4);
  });

  it('QUEUE_DRIVER=inline routes crop inline (not pg-boss)', async () => {
    const { enqueueJob, inlineEnqueue, pgBossSend } = await loadIndex('inline');
    enqueueJob('crop', PAYLOADS.crop);
    expect(pgBossSend).not.toHaveBeenCalled();
    expect(inlineEnqueue).toHaveBeenCalledWith('crop', PAYLOADS.crop);
  });

  it('QUEUE_DRIVER=pgboss routes ONLY crop to pg-boss; others stay inline', async () => {
    const { enqueueJob, inlineEnqueue, pgBossSend } = await loadIndex('pgboss');

    enqueueJob('crop', PAYLOADS.crop);
    expect(pgBossSend).toHaveBeenCalledTimes(1);
    expect(pgBossSend).toHaveBeenCalledWith('crop', PAYLOADS.crop, expect.any(Function));
    expect(inlineEnqueue).not.toHaveBeenCalled();

    enqueueJob('transcode', PAYLOADS.transcode);
    enqueueJob('captions', PAYLOADS.captions);
    enqueueJob('metadata', PAYLOADS.metadata);
    expect(pgBossSend).toHaveBeenCalledTimes(1); // still only the crop send
    expect(inlineEnqueue).toHaveBeenCalledTimes(3);
  });

  it('pg-boss send is given an inline fallback closure that targets the same job', async () => {
    const { enqueueJob, inlineEnqueue, pgBossSend } = await loadIndex('pgboss');
    enqueueJob('crop', { videoFileId: 'fallback-me' });

    const fallback = pgBossSend.mock.calls[0][2] as () => void;
    expect(inlineEnqueue).not.toHaveBeenCalled(); // not until the fallback is invoked
    fallback();
    expect(inlineEnqueue).toHaveBeenCalledWith('crop', { videoFileId: 'fallback-me' });
  });
});
