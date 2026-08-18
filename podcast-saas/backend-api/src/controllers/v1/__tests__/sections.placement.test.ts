/**
 * /sections — the WRITE side of D-01, and the one prohibition that governs it.
 *
 * The ruling is that no row is converted behind its author's back. Mapping a stored absolute second
 * onto today's segments records TODAY's position as the author's permanent intent, and if the row
 * has already drifted — the whole premise of D-01 — that makes the drift unrecoverable. So a row
 * becomes anchored in exactly two situations, both of which are the author asserting a position at
 * this instant: it is being CREATED, or it is being MOVED.
 *
 * WHAT A BROKEN IMPLEMENTATION WOULD ALSO SATISFY. "The insert carried an anchor" is satisfied by
 * an implementation that anchors everything, including the untouched rows the ruling forbids
 * touching — so the negative tests here carry as much weight as the positive ones, and they assert
 * on THE EXACT KEY SET handed to `.set()`, not merely on the absence of a value. Likewise "the
 * PATCH stored an anchor" is satisfied by one that computes the anchor once and never refreshes it,
 * which would make every subsequent drag a no-op in the viewer while looking correct in the
 * database; that is why the re-drag test asserts the anchor CHANGED.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerSectionsRoutes } from '../sections.controller.js';

const mocks = vi.hoisted(() => ({
  projects:          { findFirst: vi.fn() },
  timeline_sections: { findMany: vi.fn(), findFirst: vi.fn() },
  simulations:       { findMany: vi.fn(), findFirst: vi.fn() },
  video_files:       { findMany: vi.fn(), findFirst: vi.fn() },
  branch_sequences:  { findMany: vi.fn() },
}));

const writes = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  inserted: [] as Record<string, unknown>[],
  patched: [] as Record<string, unknown>[],
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: mocks,
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        writes.inserted.push(v);
        return { returning: async () => [writes.row] };
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        writes.patched.push(v);
        return { where: () => ({ returning: async () => [writes.row] }) };
      },
    }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  projects: Symbol('projects'), timeline_sections: Symbol('timeline_sections'),
  simulations: Symbol('simulations'), video_files: Symbol('video_files'),
  branch_sequences: Symbol('branch_sequences'),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })), and: vi.fn(() => ({ type: 'and' })),
  asc: vi.fn(() => ({ type: 'asc' })),
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
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({
    getPublicUrl: (k: string) => `https://cdn.example.com/${k}`,
    getSimPublicUrl: (k: string) => `https://cdn.example.com/sim-public/${k}`,
  }),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const PROJECT_ID = 'proj-1';

/** A = [0,30), B = [30,70). `src` is a b-roll asset and is NOT part of the concatenation. */
const VIDEOS = [
  { id: 'A', duration_sec: 30, is_broll: false },
  { id: 'B', duration_sec: 40, is_broll: false },
  { id: 'src', duration_sec: 6, is_broll: true },
];

const section = (over: Record<string, unknown> = {}) => ({
  id: 'sec-1', project_id: PROJECT_ID, video_file_id: 'src', track: 'broll', type: 'broll',
  start_sec: 0, end_sec: 6, label: 'A', notes: null, sort_order: null,
  simulation_url: null, simulation_id: null, sim_script: null, sim_prompt: null, sim_meta: null,
  simple_ui: false, auto_script: true,
  global_offset_sec: 40, clip_source_video_id: null, clip_source_image_id: null,
  clip_source_audio_id: null, clip_in_sec: 0, broll_volume: 1, camera_movement: 'zoom_in',
  anchor_video_file_id: null, anchor_offset_sec: null, placement_mode: 'legacy_absolute',
  ...over,
});

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  writes.row = section();
  writes.inserted.length = 0;
  writes.patched.length = 0;
  mocks.projects.findFirst.mockResolvedValue({ id: PROJECT_ID });
  mocks.timeline_sections.findMany.mockResolvedValue([]);
  mocks.timeline_sections.findFirst.mockResolvedValue(section());
  mocks.video_files.findFirst.mockResolvedValue({ id: 'src', project_id: PROJECT_ID });
  mocks.video_files.findMany.mockResolvedValue(VIDEOS);
  mocks.simulations.findMany.mockResolvedValue([]);
  mocks.simulations.findFirst.mockResolvedValue(null);
  mocks.branch_sequences.findMany.mockResolvedValue([]);

  app = Fastify();
  await registerSectionsRoutes(app);
  await app.ready();
});

const post = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/v1/projects/${PROJECT_ID}/sections`, payload });
const patch = (payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/api/v1/projects/${PROJECT_ID}/sections/sec-1`, payload });
const get = (path: string) =>
  app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}${path}` });

const brollBody = (over: Record<string, unknown> = {}) => ({
  video_file_id: 'src', start_sec: 0, end_sec: 6, type: 'broll',
  track: 'broll', global_offset_sec: 40, ...over,
});

// ── New writes are anchored ───────────────────────────────────────────────────

describe('POST anchors what the author places', () => {
  it('derives the anchor from the live timeline — second 40 is ten seconds into B', async () => {
    expect((await post(brollBody())).statusCode).toBe(201);
    expect(writes.inserted[0]).toMatchObject({
      global_offset_sec: 40,
      anchor_video_file_id: 'B',
      anchor_offset_sec: 10,
      placement_mode: 'segment',
    });
  });

  it('keeps the absolute second alongside it — the fallback the dual read needs', async () => {
    // Expand/contract: an application rollback must find the row exactly as it left it.
    await post(brollBody({ global_offset_sec: 7.5 }));
    expect(writes.inserted[0]!.global_offset_sec).toBe(7.5);
    expect(writes.inserted[0]!.anchor_video_file_id).toBe('A');
    expect(writes.inserted[0]!.anchor_offset_sec).toBe(7.5);
  });

  it('gives a seam to the LATER segment, matching every other surface', async () => {
    await post(brollBody({ global_offset_sec: 30 }));
    expect(writes.inserted[0]).toMatchObject({ anchor_video_file_id: 'B', anchor_offset_sec: 0 });
  });

  it('does NOT anchor a main-track row — it is positioned by its host and start_sec already', async () => {
    await post({ video_file_id: 'src', start_sec: 2, end_sec: 8, type: 'video', track: 'main' });
    expect(writes.inserted[0]).toMatchObject({
      anchor_video_file_id: null, anchor_offset_sec: null, placement_mode: 'legacy_absolute',
    });
  });

  it('leaves the row legacy when the project has no main video to anchor to', async () => {
    // The "no host" case: nothing to anchor to, so nothing is invented. The row still works.
    mocks.video_files.findMany.mockResolvedValue([{ id: 'src', duration_sec: 6, is_broll: true }]);
    expect((await post(brollBody())).statusCode).toBe(201);
    expect(writes.inserted[0]).toMatchObject({
      global_offset_sec: 40, anchor_video_file_id: null, placement_mode: 'legacy_absolute',
    });
  });

  it('refuses an explicit anchor pointing outside this project — the FK proves existence, not tenancy', async () => {
    const res = await post(brollBody({ anchor_video_file_id: 'someone-elses-video', anchor_offset_sec: 3 }));
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/not a main video of this project/);
    expect(writes.inserted).toEqual([]);
  });

  it('refuses an explicit anchor whose offset reaches into the NEXT segment', async () => {
    // Under the half-open rule that instant belongs to B, so a row claiming A does not sit in A.
    const res = await post(brollBody({ anchor_video_file_id: 'A', anchor_offset_sec: 30 }));
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/past the end of its segment/);
    expect(writes.inserted).toEqual([]);
  });

  it('allows the LAST segment its post-roll tail', async () => {
    expect((await post(brollBody({ anchor_video_file_id: 'B', anchor_offset_sec: 45 }))).statusCode).toBe(201);
    expect(writes.inserted[0]).toMatchObject({ anchor_video_file_id: 'B', anchor_offset_sec: 45 });
  });
});

// ── The prohibition ───────────────────────────────────────────────────────────

describe('PATCH converts nothing it was not asked to move', () => {
  const placementKeys = (patchBody: Record<string, unknown>) =>
    Object.keys(patchBody).filter((k) => k.startsWith('anchor_') || k === 'placement_mode');

  it('leaves an untouched row untouched when the PATCH is about something else', async () => {
    await patch({ label: 'renamed' });
    expect(writes.patched[0]).toEqual({ label: 'renamed' });
    expect(placementKeys(writes.patched[0]!)).toEqual([]);
  });

  it('does NOT anchor a row whose offset is re-sent unchanged — the undo/redo restore', async () => {
    // THE test for the ruling. The undo path PATCHes a section's ENTIRE stored body back, so an
    // implementation that anchored on the mere presence of `global_offset_sec` would silently
    // convert every legacy row the first time anyone pressed undo — canonising, permanently,
    // whatever drift that row had already accumulated. `40` is exactly what the row already holds.
    //
    // Asserted on the ROW THAT RESULTS rather than on the patch key set, because the restore echoes
    // the placement columns it read and an echo of `legacy_absolute` is not a conversion. What must
    // never happen is the row coming out anchored.
    await patch({ ...section(), global_offset_sec: 40 });
    const after = { ...section(), ...writes.patched[0]! };
    expect(after.placement_mode).toBe('legacy_absolute');
    expect(after.anchor_video_file_id).toBeNull();
    expect(after.anchor_offset_sec).toBeNull();
    expect(after.global_offset_sec).toBe(40);
  });

  it('does not anchor a legacy row that an OLD client echoes back without the placement columns', async () => {
    // The same restore from a client that has never heard of anchors: the body carries every
    // pre-D-01 column and none of the new ones. Nothing here may convert the row.
    const { anchor_video_file_id: _a, anchor_offset_sec: _b, placement_mode: _c, ...legacyBody } = section();
    await patch({ ...legacyBody, global_offset_sec: 40 });
    expect(placementKeys(writes.patched[0]!)).toEqual([]);
  });

  it('honours an explicit anchor sent WITHOUT an offset, and rewrites the fallback to match it', async () => {
    // The forward contract for a client that understands segments. The stored absolute is updated
    // to the second the anchor resolves to, so the dual read's two representations agree at rest —
    // otherwise the row would jump the day its anchor stopped resolving.
    await patch({ anchor_video_file_id: 'B', anchor_offset_sec: 20 });
    expect(writes.patched[0]).toMatchObject({
      anchor_video_file_id: 'B', anchor_offset_sec: 20, placement_mode: 'segment', global_offset_sec: 50,
    });
  });

  it('a moved offset beats a STALE anchor sent alongside it', async () => {
    // A restore replaying a snapshot from before the last drag sends the new second next to the old
    // anchor. Honouring the anchor would silently discard the move; deriving honours it.
    mocks.timeline_sections.findFirst.mockResolvedValue(section({
      global_offset_sec: 40, placement_mode: 'segment', anchor_video_file_id: 'B', anchor_offset_sec: 10,
    }));
    await patch({ global_offset_sec: 12, anchor_video_file_id: 'B', anchor_offset_sec: 10 });
    expect(writes.patched[0]).toMatchObject({
      global_offset_sec: 12, anchor_video_file_id: 'A', anchor_offset_sec: 12, placement_mode: 'segment',
    });
  });

  it('DOES anchor when the author drags it somewhere new', async () => {
    await patch({ global_offset_sec: 50 });
    expect(writes.patched[0]).toMatchObject({
      global_offset_sec: 50, anchor_video_file_id: 'B', anchor_offset_sec: 20, placement_mode: 'segment',
    });
  });

  it('RE-derives on a second drag of an already-anchored row', async () => {
    // Without this the dual read — which takes the anchor first — would keep answering with the
    // OLD moment, so the drag would land in the database and do nothing in the viewer. The
    // assertion is that the anchor MOVED, which an implementation that only anchors once fails.
    mocks.timeline_sections.findFirst.mockResolvedValue(section({
      global_offset_sec: 40, placement_mode: 'segment', anchor_video_file_id: 'B', anchor_offset_sec: 10,
    }));
    await patch({ global_offset_sec: 12 });
    expect(writes.patched[0]).toMatchObject({
      anchor_video_file_id: 'A', anchor_offset_sec: 12, placement_mode: 'segment',
    });
  });

  it('never anchors a main-track row, however it is dragged', async () => {
    mocks.timeline_sections.findFirst.mockResolvedValue(section({
      track: 'main', type: 'clip', video_file_id: 'B', clip_source_video_id: 'lib', global_offset_sec: null,
    }));
    await patch({ start_sec: 12, end_sec: 18 });
    expect(placementKeys(writes.patched[0]!)).toEqual([]);
  });
});

// ── The read side ─────────────────────────────────────────────────────────────

describe('GET /sections serves the RESOLVED second', () => {
  it('changes nothing for a legacy row', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([section({ global_offset_sec: 47 })]);
    const rows = (await get('/sections')).json() as Array<Record<string, unknown>>;
    expect(rows[0]!.global_offset_sec).toBe(47);
    expect(rows[0]!.placement).toMatchObject({ absolute_sec: 47, source: 'absolute', degradation: null });
  });

  it('serves an anchored row where the VIEWER will play it, not where the column says', async () => {
    // The editor lays its overlay track out from this field. If it kept reading the raw column
    // while the viewer read the anchor, a re-transcode would show the clip at two different seconds
    // on the two surfaces — D-01 again, on the surface the author is looking at.
    mocks.timeline_sections.findMany.mockResolvedValue([section({
      global_offset_sec: 40, placement_mode: 'segment', anchor_video_file_id: 'B', anchor_offset_sec: 10,
    })]);
    mocks.video_files.findMany.mockResolvedValue([
      { id: 'A', duration_sec: 25, is_broll: false },      // re-transcoded five seconds shorter
      { id: 'B', duration_sec: 40, is_broll: false },
      { id: 'src', duration_sec: 6, is_broll: true },
    ]);
    const rows = (await get('/sections')).json() as Array<Record<string, unknown>>;
    expect(rows[0]!.global_offset_sec).toBe(35);
    expect(rows[0]!.placement).toMatchObject({
      absolute_sec: 35, source: 'anchor', containing_segment_id: 'B', post_roll_sec: 0,
    });
  });

  it('does not overwrite the offset of a main-track row', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([section({
      track: 'main', type: 'video', video_file_id: 'B', start_sec: 5, end_sec: 9, global_offset_sec: null,
    })]);
    const rows = (await get('/sections')).json() as Array<Record<string, unknown>>;
    expect(rows[0]!.global_offset_sec).toBeNull();
    expect(rows[0]!.placement).toMatchObject({ absolute_sec: 35, source: 'native_host' });
  });
});

// ── The dry run ───────────────────────────────────────────────────────────────

describe('GET /sections/placement-report', () => {
  it('WRITES NOTHING', async () => {
    // The whole point of the endpoint. Asserted against the db mock rather than by reading the
    // handler, so it stays true of whatever the handler becomes.
    mocks.timeline_sections.findMany.mockResolvedValue([section({ global_offset_sec: 40 })]);
    await get('/sections/placement-report');
    expect(writes.inserted).toEqual([]);
    expect(writes.patched).toEqual([]);
  });

  it('nominates the convertible row and shows the anchor it would get', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([section({ id: 'x', global_offset_sec: 40 })]);
    const body = (await get('/sections/placement-report')).json();
    expect(body.candidates).toEqual([{
      sectionId: 'x', absoluteSec: 40, anchor_video_file_id: 'B', anchor_offset_sec: 10, postRollSec: 0,
    }]);
    expect(body.main_timeline).toMatchObject({ total_sec: 70, segment_count: 2, has_unknown_duration: false });
  });

  it('excludes every row of a BRANCHED project', async () => {
    // Playback there is a graph, not one concatenation — the linear cumulative sum is not its
    // timeline, so no mapping computed from it means anything.
    mocks.branch_sequences.findMany.mockResolvedValue([{ id: 'seq-1' }]);
    mocks.timeline_sections.findMany.mockResolvedValue([section({ id: 'x', global_offset_sec: 40 })]);
    const body = (await get('/sections/placement-report')).json();
    expect(body.branched).toBe(true);
    expect(body.candidates).toEqual([]);
    expect(body.excludedByReason.branched).toBe(1);
  });

  it('excludes rows sitting at or after a segment whose duration has not landed', async () => {
    mocks.video_files.findMany.mockResolvedValue([
      { id: 'A', duration_sec: null, is_broll: false },
      { id: 'B', duration_sec: 40, is_broll: false },
    ]);
    mocks.timeline_sections.findMany.mockResolvedValue([section({ id: 'x', global_offset_sec: 10 })]);
    const body = (await get('/sections/placement-report')).json();
    expect(body.candidates).toEqual([]);
    expect(body.excludedByReason.unknown_duration).toBe(1);
    expect(body.main_timeline.has_unknown_duration).toBe(true);
  });

  it('does not collide with PATCH /sections/:sid', async () => {
    // `placement-report` is a static path under the same prefix as the `:sid` param route.
    const res = await get('/sections/placement-report');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('candidates');
  });
});
