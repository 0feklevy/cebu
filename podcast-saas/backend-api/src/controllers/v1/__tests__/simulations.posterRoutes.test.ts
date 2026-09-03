/**
 * The two routes the night run 2026-09-03 §6 added to the simulations controller, driven through
 * Fastify with every collaborator mocked at the module boundary — the CONTROLLER's contract:
 *
 *   GET  /api/v1/simulations/importable         — one listing query, ready sims only, the excluded
 *                                                   project dropped, project title + poster joined.
 *   POST /api/v1/projects/:id/sections/:sid/poster — the server decides the identity from the
 *                                                   section row with the SAME function the player
 *                                                   uses (sectionPosterKey.ts); renditions are PNGs
 *                                                   of exactly the sizes the aspect names; store and
 *                                                   invalidate land together, in that order.
 *
 * The audit that asked for this file put it plainly: "previewing a sim creates a sim_posters row
 * for its served revision" rested on reading code, and nothing went red when the wiring broke.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerSimulationsRoutes } from '../simulations.controller.js';
import { posterKeyForSection } from '../../../services/simulation/sectionPosterKey.js';
import { packageRevisionFor } from 'shared/sim/simRevision';
import { derivePackageRevision } from 'shared/sim/simIdentity';
import { posterIdentityString } from 'shared/sim/posterIdentity';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  projects:    { findMany: vi.fn(), findFirst: vi.fn() },
  simulations: { findMany: vi.fn(), findFirst: vi.fn() },
  sections:    { findFirst: vi.fn() },
  videoFiles:  { findMany: vi.fn() },
  editable:    vi.fn(),
  stills:      vi.fn(),
  getPoster:   vi.fn(),
  storePoster: vi.fn(),
  invalidate:  vi.fn(),
  order:       [] as string[],
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      projects:          mocks.projects,
      simulations:       mocks.simulations,
      timeline_sections: mocks.sections,
      video_files:       mocks.videoFiles,
    },
  },
}));
vi.mock('../../../db/schema.js', () => ({
  simulations:       { project_id: 'simulations.project_id', status: 'simulations.status', id: 'simulations.id', created_at: 'simulations.created_at' },
  timeline_sections: { id: 'timeline_sections.id', project_id: 'timeline_sections.project_id' },
  video_files:       { project_id: 'video_files.project_id', created_at: 'video_files.created_at' },
}));
vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  eq:      vi.fn((col: unknown, val: unknown) => ({ type: 'eq', col, val })),
  and:     vi.fn((...parts: unknown[]) => ({ type: 'and', parts })),
  inArray: vi.fn((col: unknown, vals: unknown[]) => ({ type: 'inArray', col, vals })),
  asc:     vi.fn((col: unknown) => ({ type: 'asc', col })),
}));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: (req: Record<string, unknown>, _reply: unknown, done: () => void) => {
    req.dbUser = { id: 'user-1', org_id: 'org-1' };
    done();
  },
}));
vi.mock('../../../services/collabAccess.js', () => ({
  editableProject: (id: string, user: unknown) => mocks.editable(id, user),
  projectsEditableByWhere: vi.fn(() => ({ type: 'editable-by' })),
}));
vi.mock('../../../services/library/buildLibraryView.js', () => ({
  loadSimBannerUrls: (rows: unknown) => mocks.stills(rows),
}));
vi.mock('../../../services/simulation/PosterService.js', () => ({
  posterService: {
    getPoster:   (...a: unknown[]) => mocks.getPoster(...a),
    storePoster: async (...a: unknown[]) => { mocks.order.push('store'); return mocks.storePoster(...a); },
    invalidate:  async (...a: unknown[]) => { mocks.order.push('invalidate'); return mocks.invalidate(...a); },
  },
}));
// Everything else the controller wires at module load, and none of it is reached by these routes.
vi.mock('../../../services/simulation/SimulationService.js', () => ({
  SimulationService: class {},
  deriveEntryRelPath: vi.fn(), getSimulationContentType: vi.fn(), isTextSimulationFile: vi.fn(),
}));
vi.mock('../../../services/simulation/SimulationImportService.js', () => ({ SimulationImportService: class {} }));
vi.mock('../../../services/simulation/GuidanceService.js', () => ({ GuidanceService: class {}, guidancePublishMeta: vi.fn() }));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({ getSimPublicUrl: (key: string) => `https://cdn.example.com/sim-public/${key}` }),
}));
vi.mock('../../../services/llm/LLMService.js', () => ({ LLMService: class {} }));
vi.mock('../../../services/secrets/ApiKeyService.js', () => ({ ApiKeyService: class {} }));
vi.mock('../../../services/usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-1';
const SECTION_ID = 'sec-1';
const SIM_ID     = 'sim-1';

const SIM = {
  id: SIM_ID, project_id: PROJECT_ID, name: 'Pendulum', status: 'ready',
  storage_prefix: `simulations/${PROJECT_ID}/${SIM_ID}`, bridge_hash: 'abc123', active_revision_id: 'rev-9',
  bridge_functions: [], entry_file: 'index.html', ui_controls: null, ui_controls_meta: null,
  created_at: new Date('2026-09-01T00:00:00Z'), updated_at: new Date('2026-09-01T00:00:00Z'),
};
const SECTION = {
  id: SECTION_ID, project_id: PROJECT_ID, simulation_id: SIM_ID, type: 'simulation',
  simulation_url: `https://cdn.example.com/sim-public/simulations/${PROJECT_ID}/${SIM_ID}/index.html?section=${SECTION_ID}&v=abc123`,
  sim_script: 'main', simple_ui: false, auto_script: true, sim_meta: null,
};

/** A PNG header — signature + IHDR — of the given size. The route reads nothing past it. */
function pngDataUrl(width: number, height: number): string {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

const WIDE = [
  { size: 'standard', format: 'png', dataUrl: pngDataUrl(1280, 720) },
  { size: 'compact',  format: 'png', dataUrl: pngDataUrl(640, 360) },
];
const PORTRAIT = [
  { size: 'standard', format: 'png', dataUrl: pngDataUrl(720, 1280) },
  { size: 'compact',  format: 'png', dataUrl: pngDataUrl(360, 640) },
];

async function build() {
  const app = Fastify();
  await registerSimulationsRoutes(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  for (const m of [mocks.projects, mocks.simulations, mocks.sections, mocks.videoFiles]) {
    for (const fn of Object.values(m)) fn.mockReset();
  }
  mocks.editable.mockReset(); mocks.stills.mockReset();
  mocks.getPoster.mockReset(); mocks.storePoster.mockReset(); mocks.invalidate.mockReset();
  mocks.order.length = 0;
  mocks.editable.mockResolvedValue({ id: PROJECT_ID });
  mocks.sections.findFirst.mockResolvedValue(SECTION);
  mocks.simulations.findFirst.mockResolvedValue(SIM);
  mocks.videoFiles.findMany.mockResolvedValue([{ width: 1920, height: 1080, is_broll: false }]);
  mocks.getPoster.mockResolvedValue(null);
  mocks.storePoster.mockResolvedValue({ stored: true });
  mocks.invalidate.mockResolvedValue(undefined);
});

// ── GET /simulations/importable ───────────────────────────────────────────────

describe('GET /api/v1/simulations/importable', () => {
  it('lists ready simulations of every editable project but the excluded one, in ONE listing query, with title and poster', async () => {
    mocks.projects.findMany.mockResolvedValue([
      { id: 'proj-1', title: 'Photosynthesis' }, { id: 'proj-2', title: 'Tides' }, { id: 'proj-3', title: null },
    ]);
    mocks.simulations.findMany.mockResolvedValue([
      { ...SIM, id: 'sim-a', project_id: 'proj-2' },
      { ...SIM, id: 'sim-b', project_id: 'proj-3' },
    ]);
    mocks.stills.mockResolvedValue(new Map([['sim-a', { banner: 'https://cdn/sim-a/compact.png', poster: 'https://cdn/sim-a/standard.png' }]]));

    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/simulations/importable?exclude=proj-1' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; project_title: string; poster_url: string | null }>;
    expect(body.map((s) => [s.id, s.project_title, s.poster_url])).toEqual([
      ['sim-a', 'Tides', 'https://cdn/sim-a/compact.png'],
      ['sim-b', '', null],
    ]);

    // One query for the sims, scoped to the non-excluded projects and to status = ready.
    expect(mocks.simulations.findMany).toHaveBeenCalledTimes(1);
    const where = mocks.simulations.findMany.mock.calls[0]![0].where as { parts: Array<{ type: string; col: string; vals?: unknown[]; val?: unknown }> };
    const inArrayPart = where.parts.find((p) => p.type === 'inArray');
    const statusPart = where.parts.find((p) => p.type === 'eq');
    expect(inArrayPart?.vals).toEqual(['proj-2', 'proj-3']);
    expect(statusPart).toMatchObject({ col: 'simulations.status', val: 'ready' });
    // One stills lookup for the whole list — not one per project.
    expect(mocks.stills).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('answers an empty list without a simulations query when the user has no other project', async () => {
    mocks.projects.findMany.mockResolvedValue([{ id: 'proj-1', title: 'Only one' }]);
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/simulations/importable?exclude=proj-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(mocks.simulations.findMany).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── POST /projects/:id/sections/:sid/poster ───────────────────────────────────

describe('POST /api/v1/projects/:id/sections/:sid/poster', () => {
  const url = `/api/v1/projects/${PROJECT_ID}/sections/${SECTION_ID}/poster`;

  it('stores the renditions under the identity sectionPosterKey predicts, then invalidates — in that order', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url, payload: { renditions: WIDE } });
    expect(res.statusCode).toBe(201);

    const packageRevision = packageRevisionFor(SIM, derivePackageRevision);
    const expectedKey = posterKeyForSection(SECTION, packageRevision, 'wide');
    expect(res.json()).toEqual({ outcome: 'stored', identity: posterIdentityString(expectedKey), aspectProfile: 'wide' });

    expect(mocks.storePoster).toHaveBeenCalledTimes(1);
    const [simId, prefix, key, renditions] = mocks.storePoster.mock.calls[0]! as [string, string, unknown, Array<{ size: string; width: number; height: number; format: string }>];
    expect(simId).toBe(SIM_ID);
    expect(prefix).toBe(SIM.storage_prefix);
    expect(key).toEqual(expectedKey);
    expect(renditions.map((r) => [r.size, r.width, r.height, r.format])).toEqual([
      ['standard', 1280, 720, 'png'], ['compact', 640, 360, 'png'],
    ]);
    expect(mocks.invalidate).toHaveBeenCalledWith(SIM_ID, packageRevision);
    expect(mocks.order).toEqual(['store', 'invalidate']);
    await app.close();
  });

  it('a portrait project captures the portrait sizes under the portrait aspect', async () => {
    mocks.videoFiles.findMany.mockResolvedValue([{ width: 1080, height: 1920, is_broll: false }]);
    const app = await build();
    const wrong = await app.inject({ method: 'POST', url, payload: { renditions: WIDE } });
    expect(wrong.statusCode).toBe(400);
    expect(mocks.storePoster).not.toHaveBeenCalled();

    const res = await app.inject({ method: 'POST', url, payload: { renditions: PORTRAIT } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ outcome: 'stored', aspectProfile: 'portrait' });
    const key = mocks.storePoster.mock.calls[0]![2] as { aspectProfile: string };
    expect(key.aspectProfile).toBe('portrait');
    await app.close();
  });

  it('an existing poster for the identity is reported, not re-stored — unless forced', async () => {
    mocks.getPoster.mockResolvedValue({ id: 'poster-row' });
    const app = await build();
    const res = await app.inject({ method: 'POST', url, payload: { renditions: WIDE } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: 'existed', aspectProfile: 'wide' });
    expect(mocks.storePoster).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();

    const forced = await app.inject({ method: 'POST', url, payload: { renditions: WIDE, force: true } });
    expect(forced.statusCode).toBe(201);
    expect(mocks.getPoster).toHaveBeenCalledTimes(1);
    expect(mocks.storePoster).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('refuses a rendition that is missing, not a PNG, or not the size the aspect names', async () => {
    const app = await build();
    const missing = await app.inject({ method: 'POST', url, payload: { renditions: [WIDE[0]] } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toMatch(/Missing PNG rendition: compact/);

    const notPng = await app.inject({ method: 'POST', url, payload: { renditions: [WIDE[0], { size: 'compact', format: 'png', dataUrl: 'data:image/jpeg;base64,AAAA' }] } });
    expect(notPng.statusCode).toBe(400);

    const wrongSize = await app.inject({ method: 'POST', url, payload: { renditions: [WIDE[0], { size: 'compact', format: 'png', dataUrl: pngDataUrl(600, 300) }] } });
    expect(wrongSize.statusCode).toBe(400);
    expect(wrongSize.json().message).toMatch(/640×360/);
    expect(mocks.storePoster).not.toHaveBeenCalled();
    await app.close();
  });

  it('is creator-only and needs a section that carries a simulation', async () => {
    const app = await build();
    mocks.editable.mockResolvedValueOnce(null);
    expect((await app.inject({ method: 'POST', url, payload: { renditions: WIDE } })).statusCode).toBe(404);

    mocks.sections.findFirst.mockResolvedValueOnce({ ...SECTION, simulation_id: null });
    expect((await app.inject({ method: 'POST', url, payload: { renditions: WIDE } })).statusCode).toBe(404);

    mocks.simulations.findFirst.mockResolvedValueOnce(null);
    expect((await app.inject({ method: 'POST', url, payload: { renditions: WIDE } })).statusCode).toBe(404);
    expect(mocks.storePoster).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── POST /projects/:id/simulations/:simId/poster (the banner sweep) ───────────

describe('POST /api/v1/projects/:id/simulations/:simId/poster', () => {
  const url = `/api/v1/projects/${PROJECT_ID}/simulations/${SIM_ID}/poster`;

  it('stores under the SIMULATION identity — the entry has no section, so the variant key is the simulation id', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url, payload: { renditions: WIDE, force: true } });
    expect(res.statusCode).toBe(201);
    const packageRevision = packageRevisionFor(SIM, derivePackageRevision);
    const expectedKey = posterKeyForSection(
      { id: SIM_ID, simulation_url: SIM.entry_file, sim_script: null, simple_ui: false, auto_script: true, sim_meta: null },
      packageRevision, 'wide',
    );
    expect(expectedKey.variantKey).toBe(SIM_ID);
    expect(mocks.storePoster.mock.calls[0]![2]).toEqual(expectedKey);
    expect(res.json()).toMatchObject({ identity: posterIdentityString(expectedKey), aspectProfile: 'wide' });
    expect(mocks.order).toEqual(['store', 'invalidate']);
    await app.close();
  });

  it('shares the section route\'s validation: an existing poster is reported, a wrong size refused', async () => {
    const app = await build();
    mocks.getPoster.mockResolvedValueOnce({ id: 'poster-row' });
    expect((await app.inject({ method: 'POST', url, payload: { renditions: WIDE } })).json()).toMatchObject({ outcome: 'existed' });
    const wrong = await app.inject({ method: 'POST', url, payload: { renditions: [WIDE[0], { size: 'compact', format: 'png', dataUrl: pngDataUrl(600, 300) }] } });
    expect(wrong.statusCode).toBe(400);
    expect(mocks.storePoster).not.toHaveBeenCalled();
    await app.close();
  });

  it('404 for a simulation outside the project, or a project the user cannot edit', async () => {
    const app = await build();
    mocks.simulations.findFirst.mockResolvedValueOnce(null);
    expect((await app.inject({ method: 'POST', url, payload: { renditions: WIDE } })).statusCode).toBe(404);
    mocks.editable.mockResolvedValueOnce(null);
    expect((await app.inject({ method: 'POST', url, payload: { renditions: WIDE } })).statusCode).toBe(404);
    expect(mocks.storePoster).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /api/v1/projects/:id/simulations carries poster_url', () => {
  it('the tile banner for each simulation, null when there is none — what the banner sweep reads', async () => {
    mocks.simulations.findMany.mockResolvedValue([SIM, { ...SIM, id: 'sim-2' }]);
    mocks.stills.mockResolvedValue(new Map([[SIM_ID, { banner: 'https://cdn/sim-1/compact.png', poster: 'https://cdn/sim-1/standard.png' }]]));
    const app = await build();
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/simulations` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; poster_url: string | null }>;
    expect(body.map((s) => [s.id, s.poster_url])).toEqual([[SIM_ID, 'https://cdn/sim-1/compact.png'], ['sim-2', null]]);
    await app.close();
  });
});
