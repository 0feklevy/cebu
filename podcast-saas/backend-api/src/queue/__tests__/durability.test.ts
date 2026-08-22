import { describe, it, expect, vi, afterEach } from 'vitest';
import { JOB_NAMES } from '../types.js';
import { PGBOSS_JOB_NAMES, QUEUE_OPTIONS } from '../pgBoss.js';
import { registerWorkers } from '../pgBossDriver.js';
import type { JobName, JobPayloads } from '../types.js';

/**
 * job-queue-005 — only 3 of 11 job types were durable.
 *
 * The other 8 ran on the inline driver: `setImmediate` inside the API process, with no row in any
 * table. A deploy, an OOM kill or a crash took every one of them with it, and nothing anywhere
 * recorded that the work had been lost. Every one of the 8 either SPENDS MONEY on a third-party
 * API or runs for minutes:
 *
 *   captions            Groq whisper-large-v3 per video                       billable
 *   metadata            OpenAI chat completion, recorded in token_usage       billable
 *   podcast_script      the writers' room; cost_cents per pass, 50 min stale  billable + long
 *   podcast_render      ElevenLabs TTS per turn + ffmpeg stitch               billable + long
 *   podcast_clips       ElevenLabs TTS per turn + per-clip ffmpeg             billable + long
 *   podcast_mix_export  ffmpeg loudnorm two-pass + encode                     long
 *   transcode           full HLS ladder for an upload up to 2 GB              long
 *   project_duplicate   copies every storage object in a project              long
 *
 * The billable ones are the sharp edge: the money is spent BEFORE the process dies, so losing the
 * job loses the result and keeps the charge.
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
  audio_edition: { projectId: 'p', language: null },
  corpus_ingest: { corpusId: 'c' },
};

/** Loads the REAL producer against the REAL PGBOSS_JOB_NAMES; only the two drivers are stubbed. */
async function loadProducer() {
  vi.resetModules();
  process.env.QUEUE_DRIVER = 'pgboss';
  const inlineEnqueue = vi.fn();
  const pgBossSend = vi.fn();
  vi.doMock('../registry.js', () => ({ handlers: {} }));
  vi.doMock('../inlineDriver.js', () => ({ createInlineQueue: () => ({ enqueue: inlineEnqueue }) }));
  vi.doMock('../pgBossDriver.js', () => ({ pgBossSend }));
  const mod = await import('../index.js');
  return { enqueueJob: mod.enqueueJob, inlineEnqueue, pgBossSend };
}

afterEach(() => {
  delete process.env.QUEUE_DRIVER;
  vi.resetModules();
  vi.clearAllMocks();
});

describe('every job type survives the process that accepted it', () => {
  it('no job kind is left on the inline driver', () => {
    const inlineOnly = JOB_NAMES.filter((n) => !(PGBOSS_JOB_NAMES as readonly string[]).includes(n));
    expect(inlineOnly, `these die with the API process: ${inlineOnly.join(', ')}`).toEqual([]);
  });

  it('the jobs that spend real money on a third-party API are durable', () => {
    // Named individually rather than derived, so deleting one from PGBOSS_JOB_NAMES fails here
    // with the provider it bills against rather than as an off-by-one in a set difference.
    for (const [name, provider] of [
      ['captions', 'Groq'],
      ['metadata', 'OpenAI'],
      ['podcast_script', 'the writers-room LLM'],
      ['podcast_render', 'ElevenLabs'],
      ['podcast_clips', 'ElevenLabs'],
    ] as const) {
      expect(
        PGBOSS_JOB_NAMES as readonly string[],
        `${name} spends money on ${provider} and would be lost with the process`,
      ).toContain(name);
    }
  });

  it('every durable queue sets an explicit expiry — never pg-boss 15-minute default', () => {
    // The default would expire an honest long job and retry it from the start, redoing the spend.
    for (const name of PGBOSS_JOB_NAMES) {
      const expiry = QUEUE_OPTIONS[name].expireInSeconds;
      expect(expiry, `${name} has no expireInSeconds`).toBeGreaterThan(0);
      expect(QUEUE_OPTIONS[name].policy, `${name} has no explicit policy`).toBeDefined();
    }
  });

  it('the long ones get an expiry above the 15-minute default', () => {
    // Each of these has a stale-claim window of 20-50 minutes in its own handler; an expiry under
    // that would let pg-boss retry a run that is still going.
    for (const name of [
      'transcode', 'podcast_script', 'podcast_render', 'podcast_clips',
      'podcast_mix_export', 'project_duplicate', 'crop', 'video_generate', 'project_export',
    ] as const) {
      expect(QUEUE_OPTIONS[name].expireInSeconds, name).toBeGreaterThan(15 * 60);
    }
  });
});

describe('the producer actually routes them durably', () => {
  it('with QUEUE_DRIVER=pgboss, every job goes to pg-boss and none stays inline', async () => {
    const { enqueueJob, inlineEnqueue, pgBossSend } = await loadProducer();
    for (const name of JOB_NAMES) {
      if (name === 'project_export') continue; // NEVER_INLINE — enqueueProjectExport only
      enqueueJob(name, PAYLOADS[name]);
    }
    expect(pgBossSend).toHaveBeenCalledTimes(JOB_NAMES.length - 1);
    expect(inlineEnqueue).not.toHaveBeenCalled();
  });

  it('the inline driver is still the default when no durable queue is configured', async () => {
    // Local dev stays one process. The fix is about production, not about removing inline.
    vi.resetModules();
    delete process.env.QUEUE_DRIVER;
    const inlineEnqueue = vi.fn();
    const pgBossSend = vi.fn();
    vi.doMock('../registry.js', () => ({ handlers: {} }));
    vi.doMock('../inlineDriver.js', () => ({ createInlineQueue: () => ({ enqueue: inlineEnqueue }) }));
    vi.doMock('../pgBossDriver.js', () => ({ pgBossSend }));
    const { enqueueJob } = await import('../index.js');
    enqueueJob('captions', PAYLOADS.captions);
    expect(pgBossSend).not.toHaveBeenCalled();
    expect(inlineEnqueue).toHaveBeenCalledTimes(1);
  });
});

describe('concurrency on the 2-vCPU worker', () => {
  it('the ffmpeg/TTS-heavy queues run one job at a time', async () => {
    for (const k of ['QUEUE_EXPORT_CONCURRENCY', 'QUEUE_CROP_CONCURRENCY']) delete process.env[k];
    const work = vi.fn(async () => 'worker-id');
    const noop = async () => {};
    const handlers = Object.fromEntries(JOB_NAMES.map((n) => [n, noop])) as never;

    await registerWorkers({ work } as never, JOB_NAMES, handlers);

    const byName = Object.fromEntries(
      work.mock.calls.map((c) => [c[0] as string, (c[1] as { localConcurrency: number }).localConcurrency]),
    );
    for (const heavy of ['transcode', 'podcast_render', 'podcast_clips', 'podcast_mix_export', 'project_export', 'crop']) {
      expect(byName[heavy], `${heavy} must not run two at a time`).toBe(1);
    }
    // Crop joined that list: it is ffmpeg + frame analysis, i.e. CPU-bound, and two of them on a
    // 2-vCPU host contend with each other. The decision record required 1 and the default said 2.
    // This is still not a blanket serialisation — the genuinely I/O-bound queues keep their 2.
    for (const io of ['captions', 'metadata', 'podcast_script', 'video_generate', 'project_duplicate']) {
      expect(byName[io], `${io} is I/O-bound and should still interleave`).toBe(2);
    }
  });
});
