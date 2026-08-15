/**
 * ProjectExportService against a REAL Postgres engine — the job discipline: CAS claim, heartbeat,
 * fenced writes, cancel, failure classification, and the abandoned-run sweep. The assembler is
 * STUBBED (the sibling change owns the real one); these tests are about the row's lifecycle.
 *
 * The named mutation tests:
 *   • "the in-flight fence …" fails if the terminal `ready` write loses its
 *     `WHERE status IN in-flight` fence;
 *   • "a branching refusal …" fails if branching is classified retryable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../../../db/schema.js';

const h = vi.hoisted(() => ({ dbRef: { current: null as unknown as Record<string, unknown> } }));

vi.mock('../../../db/index.js', () => ({
  db: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      const target = h.dbRef.current;
      const v = target[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => { throw new Error('export service tests must inject their own storage'); },
}));

import {
  EXPORT_ABANDONED_MESSAGE, EXPORT_CANCELLED_MESSAGE, EXPORT_HEARTBEAT_MS,
  ProjectExportService, classifyExportFailure, liveExportFor, sweepAbandonedExports,
} from '../ProjectExportService.js';
import { ExportRefused } from '../exportPlan.js';
import type { StorageService } from '../../storage/StorageService.js';
import type { ExportPlan, LinearAssembler } from '../types.js';
import { CaptureGateFailed, type SimCaptureBackend } from '../capture/captureTypes.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');

let pg: PGlite;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}
async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await rows<T>(sql, params);
  if (!r[0]) throw new Error(`expected a row from: ${sql}`);
  return r[0];
}

interface ExportRowView {
  status: string;
  quality_state: string;
  error: string | null;
  output_key: string | null;
  objects_total: number;
  objects_done: number;
  plan: {
    timeline?: { kind: string; sectionId: string | null }[];
    warnings?: string[];
    failure?: { code: string; retryable: boolean; phase: string; detail: string };
  } | null;
  finished_at: string | null;
}
const exportRow = (id: string): Promise<ExportRowView> =>
  one<ExportRowView>(`SELECT status, quality_state, error, output_key, objects_total, objects_done, plan, finished_at
                        FROM project_exports WHERE id = $1`, [id]);

/** Poll (real timers) until a condition holds — the suite's only concession to async intervals. */
async function waitFor(cond: () => Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => { setTimeout(r, 25); });
  }
}

// ── Fixture ───────────────────────────────────────────────────────────────────────────────────

let projectId: string;
let scriptedSectionId: string;

async function seed(): Promise<void> {
  const org = await one<{ id: string }>(`INSERT INTO orgs (name) VALUES ('O') RETURNING id`);
  const user = await one<{ id: string }>(
    `INSERT INTO users (firebase_uid, email) VALUES ('uid-svc', 'e@test') RETURNING id`);
  const project = await one<{ id: string }>(
    `INSERT INTO projects (org_id, created_by, title) VALUES ($1,$2,'P') RETURNING id`, [org.id, user.id]);
  projectId = project.id;

  const video = await one<{ id: string }>(
    `INSERT INTO video_files (project_id, filename, file_size, storage_key, status, duration_sec)
     VALUES ($1,'main.mp4',1024,$2,'ready',60) RETURNING id`,
    [projectId, `videos/${projectId}/main.mp4`]);

  const sim = await one<{ id: string }>(
    `INSERT INTO simulations (project_id, name, storage_prefix, entry_file, status)
     VALUES ($1,'S','simulations/x','https://cdn.test/simulations/x/index.html','ready') RETURNING id`,
    [projectId]);
  const section = await one<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, label, track,
                                    simulation_id, simple_ui, auto_script)
     VALUES ($1,$2,5,15,'simulation','Scripted sim','main',$3,true,true) RETURNING id`,
    [projectId, video.id, sim.id]);
  scriptedSectionId = section.id;
  await pg.query(`UPDATE timeline_sections SET simulation_url=$2 WHERE id=$1`,
    [section.id, `https://cdn.test/simulations/x/index.html?section=${section.id}&v=h1`]);
}

/**
 * Most tests here are about claiming, fencing, heartbeats, assembly and cancellation — not the
 * degradation policy — and they were written when a failed capture always fell back to a poster.
 * They therefore state `allow_poster` explicitly, which is what their assertions assume. The strict
 * default is exercised deliberately by the outcome-matrix tests further down.
 */
async function newExport(
  status = 'queued',
  opts: { cancelRequested?: boolean; staleMinutes?: number; policy?: 'forbid' | 'allow_poster' } = {},
): Promise<string> {
  const { id } = await one<{ id: string }>(
    `INSERT INTO project_exports (project_id, status, cancel_requested, updated_at, degradation_policy)
     VALUES ($1,$2,$3, now() - ($4 || ' minutes')::interval, $5) RETURNING id`,
    [projectId, status, opts.cancelRequested ?? false, String(opts.staleMinutes ?? 0), opts.policy ?? 'allow_poster']);
  return id;
}

// ── Fakes ─────────────────────────────────────────────────────────────────────────────────────

function fakeStorage() {
  const uploads: { key: string; contentType: string; cacheControl?: string }[] = [];
  const headCalls = new Map<string, number>();
  const storage = {
    uploads,
    /** When set, every HEAD of a key AFTER its first answers different bytes — the mid-export
     *  re-upload the ingest gate exists to catch (plan-time HEAD vs ingest-time HEAD). */
    driftAfterFirstHead: false,
    uploadFile: vi.fn(async (key: string, _b: Buffer, contentType: string, cacheControl?: string) => {
      uploads.push({ key, contentType, cacheControl });
      return `https://cdn.test/${key}`;
    }),
    uploadStream: vi.fn(async (key: string, _s: unknown, contentType: string) => {
      uploads.push({ key, contentType });
      return `https://cdn.test/${key}`;
    }),
    getSimPublicUrl: (key: string) => `https://sim.test/${key}`,
    headObject: vi.fn(async (key: string) => {
      const n = (headCalls.get(key) ?? 0) + 1;
      headCalls.set(key, n);
      const drifted = storage.driftAfterFirstHead && n > 1;
      return {
        contentType: null, cacheControl: null,
        size: drifted ? 999_999 : 1024,
        etag: drifted ? 'etag-after-reupload' : 'etag-1',
      };
    }),
  };
  return storage as typeof storage & StorageService;
}

/** An assembler that writes a tiny master — optionally gated so a test can hold it mid-flight. */
function stubAssembler(impl?: LinearAssembler['assemble']) {
  const assemble = vi.fn<LinearAssembler['assemble']>(impl ?? (async (_plan: ExportPlan, workDir: string) => {
    const masterPath = join(workDir, 'master.mp4');
    await writeFile(masterPath, Buffer.from('not really an mp4'));
    return { masterPath };
  }));
  return { assemble };
}

let storage: ReturnType<typeof fakeStorage>;

const withCapture = (assembler: LinearAssembler, backend: SimCaptureBackend): ProjectExportService =>
    new ProjectExportService(storage, assembler, backend);

const service = (assembler: LinearAssembler): ProjectExportService =>
  new ProjectExportService(storage, assembler);

beforeEach(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  h.dbRef.current = drizzle(pg, { schema }) as unknown as Record<string, unknown>;
  storage = fakeStorage();
  await seed();
});
afterEach(async () => {
  vi.useRealTimers();
  await pg.close();
});

// ── The run ───────────────────────────────────────────────────────────────────────────────────

describe('run — the happy path (Phase 1: poster fallback for every sim window)', () => {
  it('plans, substitutes, assembles, uploads to the write-once key, and lands ready', async () => {
    const assembler = stubAssembler();
    const exportId = await newExport();
    await service(assembler).run(exportId);

    const row = await exportRow(exportId);
    expect(row.status).toBe('ready');
    expect(row.output_key).toBe(`exports/${projectId}/${exportId}/master.mp4`);
    expect(row.finished_at).not.toBeNull();
    expect(Number(row.objects_total)).toBe(2); // base video window + the sim window
    expect(Number(row.objects_done)).toBe(2);

    // MUTATION TARGET: never set quality_state and this fails — a Phase 1 export with a sim
    // window is ALWAYS degraded (its capture became a poster), and `ready` must say so.
    expect(row.quality_state).toBe('degraded');

    // The buffered upload path carries the immutable cache header — the key is write-once.
    expect(storage.uploads).toEqual([
      { key: row.output_key, contentType: 'video/mp4', cacheControl: 'public, max-age=31536000, immutable' },
    ]);

    // Phase 1 capturing: the sim-capture window became poster-fallback, recorded as a warning.
    const kinds = row.plan!.timeline!.map((w) => w.kind).sort();
    expect(kinds).toEqual(['poster-fallback', 'video']);
    // Wording note: with no capture backend injected (the default), every sim window becomes its
    // poster still. Asserted on the stable phrase, not the exact sentence, so a reword of the
    // reason does not break a test whose intent is 'the user is told the sim became a still'.
    expect(row.plan!.warnings!.some((w) => w.includes('poster still'))).toBe(true);

    // The assembler received the SUBSTITUTED plan — it must never see a sim-capture window.
    const seen = assembler.assemble.mock.calls[0][0];
    expect(seen.timeline.every((w) => w.kind !== 'sim-capture')).toBe(true);
  });

  // ── the capture provider seam (Phase 2 wiring; default-off is proven above) ──────────────────
  //
  // These drive the SAME service with a FAKE SimCaptureBackend. The real backends (Playwright
  // screenshot, container beginFrame) are proven in the capture module's own suites; here the only
  // question is whether the service does the right thing with what a backend returns — capture a
  // clip and splice it, or degrade to the poster, loudly.
  describe('with a capture backend injected', () => {
    // (hoisted to module scope so the outcome-matrix tests can use the same wiring)

    it('a gated clip is uploaded to the section key and spliced — the window is NOT a poster', async () => {
      const assembler = stubAssembler();
      const backend: SimCaptureBackend = {
        name: 'fake',
        isAvailable: async () => true,
        captureSection: vi.fn(async (spec) => {
          const clipPath = join(await mkdtemp(join(tmpdir(), 'cap-')), 'clip.mp4');
          await writeFile(clipPath, Buffer.from('captured'));
          // The service passed the section's own params through — the capture identity.
          expect(spec.sectionId).toBe(scriptedSectionId);
          expect(spec.simpleUi).toBe(true);
          expect(spec.autoScript).toBe(true);
          return { clipPath, frameCount: 300, rendererString: 'ANGLE (fake)', gate: 'passed' as const };
        }),
      };
      const exportId = await newExport();
      await withCapture(assembler, backend).run(exportId);

      const row = await exportRow(exportId);
      expect(row.status).toBe('ready');
      // The captured clip was uploaded to the export's own write-once section key…
      expect(storage.uploads.map((u) => u.key)).toContain(
        `exports/${projectId}/${exportId}/sections/${scriptedSectionId}.mp4`);
      // …and the assembler saw it as a CLIP, never a sim-capture or a poster-fallback.
      const seen = assembler.assemble.mock.calls[0][0];
      const simWin = seen.timeline.find((w) => w.sectionId === scriptedSectionId);
      expect(simWin?.kind).toBe('clip');
      // A real capture that passed the gate is NOT a degradation.
      expect(row.quality_state).toBe('full');
    });

    it('a gate FAILURE degrades to the poster, loudly, and never fails the export', async () => {
      const assembler = stubAssembler();
      const backend: SimCaptureBackend = {
        name: 'fake',
        isAvailable: async () => true,
        // The dangerous case the gate exists for: a clip WAS produced (a file on disk) but its
        // canvas region never moved — a black render under Minimal UI. The service must reject it
        // on the gate verdict, NOT trust the file's existence. (A backend that returns no clip at
        // all is the easy case; returning a bad clip is what would otherwise ship a wrong video.)
        captureSection: vi.fn(async () => {
          const clipPath = join(await mkdtemp(join(tmpdir(), 'cap-')), 'black.mp4');
          await writeFile(clipPath, Buffer.from('a produced but dead render'));
          return {
            clipPath, frameCount: 300, rendererString: 'SwiftShader Device',
            gate: 'failed' as const, reason: 'canvas region never changed',
          };
        }),
      };
      const exportId = await newExport();
      await withCapture(assembler, backend).run(exportId);

      const row = await exportRow(exportId);
      expect(row.status).toBe('ready');            // one bad window never fails the whole export
      expect(row.quality_state).toBe('degraded');
      const simWin = row.plan!.timeline!.find((w) => w.sectionId === scriptedSectionId);
      expect(simWin?.kind).toBe('poster-fallback');
      expect(row.plan!.warnings!.some((w) => w.includes('sanity gate'))).toBe(true);
      // No captured clip was uploaded — only the master.
      expect(storage.uploads.map((u) => u.key)).not.toContain(
        `exports/${projectId}/${exportId}/sections/${scriptedSectionId}.mp4`);
    });

    it('an UNAVAILABLE backend is the poster path — isAvailable false skips capture entirely', async () => {
      const assembler = stubAssembler();
      const captureSection = vi.fn();
      const backend: SimCaptureBackend = { name: 'fake', isAvailable: async () => false, captureSection };
      const exportId = await newExport();
      await withCapture(assembler, backend).run(exportId);

      const row = await exportRow(exportId);
      expect(row.status).toBe('ready');
      expect(row.quality_state).toBe('degraded');
      // isAvailable() false means captureSection is NEVER called — no browser launched to learn it.
      expect(captureSection).not.toHaveBeenCalled();
    });
  });

  /**
   * The outcome matrix. The product contract is a video OF THE SIMULATIONS: under the default
   * policy a capture that does not happen must fail the export, because a still image is not a
   * lesser version of the requested artifact, it is a different one — and shipping it silently is
   * exactly the failure the whole capture incident exists to prevent. Publishing nothing is better
   * than publishing a slideshow, because nothing is visible and a silent slideshow is not.
   */
  describe('degradation policy — the outcome matrix', () => {
    const strictFailure = async (exportId: string) => {
      const row = await exportRow(exportId);
      expect(row.status).toBe('failed');
      // The load-bearing assertion: NO master was published, at any key.
      expect(row.output_key).toBeNull();
      return row;
    };

    it('FORBID + unavailable provider fails the export and publishes no master', async () => {
      const assembler = stubAssembler();
      const captureSection = vi.fn();
      const backend: SimCaptureBackend = { name: 'fake', isAvailable: async () => false, captureSection };
      const exportId = await newExport('queued', { policy: 'forbid' });

      await expect(withCapture(assembler, backend).run(exportId)).rejects.toMatchObject({
        code: 'capture_failed_strict',
      });
      const row = await strictFailure(exportId);
      expect(row.error).toMatch(/could not be rendered/i);
      expect(captureSection).not.toHaveBeenCalled();
    });

    it('FORBID + a capture exception fails the export and publishes no master', async () => {
      const assembler = stubAssembler();
      const backend: SimCaptureBackend = {
        name: 'fake',
        isAvailable: async () => true,
        captureSection: async () => { throw new Error('chrome crashed at begin_frame'); },
      };
      const exportId = await newExport('queued', { policy: 'forbid' });
      await expect(withCapture(assembler, backend).run(exportId)).rejects.toMatchObject({
        code: 'capture_failed_strict',
      });
      await strictFailure(exportId);
    });

    it('FORBID + a FAILED GATE fails the export — a dead canvas is never published', async () => {
      const assembler = stubAssembler();
      const backend: SimCaptureBackend = {
        name: 'fake',
        isAvailable: async () => true,
        captureSection: async () => {
          throw new CaptureGateFailed('every sampled canvas frame is uniform', 'SwiftShader', 450);
        },
      };
      const exportId = await newExport('queued', { policy: 'forbid' });
      await expect(withCapture(assembler, backend).run(exportId)).rejects.toMatchObject({
        code: 'capture_failed_strict',
        // A gate failure is deterministic: the same package fails the same way, so retrying is a
        // waste of ten minutes of CPU rather than a second chance.
        retryable: false,
      });
      await strictFailure(exportId);
    });

    it('ALLOW_POSTER keeps the per-window fallback and records the exact warning', async () => {
      const assembler = stubAssembler();
      const backend: SimCaptureBackend = {
        name: 'fake',
        isAvailable: async () => true,
        captureSection: async () => { throw new Error('chrome crashed at begin_frame'); },
      };
      const exportId = await newExport('queued', { policy: 'allow_poster' });
      await withCapture(assembler, backend).run(exportId);

      const row = await exportRow(exportId);
      expect(row.status).toBe('ready');
      expect(row.quality_state).toBe('degraded');
      const warnings = (row.plan as { warnings?: string[] } | null)?.warnings ?? [];
      expect(warnings.join(' ')).toMatch(/simulation capture failed/i);
      expect(warnings.join(' ')).toMatch(/chrome crashed at begin_frame/);
    });

    it('CANCELLATION is never degradation, even where a poster was permitted', async () => {
      const assembler = stubAssembler();
      const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
      const backend: SimCaptureBackend = {
        name: 'fake',
        isAvailable: async () => true,
        captureSection: async () => { throw abortErr; },
      };
      // allow_poster: the ONE policy under which a lazy catch would have turned a user pressing
      // stop into a published slideshow.
      const exportId = await newExport('queued', { policy: 'allow_poster' });
      await expect(withCapture(assembler, backend).run(exportId)).rejects.toMatchObject({ name: 'AbortError' });

      const row = await exportRow(exportId);
      expect(row.status).toBe('cancelled');
      expect(row.output_key).toBeNull();
      // The planner's own advisory ("no poster exists for this configuration") is fine and
      // predates the run. What must NOT appear is a DEGRADATION record — a claim that this window
      // was exported as a still, which is what a lazy catch would have written for a cancellation.
      const warnings = (row.plan as { warnings?: string[] } | null)?.warnings ?? [];
      expect(warnings.join(' ')).not.toMatch(/exported as its poster still/i);
      expect(warnings.join(' ')).not.toMatch(/simulation capture failed/i);
    });

    it('the policy is read from the ROW, so a redelivery cannot change the answer', async () => {
      const exportId = await newExport('queued', { policy: 'forbid' });
      const { degradation_policy } = await one<{ degradation_policy: string }>(
        `SELECT degradation_policy FROM project_exports WHERE id = $1`, [exportId]);
      expect(degradation_policy).toBe('forbid');
    });
  });

  it('an export with no sim windows lands ready at FULL quality', async () => {
    await pg.query(`DELETE FROM timeline_sections WHERE id = $1`, [scriptedSectionId]);
    const assembler = stubAssembler();
    const exportId = await newExport();
    await service(assembler).run(exportId);
    const row = await exportRow(exportId);
    expect(row.status).toBe('ready');
    expect(row.quality_state).toBe('full');
  });
});

describe('run — the claim', () => {
  it('a terminal row is left exactly as it is', async () => {
    const assembler = stubAssembler();
    const exportId = await newExport('ready');
    await service(assembler).run(exportId);
    expect(assembler.assemble).not.toHaveBeenCalled();
    expect((await exportRow(exportId)).status).toBe('ready');
  });

  it('a second delivery does nothing while a FRESH run holds the row', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const assembler = stubAssembler(async (_plan, workDir) => {
      await gate;
      const masterPath = join(workDir, 'master.mp4');
      await writeFile(masterPath, Buffer.from('x'));
      return { masterPath };
    });
    const exportId = await newExport();
    const first = service(assembler).run(exportId);
    // Synchronize on the ASSEMBLE CALL, not on the status write. The service sets `assembling`
    // BEFORE it invokes assemble(), so waiting on the status leaves a window where the row is
    // `assembling` but the first run's assemble() has not fired yet — under CPU load the second
    // delivery and the assertion then run inside that window and see 0 calls. Waiting on the gated
    // call itself is the true precondition for "a fresh run holds the row".
    await waitFor(async () => assembler.assemble.mock.calls.length === 1, 'first assemble');

    // The second delivery: the CAS refuses, nothing runs twice.
    await service(assembler).run(exportId);
    expect(assembler.assemble).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect((await exportRow(exportId)).status).toBe('ready');
  });

  it('claims a STALE in-flight row — the abandoned-run recovery path', async () => {
    const assembler = stubAssembler();
    const exportId = await newExport('capturing', { staleMinutes: 20 });
    await service(assembler).run(exportId);
    expect((await exportRow(exportId)).status).toBe('ready');
  });
});

describe('run — the heartbeat', () => {
  it('a live run keeps beating updated_at while the assembler grinds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const assembler = stubAssembler(async (_plan, workDir) => {
      await gate;
      const masterPath = join(workDir, 'master.mp4');
      await writeFile(masterPath, Buffer.from('x'));
      return { masterPath };
    });
    const exportId = await newExport();
    const running = service(assembler).run(exportId);
    await waitFor(async () => (await exportRow(exportId)).status === 'assembling', 'assembling');

    // Backdate the row as if no write had landed for 20 minutes, then let ONE beat fire.
    await pg.query(`UPDATE project_exports SET updated_at = now() - interval '20 minutes' WHERE id = $1`, [exportId]);
    await vi.advanceTimersByTimeAsync(EXPORT_HEARTBEAT_MS + 50);
    await waitFor(async () => {
      const [r] = await rows<{ fresh: boolean }>(
        `SELECT updated_at > now() - interval '1 minute' AS fresh FROM project_exports WHERE id = $1`, [exportId]);
      return r!.fresh;
    }, 'heartbeat write');

    release();
    await running;
    expect((await exportRow(exportId)).status).toBe('ready');
  });
});

describe('run — cancellation', () => {
  it('honours cancel_requested between phases: CANCELLED — not failed — and the assembler never runs', async () => {
    const assembler = stubAssembler();
    const exportId = await newExport('queued', { cancelRequested: true });
    await expect(service(assembler).run(exportId)).rejects.toThrow(/cancelled/i);

    const row = await exportRow(exportId);
    // A honoured cancellation is the system doing what the user asked. `failed` would make
    // every cancel read as a defect in the UI, the logs and any error-rate metric.
    expect(row.status).toBe('cancelled');
    expect(row.error).toContain(EXPORT_CANCELLED_MESSAGE);
    expect(row.error).toContain('[export_cancelled]');
    expect(row.plan!.failure).toMatchObject({ code: 'export_cancelled', retryable: false });
    expect(assembler.assemble).not.toHaveBeenCalled();
    expect(storage.uploads).toHaveLength(0);
  });

  it('an assembler abort (AbortError) classifies as the cancellation it is', async () => {
    const assembler = stubAssembler(async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    });
    const exportId = await newExport();
    await expect(service(assembler).run(exportId)).rejects.toThrow();
    const row = await exportRow(exportId);
    expect(row.status).toBe('cancelled');
    expect(row.plan!.failure).toMatchObject({ code: 'export_cancelled', retryable: false, phase: 'assembling' });
    expect(storage.uploads).toHaveLength(0);
  });
});

describe('run — the ingest gate (source identity)', () => {
  it('a source that changed between plan and ingest refuses as source_changed, retryable — no chimera master', async () => {
    // The drift: plan-time HEAD answers one identity, ingest-time HEAD another — exactly what a
    // re-upload mid-export looks like.
    storage.driftAfterFirstHead = true;
    const assembler = stubAssembler();
    const exportId = await newExport();
    await expect(service(assembler).run(exportId)).rejects.toThrow(/media changed/i);

    const row = await exportRow(exportId);
    expect(row.status).toBe('failed');
    // MUTATION TARGET: skip the ingest assertion and this run sails through to `ready` — a
    // master spliced from two generations of one file.
    expect(row.plan!.failure).toMatchObject({ code: 'source_changed', retryable: true, phase: 'assembling' });
    expect(assembler.assemble).not.toHaveBeenCalled();
    expect(storage.uploads).toHaveLength(0);
  });
});

describe('run — failure classification', () => {
  it('a failure stores the REAL reason and the phase — never the bare generic', async () => {
    const assembler = stubAssembler(async () => { throw new Error('ffmpeg exploded: filter graph too deep'); });
    const exportId = await newExport();
    await expect(service(assembler).run(exportId)).rejects.toThrow('ffmpeg exploded');

    const row = await exportRow(exportId);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('[unknown]');
    expect(row.plan!.failure).toMatchObject({ code: 'unknown', retryable: true, phase: 'assembling' });
    expect(row.plan!.failure!.detail).toContain('ffmpeg exploded');
    // The plan written at planning time SURVIVES the failure, merged rather than replaced.
    expect(row.plan!.timeline!.length).toBeGreaterThan(0);
    expect(row.output_key).toBeNull();
  });

  it('a branching refusal is recorded NOT retryable, with its own code, in the planning phase', async () => {
    await pg.query(`INSERT INTO branch_sequences (project_id, label, is_entry, sort_order) VALUES ($1,'A',true,0)`,
      [projectId]);
    const assembler = stubAssembler();
    const exportId = await newExport();
    await expect(service(assembler).run(exportId)).rejects.toThrow(/branching/i);

    const row = await exportRow(exportId);
    expect(row.status).toBe('failed');
    // MUTATION TARGET: classify branching as retryable and this fails — "try again" is provably
    // false advice for a project that has branching.
    expect(row.plan!.failure).toMatchObject({
      code: 'export_branching_unsupported', retryable: false, phase: 'planning',
    });
    expect(assembler.assemble).not.toHaveBeenCalled();
  });

  it('classifyExportFailure: refusals pass through; the unknown is retryable', () => {
    const refusal = classifyExportFailure(new ExportRefused('no', 409, 'export_branching_unsupported', false));
    expect(refusal).toMatchObject({ code: 'export_branching_unsupported', retryable: false });
    const unknown = classifyExportFailure(new Error('socket reset'));
    expect(unknown).toMatchObject({ code: 'unknown', retryable: true });
    expect(unknown.detail).toContain('socket reset');
  });
});

describe('run — the in-flight fence', () => {
  it('a run that lost its row must not publish over its successor', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const assembler = stubAssembler(async (_plan, workDir) => {
      await gate;
      const masterPath = join(workDir, 'master.mp4');
      await writeFile(masterPath, Buffer.from('x'));
      return { masterPath };
    });
    const exportId = await newExport();
    const running = service(assembler).run(exportId);
    await waitFor(async () => (await exportRow(exportId)).status === 'assembling', 'assembling');

    // The takeover: a sweeper (or a successor's claim) declared this run dead and owned the row.
    await pg.query(`UPDATE project_exports SET status='failed', error='reaped elsewhere' WHERE id = $1`, [exportId]);

    release();
    await running; // finishes quietly — the fenced terminal write matched zero rows

    // MUTATION TARGET: drop the `WHERE status IN in-flight` fence from the terminal write and
    // this row comes back `ready` — a dead run publishing behind its successor's back.
    const row = await exportRow(exportId);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('reaped elsewhere');
    expect(row.output_key).toBeNull();
  });
});

// ── The sweep ─────────────────────────────────────────────────────────────────────────────────

describe('sweepAbandonedExports / liveExportFor', () => {
  it('reaps only rows past the staleness rule, with the abandoned message', async () => {
    const stale = await newExport('capturing', { staleMinutes: 20 });
    const reaped = await sweepAbandonedExports();
    expect(reaped).toBe(1);
    const row = await exportRow(stale);
    expect(row.status).toBe('failed');
    expect(row.error).toBe(EXPORT_ABANDONED_MESSAGE);
  });

  it('leaves a fresh in-flight row alone', async () => {
    const fresh = await newExport('assembling');
    expect(await sweepAbandonedExports()).toBe(0);
    expect((await exportRow(fresh)).status).toBe('assembling');
  });

  it('liveExportFor: returns the fresh row, reaps the stale one, null when none', async () => {
    expect(await liveExportFor(projectId)).toBeNull();

    const fresh = await newExport('planning');
    expect((await liveExportFor(projectId))?.id).toBe(fresh);
    await pg.query(`UPDATE project_exports SET status='failed' WHERE id=$1`, [fresh]);

    const stale = await newExport('uploading', { staleMinutes: 20 });
    expect(await liveExportFor(projectId)).toBeNull();
    expect((await exportRow(stale)).status).toBe('failed');
  });
});
