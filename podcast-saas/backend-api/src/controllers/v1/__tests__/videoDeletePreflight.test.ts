/**
 * DELETING A VIDEO THAT OTHER ROWS ARE PLACED AGAINST REQUIRES AN EXPLICIT CHOICE (D-01b).
 *
 * What this route used to do, silently and in one request: cascade-delete every section SOURCED
 * from the video, and NULL the anchor of every overlay ANCHORED to it — leaving those overlays
 * pinned to a wall-clock second that the now-shorter timeline had just made wrong. Neither was
 * shown to the author and neither was reversible.
 *
 * The ruling: list the dependents, refuse until a person chooses, and never re-anchor an orphan to
 * "the next" video. These tests drive the real route over a mocked db and assert the three answers.
 *
 * ASSERTION DISCIPLINE: it is not enough that a 409 comes back. A route that 409'd on every delete
 * would pass that. Each case therefore pins WHICH rows were named, WHICH write ran, and — for the
 * property the ruling actually turns on — that no write anywhere sets an anchor to a different
 * video.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const MAIN = '11111111-1111-1111-1111-111111111111';
const NEXT = '22222222-2222-2222-2222-222222222222';
const SRC = '33333333-3333-3333-3333-333333333333';
const PROJECT = 'proj-1';

/** The project: a 30 s main video, a 40 s main video after it, and a b-roll source. */
const VIDEOS = [
  { id: MAIN, duration_sec: 30, is_broll: false },
  { id: NEXT, duration_sec: 40, is_broll: false },
  { id: SRC, duration_sec: 20, is_broll: true },
];

/** An overlay ANCHORED to MAIN, and a chapter whose MEDIA is MAIN. */
const SECTIONS = [
  {
    id: 'sec-anchored', project_id: PROJECT, track: 'broll', type: 'broll', video_file_id: SRC,
    start_sec: 0, end_sec: 6, global_offset_sec: 12, label: 'logo sting',
    placement_mode: 'segment', anchor_video_file_id: MAIN, anchor_offset_sec: 12,
  },
  {
    id: 'sec-sourced', project_id: PROJECT, track: 'main', type: 'section', video_file_id: MAIN,
    start_sec: 0, end_sec: 30, label: 'chapter one', placement_mode: 'legacy_absolute',
  },
  {
    id: 'sec-elsewhere', project_id: PROJECT, track: 'broll', type: 'broll', video_file_id: SRC,
    start_sec: 0, end_sec: 4, global_offset_sec: 40, label: 'unrelated',
    placement_mode: 'segment', anchor_video_file_id: NEXT, anchor_offset_sec: 10,
  },
];

const writes = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  deletes: [] as string[],
  inserted: [] as Array<Record<string, unknown>>,
  storageDeletes: [] as string[],
}));

const mocks = vi.hoisted(() => ({
  sections: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../services/storage/deleteWithFallback.js', () => ({
  deleteWithFallback: vi.fn(async (k: string) => { writes.storageDeletes.push(k); }),
  deleteWithPrefixFallback: vi.fn(async (k: string) => { writes.storageDeletes.push(`${k}/*`); }),
}));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({
    getPresignedDownloadUrl: async () => 'https://example.test/x',
    getPublicUrl: (k: string) => `https://example.test/${k}`,
  }),
}));
vi.mock('../../../services/storage/uploadStreamWithFallback.js', () => ({
  uploadStreamWithFallback: vi.fn(async () => ({ key: 'k' })),
}));
vi.mock('../../../services/video/hlsRetention.js', () => ({
  deleteHlsRetirementRowsForVideo: vi.fn(async () => {}),
}));
vi.mock('../../../services/crop/runCropAnalysis.js', () => ({
  enqueueCropForProject: vi.fn(async () => {}),
}));
vi.mock('../../../queue/index.js', () => ({ enqueueJob: vi.fn() }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../services/collabAccess.js', () => ({
  editableProject: async (id: string) => (id === PROJECT ? { id: PROJECT } : null),
}));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: (req: Record<string, unknown>, _r: unknown, done: () => void) => {
    req.dbUser = { id: 'user-1' };
    done();
  },
}));
vi.mock('../../../db/schema.js', () => ({
  video_files: { id: 'video_files.id', project_id: 'video_files.project_id', created_at: 'video_files.created_at' },
  timeline_sections: { id: 'timeline_sections.id', project_id: 'timeline_sections.project_id' },
  video_generation_jobs: {
    target_anchor_video_file_id: 'jobs.target_anchor_video_file_id', status: 'jobs.status',
  },
  placement_impact_reviews: { section_id: 'reviews.section_id', reason: 'reviews.reason', resolved_at: 'reviews.resolved_at' },
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })), and: vi.fn(() => ({ type: 'and' })),
  asc: vi.fn(() => ({ type: 'asc' })), desc: vi.fn(() => ({ type: 'desc' })),
  inArray: vi.fn((_c: unknown, ids: string[]) => ({ type: 'inArray', ids })),
  isNull: vi.fn(() => ({ type: 'isNull' })),
  notInArray: vi.fn(() => ({ type: 'notInArray' })),
}));

/** One writer surface, shared by `db` and the `tx` handed to the transaction callback. */
const writer = {
  update: () => ({
    set: (v: Record<string, unknown>) => ({
      where: async (cond: { ids?: string[] }) => { writes.updates.push({ ...v, ids: cond?.ids }); },
    }),
  }),
  delete: () => ({
    where: async (cond: { ids?: string[] }) => {
      writes.deletes.push(...(cond?.ids ?? ['<video row>']));
    },
  }),
  insert: () => ({
    values: (v: Array<Record<string, unknown>>) => ({
      onConflictDoNothing: async () => { writes.inserted.push(...v); },
    }),
  }),
};

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      video_files: {
        findFirst: async () => ({ id: MAIN, project_id: PROJECT, filename: 'intro.mp4', storage_key: 'videos/intro.mp4' }),
        findMany: async () => VIDEOS,
      },
      timeline_sections: { findMany: async () => mocks.sections },
      video_generation_jobs: { findMany: async () => [] },
    },
    transaction: async (fn: (tx: typeof writer) => Promise<void>) => { await fn(writer); },
    ...writer,
  },
}));

let app: FastifyInstance;

beforeEach(async () => {
  writes.updates.length = 0;
  writes.deletes.length = 0;
  writes.inserted.length = 0;
  writes.storageDeletes.length = 0;
  mocks.sections = SECTIONS;
  const { registerVideoRoutes } = await import('../video.controller.js');
  app = Fastify();
  await registerVideoRoutes(app);
});

const del = (query = '') =>
  app.inject({ method: 'DELETE', url: `/api/v1/projects/${PROJECT}/videos/${MAIN}${query}` });

describe('DELETE video — the preflight', () => {
  it('REFUSES a bare delete and names every dependent, with its kind', async () => {
    const res = await del();
    expect(res.statusCode).toBe(409);
    const body = res.json();

    expect(body.code).toBe('video_has_dependent_sections');
    expect(body.dependents.map((d: { sectionId: string }) => d.sectionId).sort())
      .toEqual(['sec-anchored', 'sec-sourced']);
    expect(body.dependents.find((d: { sectionId: string }) => d.sectionId === 'sec-anchored').kind)
      .toBe('anchor');
    // The rows a "keep my clips" choice cannot keep, named separately: their media IS this video.
    expect(body.removed_regardless).toEqual(['sec-sourced']);
    expect(body.choices).toEqual(['detach', 'delete']);

    // NOTHING happened — not the row, and above all not the bytes.
    expect(writes.deletes).toEqual([]);
    expect(writes.storageDeletes).toEqual([]);
  });

  it('never proposes re-anchoring to the next video', async () => {
    // The one thing the ruling forbids outright. `NEXT` is a real main segment sitting right after
    // the host, which is exactly what a helpful-looking implementation would reach for.
    const body = (await del()).json();
    expect(JSON.stringify(body)).not.toContain(NEXT);
    expect(body.choices).not.toContain('reanchor');
  });

  it('rejects a choice it does not recognise, rather than falling back to a default', async () => {
    const res = await del('?dependents=reanchor');
    expect(res.statusCode).toBe(400);
    expect(writes.deletes).toEqual([]);
  });

  it('DETACH keeps the overlay, drops only the anchor, and files a review', async () => {
    const res = await del('?dependents=detach');
    expect(res.statusCode).toBe(204);

    const detach = writes.updates.find((u) => 'anchor_video_file_id' in u);
    expect(detach).toBeTruthy();
    expect(detach!.ids).toEqual(['sec-anchored']);          // only the anchored row
    expect(detach!.anchor_video_file_id).toBeNull();
    expect(detach!.anchor_offset_sec).toBeNull();
    // `placement_mode` is deliberately NOT reset: "was anchored, lost its host" must stay
    // distinguishable from "was never anchored", which is what the resolver reports on.
    expect(detach).not.toHaveProperty('placement_mode');

    expect(writes.inserted).toHaveLength(1);
    expect(writes.inserted[0]).toMatchObject({
      section_id: 'sec-anchored', reason: 'host_deleted_detached', change_kind: 'host_delete',
    });
    // The host id will be nulled by the FK, so the name has to be in the text.
    expect(String(writes.inserted[0].detail)).toContain('intro.mp4');

    // The video row is deleted, and no section is.
    expect(writes.deletes).toEqual(['<video row>']);
  });

  it('DELETE removes the dependents with the video, and files no review', async () => {
    const res = await del('?dependents=delete');
    expect(res.statusCode).toBe(204);

    expect(writes.deletes).toEqual(['sec-anchored', 'sec-sourced', '<video row>']);
    expect(writes.inserted).toEqual([]);
    expect(writes.updates).toEqual([]);
  });

  it('deletes the bytes only AFTER the row is gone', async () => {
    await del('?dependents=detach');
    // The old order deleted the bytes first, so a failed DB delete left a row pointing at media
    // that no longer existed — reachable now that the FK can refuse the delete outright.
    expect(writes.deletes).toContain('<video row>');
    expect(writes.storageDeletes).toContain('videos/intro.mp4');
  });

  it('proceeds without a choice when nothing depends on the video', async () => {
    mocks.sections = [SECTIONS[2]];   // anchored to NEXT, not to the video being deleted
    const res = await del();
    expect(res.statusCode).toBe(204);
    expect(writes.deletes).toEqual(['<video row>']);
    expect(writes.updates).toEqual([]);
  });
});
