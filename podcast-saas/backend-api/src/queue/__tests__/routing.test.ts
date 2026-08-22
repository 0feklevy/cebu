import { describe, it, expect, vi, afterEach } from 'vitest';
import { JOB_NAMES, type JobName, type JobPayloads } from '../types.js';

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

/**
 * EVERY job kind, and the type annotation means it.
 *
 * This map claimed to be exhaustive over `JobName` and covered four of twelve — the compiler would
 * have said so on the first build, but `tsconfig.json` excludes test files and nothing ran
 * `tsconfig.test.json` (job-queue-014). So the routing test below only ever exercised four kinds
 * while reading as though it covered all of them, which is worse than covering four honestly.
 */
const PAYLOADS: { [N in JobName]: JobPayloads[N] } = {
  transcode: { videoFileId: 'v' },
  captions: { videoId: 'v' },
  crop: { videoFileId: 'v' },
  metadata: { projectId: 'p', videoFileId: 'v' },
  podcast_script: { scriptId: 's' },
  podcast_render: { renderId: 'r' },
  podcast_clips: { mixId: 'm' },
  podcast_mix_export: { renderId: 'r' },
  video_generate: { jobId: 'j' },
  project_duplicate: { duplicationId: 'd' },
  project_export: { exportId: 'e' },
  dub: { dubId: 'd' },
};

afterEach(() => {
  delete process.env.QUEUE_DRIVER;
  vi.resetModules();
  vi.clearAllMocks();
});

/**
 * The exhaustiveness guarantee, asserted at RUNTIME as well as in the type.
 *
 * `{ [N in JobName]: ... }` is the stronger statement, but it is only checked by
 * `tsconfig.test.json` — a config that, until job-queue-014, no script and no CI job ran, which is
 * how this very map came to cover four of twelve names while reading as exhaustive. Until the test
 * typecheck is a gate, this assertion is the one that actually runs on every branch.
 *
 * It compares against JOB_NAMES rather than a written-out list, so adding a job kind fails HERE,
 * in the place that will tell you which one is missing.
 */
describe('the payload map covers every job kind', () => {
  it('has an entry for each name in JOB_NAMES, and no extras', () => {
    expect(Object.keys(PAYLOADS).sort()).toEqual([...JOB_NAMES].sort());
  });
});

describe('enqueueJob routing', () => {
  /**
   * `project_export` is the one kind `enqueueJob` refuses outright — it must go through
   * `enqueueProjectExport`, which is awaitable and answers honestly when the durable send fails,
   * because an export that silently never runs leaves a progress bar for a job that does not exist.
   *
   * Completing PAYLOADS to all twelve kinds is what surfaced this: the four-entry map never reached
   * it, so the refusal had no coverage here at all.
   */
  const ROUTABLE = (Object.keys(PAYLOADS) as JobName[]).filter((n) => n !== 'project_export');

  it('default (driver unset) routes every routable job inline, never to pg-boss', async () => {
    const { enqueueJob, inlineEnqueue, pgBossSend } = await loadIndex(undefined);
    for (const name of ROUTABLE) {
      enqueueJob(name, PAYLOADS[name]);
    }
    expect(pgBossSend).not.toHaveBeenCalled();
    expect(inlineEnqueue).toHaveBeenCalledTimes(ROUTABLE.length);
  });

  it('refuses project_export through enqueueJob, whatever the driver', async () => {
    for (const driver of [undefined, 'inline', 'pgboss']) {
      const { enqueueJob } = await loadIndex(driver);
      expect(() => enqueueJob('project_export', PAYLOADS.project_export), String(driver))
        .toThrow(/must be enqueued durably/);
    }
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
