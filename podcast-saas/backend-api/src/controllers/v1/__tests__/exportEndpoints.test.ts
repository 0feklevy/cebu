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
  admit: vi.fn((..._args: unknown[]): { admitted: boolean; statusCode: number; code: string; message: string; detail: string } | null => null),
  // The row the controller writes — the frozen degradation policy is asserted on it.
  values: vi.fn(),
  findFirst: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  liveExportFor: vi.fn(),
  buildExportPlan: vi.fn(),
  enqueueJob: vi.fn(),
  enqueueProjectExport: vi.fn(async () => {}),
  presign: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: { projects: { findFirst: mocks.findFirst } },
    select: () => ({ from: () => ({ where: mocks.select }) }),
    insert: () => ({ values: (v: unknown) => { mocks.values(v); return { returning: mocks.insert }; } }),
    // `where` is both awaitable and chainable: the controller awaits it for a plain UPDATE and
    // calls `.returning()` for the cancel path, and a mock that supports only one shape turns a
    // deliberate 503 into a 500.
    update: () => ({
      set: (v: unknown) => ({
        where: () => {
          mocks.update(v);
          return Object.assign(Promise.resolve([{ id: EXPORT_ID }]), { returning: mocks.update });
        },
      }),
    }),
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
vi.mock('../../../queue/index.js', () => ({
  enqueueJob: mocks.enqueueJob,
  enqueueProjectExport: mocks.enqueueProjectExport,
  ExportQueueUnavailable: class ExportQueueUnavailable extends Error {
    readonly code = 'export_queue_unavailable';
    constructor(readonly detail: string) { super('unavailable'); this.name = 'ExportQueueUnavailable'; }
  },
}));
vi.mock('../../../services/export/exportPlan.js', () => {
  class ExportRefused extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
      readonly code = 'refused',
      readonly retryable = false,
    ) { super(message); this.name = 'ExportRefused'; }
  }
  // The real admission arithmetic, not a stub: these tests care whether the CONTROLLER consults it
  // and translates its verdict into the right status code, and a stub that always admits would hide
  // exactly that. `mocks.admit` lets one test drive a refusal without inventing a giant plan.
  return {
    ExportRefused,
    buildExportPlan: mocks.buildExportPlan,
    admitCaptureWorkload: (...args: unknown[]) => mocks.admit(...(args as [unknown])),
  };
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
// A window the PLANNER already resolved to a still — the package cannot be captured at all. This,
// and only this, is degradation known before the run, and so the only thing consent is for.
const PLAN_WITH_POSTER_FALLBACK = {
  timeline: [{ kind: 'video' }, { kind: 'poster-fallback', sectionId: 's1' }],
  warnings: ['Broken sim: cannot be captured — exported as its poster still'],
};

const READY_ROW = {
  id: EXPORT_ID, status: 'ready', quality_state: 'degraded',
  objects_total: 2, objects_done: 2, error: null, cancel_requested: false,
  output_key: `exports/${PROJECT_ID}/${EXPORT_ID}/master.mp4`,
  plan: { warnings: ['Scripted sim: exported as its poster still'] },
};

beforeEach(async () => {
  // Consent is signed, so the suite needs a key. Absent, the endpoint refuses to issue one at
  // all — which is the production posture, not a test inconvenience.
  process.env.EXPORT_CONSENT_SECRET = 'test-consent-secret-at-least-32-chars-long';
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

describe('GET /projects/:id/export/current — discovery', () => {
  it('finds the in-flight export, so a reload does not lose it', async () => {
    // The id used to live only in the tab that started the export: refreshing, or opening the
    // project on another device, showed no sign that a render was in progress — and the natural
    // response was to press Export again.
    mocks.select.mockResolvedValue([{ ...READY_ROW, status: 'capturing' }]);
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/export/current` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ export: { id: string; status: string } | null; capability: Record<string, boolean> }>();
    expect(body.export).toMatchObject({ id: EXPORT_ID, status: 'capturing' });
    expect(body.capability).toMatchObject({ export_enabled: true });
  });

  it('answers null when nothing is running, rather than 404', async () => {
    mocks.select.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/export/current` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ export: unknown }>().export).toBeNull();
  });

  it('is matched BEFORE /export/:exportId — "current" is not an id', async () => {
    mocks.select.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/export/current` });
    // A 404 here would mean Fastify routed to the by-id handler and looked up an export called
    // "current".
    expect(res.statusCode).toBe(200);
  });

  it('reports server capability instead of letting the client duplicate flags it cannot see', async () => {
    delete process.env.EXPORT_CAPTURE_IMAGE;
    mocks.select.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/export/current` });
    expect(res.json<{ capability: { live_capture_configured: boolean } }>().capability.live_capture_configured)
      .toBe(false);
  });

  it('is owner-only', async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/export/current` });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /projects/:id/export', () => {
  it('a SIM-CAPTURE window needs no consent — it is the promise to render, not degradation', async () => {
    // The old gate asked every user to pre-approve a slideshow before anything had failed, which
    // trained them to click through the warning and made the full-quality contract unreachable.
    // A sim-capture window means "this will be rendered live"; if that fails, the STRICT policy
    // fails the export rather than quietly shipping a still.
    const res = await post();
    expect(res.statusCode).toBe(202);
    expect(mocks.insert).toHaveBeenCalled();
    expect(mocks.enqueueProjectExport).toHaveBeenCalledWith(EXPORT_ID);
  });

  it('refuses an inadmissible capture workload BEFORE enqueueing anything', async () => {
    // Measured cost makes some jobs impossible rather than slow: at 1080p a frame is ~16 s on the
    // reference worker, against a per-section budget of 90 + 6·duration. Such a job would occupy a
    // worker for its full budget, be killed, and — under the strict policy — fail. Refusing at the
    // door is truthful, and it is what stops one project starving every other tenant's queue.
    mocks.admit.mockReturnValueOnce({
      admitted: false,
      statusCode: 413,
      code: 'too_many_simulations',
      message: 'This project has 40 simulation sections…',
      detail: 'sim windows 40 > 12',
    });
    const res = await post();
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'too_many_simulations' });
    // MUTATION TARGET: move the check after the insert and these two stop holding.
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.enqueueProjectExport).not.toHaveBeenCalled();
  });

  it('records the STRICT policy on the row by default', async () => {
    await post();
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({ degradation_policy: 'forbid' }));
  });

  it('a POSTER-FALLBACK window requires consent: 409 naming the sections, with a token to confirm with', async () => {
    // MUTATION TARGET: drop the consent gate and this becomes a 202 — a degraded master the
    // user learns about from the file instead of from a dialog.
    mocks.buildExportPlan.mockResolvedValue(PLAN_WITH_POSTER_FALLBACK);
    const res = await post();
    expect(res.statusCode).toBe(409);
    const body = res.json<{
      code: string; warnings: string[]; consent_token: string; plan_fingerprint: string;
      affected_sections: Array<{ section_id: string; label: string | null; will_use_still: boolean }>;
    }>();
    expect(body.code).toBe('degraded_only');
    expect(body.warnings).toEqual(PLAN_WITH_POSTER_FALLBACK.warnings);
    // The dialog can NAME what it is asking about. "This export will include simulations as still
    // images" was true of nothing in particular and implied all of them.
    expect(body.affected_sections).toEqual([{ section_id: 's1', label: null, will_use_still: true }]);
    expect(body.consent_token).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(body.plan_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.enqueueProjectExport).not.toHaveBeenCalled();
  });

  it('a durable-enqueue failure answers 503 and does not leave a queued row nobody will run', async () => {
    // Fire-and-forget was the old shape: a send that failed left a `queued` row nothing would ever
    // pick up, and the user watched a progress bar for a job that did not exist.
    mocks.enqueueProjectExport.mockRejectedValueOnce(new Error('pg-boss is down'));
    const res = await post();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'export_queue_unavailable', retryable: true });
    expect(mocks.update).toHaveBeenCalled();   // the row was marked failed, not left queued
  });

  it('a NAKED allow_degraded no longer starts anything — a boolean is not consent', async () => {
    // It could be sent by anything that could reach this endpoint, said nothing about what was
    // being agreed to, and survived any amount of drift.
    mocks.buildExportPlan.mockResolvedValue(PLAN_WITH_POSTER_FALLBACK);
    const res = await post({ allow_degraded: true } as never);
    expect(res.statusCode).toBe(409);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.enqueueProjectExport).not.toHaveBeenCalled();
  });

  it('starts with a VALID token → 202, and the row records allow_poster', async () => {
    mocks.buildExportPlan.mockResolvedValue(PLAN_WITH_POSTER_FALLBACK);
    const first = await post();
    const { consent_token } = first.json<{ consent_token: string }>();

    const res = await post({ consent_token });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ export_id: EXPORT_ID, status: 'queued' });
    expect(mocks.enqueueProjectExport).toHaveBeenCalledWith(EXPORT_ID);
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({ degradation_policy: 'allow_poster' }));
  });

  it('a token issued for a DIFFERENT plan re-prompts instead of starting', async () => {
    mocks.buildExportPlan.mockResolvedValue(PLAN_WITH_POSTER_FALLBACK);
    const { consent_token } = (await post()).json<{ consent_token: string }>();

    // The project changed between the dialog and the confirmation: the substitutions the user saw
    // are not the substitutions that would happen.
    mocks.buildExportPlan.mockResolvedValue({
      ...PLAN_WITH_POSTER_FALLBACK,
      timeline: [...PLAN_WITH_POSTER_FALLBACK.timeline, { kind: 'poster-fallback', sectionId: 's2' }],
    });
    const res = await post({ consent_token });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: 'plan_changed' });
    expect(mocks.insert).not.toHaveBeenCalled();
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
