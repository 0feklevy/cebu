/**
 * `runVideoGenerate` against a REAL Postgres engine: the crash matrix.
 *
 * THE BUG THIS SUITE EXISTS FOR
 * `video_generate` is a durable queue with retries and is re-driven on every boot. Its body ended
 * with an unkeyed INSERT of a b-roll timeline section, so a retry, a recovery delivery, or a second
 * worker appended a SECOND overlay at the same global offset — and the player picks an overlay with
 * a first-match `.find()` over one concatenated array, so the user gets a clip playing where they
 * never put one, intermittently.
 *
 * WHAT "CRASH" MEANS HERE
 * A process death does not run the job's catch block, so the test cannot simply let an injected
 * error propagate: the runner would mark the row `failed` and no re-run would be possible. Each
 * crash therefore (1) drives the REAL code path to the chosen point, (2) records the row's status
 * at that instant from inside the collaborator, and (3) rewinds ONLY the failure bookkeeping the
 * catch performed — status back to what it was, `error`/`finished_at` cleared — and stops the
 * heartbeat by backdating `updated_at`. Everything else the run durably wrote (external task id,
 * video file, sections, the claim itself) is left EXACTLY as it was. That is precisely the state a
 * `kill -9` leaves behind, and it is the state the re-run must converge from.
 *
 * The named mutation tests:
 *   • "converges to exactly one section" (×6) fails if the section insert loses its
 *     job-row lock (SELECT ... FOR UPDATE) or the `section_id IS NULL` fence;
 *   • "does not re-submit …" fails if the `attempts`-based poison check is dropped — that mutation
 *     is a SECOND CHARGE from the paid provider, not just a duplicate row;
 *   • "a second delivery does nothing" fails if the CAS claim is weakened to a read-then-write;
 *   • "a reclaimed run can no longer write" fails if any post-claim write loses its `claimed_by`
 *     fence.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../../db/schema.js';

const h = vi.hoisted(() => ({
  dbRef: { current: null as unknown as Record<string, unknown> },
  enqueued: [] as Array<{ name: string; payload: unknown }>,
}));

vi.mock('../../db/index.js', () => ({
  db: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      const target = h.dbRef.current;
      const v = target[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }),
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@trigger.dev/sdk/v3', () => ({ task: (o: unknown) => o }));
vi.mock('../../services/storage/getStorageAdapter.js', () => ({ getStorageAdapter: () => ({}) }));
vi.mock('../../services/llm/LLMService.js', () => ({ LLMService: class {} }));
vi.mock('../../services/secrets/ApiKeyService.js', () => ({ ApiKeyService: class {} }));
vi.mock('../../services/usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));
vi.mock('../../services/llm/systemAi.js', () => ({ recordVideoUsage: vi.fn(async () => undefined) }));
vi.mock('../../queue/index.js', () => ({
  enqueueJob: vi.fn((name: string, payload: unknown) => { h.enqueued.push({ name, payload }); }),
}));

const svc = vi.hoisted(() => ({
  calls: { enhance: 0, submit: 0, poll: 0, download: 0, transcode: 0 },
  /** Which stage kills the process, and the status the row held at that instant. */
  // 'transcode' dies AFTER publishing the ladder; 'transcode-start' dies before touching it, which
  // is what leaves a re-run with real transcoding still to do.
  crashAt: null as null | 'enhance' | 'submit' | 'poll' | 'download' | 'transcode' | 'transcode-start',
  crashedStatus: null as string | null,
  /** The job the current test is driving — what `crash()` snapshots the durable status of. */
  currentJobId: null as string | null,
  /** When set, the transcode hands the lease to this owner just before the run finalises. */
  stealClaimDuringTranscode: null as string | null,
  /** Poll answers, consumed in order; the tail repeats. */
  pollScript: [] as Array<'completed' | 'generating' | 'failed'>,
}));

vi.mock('../../services/video-generation/VideoGenerationService.js', () => ({
  createVideoGenerationService: () => fakeService,
}));
vi.mock('../../services/video/runVideoTranscode.js', () => ({
  runVideoTranscode: async (videoFileId: string) => {
    svc.calls.transcode++;
    if (svc.crashAt === 'transcode-start') await crash();
    // The real transcode overwrites duration_sec with the ffprobe value and flips hls_status.
    await pg.query(
      `UPDATE video_files SET hls_status='ready', duration_sec=7.5, hls_master_key='hls/x/master.m3u8'
        WHERE id=$1`, [videoFileId]);
    if (svc.crashAt === 'transcode') await crash();
    if (svc.stealClaimDuringTranscode) {
      await pg.query(`UPDATE video_generation_jobs SET claimed_by=$2 WHERE id=$1`,
        [svc.currentJobId, svc.stealClaimDuringTranscode]);
    }
  },
}));

import {
  VIDEO_GEN_POISONED_SUBMIT_MESSAGE,
  recoverStuckVideoGenerations,
  runVideoGenerate,
  videoGenStaleBefore,
} from '../video.generate.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

let pg: PGlite;
let projectId: string;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}
async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await rows<T>(sql, params);
  if (!r[0]) throw new Error(`expected a row from: ${sql}`);
  return r[0];
}

/** Kill the process: record the durable status, then throw past every stage. */
class SimulatedCrash extends Error {}
async function crash(): Promise<never> {
  const row = await one<{ status: string }>(
    `SELECT status FROM video_generation_jobs WHERE id=$1`, [svc.currentJobId]);
  svc.crashedStatus = row.status;
  throw new SimulatedCrash('__CRASH__');
}

const fakeService = {
  async enhancePrompt(prompt: string): Promise<string> {
    svc.calls.enhance++;
    if (svc.crashAt === 'enhance') await crash();
    return `${prompt}, cinematic`;
  },
  async submit(): Promise<string> {
    svc.calls.submit++;
    if (svc.crashAt === 'submit') await crash();
    return `task-${svc.calls.submit}`;
  },
  async poll(): Promise<{ status: string; videoUrl?: string; error?: string }> {
    svc.calls.poll++;
    if (svc.crashAt === 'poll') await crash();
    const step = svc.pollScript[Math.min(svc.calls.poll - 1, svc.pollScript.length - 1)] ?? 'completed';
    if (step === 'completed') return { status: 'completed', videoUrl: 'https://cdn.test/out.mp4' };
    if (step === 'failed') return { status: 'failed', error: 'provider said no' };
    return { status: 'generating' };
  },
  async downloadAndStore(_url: string, project: string): Promise<{ id: string }> {
    svc.calls.download++;
    if (svc.crashAt === 'download') await crash();
    const row = await one<{ id: string }>(
      `INSERT INTO video_files (project_id, filename, file_size, storage_key, status, hls_status, is_broll)
       VALUES ($1,$2,1024,$3,'ready','pending',true) RETURNING id`,
      [project, `broll-${svc.calls.download}.mp4`, `videos/${project}/broll-${svc.calls.download}.mp4`]);
    return row;
  },
};

// ── Fixture ───────────────────────────────────────────────────────────────────────────────────

const FAST = { pollIntervalMs: 1, heartbeatMs: 10_000 };

async function newJob(opts: { enhance?: boolean; offset?: number } = {}): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO video_generation_jobs (project_id, model, original_prompt, enhance_enabled,
                                        target_duration_sec, target_global_offset_sec)
     VALUES ($1,'kling','a cat on a roof',$2,5,$3) RETURNING id`,
    [projectId, opts.enhance ?? false, opts.offset ?? 12]);
  svc.currentJobId = r.id;
  return r.id;
}

interface JobView {
  status: string; error: string | null; section_id: string | null; video_file_id: string | null;
  external_task_id: string | null; claimed_by: string | null; attempts: number;
  finished_at: string | null;
}
const jobRow = (id: string): Promise<JobView> => one<JobView>(
  `SELECT status, error, section_id, video_file_id, external_task_id, claimed_by, attempts,
          finished_at
     FROM video_generation_jobs WHERE id=$1`, [id]);

/**
 * Every section this generation produced. The whole suite is about this being length 1.
 *
 * Reached THROUGH the job row, because that is where the provenance lives: finalisation writes
 * video_generation_jobs.section_id under a row lock. An earlier draft carried a
 * timeline_sections.generation_job_id column; it was dropped, so a join is the only honest way to
 * ask this question now.
 */
async function sectionsFor(jobId: string): Promise<Array<{ id: string; global_offset_sec: number }>> {
  return rows(`SELECT s.id, s.global_offset_sec
                 FROM timeline_sections s
                 JOIN video_generation_jobs j ON j.section_id = s.id
                WHERE j.id=$1 ORDER BY s.id`, [jobId]);
}
async function brollSections(): Promise<Array<{ id: string }>> {
  return rows(`SELECT id FROM timeline_sections WHERE project_id=$1 AND track='broll' ORDER BY id`,
    [projectId]);
}

/**
 * Undo ONLY what a real crash would not have done — the catch block's failure bookkeeping — and
 * stop the heartbeat by backdating it. The claim is left in place on purpose: a dead process does
 * not release its lease, and the re-run has to be able to take a lease that still looks held.
 */
async function rewindCrash(jobId: string): Promise<void> {
  if (svc.crashedStatus === null) throw new Error('rewindCrash called but nothing crashed');
  await pg.query(
    `UPDATE video_generation_jobs
        SET status=$2, error=NULL, finished_at=NULL, updated_at=now() - interval '1 hour'
      WHERE id=$1`, [jobId, svc.crashedStatus]);
  svc.crashedStatus = null;
  svc.crashAt = null;
}

/** Drive the real runner until the injected crash, asserting it really did die there. */
async function runUntilCrash(jobId: string, at: NonNullable<typeof svc.crashAt>): Promise<void> {
  svc.crashAt = at;
  await expect(runVideoGenerate(jobId, FAST)).rejects.toBeInstanceOf(SimulatedCrash);
  await rewindCrash(jobId);
}

// Booted ONCE. Replaying 62 migrations into a fresh WASM Postgres costs ~25 s, and this file has
// nineteen tests: per-test boots put the suite past ten minutes and put each beforeEach hook within
// reach of the 60 s hook timeout under parallel load. Isolation comes from truncating instead —
// every table these tests touch hangs off `orgs`, so one CASCADE empties all of them.
beforeAll(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  h.dbRef.current = drizzle(pg, { schema }) as unknown as Record<string, unknown>;
});
afterAll(async () => { await pg.close(); });

beforeEach(async () => {
  await pg.exec('TRUNCATE orgs, users CASCADE');
  h.enqueued.length = 0;
  svc.calls = { enhance: 0, submit: 0, poll: 0, download: 0, transcode: 0 };
  svc.crashAt = null;
  svc.crashedStatus = null;
  svc.currentJobId = null;
  svc.stealClaimDuringTranscode = null;
  svc.pollScript = ['completed'];

  const org = await one<{ id: string }>(`INSERT INTO orgs (name) VALUES ('O') RETURNING id`);
  const user = await one<{ id: string }>(
    `INSERT INTO users (firebase_uid, email) VALUES ('uid-vg','e@test') RETURNING id`);
  const project = await one<{ id: string }>(
    `INSERT INTO projects (org_id, created_by, title) VALUES ($1,$2,'P') RETURNING id`,
    [org.id, user.id]);
  projectId = project.id;
});

// ── The happy path, first ─────────────────────────────────────────────────────────────────────

describe('runVideoGenerate — one clean run', () => {
  it('produces exactly one section, anchored where the request asked', async () => {
    const jobId = await newJob({ offset: 12 });
    const out = await runVideoGenerate(jobId, FAST);

    const sections = await sectionsFor(jobId);
    expect(sections).toHaveLength(1);
    expect(sections[0].global_offset_sec).toBe(12);

    const job = await jobRow(jobId);
    expect(job.status).toBe('ready');
    expect(job.section_id).toBe(sections[0].id);
    expect(out).toMatchObject({ status: 'ready', section_id: sections[0].id });
    // end_sec comes from the transcode's ffprobe duration, not the requested target.
    const [sec] = await rows<{ end_sec: number }>(
      `SELECT end_sec FROM timeline_sections WHERE id=$1`, [sections[0].id]);
    expect(sec.end_sec).toBe(7.5);
  });

  it('a redelivery of a finished job is a no-op, not a second section', async () => {
    const jobId = await newJob();
    await runVideoGenerate(jobId, FAST);
    await runVideoGenerate(jobId, FAST);
    await runVideoGenerate(jobId, FAST);

    expect(await sectionsFor(jobId)).toHaveLength(1);
    expect(await brollSections()).toHaveLength(1);
    expect(svc.calls.submit).toBe(1);
    expect(svc.calls.download).toBe(1);
  });
});

// ── The crash matrix ──────────────────────────────────────────────────────────────────────────

describe('the crash matrix — every stage converges to exactly one section', () => {
  it('crash after PROVIDER SUBMISSION (before the id was stored): converges, and does not re-submit', async () => {
    // The one un-resumable step. A generation was paid for and its handle is gone; the only
    // choices are "resubmit and bill twice" or "fail honestly". The invariant the rest of this
    // suite protects still holds — it converges, to ZERO sections and one terminal row, and never
    // to two of either.
    const jobId = await newJob();
    await runUntilCrash(jobId, 'submit');
    expect(svc.calls.submit).toBe(1);

    const out = await runVideoGenerate(jobId, FAST);

    expect(svc.calls.submit).toBe(1);                 // NOT charged a second time
    expect(await sectionsFor(jobId)).toHaveLength(0);
    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toBe(VIDEO_GEN_POISONED_SUBMIT_MESSAGE);
    expect(out).toMatchObject({ status: 'failed' });
  });

  it('crash after EXTERNAL-ID STORAGE: converges to exactly one section, on the original task', async () => {
    const jobId = await newJob();
    svc.pollScript = ['generating', 'completed'];
    await runUntilCrash(jobId, 'poll');
    expect((await jobRow(jobId)).external_task_id).toBe('task-1');

    await runVideoGenerate(jobId, FAST);

    expect(svc.calls.submit).toBe(1);                 // resumed the existing provider task
    expect(await sectionsFor(jobId)).toHaveLength(1);
    expect(await brollSections()).toHaveLength(1);
    expect((await jobRow(jobId)).status).toBe('ready');
  });

  it('crash after DOWNLOAD: converges to exactly one section and does not re-download', async () => {
    const jobId = await newJob();
    svc.crashAt = 'transcode';
    await expect(runVideoGenerate(jobId, FAST)).rejects.toBeInstanceOf(SimulatedCrash);
    await rewindCrash(jobId);
    const afterCrash = await jobRow(jobId);
    expect(afterCrash.video_file_id).not.toBeNull();

    await runVideoGenerate(jobId, FAST);

    expect(svc.calls.download).toBe(1);               // the stored file was reused
    expect(await sectionsFor(jobId)).toHaveLength(1);
    expect(await brollSections()).toHaveLength(1);
    // …and exactly one b-roll video file was ever created, not an orphan per attempt.
    const files = await rows(`SELECT id FROM video_files WHERE project_id=$1 AND is_broll=true`,
      [projectId]);
    expect(files).toHaveLength(1);
    expect((await jobRow(jobId)).status).toBe('ready');
  });

  it('crash after TRANSCODE (before the section existed): converges, and does not transcode twice', async () => {
    const jobId = await newJob();
    // The transcode mock finishes its durable work and only then dies — the exact window between
    // "the HLS ladder is published" and "the section exists".
    svc.crashAt = 'transcode';
    await expect(runVideoGenerate(jobId, FAST)).rejects.toBeInstanceOf(SimulatedCrash);
    expect(svc.calls.transcode).toBe(1);
    await rewindCrash(jobId);

    await runVideoGenerate(jobId, FAST);

    expect(svc.calls.transcode).toBe(1);              // already ready — not re-encoded
    expect(await sectionsFor(jobId)).toHaveLength(1);
    expect(await brollSections()).toHaveLength(1);
  });

  it('a LINKED PREDECESSOR section is adopted AND the job row is terminated', async () => {
    // The state a pre-062 run could leave, and the state any non-atomic finalisation would leave.
    // The re-run must ADOPT the orphan rather than insert its twin.
    const jobId = await newJob();
    svc.crashAt = 'transcode';
    await expect(runVideoGenerate(jobId, FAST)).rejects.toBeInstanceOf(SimulatedCrash);
    await rewindCrash(jobId);
    const videoFileId = (await jobRow(jobId)).video_file_id!;
    // A previous attempt's section, attached the way finalisation attaches one: the row itself
    // carries no provenance, so the link is video_generation_jobs.section_id. The re-run must ADOPT
    // this row under the job-row lock, never create a second one and never overwrite it — the user
    // may already have moved or trimmed it.
    const orphan = await one<{ id: string }>(
      `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, track,
                                      global_offset_sec)
       VALUES ($1,$2,0,7.5,'broll','broll',12) RETURNING id`,
      [projectId, videoFileId]);
    await rows(`UPDATE video_generation_jobs SET section_id=$1 WHERE id=$2`, [orphan.id, jobId]);

    await runVideoGenerate(jobId, FAST);

    const sections = await sectionsFor(jobId);
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe(orphan.id);           // adopted, not replaced
    expect(await brollSections()).toHaveLength(1);

    // LINKAGE IS NOT ENOUGH, and asserting only linkage is what let the bug through the first time.
    // The adoption branch used to return from inside the transaction, before the terminal UPDATE:
    // the function reported ready in memory while the ROW stayed in-flight, so startup recovery
    // could reclaim it forever. Assert the row actually ended.
    const finished = await jobRow(jobId);
    expect(finished.section_id).toBe(orphan.id);
    expect(finished.status).toBe('ready');
    expect(finished.finished_at).not.toBeNull();

    // …and that adopting did no vendor work: no re-submit, no re-download, no re-transcode.
    const callsAfterAdopt = { ...svc.calls };
    await runVideoGenerate(jobId, FAST);
    expect(svc.calls).toEqual(callsAfterAdopt);
    expect(await brollSections()).toHaveLength(1);
  });

  it('crash after COMPLETION: the redelivery is a no-op', async () => {
    const jobId = await newJob();
    await runVideoGenerate(jobId, FAST);
    const sectionId = (await sectionsFor(jobId))[0].id;

    // The process died between the commit and the ack, so the queue delivers it again.
    const out = await runVideoGenerate(jobId, FAST);

    expect(await sectionsFor(jobId)).toHaveLength(1);
    expect((await sectionsFor(jobId))[0].id).toBe(sectionId);
    expect(out).toMatchObject({ status: 'ready' });
    expect(svc.calls.submit).toBe(1);
  });

  it('finalisation is ATOMIC: a claim lost mid-finalise leaves NO section behind', async () => {
    // The insert and the job's terminal write are ONE transaction. If the fenced write finds the
    // lease gone, the section has to roll back with it — otherwise the loser has already published
    // an overlay for a run it no longer owns, and the winner then publishes its own beside it.
    const jobId = await newJob();
    svc.crashAt = 'transcode-start';
    await expect(runVideoGenerate(jobId, FAST)).rejects.toBeInstanceOf(SimulatedCrash);
    await rewindCrash(jobId);

    // The lease is handed to somebody else during the last stage before finalisation, so the steal
    // lands AFTER this run's own claim — which is the only ordering that tests anything.
    svc.stealClaimDuringTranscode = 'someone-else';
    try {
      const out = await runVideoGenerate(jobId, FAST);
      expect(out).toMatchObject({ status: 'skipped', reason: 'superseded' });
    } finally {
      svc.stealClaimDuringTranscode = null;
    }

    expect(await sectionsFor(jobId)).toHaveLength(0);
    expect(await brollSections()).toHaveLength(0);
    // …and the row is left to its new owner, not dragged to a terminal state by the loser.
    const job = await jobRow(jobId);
    expect(job.claimed_by).toBe('someone-else');
    expect(job.status).not.toBe('ready');
    expect(job.status).not.toBe('failed');
  });
});

// ── The lease ─────────────────────────────────────────────────────────────────────────────────

describe('the lease — a second worker cannot run a job the first still holds', () => {
  it('a second delivery does nothing while the first run is live', async () => {
    const jobId = await newJob();
    // A live run: claimed a moment ago, heartbeat fresh.
    await pg.query(
      `UPDATE video_generation_jobs SET status='generating', external_task_id='task-live',
              claimed_by='worker-1', attempts=1, updated_at=now() WHERE id=$1`, [jobId]);

    const out = await runVideoGenerate(jobId, FAST);

    expect(out).toMatchObject({ status: 'skipped', reason: 'already_running' });
    expect(svc.calls.poll).toBe(0);
    expect(await sectionsFor(jobId)).toHaveLength(0);
    // The live run's lease is untouched — a refused delivery must not disturb the holder.
    expect((await jobRow(jobId)).claimed_by).toBe('worker-1');
  });

  it('a crashed run IS reclaimable once its heartbeat goes stale', async () => {
    const jobId = await newJob();
    await pg.query(
      `UPDATE video_generation_jobs SET status='generating', external_task_id='task-dead',
              claimed_by='worker-dead', attempts=1, updated_at=now() - interval '1 hour' WHERE id=$1`,
      [jobId]);

    await runVideoGenerate(jobId, FAST);

    const job = await jobRow(jobId);
    expect(job.status).toBe('ready');
    expect(job.claimed_by).not.toBe('worker-dead');
    expect(job.attempts).toBe(2);
    expect(await sectionsFor(jobId)).toHaveLength(1);
  });

  it('two simultaneous deliveries produce exactly one section', async () => {
    const jobId = await newJob();
    const [a, b] = await Promise.all([
      runVideoGenerate(jobId, FAST),
      runVideoGenerate(jobId, FAST),
    ]);

    expect(await sectionsFor(jobId)).toHaveLength(1);
    expect(await brollSections()).toHaveLength(1);
    expect(svc.calls.submit).toBe(1);
    const outcomes = [a, b].map((o) => o.status).sort();
    expect(outcomes).toEqual(['ready', 'skipped']);
  });

  it('a reclaimed run can no longer write — the fence, not just the claim', async () => {
    const jobId = await newJob();
    svc.pollScript = ['generating', 'generating', 'completed'];
    // Steal the row while the first run is between polls.
    let stolen = false;
    const originalPoll = fakeService.poll;
    fakeService.poll = async function stealingPoll() {
      const r = await originalPoll.call(fakeService);
      if (!stolen) {
        stolen = true;
        await pg.query(`UPDATE video_generation_jobs SET claimed_by='thief' WHERE id=$1`, [jobId]);
      }
      return r;
    };
    try {
      const out = await runVideoGenerate(jobId, FAST);
      expect(out).toMatchObject({ status: 'skipped', reason: 'superseded' });
    } finally {
      fakeService.poll = originalPoll;
    }

    // The superseded run wrote nothing terminal and left no section.
    const job = await jobRow(jobId);
    expect(job.claimed_by).toBe('thief');
    expect(job.status).not.toBe('ready');
    expect(job.status).not.toBe('failed');
    expect(await sectionsFor(jobId)).toHaveLength(0);
  });

  it('a live run beats a heartbeat, so it never looks stale to anyone else', async () => {
    const jobId = await newJob();
    svc.pollScript = ['generating', 'generating', 'generating', 'completed'];
    // Backdate the row well past the stale threshold, then run with a fast heartbeat: the beat has
    // to drag `updated_at` forward or the row stays reclaimable while it is plainly working.
    await pg.query(`UPDATE video_generation_jobs SET updated_at=now() - interval '1 hour' WHERE id=$1`,
      [jobId]);

    await runVideoGenerate(jobId, { pollIntervalMs: 20, heartbeatMs: 5 });

    const [row] = await rows<{ updated_at: Date }>(
      `SELECT updated_at FROM video_generation_jobs WHERE id=$1`, [jobId]);
    expect(new Date(row.updated_at).getTime()).toBeGreaterThan(videoGenStaleBefore().getTime());
  });
});

// ── Provider failure still terminates cleanly ─────────────────────────────────────────────────

describe('terminal outcomes', () => {
  it('a provider failure fails the row and creates no section', async () => {
    const jobId = await newJob();
    svc.pollScript = ['failed'];

    const out = await runVideoGenerate(jobId, FAST);

    expect(out).toMatchObject({ status: 'failed' });
    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toContain('provider said no');
    expect(await sectionsFor(jobId)).toHaveLength(0);
  });

  it('an enhanced prompt survives a crash and is not re-billed', async () => {
    const jobId = await newJob({ enhance: true });
    svc.crashAt = 'submit';
    await expect(runVideoGenerate(jobId, FAST)).rejects.toBeInstanceOf(SimulatedCrash);
    expect(svc.calls.enhance).toBe(1);
    const [row] = await rows<{ enhanced_prompt: string }>(
      `SELECT enhanced_prompt FROM video_generation_jobs WHERE id=$1`, [jobId]);
    expect(row.enhanced_prompt).toBe('a cat on a roof, cinematic');
    await rewindCrash(jobId);

    await runVideoGenerate(jobId, FAST);
    expect(svc.calls.enhance).toBe(1); // reused the stored enhancement
  });
});

// ── Startup recovery ──────────────────────────────────────────────────────────────────────────

describe('recoverStuckVideoGenerations', () => {
  it('re-drives every in-flight row and leaves terminal ones alone', async () => {
    const live = await newJob();
    const done = await newJob();
    const dead = await newJob();
    await pg.query(`UPDATE video_generation_jobs SET status='generating' WHERE id=$1`, [live]);
    await pg.query(`UPDATE video_generation_jobs SET status='ready' WHERE id=$1`, [done]);
    await pg.query(`UPDATE video_generation_jobs SET status='transcoding' WHERE id=$1`, [dead]);

    const summary = await recoverStuckVideoGenerations();

    const ids = h.enqueued.map((e) => (e.payload as { jobId: string }).jobId).sort();
    expect(ids).toEqual([live, dead].sort());
    expect(h.enqueued.every((e) => e.name === 'video_generate')).toBe(true);
    expect(summary.requeued).toBe(2);
  });

  it('does NOT fail a row a live worker in another process is holding', async () => {
    // The old recovery wrote `failed` over any enhancing/submitting row with no task id — including
    // one another process was actively working, which then carried on and overwrote it back.
    const jobId = await newJob();
    await pg.query(
      `UPDATE video_generation_jobs SET status='submitting', claimed_by='worker-1', attempts=1,
              updated_at=now() WHERE id=$1`, [jobId]);

    await recoverStuckVideoGenerations();

    const job = await jobRow(jobId);
    expect(job.status).toBe('submitting');
    expect(job.claimed_by).toBe('worker-1');
  });

  it('schedules a SECOND delivery for rows whose lease has not expired yet', async () => {
    // A process that dies ten seconds after claiming leaves a lease that still looks live. The
    // immediate re-drive is refused by the CAS, so without this the row waits for the next boot.
    vi.useFakeTimers();
    try {
      const jobId = await newJob();
      await pg.query(
        `UPDATE video_generation_jobs SET status='generating', claimed_by='worker-dead',
                attempts=1, updated_at=now() WHERE id=$1`, [jobId]);

      const summary = await recoverStuckVideoGenerations();
      expect(summary.requeued).toBe(1);
      expect(summary.deferredMs).toBeGreaterThan(0);
      expect(h.enqueued).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(summary.deferredMs! + 10);
      expect(h.enqueued).toHaveLength(2);
      expect(h.enqueued[1].payload).toEqual({ jobId });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── The anchor is captured at ENQUEUE, and the finaliser copies it (D-01) ──────────────────────

describe('runVideoGenerate — segment-relative placement', () => {
  /**
   * THE RACE THIS CLOSES. A generation runs for up to twenty-five minutes and the timeline is
   * editable the whole time. `target_global_offset_sec` alone is an absolute second, so the obvious
   * fix — work the anchor out when the job FINISHES — reads a timeline the author may never have
   * seen, and reproduces the drift the anchor exists to prevent with a wider window.
   *
   * The test drives that directly: enqueue against one timeline, CHANGE the timeline while the job
   * is "running", then finish it. An implementation that re-derived at completion would write an
   * anchor computed from the second layout, which is a different segment and a different offset —
   * so asserting the ORIGINAL pair is an assertion only the correct implementation can satisfy.
   */
  async function twoMainVideos(): Promise<{ a: string; b: string }> {
    const a = await one<{ id: string }>(
      `INSERT INTO video_files (project_id, filename, file_size, storage_key, status, duration_sec, created_at)
       VALUES ($1,'a.mp4',10,$2,'ready',30, now() - interval '2 hours') RETURNING id`,
      [projectId, `videos/${projectId}/a.mp4`]);
    const b = await one<{ id: string }>(
      `INSERT INTO video_files (project_id, filename, file_size, storage_key, status, duration_sec, created_at)
       VALUES ($1,'b.mp4',10,$2,'ready',40, now() - interval '1 hour') RETURNING id`,
      [projectId, `videos/${projectId}/b.mp4`]);
    return { a: a.id, b: b.id };
  }

  async function anchoredJob(anchorId: string, anchorOffset: number, absolute: number): Promise<string> {
    const r = await one<{ id: string }>(
      `INSERT INTO video_generation_jobs (project_id, model, original_prompt, enhance_enabled,
                                          target_duration_sec, target_global_offset_sec,
                                          target_anchor_video_file_id, target_anchor_offset_sec)
       VALUES ($1,'kling','a cat on a roof',false,5,$2,$3,$4) RETURNING id`,
      [projectId, absolute, anchorId, anchorOffset]);
    svc.currentJobId = r.id;
    return r.id;
  }

  it('publishes the section with the anchor the JOB carries, not one re-derived at completion', async () => {
    const { a, b } = await twoMainVideos();
    // The author aimed at second 40 — ten seconds into B, while A was thirty seconds long.
    const jobId = await anchoredJob(b, 10, 40);

    // …and then re-cut A while the generation was in flight. Second 40 is now fifteen seconds into
    // B, so a completion-time derivation would store (B, 15) and the clip would land five seconds
    // from where it was placed.
    await pg.query(`UPDATE video_files SET duration_sec = 25 WHERE id = $1`, [a]);

    await runVideoGenerate(jobId, FAST);

    const sec = await one<{
      anchor_video_file_id: string; anchor_offset_sec: number;
      placement_mode: string; global_offset_sec: number;
    }>(`SELECT s.anchor_video_file_id, s.anchor_offset_sec, s.placement_mode, s.global_offset_sec
          FROM timeline_sections s JOIN video_generation_jobs j ON j.section_id = s.id
         WHERE j.id = $1`, [jobId]);

    expect(sec.anchor_video_file_id).toBe(b);
    expect(sec.anchor_offset_sec).toBe(10);          // NOT 15
    expect(sec.placement_mode).toBe('segment');
    // The absolute rides along untouched as the dual read's fallback, so an application rollback
    // finds exactly the row the pre-D-01 code would have written.
    expect(sec.global_offset_sec).toBe(40);
  });

  it('publishes a LEGACY row when the job carries no anchor — a job enqueued before 063', async () => {
    await twoMainVideos();
    const jobId = await newJob({ offset: 12 });
    await runVideoGenerate(jobId, FAST);

    const sec = await one<{
      anchor_video_file_id: string | null; placement_mode: string; global_offset_sec: number;
    }>(`SELECT s.anchor_video_file_id, s.placement_mode, s.global_offset_sec
          FROM timeline_sections s JOIN video_generation_jobs j ON j.section_id = s.id
         WHERE j.id = $1`, [jobId]);

    expect(sec).toEqual({
      anchor_video_file_id: null, placement_mode: 'legacy_absolute', global_offset_sec: 12,
    });
  });
});
