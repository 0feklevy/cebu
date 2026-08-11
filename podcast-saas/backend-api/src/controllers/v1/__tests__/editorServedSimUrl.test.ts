/**
 * The editor's two bootstrap reads resolve the revision pointer (audit §9.6, Stage 0).
 *
 * GET /projects/:id/sections and GET /projects/:id/editor-state hand `timeline_sections` rows to
 * the editor. The stored `simulation_url` is what a section last PUBLISHED — after a republish of
 * any other section of the same package, or after a rollback, those are a retired revision's
 * bytes. The viewer has resolved `simulations.active_revision_entry_key` on the way out since
 * P0.4; these routes did not, so the editor rendered retired bytes.
 *
 * Two things are pinned here and they pull in opposite directions:
 *   1. the SERVED url reflects the pointer, and
 *   2. the STORED url is returned untouched — the editor copies it verbatim into PATCH/POST bodies
 *      (undo/redo restore, duplicate section), so a rewrite on read would persist a resolved URL
 *      into a column whose meaning is "what this section published".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerSectionsRoutes } from '../sections.controller.js';
import { registerEditorStateRoutes } from '../editor-state.controller.js';

const mocks = vi.hoisted(() => ({
  projects:               { findFirst: vi.fn() },
  timeline_sections:      { findMany: vi.fn(), findFirst: vi.fn() },
  simulations:            { findMany: vi.fn(), findFirst: vi.fn() },
  video_files:            { findMany: vi.fn(), findFirst: vi.fn() },
  video_generation_jobs:  { findMany: vi.fn() },
  image_files:            { findMany: vi.fn() },
  audio_files:            { findMany: vi.fn() },
}));

vi.mock('../../../db/index.js', () => ({ db: { query: mocks } }));
vi.mock('../../../db/schema.js', () => ({
  projects: Symbol('projects'), timeline_sections: Symbol('timeline_sections'),
  simulations: Symbol('simulations'), video_files: Symbol('video_files'),
  video_generation_jobs: Symbol('video_generation_jobs'),
  image_files: Symbol('image_files'), audio_files: Symbol('audio_files'),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })), and: vi.fn(() => ({ type: 'and' })),
  asc: vi.fn(() => ({ type: 'asc' })), desc: vi.fn(() => ({ type: 'desc' })),
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
    getPublicUrl: (key: string) => `https://cdn.example.com/${key}`,
    getSimPublicUrl: (key: string) => `https://cdn.example.com/sim-public/${key}`,
    getPresignedDownloadUrl: async (key: string) => `https://cdn.example.com/signed/${key}`,
  }),
}));
const logged = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: logged.error, debug: vi.fn() },
}));

const PROJECT_ID = 'proj-1';
const REV = '11111111-1111-1111-1111-111111111111';
const ENTRY_KEY = `simulations/${PROJECT_ID}/sim-1/revisions/${REV}/package/index.html`;
const SERVED = `https://cdn.example.com/sim-public/${ENTRY_KEY}`;
/** A retired revision's URL — what generation stamped on this row when IT last published. */
const STORED = `https://cdn.example.com/sim-public/simulations/${PROJECT_ID}/sim-1/revisions/`
  + '00000000-0000-0000-0000-000000000000/package/index.html?section=sec-1&v=H1';

const section = (over: Record<string, unknown> = {}) => ({
  id: 'sec-1', project_id: PROJECT_ID, video_file_id: 'vid-1', track: 'main', type: 'simulation',
  start_sec: 0, end_sec: 10, label: 'A', simulation_id: 'sim-1', simulation_url: STORED,
  sim_script: 'main', sim_meta: null, simple_ui: false, auto_script: true, ...over,
});

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.projects.findFirst.mockResolvedValue({ id: PROJECT_ID });
  mocks.timeline_sections.findMany.mockResolvedValue([section()]);
  mocks.simulations.findMany.mockResolvedValue([{ id: 'sim-1', active_revision_entry_key: ENTRY_KEY }]);
  mocks.video_files.findMany.mockResolvedValue([]);
  mocks.video_generation_jobs.findMany.mockResolvedValue([]);
  mocks.image_files.findMany.mockResolvedValue([]);
  mocks.audio_files.findMany.mockResolvedValue([]);

  app = Fastify();
  await registerSectionsRoutes(app);
  await registerEditorStateRoutes(app);
  await app.ready();
});

const listSections = async () => {
  const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/sections` });
  expect(res.statusCode).toBe(200);
  return res.json() as Array<Record<string, unknown>>;
};
const editorState = async () => {
  const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/editor-state` });
  expect(res.statusCode).toBe(200);
  return (res.json() as { sections: Array<Record<string, unknown>> }).sections;
};

describe('GET /sections', () => {
  it('serves the ACTIVE revision, with the query preserved', async () => {
    const [row] = await listSections();
    expect(row.simulation_served_url).toBe(`${SERVED}?section=sec-1&v=H1`);
  });

  it('returns the STORED url untouched, because the editor writes it back', async () => {
    const [row] = await listSections();
    expect(row.simulation_url).toBe(STORED);
  });

  it('leaves a legacy (un-revisioned) simulation byte-identical', async () => {
    mocks.simulations.findMany.mockResolvedValue([{ id: 'sim-1', active_revision_entry_key: null }]);
    const [row] = await listSections();
    expect(row.simulation_url).toBe(STORED);
    expect(row.simulation_served_url).toBe(STORED);
  });

  it('preserves a url that has no query at all', async () => {
    const bare = 'https://cdn.example.com/sim-public/legacy/index.html';
    mocks.timeline_sections.findMany.mockResolvedValue([section({ simulation_url: bare })]);
    const [row] = await listSections();
    expect(row.simulation_served_url).toBe(SERVED);
  });

  it('emits null for a section with no simulation', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([
      section({ id: 'sec-x', type: 'video', simulation_id: null, simulation_url: null }),
    ]);
    const [row] = await listSections();
    expect(row.simulation_served_url).toBeNull();
  });

  it('reads the pointers ONCE for the whole list — never one query per section', async () => {
    mocks.timeline_sections.findMany.mockResolvedValue([
      section({ id: 'sec-1' }),
      section({ id: 'sec-2', simulation_url: `${STORED}&x=2` }),
      section({ id: 'sec-3', simulation_id: 'sim-2' }),
      section({ id: 'sec-4', simulation_id: null, simulation_url: null }),
    ]);
    mocks.simulations.findMany.mockResolvedValue([
      { id: 'sim-1', active_revision_entry_key: ENTRY_KEY },
      { id: 'sim-2', active_revision_entry_key: null },
    ]);
    const rows = await listSections();
    expect(mocks.simulations.findMany).toHaveBeenCalledTimes(1);
    expect(rows.map(r => r.simulation_served_url)).toEqual([
      `${SERVED}?section=sec-1&v=H1`,
      `${SERVED}?section=sec-1&v=H1&x=2`,
      STORED,
      null,
    ]);
  });

  it('does not query at all for a project with no simulation sections', async () => {
    // Most projects. The lookup is skipped, and every section still carries the field.
    mocks.timeline_sections.findMany.mockResolvedValue([
      section({ id: 'sec-1', type: 'video', simulation_id: null, simulation_url: null }),
    ]);
    const rows = await listSections();
    expect(mocks.simulations.findMany).not.toHaveBeenCalled();
    expect(rows[0]).toHaveProperty('simulation_served_url', null);
  });

  it('keeps a narrow column select — the row also carries guidance and canary_report', async () => {
    await listSections();
    const args = mocks.simulations.findMany.mock.calls[0]?.[0] as { columns?: Record<string, boolean> };
    const selected = Object.keys(args.columns ?? {});

    // What this guards is the SIZE of the row, not its exact shape. `simulations` carries
    // `guidance`, `bridge_functions` and `canary_report` — JSONB that can run to hundreds of KB per
    // row — and pulling any of them to resolve a URL would make opening the editor pay for data no
    // caller here reads.
    //
    // Asserted as "these must be absent, those must be present" rather than a deep-equal on the
    // whole set, because the set legitimately grows: this select is the agreed home for narrow
    // per-simulation scalars the editor bootstrap needs (migration 057 added
    // `requires_import_maps` to it for exactly that reason, and a deep-equal turned that into a
    // spurious failure). A new SCALAR here is fine; a new JSONB is the regression.
    for (const heavy of ['guidance', 'guidance_meta', 'bridge_functions', 'canary_report']) {
      expect(selected, `the editor bootstrap must not select ${heavy}`).not.toContain(heavy);
    }
    expect(selected).toEqual(expect.arrayContaining([
      'id', 'active_revision_entry_key', 'requires_import_maps',
      // audit P0.5. Absent, the editor's apply gate could only ever answer UNKNOWN — for every
      // package, on the same warm-then-dispatch pool the viewer uses — and a warm document that
      // has already painted arms no ceiling, so the editor's cover ran for the whole section.
      'bridge_ack_capable',
    ]));
  });

  it('carries the bridge ack capability of the SERVED revision to the editor', async () => {
    mocks.simulations.findMany.mockResolvedValue([
      { id: 'sim-1', active_revision_entry_key: ENTRY_KEY, bridge_ack_capable: false },
    ]);
    const [row] = await listSections();
    expect(row.bridge_ack_capable).toBe(false);
  });

  it('reports the capability as NULL when nothing recorded one', async () => {
    const [row] = await listSections();       // the default pointer row has no capability columns
    expect(row.bridge_ack_capable).toBeNull();
    expect((await listSections())[0].requires_import_maps).toBeNull();
  });

  it('degrades to stored urls, loudly, when the pointer column cannot be read', async () => {
    // Migration 050 not applied yet: the editor must still open, with today's behaviour.
    mocks.simulations.findMany.mockRejectedValue(Object.assign(new Error('boom'), { code: '42703' }));
    const [row] = await listSections();
    expect(row.simulation_served_url).toBe(STORED);
    expect(logged.error).toHaveBeenCalled();
  });
});

describe('GET /editor-state', () => {
  it('resolves the pointer exactly as GET /sections does', async () => {
    const [row] = await editorState();
    expect(row.simulation_served_url).toBe(`${SERVED}?section=sec-1&v=H1`);
    expect(row.simulation_url).toBe(STORED);
  });

  it('adds NO round-trip — it resolves from the simulation rows it already loads', async () => {
    // This endpoint exists to replace six list calls with one; paying for a seventh query to
    // resolve a pointer already present on those rows would undo the reason it exists.
    await editorState();
    expect(mocks.simulations.findMany).toHaveBeenCalledTimes(1);
  });

  it('carries the ack capability, exactly as GET /sections does', async () => {
    mocks.simulations.findMany.mockResolvedValue([
      { id: 'sim-1', active_revision_entry_key: ENTRY_KEY, bridge_ack_capable: true },
    ]);
    const [row] = await editorState();
    expect(row.bridge_ack_capable).toBe(true);
  });

  it('survives an image deployed AHEAD of migrations 055/057 — it retries without those columns', async () => {
    // This read has no `columns` list, so Drizzle selects whatever the schema declares — including
    // `bridge_ack_capable` and `requires_import_maps`. Before this guard a Postgres 42703 from
    // either of them took down the WHOLE editor: videos, sections, images, audio and b-roll jobs
    // with it, because this endpoint is the editor's single bootstrap read.
    //
    // It RETRIES rather than degrading to an empty list. `[]` would tell the editor the project has
    // no simulations at all; dropping the two post-migration columns returns every row otherwise
    // whole, with both facts reading UNKNOWN — the state both consumers already handle.
    mocks.simulations.findMany
      .mockRejectedValueOnce(Object.assign(new Error('column does not exist'), { code: '42703' }))
      .mockResolvedValueOnce([{ id: 'sim-1', active_revision_entry_key: ENTRY_KEY }]);

    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/editor-state` });
    expect(res.statusCode, 'one missing column took the whole editor down').toBe(200);
    const body = res.json() as { sections: Array<Record<string, unknown>>; simulations: unknown[] };
    expect(body.simulations, 'the retry must return the rows, not swallow them').toHaveLength(1);
    expect(body.sections[0].simulation_served_url).toBe(`${SERVED}?section=sec-1&v=H1`);
    expect(body.sections[0].bridge_ack_capable, 'a dropped column must read UNKNOWN').toBeNull();
    expect(logged.error).toHaveBeenCalled();

    const retryArgs = mocks.simulations.findMany.mock.calls[1]?.[0] as { columns?: Record<string, boolean> };
    expect(retryArgs.columns).toMatchObject({ bridge_ack_capable: false, requires_import_maps: false });
  });
});
