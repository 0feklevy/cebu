/**
 * GET /api/v1/projects/:id/simulations/:simId/ui-controls — static Minimal-UI control scan.
 *
 * Covers: auth guard (same collabAccess gate as upload/replace), the happy path
 * ({ controls, source: 'static' } from the stored entry HTML with injected blocks
 * stripped), and clean 404s for missing project/sim/entry.
 * db/auth/storage are mocked in the style of simulations.replace.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerSimulationsRoutes } from '../simulations.controller.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  mockProjects:    { findFirst: vi.fn() },
  mockSimulations: { findFirst: vi.fn() },
  mockStorage: {
    uploadFile:       vi.fn(),
    readObject:       vi.fn(),
    listObjects:      vi.fn(),
    deleteFile:       vi.fn(),
    deleteWithPrefix: vi.fn(),
    getSimPublicUrl:  vi.fn((key: string) => `https://cdn.example.com/sim-public/${key}`),
  },
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      simulations: mocks.mockSimulations,
      projects:    mocks.mockProjects,
    },
  },
}));

vi.mock('../../../db/schema.js', () => ({
  simulations:       Symbol('simulations'),
  timeline_sections: Symbol('timeline_sections'),
  system_prompts:    Symbol('system_prompts'),
}));

vi.mock('drizzle-orm', () => ({
  eq:  vi.fn(() => ({ type: 'eq' })),
  and: vi.fn(() => ({ type: 'and' })),
}));

vi.mock('../../../services/collabAccess.js', () => ({
  editableProject: vi.fn((_id: string, _user: unknown) => mocks.mockProjects.findFirst()),
}));

vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: (req: Record<string, unknown>, _reply: unknown, done: () => void) => {
    req.dbUser = { id: 'user-1', email: 'u@example.com' };
    done();
  },
}));

vi.mock('../../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => mocks.mockStorage,
}));

vi.mock('../../../services/llm/LLMService.js', () => ({ LLMService: class {} }));
vi.mock('../../../services/secrets/ApiKeyService.js', () => ({ ApiKeyService: class {} }));
vi.mock('../../../services/usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { mockProjects, mockSimulations, mockStorage } = mocks;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-1';
const SIM_ID     = 'sim-1';
const PREFIX     = `simulations/${PROJECT_ID}/${SIM_ID}`;
const URL_PATH   = `/api/v1/projects/${PROJECT_ID}/simulations/${SIM_ID}/ui-controls`;

const FAKE_PROJECT = { id: PROJECT_ID, created_by: 'user-1' };
const FAKE_SIM = {
  id: SIM_ID, project_id: PROJECT_ID, name: 'My Sim',
  storage_prefix: PREFIX, entry_file: `${PREFIX}/index.html`,
  bridge_functions: [], status: 'ready', error: null,
};

const ENTRY_HTML = [
  '<html><head></head><body>',
  '  <div id="panel">',
  '    <label for="gravity">Gravity</label>',
  '    <input type="range" id="gravity">',
  '    <button id="reset">Reset</button>',
  '  </div>',
  '</body></html>',
].join('\n');

async function makeApp() {
  const app = Fastify();
  await registerSimulationsRoutes(app);
  return app;
}

let app: Awaited<ReturnType<typeof makeApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  mockStorage.getSimPublicUrl.mockImplementation((key: string) => `https://cdn.example.com/sim-public/${key}`);
  // Public-URL fallback path must not hit the network in tests.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in tests')));
  app = await makeApp();
});

describe('GET /api/v1/projects/:id/simulations/:simId/ui-controls', () => {
  it('returns the static scan of the stored entry HTML', async () => {
    mockProjects.findFirst.mockResolvedValue(FAKE_PROJECT);
    mockSimulations.findFirst.mockResolvedValue(FAKE_SIM);
    mockStorage.readObject.mockResolvedValue(Buffer.from(ENTRY_HTML, 'utf-8'));

    const res = await app.inject({ method: 'GET', url: URL_PATH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe('static');
    expect(body.controls).toEqual([
      { selector: '#gravity', kind: 'slider', label: 'Gravity' },
      { selector: '#reset',   kind: 'button', label: 'Reset' },
    ]);
    expect(mockStorage.readObject).toHaveBeenCalledWith(`${PREFIX}/index.html`);
  });

  it('is gated by the same collabAccess check as upload/replace — 404 when not editable', async () => {
    mockProjects.findFirst.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: URL_PATH });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Project not found');
    expect(mockSimulations.findFirst).not.toHaveBeenCalled();
    expect(mockStorage.readObject).not.toHaveBeenCalled();
  });

  it('404s cleanly when the simulation does not exist', async () => {
    mockProjects.findFirst.mockResolvedValue(FAKE_PROJECT);
    mockSimulations.findFirst.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: URL_PATH });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Simulation not found');
  });

  it('404s cleanly when the entry file is underivable (failed initial upload)', async () => {
    mockProjects.findFirst.mockResolvedValue(FAKE_PROJECT);
    mockSimulations.findFirst.mockResolvedValue({ ...FAKE_SIM, entry_file: '' });
    const res = await app.inject({ method: 'GET', url: URL_PATH });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/no readable entry file/);
  });

  it('404s cleanly when the entry HTML is unreadable via storage AND the public URL', async () => {
    mockProjects.findFirst.mockResolvedValue(FAKE_PROJECT);
    mockSimulations.findFirst.mockResolvedValue(FAKE_SIM);
    mockStorage.readObject.mockRejectedValue(new Error('AccessDenied'));
    const res = await app.inject({ method: 'GET', url: URL_PATH });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/entry file not found/);
  });

  it('falls back to the public URL when storage GetObject is denied', async () => {
    mockProjects.findFirst.mockResolvedValue(FAKE_PROJECT);
    mockSimulations.findFirst.mockResolvedValue(FAKE_SIM);
    mockStorage.readObject.mockRejectedValue(new Error('AccessDenied'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => ENTRY_HTML }));

    const res = await app.inject({ method: 'GET', url: URL_PATH });
    expect(res.statusCode).toBe(200);
    expect(res.json().controls).toHaveLength(2);
  });
});
