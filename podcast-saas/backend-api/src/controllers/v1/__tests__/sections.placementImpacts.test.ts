/**
 * /placement-impacts — the queue an author can actually reach, and the word it will not accept.
 *
 * Nothing in this system may repair a broken placement, which is only defensible if the person who
 * can repair it is told. These two endpoints are that telling: what is open, and "I have dealt with
 * this". They are small, and one property in them is load-bearing —
 *
 *   `re_placed` IS NOT ACCEPTED HERE. "The author moved it" is a claim only a write to the section
 *   can make, and the PATCH handler makes it there. If this route accepted the word, a client could
 *   mark the queue clean without a single clip having moved, and the queue would go quiet exactly
 *   when it was most wrong.
 *
 * The list also carries each row's placement resolved through the ONE resolver, because the numbers
 * stored on a review are the ones captured at DETECTION and the timeline has usually moved since —
 * an author needs the second the clip plays at NOW in order to find it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const PROJECT = 'proj-1';
const HOST = '11111111-1111-1111-1111-111111111111';
const SRC = '22222222-2222-2222-2222-222222222222';

const mocks = vi.hoisted(() => ({
  reviews: [] as Array<Record<string, unknown>>,
  sections: [] as Array<Record<string, unknown>>,
  videos: [] as Array<Record<string, unknown>>,
  updatedRow: null as Record<string, unknown> | null,
  updateSet: null as Record<string, unknown> | null,
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      placement_impact_reviews: { findMany: async () => mocks.reviews },
      timeline_sections: { findMany: async () => mocks.sections, findFirst: async () => null },
      video_files: { findMany: async () => mocks.videos, findFirst: async () => null },
      simulations: { findMany: async () => [], findFirst: async () => null },
      branch_sequences: { findMany: async () => [] },
    },
    update: () => ({
      set: (v: Record<string, unknown>) => {
        mocks.updateSet = v;
        return { where: () => ({ returning: async () => (mocks.updatedRow ? [mocks.updatedRow] : []) }) };
      },
    }),
    insert: () => ({ values: () => ({ returning: async () => [] }) }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  projects: Symbol('projects'), timeline_sections: Symbol('timeline_sections'),
  simulations: Symbol('simulations'), video_files: Symbol('video_files'),
  branch_sequences: Symbol('branch_sequences'),
  placement_impact_reviews: {
    id: 'id', project_id: 'project_id', section_id: 'section_id', reason: 'reason',
    resolved_at: 'resolved_at', detected_at: 'detected_at',
  },
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })), and: vi.fn(() => ({ type: 'and' })),
  asc: vi.fn(() => ({ type: 'asc' })), desc: vi.fn(() => ({ type: 'desc' })),
  inArray: vi.fn(() => ({ type: 'inArray' })), isNull: vi.fn(() => ({ type: 'isNull' })),
}));
vi.mock('../../../services/collabAccess.js', () => ({
  editableProject: vi.fn(async (id: string) => (id === PROJECT ? { id: PROJECT } : null)),
}));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: (req: Record<string, unknown>, _r: unknown, done: () => void) => {
    req.dbUser = { id: 'user-1' };
    done();
  },
}));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({
    getPublicUrl: (k: string) => `https://cdn.example.com/${k}`,
    getSimPublicUrl: (k: string) => `https://cdn.example.com/sim-public/${k}`,
  }),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../services/timeline/placementImpact.js', () => ({
  resolveReviewsAfterReplacement: vi.fn(async () => {}),
}));

let app: FastifyInstance;

beforeEach(async () => {
  mocks.updateSet = null;
  mocks.updatedRow = { id: 'rev-1', resolution: 'accepted' };
  // A = [0,30), B = [30,70). The impacted clip is anchored 12s into A, so it plays at second 12.
  mocks.videos = [
    { id: HOST, duration_sec: 30, is_broll: false, created_at: '2026-01-01' },
    { id: SRC, duration_sec: 20, is_broll: true, created_at: '2026-01-02' },
  ];
  mocks.sections = [{
    id: 'sec-a', project_id: PROJECT, track: 'broll', type: 'broll', video_file_id: SRC,
    start_sec: 0, end_sec: 6, global_offset_sec: 47,
    placement_mode: 'segment', anchor_video_file_id: HOST, anchor_offset_sec: 12,
  }];
  mocks.reviews = [{
    id: 'rev-1', project_id: PROJECT, section_id: 'sec-a', reason: 'anchor_out_of_range',
    change_kind: 'media_replace', host_duration_before_sec: 60, host_duration_after_sec: 30,
    anchor_offset_sec: 12, absolute_sec: 47, resolved_at: null,
  }];

  const { registerSectionsRoutes } = await import('../sections.controller.js');
  app = Fastify();
  await registerSectionsRoutes(app);
});

describe('GET /placement-impacts', () => {
  it('returns the open items with the numbers captured at detection', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT}/placement-impacts` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.open).toHaveLength(1);
    expect(body.open[0]).toMatchObject({
      id: 'rev-1', reason: 'anchor_out_of_range', change_kind: 'media_replace',
      host_duration_before_sec: 60, host_duration_after_sec: 30,
    });
  });

  it('also says where the row sits NOW, through the one resolver', async () => {
    // The stored `absolute_sec` is 47 — where it was at detection. Today the anchor resolves to 12,
    // and 12 is the number that lets a person find the clip on the ruler.
    const body = (await app.inject({
      method: 'GET', url: `/api/v1/projects/${PROJECT}/placement-impacts`,
    })).json();
    expect(body.open[0].absolute_sec).toBe(47);
    expect(body.open[0].placement).toMatchObject({
      absolute_sec: 12, source: 'anchor', containing_segment_id: HOST,
    });
  });

  it('404s a project the caller may not edit', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/other/placement-impacts' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /placement-impacts/:reviewId/resolve', () => {
  const resolve = (resolution: unknown) => app.inject({
    method: 'POST',
    url: `/api/v1/projects/${PROJECT}/placement-impacts/rev-1/resolve`,
    payload: { resolution },
  });

  it('accepts the two answers a person can give', async () => {
    for (const r of ['accepted', 'dismissed']) {
      expect((await resolve(r)).statusCode).toBe(200);
      expect(mocks.updateSet).toMatchObject({ resolution: r });
      expect(mocks.updateSet!.resolved_at).toBeInstanceOf(Date);
    }
  });

  it('REFUSES re_placed — only a write to the section may claim the author moved it', async () => {
    const res = await resolve('re_placed');
    expect(res.statusCode).toBe(400);
    expect(mocks.updateSet).toBeNull();
  });

  it('refuses a missing or unknown resolution rather than defaulting to one', async () => {
    expect((await resolve(undefined)).statusCode).toBe(400);
    expect((await resolve('auto_fixed')).statusCode).toBe(400);
    expect(mocks.updateSet).toBeNull();
  });

  it('404s an item that is not open (or not this project’s)', async () => {
    mocks.updatedRow = null;   // the guarded UPDATE matched nothing
    expect((await resolve('accepted')).statusCode).toBe(404);
  });
});
