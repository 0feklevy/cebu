/**
 * The linear-video-export endpoints — the duplicationTableMissing.test.ts harness applied to the
 * three routes that replaced the 501 stubs:
 *
 *   • the dark-ship flag: LINEAR_EXPORT_ENABLED !== 'true' answers 404, exactly what this URL
 *     was to the outside world before migration 058;
 *   • the DEGRADED-CONSENT gate: a plan with sim windows requires `allow_degraded: true`, else
 *     409 `degraded_only` with the warnings the consent dialog shows (mutation target);
 *   • ownership (`projects.created_by`), the in-flight join, and 42P01 → 503 on every route
 *     that touches the table — the duplication endpoints' posture, kept identical.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const UNDEFINED_TABLE = '42P01';
const missingTable = (): Error =>
  Object.assign(new Error('relation "project_exports" does not exist'), { code: UNDEFINED_TABLE });

const PROJECT_ID = 'proj-1';
const EXPORT_ID = 'exp-1';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  liveExportFor: vi.fn(),
  buildExportPlan: vi.fn(),
  enqueueJob: vi.fn(),
  presign: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: { projects: { findFirst: mocks.findFirst } },
    select: () => ({ from: () => ({ where: mocks.select }) }),
    insert: () => ({ values: () => ({ returning: mocks.insert }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: mocks.update }) }) }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  projects: Symbol('projects'), project_exports: Symbol('project_exports'),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})), and: vi.fn(() => ({})), inArray: vi.fn(() => ({})),
}));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: (req: Record<string, unknown>, _r: unknown, done: () => void) => {
    req.dbUser = { id: 'user-1' };
    done();
  },
}));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({ getPresignedDownloadUrl: mocks.presign }),
}));
vi.mock('../../../queue/index.js', () => ({ enqueueJob: mocks.enqueueJob }));
vi.mock('../../../services/export/exportPlan.js', () => {
  class ExportRefused extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
      readonly code = 'refused',
      readonly retryable = false,
    ) { super(message); this.name = 'ExportRefused'; }
  }
  return { ExportRefused, buildExportPlan: mocks.buildExportPlan };
});
vi.mock('../../../services/export/ProjectExportService.js', () => ({
  liveExportFor: mocks.liveExportFor,
  EXPORT_IN_FLIGHT_STATUSES: ['queued', 'planning', 'capturing', 'assembling', 'uploading'] as const,
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let app: FastifyInstance;

const PLAN_WITH_SIMS = {
  timeline: [{ kind: 'video' }, { kind: 'sim-capture', sectionId: 's1' }],
  warnings: ['Scripted sim: exported as its poster still'],
};
const PLAN_NO_SIMS = { timeline: [{ kind: 'video' }], warnings: [] };

const READY_ROW = {
  id: EXPORT_ID, status: 'ready', quality_state: 'degraded',
  objects_total: 2, objects_done: 2, error: null, cancel_requested: false,
  output_key: `exports/${PROJECT_ID}/${EXPORT_ID}/master.mp4`,
  plan: { warnings: ['Scripted sim: exported as its poster still'] },
};

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.LINEAR_EXPORT_ENABLED = 'true';
  mocks.findFirst.mockResolvedValue({ id: PROJECT_ID, created_by: 'user-1' });
  mocks.liveExportFor.mockResolvedValue(null);
  mocks.buildExportPlan.mockResolvedValue(PLAN_WITH_SIMS);
  mocks.insert.mockResolvedValue([{ id: EXPORT_ID, status: 'queued' }]);
  mocks.select.mockResolvedValue([READY_ROW]);
  mocks.update.mockResolvedValue([]);
  mocks.presign.mockResolvedValue('https://signed.example/master.mp4');

  const { registerExportRoutes } = await import('../export.controller.js');
  app = Fastify();
  await registerExportRoutes(app);
  await app.ready();
});
afterEach(() => { delete process.env.LINEAR_EXPORT_ENABLED; });

const post = (body?: unknown) =>
  app.inject({ method: 'POST', url: `/api/v1/projects/${PROJECT_ID}/export`, ...(body === undefined ? {} : { payload: body as Record<string, unknown> }) });
const get = () => app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/exports/${EXPORT_ID}` });
const cancel = () => app.inject({ method: 'POST', url: `/api/v1/projects/${PROJECT_ID}/exports/${EXPORT_ID}/cancel` });

// ── The dark-ship flag ────────────────────────────────────────────────────────────────────────

describe('LINEAR_EXPORT_ENABLED', () => {
  it('OFF answers 404 before touching anything — the URL does not exist yet', async () => {
    process.env.LINEAR_EXPORT_ENABLED = 'false';
    const res = await post({ allow_degraded: true });
    expect(res.statusCode).toBe(404);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('unset is OFF — the feature ships dark until Phase 2', async () => {
    delete process.env.LINEAR_EXPORT_ENABLED;
    expect((await post({ allow_degraded: true })).statusCode).toBe(404);
  });
});

// ── POST ──────────────────────────────────────────────────────────────────────────────────────

describe('POST /projects/:id/export', () => {
  it('requires degraded CONSENT: sim windows without allow_degraded answer 409 degraded_only with the warnings', async () => {
    // MUTATION TARGET: drop the consent gate and this becomes a 202 — a degraded master the
    // user learns about from the file instead of from a dialog.
    const res = await post();
    expect(res.statusCode).toBe(409);
    const body = res.json<{ code: string; warnings: string[] }>();
    expect(body.code).toBe('degraded_only');
    expect(body.warnings).toEqual(PLAN_WITH_SIMS.warnings);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it('starts with consent: allow_degraded true → 202 + the job enqueued with {exportId}', async () => {
    const res = await post({ allow_degraded: true });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ export_id: EXPORT_ID, status: 'queued' });
    expect(mocks.enqueueJob).toHaveBeenCalledWith('project_export', { exportId: EXPORT_ID });
  });

  it('needs no consent when nothing would degrade', async () => {
    mocks.buildExportPlan.mockResolvedValue(PLAN_NO_SIMS);
    expect((await post()).statusCode).toBe(202);
  });

  it('joins an already-running export without re-planning', async () => {
    mocks.liveExportFor.mockResolvedValue({ id: EXPORT_ID, status: 'assembling' });
    const res = await post();
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ export_id: EXPORT_ID, already_running: true });
    expect(mocks.buildExportPlan).not.toHaveBeenCalled();
  });

  it('maps a planning refusal (branching) to its own status and code — not a 500, not a poll', async () => {
    const { ExportRefused } = await import('../../../services/export/exportPlan.js');
    mocks.buildExportPlan.mockRejectedValue(
      new ExportRefused('This project uses branching.', 409, 'export_branching_unsupported', false));
    const res = await post({ allow_degraded: true });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'export_branching_unsupported' });
  });

  it('is owner-gated: a project the caller does not own is 404', async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    expect((await post({ allow_degraded: true })).statusCode).toBe(404);
  });

  it('races on the partial unique index resolve to the winner (23505 → already_running)', async () => {
    mocks.insert.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }));
    mocks.select.mockResolvedValue([{ id: 'other-exp', status: 'planning' }]);
    const res = await post({ allow_degraded: true });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ export_id: 'other-exp', already_running: true });
  });

  it('answers 503 when migration 058 is rolled back under a serving image (read AND insert)', async () => {
    mocks.liveExportFor.mockRejectedValue(missingTable());
    expect((await post({ allow_degraded: true })).statusCode).toBe(503);

    mocks.liveExportFor.mockResolvedValue(null);
    mocks.insert.mockRejectedValue(missingTable());
    expect((await post({ allow_degraded: true })).statusCode).toBe(503);
  });

  it('a REAL failure is still a 500 — the guard is scoped to 42P01 and nothing else', async () => {
    mocks.liveExportFor.mockRejectedValue(Object.assign(new Error('connection reset'), { code: '08006' }));
    expect((await post({ allow_degraded: true })).statusCode).toBe(500);
  });
});

// ── GET ───────────────────────────────────────────────────────────────────────────────────────

describe('GET /projects/:id/exports/:exportId', () => {
  it('a ready row carries quality_state, the plan warnings, and a 6-hour presigned download', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: EXPORT_ID,
      status: 'ready',
      quality_state: 'degraded',
      warnings: READY_ROW.plan.warnings,
      download_url: 'https://signed.example/master.mp4',
    });
    expect(mocks.presign).toHaveBeenCalledWith(READY_ROW.output_key, 6 * 60 * 60);
  });

  it('an in-flight row has no download URL and no presign call', async () => {
    mocks.select.mockResolvedValue([{ ...READY_ROW, status: 'assembling', output_key: null }]);
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json<{ download_url: string | null }>().download_url).toBeNull();
    expect(mocks.presign).not.toHaveBeenCalled();
  });

  it('404 for a row that does not exist; 503 when the table is gone', async () => {
    mocks.select.mockResolvedValue([]);
    expect((await get()).statusCode).toBe(404);
    mocks.select.mockRejectedValue(missingTable());
    expect((await get()).statusCode).toBe(503);
  });
});

// ── Cancel ────────────────────────────────────────────────────────────────────────────────────

describe('POST /projects/:id/exports/:exportId/cancel', () => {
  it('sets the flag on an in-flight row, fenced, and answers with the row', async () => {
    mocks.update.mockResolvedValue([{ ...READY_ROW, status: 'assembling', output_key: null, cancel_requested: true }]);
    const res = await cancel();
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id: EXPORT_ID, cancel_requested: true });
  });

  it('409 for a finished export, 404 for a missing one, 503 when the table is gone', async () => {
    mocks.update.mockResolvedValue([]);   // the fence matched nothing in flight
    mocks.select.mockResolvedValue([READY_ROW]);
    expect((await cancel()).statusCode).toBe(409);

    mocks.select.mockResolvedValue([]);
    expect((await cancel()).statusCode).toBe(404);

    mocks.update.mockRejectedValue(missingTable());
    expect((await cancel()).statusCode).toBe(503);
  });
});
