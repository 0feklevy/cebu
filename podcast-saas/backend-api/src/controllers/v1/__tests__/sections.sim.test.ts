import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerSectionsRoutes } from '../sections.controller.js';

// ── Mocks (hoisted so they're available inside vi.mock factories) ──────────────

const mocks = vi.hoisted(() => {
  const mockInsertReturning = vi.fn();
  const mockInsertValues    = vi.fn(() => ({ returning: mockInsertReturning }));
  const mockInsert          = vi.fn(() => ({ values: mockInsertValues }));

  const mockUpdateReturning = vi.fn();
  const mockUpdateWhere     = vi.fn(() => ({ returning: mockUpdateReturning }));
  const mockUpdateSet       = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate          = vi.fn(() => ({ set: mockUpdateSet }));

  const mockDeleteWhere = vi.fn();
  const mockDelete      = vi.fn(() => ({ where: mockDeleteWhere }));

  return {
    mockProjects:         { findFirst: vi.fn() },
    mockSections:         { findFirst: vi.fn() },
    mockSimulations:      { findFirst: vi.fn() },
    mockInsert,
    mockInsertValues,
    mockInsertReturning,
    mockUpdate,
    mockUpdateSet,
    mockUpdateWhere,
    mockUpdateReturning,
    mockDelete,
    mockDeleteWhere,
  };
});

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      projects:          mocks.mockProjects,
      timeline_sections: mocks.mockSections,
      simulations:       mocks.mockSimulations,
    },
    insert: mocks.mockInsert,
    update: mocks.mockUpdate,
    delete: mocks.mockDelete,
  },
}));

// Destructure for ergonomics in tests
const {
  mockProjects, mockSections, mockSimulations,
  mockInsertValues, mockInsertReturning,
  mockUpdateSet, mockUpdateReturning,
} = mocks;

vi.mock('../../../db/schema.js', () => ({
  projects:          Symbol('projects'),
  timeline_sections: Symbol('timeline_sections'),
  simulations:       Symbol('simulations'),
}));

vi.mock('drizzle-orm', () => ({
  eq:  vi.fn((_col: unknown, _val: unknown) => ({ type: 'eq' })),
  and: vi.fn((..._args: unknown[]) => ({ type: 'and' })),
  asc: vi.fn((_col: unknown) => ({ type: 'asc' })),
}));

vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: (req: Record<string, unknown>, _reply: unknown, done: () => void) => {
    req.dbUser = { id: 'user-1' };
    done();
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const PROJECT_ID  = 'proj-1';
const SECTION_ID  = 'sec-1';
const SIM_ID      = 'sim-1';
const SIM_URL     = 'https://r2.example.com/simulations/proj-1/sim-1/index.html';

const FAKE_PROJECT = { id: PROJECT_ID, created_by: 'user-1' };
const FAKE_SECTION = {
  id:           SECTION_ID,
  project_id:   PROJECT_ID,
  video_file_id: 'vid-1',
  start_sec:    0,
  end_sec:      10,
  type:         'simulation',
  simulation_id: SIM_ID,
  simulation_url: SIM_URL,
  sim_script:   null,
};

async function makeApp() {
  const app = Fastify();
  await registerSectionsRoutes(app);
  return app;
}

function resetChains() {
  // Re-wire insert chain after clearAllMocks resets all fns to no-ops
  mocks.mockInsertReturning.mockReset();
  mocks.mockInsertValues.mockImplementation(() => ({ returning: mocks.mockInsertReturning }));
  mocks.mockInsert.mockImplementation(() => ({ values: mocks.mockInsertValues }));

  mocks.mockUpdateReturning.mockReset();
  mocks.mockUpdateWhere.mockImplementation(() => ({ returning: mocks.mockUpdateReturning }));
  mocks.mockUpdateSet.mockImplementation(() => ({ where: mocks.mockUpdateWhere }));
  mocks.mockUpdate.mockImplementation(() => ({ set: mocks.mockUpdateSet }));

  mocks.mockDeleteWhere.mockReset();
  mocks.mockDelete.mockImplementation(() => ({ where: mocks.mockDeleteWhere }));
}

// ── POST tests ────────────────────────────────────────────────────────────────

describe('POST /api/v1/projects/:id/sections — simulation denormalization', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetChains();
    app = await makeApp();
  });

  it('resolves simulation_url from simulation_id when simulation_url is not provided', async () => {
    mockProjects.findFirst.mockResolvedValue(FAKE_PROJECT);
    mockSimulations.findFirst.mockResolvedValue({ id: SIM_ID, entry_file: SIM_URL });
    const newSection = { ...FAKE_SECTION };
    mockInsertReturning.mockResolvedValue([newSection]);

    const res = await app.inject({
      method: 'POST',
      url:    `/api/v1/projects/${PROJECT_ID}/sections`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        video_file_id: 'vid-1',
        start_sec:     0,
        end_sec:       10,
        type:          'simulation',
        simulation_id: SIM_ID,
      }),
    });

    expect(res.statusCode).toBe(201);
    // simulation_url should be resolved from the sim row
    const body = res.json();
    expect(body.simulation_url).toBe(SIM_URL);

    // Confirm the insert values contained the resolved URL
    const insertedValues = mockInsertValues.mock.calls[0][0];
    expect(insertedValues.simulation_url).toBe(SIM_URL);
    expect(insertedValues.simulation_id).toBe(SIM_ID);
  });

  it('uses simulation_url directly when provided without simulation_id', async () => {
    mockProjects.findFirst.mockResolvedValue(FAKE_PROJECT);
    const directUrl = 'https://cdn.example.com/sim/index.html';
    mockInsertReturning.mockResolvedValue([{ ...FAKE_SECTION, simulation_url: directUrl, simulation_id: null }]);

    const res = await app.inject({
      method: 'POST',
      url:    `/api/v1/projects/${PROJECT_ID}/sections`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        video_file_id:  'vid-1',
        start_sec:      0,
        end_sec:        10,
        type:           'video',
        simulation_url: directUrl,
      }),
    });

    expect(res.statusCode).toBe(201);
    // Should NOT have queried simulations table
    expect(mockSimulations.findFirst).not.toHaveBeenCalled();
    const insertedValues = mockInsertValues.mock.calls[0][0];
    expect(insertedValues.simulation_url).toBe(directUrl);
  });

  it('returns 400 when start_sec >= end_sec', async () => {
    mockProjects.findFirst.mockResolvedValue(FAKE_PROJECT);

    const res = await app.inject({
      method: 'POST',
      url:    `/api/v1/projects/${PROJECT_ID}/sections`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        video_file_id: 'vid-1',
        start_sec:     10,
        end_sec:       5,
        type:          'video',
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/start_sec/);
  });

  it('returns 404 when project not found', async () => {
    mockProjects.findFirst.mockResolvedValue(null);

    const res = await app.inject({
      method: 'POST',
      url:    `/api/v1/projects/nonexistent/sections`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        video_file_id: 'vid-1',
        start_sec:     0,
        end_sec:       10,
        type:          'video',
      }),
    });

    expect(res.statusCode).toBe(404);
  });
});

// ── PATCH tests ───────────────────────────────────────────────────────────────

describe('PATCH /api/v1/projects/:id/sections/:sid — simulation denormalization', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetChains();
    app = await makeApp();
  });

  it('denormalizes entry_file → simulation_url when simulation_id is provided', async () => {
    mockProjects.findFirst.mockResolvedValue(FAKE_PROJECT);
    mockSections.findFirst.mockResolvedValue(FAKE_SECTION);
    mockSimulations.findFirst.mockResolvedValue({ id: SIM_ID, entry_file: SIM_URL });
    const updated = { ...FAKE_SECTION };
    mockUpdateReturning.mockResolvedValue([updated]);

    const res = await app.inject({
      method: 'PATCH',
      url:    `/api/v1/projects/${PROJECT_ID}/sections/${SECTION_ID}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ simulation_id: SIM_ID }),
    });

    expect(res.statusCode).toBe(200);
    // Verify the patch object passed to db.update().set() included simulation_url
    const setArg = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.simulation_url).toBe(SIM_URL);
    expect(setArg.simulation_id).toBe(SIM_ID);
  });

  it('sets simulation_url to null when simulation_id is empty string', async () => {
    mockProjects.findFirst.mockResolvedValue(FAKE_PROJECT);
    mockSections.findFirst.mockResolvedValue(FAKE_SECTION);
    mockUpdateReturning.mockResolvedValue([{ ...FAKE_SECTION, simulation_id: null, simulation_url: null }]);

    const res = await app.inject({
      method: 'PATCH',
      url:    `/api/v1/projects/${PROJECT_ID}/sections/${SECTION_ID}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ simulation_id: '' }),
    });

    expect(res.statusCode).toBe(200);
    // Empty simulation_id should clear URL and not query simulations table
    expect(mockSimulations.findFirst).not.toHaveBeenCalled();
    const setArg = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.simulation_url).toBeNull();
    expect(setArg.simulation_id).toBeNull();
  });

  it('leaves simulation_url unchanged when simulation_id is absent from body', async () => {
    mockProjects.findFirst.mockResolvedValue(FAKE_PROJECT);
    mockSections.findFirst.mockResolvedValue(FAKE_SECTION);
    mockUpdateReturning.mockResolvedValue([{ ...FAKE_SECTION, label: 'Updated' }]);

    const res = await app.inject({
      method: 'PATCH',
      url:    `/api/v1/projects/${PROJECT_ID}/sections/${SECTION_ID}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Updated' }),
    });

    expect(res.statusCode).toBe(200);
    // simulation_id not in body → simulations table not queried, simulation_url not in patch
    expect(mockSimulations.findFirst).not.toHaveBeenCalled();
    const setArg = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect('simulation_url' in setArg).toBe(false);
  });
});
