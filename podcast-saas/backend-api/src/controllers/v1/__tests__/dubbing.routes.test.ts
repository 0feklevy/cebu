/**
 * The dubbing routes' access rules and the one route that can spend money.
 *
 * Three properties are pinned here, each because getting it wrong is a class of bug this codebase
 * has already been bitten by once:
 *
 *   • 404-not-403 on every creator route, so an unauthorised caller cannot use them as an
 *     existence oracle for someone else's project (the convention player.controller documents);
 *   • the public caption route refuses a dub that is not SERVABLE — specifically a watermarked
 *     one, which is finished and paid for but must never reach a viewer;
 *   • the billable POST is unreachable without passing `editableProject`, and a bad language is
 *     rejected before it can reach a vendor call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  projects: { findFirst: vi.fn() },
  video_files: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
  video_dubs: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
  editableProject: vi.fn(),
  requestProjectDub: vi.fn(),
  deleteProjectDub: vi.fn(),
  listDubsForProject: vi.fn(async () => []),
  estimateProjectDubCost: vi.fn(async () => ({
    language_count: 1, total_duration_sec: 600, usd_per_minute_per_language: 2.2,
    usd_per_language: 22, estimated_usd: 22, estimated_credits: 30000,
    watermarked: false, watermark_notice: null,
  })),
  authedUser: { id: 'user-1', email: 'a@b.c' } as { id: string; email: string } | null,
  checkDubbingBudget: vi.fn(async () => ({
    allowed: true, spentCents: 0, budgetCents: 5000, estimateCents: 2200, exempt: false, reason: null,
  })),
}));

vi.mock('../../../db/index.js', () => ({ db: { query: mocks } }));
vi.mock('../../../db/schema.js', () => ({
  projects: Symbol('projects'),
  video_files: Symbol('video_files'),
  video_dubs: Symbol('video_dubs'),
}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => ({ type: 'eq' })) }));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: async (req: Record<string, unknown>) => { req.dbUser = mocks.authedUser; },
  firebaseAuthOptionalMiddleware: async (req: Record<string, unknown>) => { req.dbUser = mocks.authedUser; },
}));
vi.mock('../../../services/collabAccess.js', () => ({
  editableProject: mocks.editableProject,
  isCollaborator: vi.fn(async () => false),
}));
vi.mock('../../../services/projectAccess.js', () => ({ requireProjectAccess: vi.fn(() => true) }));
// The ceiling reaches the database through `select`, which this suite does not stub; the policy
// itself is proven in dubbingBudget.test.ts. What matters HERE is only what the route does with a
// verdict — and specifically that a refusal never reaches the vendor.
vi.mock('../../../services/dubbing/budget.js', () => ({ checkDubbingBudget: mocks.checkDubbingBudget }));
vi.mock('../../../services/billing/BillingService.js', () => ({
  BillingService: { getPricing: vi.fn(async () => ({ accessType: 'free' })), hasAccess: vi.fn(async () => true) },
}));

// The registry is mocked EXCEPT for the two pure predicates the routes genuinely depend on —
// `isDubServable` is the rule under test on the caption route, so stubbing it would test nothing.
vi.mock('../../../services/dubbing/dubRegistry.js', async () => {
  const actual = await vi.importActual<typeof import('../../../services/dubbing/dubRegistry.js')>(
    '../../../services/dubbing/dubRegistry.js',
  );
  return {
    ...actual,
    listDubsForProject: mocks.listDubsForProject,
    requestProjectDub: mocks.requestProjectDub,
    deleteProjectDub: mocks.deleteProjectDub,
    estimateProjectDubCost: mocks.estimateProjectDubCost,
  };
});

const { registerDubbingRoutes } = await import('../dubbing.controller.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const VIDEO_ID = '22222222-2222-4222-8222-222222222222';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerDubbingRoutes(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authedUser = { id: 'user-1', email: 'a@b.c' };
  mocks.editableProject.mockResolvedValue({ id: PROJECT_ID });
  mocks.checkDubbingBudget.mockResolvedValue({
    allowed: true, spentCents: 0, budgetCents: 5000, estimateCents: 2200, exempt: false, reason: null,
  });
  mocks.video_files.findMany.mockResolvedValue([]);
  mocks.video_dubs.findMany.mockResolvedValue([]);
  mocks.listDubsForProject.mockResolvedValue([]);
});

describe('creator routes answer 404, never 403, when access is refused', () => {
  it('GET /dubs on a project the caller cannot edit', async () => {
    mocks.editableProject.mockResolvedValue(undefined);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/dubs` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ message: 'Project not found' });
  });

  it('POST /dubs on a project the caller cannot edit — and nothing billable runs', async () => {
    mocks.editableProject.mockResolvedValue(undefined);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/projects/${PROJECT_ID}/dubs`, payload: { language: 'he' },
    });
    expect(res.statusCode).toBe(404);
    // The assertion that matters: the guard answered before anything could spend.
    expect(mocks.requestProjectDub).not.toHaveBeenCalled();
  });

  it('DELETE /dubs/:language on a project the caller cannot edit', async () => {
    mocks.editableProject.mockResolvedValue(undefined);
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/projects/${PROJECT_ID}/dubs/he` });
    expect(res.statusCode).toBe(404);
    expect(mocks.deleteProjectDub).not.toHaveBeenCalled();
  });

  it('a malformed project id 404s before the database is touched', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/banana/dubs' });
    expect(res.statusCode).toBe(404);
    expect(mocks.editableProject).not.toHaveBeenCalled();
  });
});

describe('POST /dubs — the billable route', () => {
  it('queues the dub and answers 202, because the work is not done yet', async () => {
    mocks.requestProjectDub.mockResolvedValue([{ id: 'dub-1', language: 'he', status: 'queued' }]);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/projects/${PROJECT_ID}/dubs`, payload: { language: 'he' },
    });
    expect(res.statusCode).toBe(202);
    expect(mocks.requestProjectDub).toHaveBeenCalledWith(PROJECT_ID, 'he', { force: undefined });
  });

  it('rejects a language the product does not dub into, before any vendor call', async () => {
    const { UnsupportedDubLanguage } = await import('../../../services/dubbing/dubRegistry.js');
    mocks.requestProjectDub.mockRejectedValue(new UnsupportedDubLanguage('klingon'));
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/projects/${PROJECT_ID}/dubs`, payload: { language: 'klingon' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('klingon');
  });

  it('requires a language rather than defaulting to one', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `/api/v1/projects/${PROJECT_ID}/dubs`, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(mocks.requestProjectDub).not.toHaveBeenCalled();
  });

  it('says so plainly when there is nothing to dub, instead of queueing zero jobs silently', async () => {
    mocks.requestProjectDub.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/projects/${PROJECT_ID}/dubs`, payload: { language: 'he' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('GET /videos/:videoId/captions/:language — the public per-language read', () => {
  const servableDub = {
    video_file_id: VIDEO_ID,
    target_language: 'he',
    status: 'completed',
    watermarked: false,
    hls_master_key: 'dubs/x/he/hls/1/master.m3u8',
    captions_vtt: 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nשלום\n',
  };

  beforeEach(() => {
    mocks.video_files.findFirst.mockResolvedValue({ id: VIDEO_ID, project_id: PROJECT_ID });
    mocks.projects.findFirst.mockResolvedValue({ id: PROJECT_ID });
  });

  it('serves the dub-derived VTT as text/vtt', async () => {
    mocks.video_dubs.findFirst.mockResolvedValue(servableDub);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/videos/${VIDEO_ID}/captions/he.vtt` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/vtt');
    expect(res.body).toContain('WEBVTT');
  });

  it('accepts the language with or without the .vtt suffix', async () => {
    mocks.video_dubs.findFirst.mockResolvedValue(servableDub);
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: `/api/v1/videos/${VIDEO_ID}/captions/he` })).statusCode).toBe(200);
  });

  it('REFUSES a watermarked dub — finished and paid for, but never served to a viewer', async () => {
    mocks.video_dubs.findFirst.mockResolvedValue({ ...servableDub, watermarked: true });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/videos/${VIDEO_ID}/captions/he.vtt` });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a dub with no rendition to play the captions against', async () => {
    mocks.video_dubs.findFirst.mockResolvedValue({ ...servableDub, hls_master_key: null });
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: `/api/v1/videos/${VIDEO_ID}/captions/he.vtt` })).statusCode).toBe(404);
  });

  it('refuses a dub that has not finished', async () => {
    mocks.video_dubs.findFirst.mockResolvedValue({ ...servableDub, status: 'processing' });
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: `/api/v1/videos/${VIDEO_ID}/captions/he.vtt` })).statusCode).toBe(404);
  });

  it('404s an unoffered language without querying for it', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/videos/${VIDEO_ID}/captions/klingon.vtt` });
    expect(res.statusCode).toBe(404);
    expect(mocks.video_dubs.findFirst).not.toHaveBeenCalled();
  });

  it('404s when the project is not readable, rather than confirming the video exists', async () => {
    mocks.video_dubs.findFirst.mockResolvedValue(servableDub);
    mocks.projects.findFirst.mockResolvedValue(undefined);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/videos/${VIDEO_ID}/captions/he.vtt` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ message: 'Captions not available' });
  });

  it('serves an ANONYMOUS viewer on a share link — the acceptance case for a public /he page', async () => {
    mocks.authedUser = null;
    mocks.video_dubs.findFirst.mockResolvedValue(servableDub);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/videos/${VIDEO_ID}/captions/he.vtt?share=tok123`,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('the monthly dubbing ceiling', () => {
  it('refuses the run WITHOUT EVER REACHING THE VENDOR when the budget is spent', async () => {
    mocks.checkDubbingBudget.mockResolvedValue({
      allowed: false, spentCents: 4900, budgetCents: 5000, estimateCents: 2200, exempt: false,
      reason: 'Dubbing this project would cost about $22.00, and only $1.00 of your $50.00 monthly dubbing budget is left ($49.00 used). The budget resets at the start of next month.',
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/projects/${PROJECT_ID}/dubs`, payload: { language: 'he' },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).message).toContain('monthly dubbing budget');
    expect(JSON.parse(res.body).budget).toMatchObject({ spent_cents: 4900, budget_cents: 5000 });
    // THE ASSERTION THIS TEST EXISTS FOR. The vendor bills on job creation and offers no
    // idempotency key, so a ceiling that is checked after this call is a report, not a limit.
    expect(mocks.requestProjectDub).not.toHaveBeenCalled();
  });

  it('lets a run inside the budget through to the vendor', async () => {
    mocks.requestProjectDub.mockResolvedValue([{ id: 'dub-1', target_language: 'he' }]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/projects/${PROJECT_ID}/dubs`, payload: { language: 'he' },
    });

    expect(res.statusCode).toBe(202);
    expect(mocks.requestProjectDub).toHaveBeenCalledTimes(1);
  });

  it('checks the ceiling only after access is proven — a stranger learns nothing about cost', async () => {
    mocks.editableProject.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: `/api/v1/projects/${PROJECT_ID}/dubs`, payload: { language: 'he' },
    });

    expect(res.statusCode).toBe(404);
    expect(mocks.checkDubbingBudget).not.toHaveBeenCalled();
  });
});
