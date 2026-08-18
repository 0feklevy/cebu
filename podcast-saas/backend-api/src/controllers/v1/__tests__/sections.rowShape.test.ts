/**
 * POST/PATCH /sections — the write half of "what a timeline_sections row is".
 *
 * THE TABLE ENFORCES NOTHING. There is no CHECK constraint on `timeline_sections`; `track` is a
 * bare TEXT whose three legal values live in a COMMENT, `type` has no enum at all, and
 * `global_offset_sec` is nullable with no rule tying it to the track that needs it. Every other
 * write path into this table is a zod-validated endpoint that can only produce one shape — the
 * b-roll panel, the generator, the audio cutaway route. This one generic endpoint pair had no
 * runtime schema whatsoever (a hand-rolled four-field presence check and one interval comparison),
 * so it is the ONLY way the malformed shapes the census counts can be created:
 *
 *   • a b-roll row with NO position at all — four separate read sites then coerce the NULL to
 *     second zero, so it silently plays over the opening frames instead of failing;
 *   • the hybrid `track='broll' AND type='clip' AND clip_source_video_id IS NOT NULL`, which the
 *     viewer used to emit twice, the export renders once as a clip and the editor previews as
 *     b-roll — one row, three answers;
 *   • an interval whose end is not after its start, which the transcode clamp can then collapse.
 *
 * TWO THINGS THIS FILE PINS THAT ARE *NOT* BUGS, because the audit claimed they were:
 *
 *   1. PATCH is a TRUE PARTIAL UPDATE. Omitted fields are not nulled — the handler spreads only the
 *      keys the request sent. The tests below assert the exact key set handed to `.set()`.
 *   2. A MAIN-track row legitimately has a NULL `global_offset_sec`. Main sections are positioned by
 *      `start_sec` within their host video; requiring an offset there would manufacture a failure
 *      out of correct data.
 *
 * AND ONE DELIBERATE ASYMMETRY. POST is strict; PATCH may not INTRODUCE a violation but may leave
 * one it found alone. That is not laxity, it is the only thing that keeps the editor usable on the
 * rows the missing constraints already let through: the undo/redo restore path posts a section's
 * entire stored body back through PATCH, so holding PATCH to "the result must be perfect" would
 * make every undo in a project fail because of one legacy row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerSectionsRoutes } from '../sections.controller.js';

const mocks = vi.hoisted(() => ({
  projects:          { findFirst: vi.fn() },
  timeline_sections: { findMany: vi.fn(), findFirst: vi.fn() },
  simulations:       { findMany: vi.fn(), findFirst: vi.fn() },
  video_files:       { findMany: vi.fn(), findFirst: vi.fn() },
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

const section = (over: Record<string, unknown> = {}) => ({
  id: 'sec-1', project_id: PROJECT_ID, video_file_id: 'vid-1', track: 'main', type: 'video',
  start_sec: 5, end_sec: 10, label: 'A', notes: null, sort_order: null,
  simulation_url: null, simulation_id: null, sim_script: null, sim_prompt: null, sim_meta: null,
  simple_ui: false, auto_script: true,
  global_offset_sec: null, clip_source_video_id: null, clip_source_image_id: null,
  clip_source_audio_id: null, clip_in_sec: 0, broll_volume: 1, camera_movement: 'zoom_in',
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
  mocks.video_files.findFirst.mockResolvedValue({ id: 'vid-1', project_id: PROJECT_ID });
  mocks.simulations.findMany.mockResolvedValue([]);
  mocks.simulations.findFirst.mockResolvedValue(null);

  app = Fastify();
  await registerSectionsRoutes(app);
  await app.ready();
});

const post = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/v1/projects/${PROJECT_ID}/sections`, payload });

const patch = (payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/api/v1/projects/${PROJECT_ID}/sections/sec-1`, payload });

/** A well-formed b-roll create body — the shape the b-roll panel produces. */
const brollBody = (over: Record<string, unknown> = {}) => ({
  video_file_id: 'vid-1', start_sec: 0, end_sec: 8, type: 'broll',
  track: 'broll', global_offset_sec: 30, ...over,
});

// ── POST: the shapes that must not be creatable ───────────────────────────────

describe('POST /sections refuses to create a malformed row', () => {
  it('rejects a broll section with no global_offset_sec — the only thing that positions it', async () => {
    const res = await post(brollBody({ global_offset_sec: undefined }));
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/global_offset_sec/);
    expect(writes.inserted).toEqual([]);
  });

  it('rejects an explicit NULL offset on a broll section', async () => {
    expect((await post(brollBody({ global_offset_sec: null }))).statusCode).toBe(400);
  });

  it('rejects a NULL offset on an audio-track section for the same reason', async () => {
    const res = await post({
      video_file_id: 'vid-1', start_sec: 0, end_sec: 8, type: 'audio', track: 'audio',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects the hybrid: a broll row carrying a clip source', async () => {
    // The row the viewer emitted twice, at two different offsets, into one array.
    const res = await post(brollBody({ type: 'clip', clip_source_video_id: 'vid-2' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/clip source|track/i);
    expect(writes.inserted).toEqual([]);
  });

  it('rejects the hybrid even when `type` is the harmless-looking one', async () => {
    // The residue shape: one Save from the section editor rewrites `type` to 'video' and leaves the
    // clip pointer behind, where it lies dormant until something sets `type` back to 'clip'.
    expect((await post(brollBody({ type: 'video', clip_source_video_id: 'vid-2' }))).statusCode).toBe(400);
  });

  it('rejects two clip sources on one row', async () => {
    const res = await post({
      video_file_id: 'vid-1', start_sec: 0, end_sec: 8, type: 'clip', track: 'main',
      clip_source_video_id: 'vid-2', clip_source_image_id: 'img-1',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an interval that does not move forward', async () => {
    expect((await post({ video_file_id: 'vid-1', start_sec: 5, end_sec: 5, type: 'video' })).statusCode).toBe(400);
    expect((await post({ video_file_id: 'vid-1', start_sec: 9, end_sec: 2, type: 'video' })).statusCode).toBe(400);
  });

  it('rejects seconds that are negative or absurd', async () => {
    expect((await post({ video_file_id: 'vid-1', start_sec: -1, end_sec: 5, type: 'video' })).statusCode).toBe(400);
    expect((await post({ video_file_id: 'vid-1', start_sec: 0, end_sec: 1e12, type: 'video' })).statusCode).toBe(400);
    expect((await post(brollBody({ global_offset_sec: -3 }))).statusCode).toBe(400);
  });

  it('rejects seconds that are not numbers at all', async () => {
    expect((await post({ video_file_id: 'vid-1', start_sec: '0', end_sec: 5, type: 'video' })).statusCode).toBe(400);
  });

  it('still rejects the missing required fields it always rejected', async () => {
    expect((await post({ start_sec: 0, end_sec: 5, type: 'video' })).statusCode).toBe(400);
    expect((await post({ video_file_id: 'vid-1', end_sec: 5, type: 'video' })).statusCode).toBe(400);
    expect((await post({ video_file_id: 'vid-1', start_sec: 0, end_sec: 5 })).statusCode).toBe(400);
  });
});

// ── POST: everything legitimate still goes through ────────────────────────────

describe('POST /sections still creates every legitimate shape', () => {
  it('creates a well-formed b-roll', async () => {
    const res = await post(brollBody());
    expect(res.statusCode).toBe(201);
    expect(writes.inserted[0]).toMatchObject({ track: 'broll', global_offset_sec: 30 });
  });

  it('creates a MAIN section with no global offset — main rows are positioned by start_sec', async () => {
    // The audit claimed a null offset is always a defect. It is not: this row is correct.
    const res = await post({ video_file_id: 'vid-1', start_sec: 0, end_sec: 10, type: 'video' });
    expect(res.statusCode).toBe(201);
    expect(writes.inserted[0]).toMatchObject({ track: 'main', global_offset_sec: null });
  });

  it('creates a main-track "Existing Visual" clip', async () => {
    const res = await post({
      video_file_id: 'vid-1', start_sec: 12, end_sec: 20, type: 'clip', track: 'main',
      clip_source_video_id: 'vid-2', clip_in_sec: 3,
    });
    expect(res.statusCode).toBe(201);
  });

  it('creates the PROVISIONAL empty clip the editor\'s Add button makes', async () => {
    // TimelinePanel's Add → "Existing clip" posts a type='clip' row with no source at all and lets
    // the user pick one afterwards. It renders nowhere until they do, which is correct — but it
    // must remain creatable, or the Add button stops working.
    const res = await post({ video_file_id: 'vid-1', start_sec: 0, end_sec: 10, type: 'clip' });
    expect(res.statusCode).toBe(201);
  });

  it('creates a simulation section', async () => {
    const res = await post({
      video_file_id: 'vid-1', start_sec: 0, end_sec: 10, type: 'simulation', simulation_id: 'sim-1',
    });
    expect(res.statusCode).toBe(201);
  });

  it('creates an audio cutaway that DOES carry its offset', async () => {
    const res = await post({
      video_file_id: 'vid-1', start_sec: 0, end_sec: 6, type: 'broll', track: 'broll',
      clip_source_audio_id: 'aud-1', global_offset_sec: 15,
    });
    expect(res.statusCode).toBe(201);
  });

  it('preserves the duplicate-section body verbatim, nulls and all', async () => {
    // The editor's duplicate path re-posts a section's whole stored body with a new position.
    const res = await post({
      video_file_id: 'vid-1', start_sec: 0, end_sec: 10, type: 'video', label: null, notes: null,
      sort_order: null, simulation_url: null, simulation_id: null, sim_script: null,
      sim_prompt: null, sim_meta: null, track: 'main', global_offset_sec: null,
      clip_source_video_id: null, clip_in_sec: 0, broll_volume: 1, simple_ui: false,
      auto_script: true, clip_source_image_id: null, camera_movement: 'zoom_in',
      clip_source_audio_id: null,
    });
    expect(res.statusCode).toBe(201);
  });
});

// ── PATCH: still a true partial update ────────────────────────────────────────

describe('PATCH /sections is a TRUE partial update', () => {
  it('writes ONLY the keys the request sent — omitted fields are not nulled', async () => {
    // The audit claimed the handler nulls omitted fields. It does not, and this pins that it never
    // starts to: a validator that "normalises" the body into a full row would do exactly that.
    const res = await patch({ label: 'renamed' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(writes.patched[0]!).sort()).toEqual(['label']);
  });

  it('writes no column the endpoint does not declare', async () => {
    // The handler used to spread the RAW body into the update. `project_id` and `video_file_id` are
    // real columns and neither is a declared field of this endpoint, so a request naming either one
    // rewrote it — repointing a section at another project's video, or moving it into another
    // project outright, with no ownership check anywhere on the path. The schema now strips every
    // key it does not declare, so the update can only ever touch this endpoint's own fields.
    const res = await patch({ label: 'x', video_file_id: 'vid-elsewhere', project_id: 'proj-2' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(writes.patched[0]!).sort()).toEqual(['label']);
  });

  it('leaves clip fields untouched when they are not sent', async () => {
    mocks.timeline_sections.findFirst.mockResolvedValue(
      section({ type: 'clip', clip_source_video_id: 'vid-2', clip_in_sec: 4 }),
    );
    await patch({ start_sec: 6, end_sec: 12 });
    expect(Object.keys(writes.patched[0]!).sort()).toEqual(['end_sec', 'start_sec']);
  });
});

// ── PATCH: may not INTRODUCE a violation ──────────────────────────────────────

describe('PATCH /sections cannot turn a healthy row into a malformed one', () => {
  it('rejects moving a clip section onto the broll track (hybrid, from the track side)', async () => {
    mocks.timeline_sections.findFirst.mockResolvedValue(
      section({ type: 'clip', clip_source_video_id: 'vid-2', global_offset_sec: 20 }),
    );
    const res = await patch({ track: 'broll' });
    expect(res.statusCode).toBe(400);
    expect(writes.patched).toEqual([]);
  });

  it('rejects attaching a clip source to a broll row (hybrid, from the source side)', async () => {
    mocks.timeline_sections.findFirst.mockResolvedValue(
      section({ track: 'broll', type: 'broll', global_offset_sec: 20 }),
    );
    const res = await patch({ clip_source_video_id: 'vid-2' });
    expect(res.statusCode).toBe(400);
    expect(writes.patched).toEqual([]);
  });

  it('rejects clearing the offset of a broll row', async () => {
    mocks.timeline_sections.findFirst.mockResolvedValue(
      section({ track: 'broll', type: 'broll', global_offset_sec: 20 }),
    );
    expect((await patch({ global_offset_sec: null })).statusCode).toBe(400);
  });

  it('rejects an end_sec that lands below the EXISTING start_sec', async () => {
    // The old check compared start to end only when the request sent BOTH, so a one-sided trim
    // could invert the interval and nothing noticed.
    mocks.timeline_sections.findFirst.mockResolvedValue(section({ start_sec: 5, end_sec: 10 }));
    const res = await patch({ end_sec: 3 });
    expect(res.statusCode).toBe(400);
    expect(writes.patched).toEqual([]);
  });

  it('rejects a start_sec that overtakes the EXISTING end_sec', async () => {
    mocks.timeline_sections.findFirst.mockResolvedValue(section({ start_sec: 5, end_sec: 10 }));
    expect((await patch({ start_sec: 11 })).statusCode).toBe(400);
  });

  it('still rejects an inverted interval sent in one request', async () => {
    expect((await patch({ start_sec: 9, end_sec: 2 })).statusCode).toBe(400);
  });

  it('rejects out-of-range seconds', async () => {
    expect((await patch({ global_offset_sec: -1 })).statusCode).toBe(400);
    expect((await patch({ clip_in_sec: 1e12 })).statusCode).toBe(400);
  });
});

// ── PATCH: an already-malformed row stays editable ────────────────────────────

describe('PATCH /sections does not brick the rows the missing constraints let through', () => {
  const BROKEN = () => section({ track: 'broll', type: 'broll', global_offset_sec: null });

  it('allows an unrelated edit to a row that is ALREADY missing its offset', async () => {
    // Refusing here would make the row uneditable and undeletable-by-undo — punishing the user for
    // a defect the API created.
    mocks.timeline_sections.findFirst.mockResolvedValue(BROKEN());
    const res = await patch({ label: 'still broken, still renameable' });
    expect(res.statusCode).toBe(200);
  });

  it('allows the undo/redo restore, which posts the whole stored body back', async () => {
    mocks.timeline_sections.findFirst.mockResolvedValue(BROKEN());
    const res = await patch({
      start_sec: 0, end_sec: 8, type: 'broll', label: 'A', notes: null, sort_order: null,
      track: 'broll', simulation_url: null, simulation_id: null, sim_script: null,
      sim_prompt: null, sim_meta: null, global_offset_sec: null, clip_source_video_id: null,
      clip_in_sec: 0, broll_volume: 1, simple_ui: false, auto_script: true,
      clip_source_image_id: null, camera_movement: 'zoom_in', clip_source_audio_id: null,
    });
    expect(res.statusCode).toBe(200);
  });

  it('allows a REPAIR — giving the broken row the offset it never had', async () => {
    mocks.timeline_sections.findFirst.mockResolvedValue(BROKEN());
    const res = await patch({ global_offset_sec: 12 });
    expect(res.statusCode).toBe(200);
    expect(writes.patched[0]).toMatchObject({ global_offset_sec: 12 });
  });

  it('allows the drag that repairs it — the b-roll move sends exactly this', async () => {
    mocks.timeline_sections.findFirst.mockResolvedValue(BROKEN());
    expect((await patch({ global_offset_sec: 41.5 })).statusCode).toBe(200);
  });
});
