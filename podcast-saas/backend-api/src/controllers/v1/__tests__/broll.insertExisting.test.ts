/**
 * POST /broll/insert-existing — the one write path that was already clean, held to it.
 *
 * The census's verdict on this endpoint is that it can produce exactly ONE shape: a true b-roll
 * with a non-null, non-negative offset. That is a valuable property — it is why a malformed b-roll
 * row in the wild can be attributed to the generic sections API rather than to the b-roll panel —
 * and it was resting entirely on `z.number().min(0)`, which does not mean what it looks like:
 *
 *   `z.number()` accepts Infinity, and `JSON.parse('1e400')` IS Infinity. `Infinity >= 0` is true,
 *   so an infinite offset passed the schema, passed the `start_sec >= end_sec` guard, and reached a
 *   Postgres `real` column, which stores infinities happily. The row then positions a clip at a
 *   time no playhead can reach.
 *
 * These tests pin the endpoint to the shape the census credits it with, using the SAME shared rule
 * set the player and the sections endpoints use — so "this endpoint cannot make a hybrid" is a fact
 * checked against one definition rather than three.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerBrollRoutes } from '../broll.controller.js';
import { timelineSectionViolations } from 'shared';

const mocks = vi.hoisted(() => ({
  projects:              { findFirst: vi.fn() },
  video_files:           { findFirst: vi.fn(), findMany: vi.fn() },
  video_generation_jobs: { findMany: vi.fn(), findFirst: vi.fn() },
  timeline_sections:     { findFirst: vi.fn() },
}));
const writes = vi.hoisted(() => ({ inserted: [] as Record<string, unknown>[] }));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: mocks,
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        writes.inserted.push(v);
        return { returning: async () => [{ id: 'sec-new', ...v }] };
      },
    }),
    delete: () => ({ where: () => ({ returning: async () => [] }) }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  video_generation_jobs: Symbol('video_generation_jobs'),
  timeline_sections: Symbol('timeline_sections'),
  video_files: Symbol('video_files'),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })), and: vi.fn(() => ({ type: 'and' })),
  desc: vi.fn(() => ({ type: 'desc' })), asc: vi.fn(() => ({ type: 'asc' })),
}));
vi.mock('../../../services/collabAccess.js', () => ({
  editableProject: vi.fn(() => mocks.projects.findFirst()),
}));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: (req: Record<string, unknown>, _reply: unknown, done: () => void) => {
    req.dbUser = { id: 'user-1' };
    done();
  },
}));
vi.mock('../../../queue/index.js', () => ({ enqueueJob: vi.fn() }));
vi.mock('../../../lib/rateLimit.js', () => ({ rateLimit: vi.fn(() => true) }));
vi.mock('../../../services/llm/systemAi.js', () => ({ assertGenerationAllowed: vi.fn(async () => undefined) }));
vi.mock('../../../services/llm/ContentModerationService.js', () => ({
  moderateGenerationInput: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const PROJECT_ID = 'proj-1';
/** A real uuid: this endpoint's schema already validates the format, and that is worth keeping. */
const VIDEO_ID = '11111111-1111-1111-1111-111111111111';
/** The project's MAIN timeline: A = [0,30), B = [30,70). `VIDEO_ID` is the b-roll being inserted. */
const MAIN_A = '22222222-2222-2222-2222-222222222222';
const MAIN_B = '33333333-3333-3333-3333-333333333333';
let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  writes.inserted.length = 0;
  mocks.projects.findFirst.mockResolvedValue({ id: PROJECT_ID });
  mocks.video_files.findFirst.mockResolvedValue({
    id: VIDEO_ID, project_id: PROJECT_ID, filename: 'clip.mp4', duration_sec: 30, is_broll: false,
  });
  mocks.video_files.findMany.mockResolvedValue([
    { id: MAIN_A, duration_sec: 30, is_broll: false },
    { id: MAIN_B, duration_sec: 40, is_broll: false },
    { id: VIDEO_ID, duration_sec: 30, is_broll: true },
  ]);
  app = Fastify();
  await registerBrollRoutes(app);
  await app.ready();
});

/** Raw body, because `JSON.stringify` turns Infinity into null and hides the case under test. */
const insertRaw = (body: string) => app.inject({
  method: 'POST', url: `/api/v1/projects/${PROJECT_ID}/broll/insert-existing`,
  headers: { 'content-type': 'application/json' }, body,
});
const insert = (payload: Record<string, unknown>) => insertRaw(JSON.stringify(payload));

describe('POST /broll/insert-existing rejects seconds that are not real times', () => {
  it('rejects an INFINITE offset — `z.number().min(0)` lets Infinity through', async () => {
    const res = await insertRaw(`{"video_file_id":"${VIDEO_ID}","global_offset_sec":1e400,"start_sec":0,"end_sec":5}`);
    expect(res.statusCode).toBe(400);
    expect(writes.inserted).toEqual([]);
  });

  it('rejects an infinite end_sec', async () => {
    const res = await insertRaw(`{"video_file_id":"${VIDEO_ID}","global_offset_sec":0,"start_sec":0,"end_sec":1e400}`);
    expect(res.statusCode).toBe(400);
    expect(writes.inserted).toEqual([]);
  });

  it('rejects an offset past any plausible timeline', async () => {
    expect((await insert({ video_file_id: VIDEO_ID, global_offset_sec: 1e12, start_sec: 0, end_sec: 5 })).statusCode).toBe(400);
  });

  it('still rejects a negative offset and an interval that does not move forward', async () => {
    expect((await insert({ video_file_id: VIDEO_ID, global_offset_sec: -1, start_sec: 0, end_sec: 5 })).statusCode).toBe(400);
    expect((await insert({ video_file_id: VIDEO_ID, global_offset_sec: 0, start_sec: 5, end_sec: 5 })).statusCode).toBe(400);
  });
});

describe('POST /broll/insert-existing still inserts the one shape it is meant to', () => {
  it('creates a true b-roll row', async () => {
    const res = await insert({ video_file_id: VIDEO_ID, global_offset_sec: 12, start_sec: 1, end_sec: 6 });
    expect(res.statusCode).toBe(201);
    expect(writes.inserted[0]).toMatchObject({
      track: 'broll', type: 'broll', video_file_id: VIDEO_ID, global_offset_sec: 12,
      start_sec: 1, end_sec: 6,
    });
  });

  it('defaults end_sec to the source duration', async () => {
    const res = await insert({ video_file_id: VIDEO_ID, global_offset_sec: 0 });
    expect(res.statusCode).toBe(201);
    expect(writes.inserted[0]).toMatchObject({ start_sec: 0, end_sec: 30 });
  });

  it('writes a row that the SHARED rule set considers well-formed', async () => {
    // The property the census credits this endpoint with — checked against the one definition the
    // player and the sections endpoints use, so it cannot drift away from them.
    await insert({ video_file_id: VIDEO_ID, global_offset_sec: 12, start_sec: 1, end_sec: 6 });
    expect(timelineSectionViolations(writes.inserted[0]!)).toEqual([]);
  });
});

// ── Segment-relative placement (D-01) ─────────────────────────────────────────

describe('POST /broll/insert-existing anchors what it places', () => {
  it('derives the anchor from the live timeline', async () => {
    // Second 40 is ten seconds into B. Storing that as `(B, 10)` is what lets the clip follow its
    // content when A is later re-transcoded to a different length — which is the whole of D-01.
    // Asserted as the PAIR, because a broken implementation that stored the absolute in both
    // columns would still produce a row with "an anchor".
    await insert({ video_file_id: VIDEO_ID, global_offset_sec: 40, start_sec: 0, end_sec: 6 });
    expect(writes.inserted[0]).toMatchObject({
      global_offset_sec: 40,
      anchor_video_file_id: MAIN_B,
      anchor_offset_sec: 10,
      placement_mode: 'segment',
    });
  });

  it('leaves the row legacy when there is no main video to anchor to', async () => {
    mocks.video_files.findMany.mockResolvedValue([{ id: VIDEO_ID, duration_sec: 30, is_broll: true }]);
    await insert({ video_file_id: VIDEO_ID, global_offset_sec: 40, start_sec: 0, end_sec: 6 });
    expect(writes.inserted[0]).toMatchObject({
      global_offset_sec: 40, anchor_video_file_id: null, placement_mode: 'legacy_absolute',
    });
  });
});

describe('POST /broll/generate captures the anchor AT ENQUEUE', () => {
  const generate = (body: Record<string, unknown>) => app.inject({
    method: 'POST', url: `/api/v1/projects/${PROJECT_ID}/broll/generate`, payload: body,
  });

  it('stores the segment the author aimed at on the JOB ROW', async () => {
    // THE RACE. This job runs for up to twenty-five minutes and the timeline stays editable the
    // whole time, so working the anchor out when the job FINISHES would read a layout the author
    // may never have seen — the same drift the anchor exists to end, with a wider window. It is
    // resolved once, here, and the finaliser copies it verbatim onto the published section.
    const res = await generate({
      prompt: 'a cat on a roof', model: 'kling', target_duration_sec: 5,
      target_global_offset_sec: 40,
    });
    expect(res.statusCode).toBe(201);
    expect(writes.inserted[0]).toMatchObject({
      target_global_offset_sec: 40,
      target_anchor_video_file_id: MAIN_B,
      target_anchor_offset_sec: 10,
    });
  });

  it('enqueues with a NULL anchor when there is no main video to aim at', async () => {
    mocks.video_files.findMany.mockResolvedValue([{ id: VIDEO_ID, duration_sec: 30, is_broll: true }]);
    await generate({
      prompt: 'a cat on a roof', model: 'kling', target_duration_sec: 5,
      target_global_offset_sec: 40,
    });
    expect(writes.inserted[0]).toMatchObject({
      target_global_offset_sec: 40, target_anchor_video_file_id: null, target_anchor_offset_sec: null,
    });
  });
});
