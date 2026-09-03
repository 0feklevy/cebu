/**
 * A saved setup travels between projects (owner ruling 2026-09-03).
 *
 * The routes' half: /fit answers for a section with NO simulation instead of refusing it, and
 * /apply brings the setup's package along — importing it when this project has never seen it,
 * attaching the copy it already received when it has, and never swapping a simulation the section
 * already shows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  project: { id: 'proj-dest', editable: true } as Record<string, unknown> | null,
  section: null as Record<string, unknown> | null,
  preset: null as Record<string, unknown> | null,
  sims: [] as Array<Record<string, unknown>>,
  fitVerdict: 'artifact' as 'artifact' | 'recipe',
  imported: [] as Array<{ destProjectId: string; sourceSimulationId: string }>,
  sectionUpdates: [] as Array<Record<string, unknown>>,
  applied: 0,
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      timeline_sections: { findFirst: async () => state.section },
      simulations: {
        findFirst: async (args: { where?: { and?: Array<{ col?: string; val?: unknown }>; col?: string; val?: unknown } }) => {
          const parts = args?.where?.and ?? [args?.where].filter(Boolean) as Array<{ col?: string; val?: unknown }>;
          const byId = parts.find((p) => p?.col === 'simulations.id')?.val;
          const byProject = parts.find((p) => p?.col === 'simulations.project_id')?.val;
          const byImport = parts.find((p) => p?.col === 'simulations.imported_from')?.val;
          return state.sims.find((s) =>
            (byId === undefined || s.id === byId)
            && (byProject === undefined || s.project_id === byProject)
            && (byImport === undefined || s.imported_from_simulation_id === byImport)) ?? null;
        },
      },
    },
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => { state.sectionUpdates.push(values); } }) }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  timeline_sections: { id: 'timeline_sections.id', project_id: 'timeline_sections.project_id' },
  simulations: { id: 'simulations.id', project_id: 'simulations.project_id', imported_from_simulation_id: 'simulations.imported_from' },
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn((...parts: unknown[]) => ({ and: parts })),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));
vi.mock('../../../middleware/firebase-auth.js', () => ({ firebaseAuthMiddleware: vi.fn() }));
vi.mock('../../../services/collabAccess.js', () => ({ editableProject: async () => (state.project?.editable ? state.project : null) }));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({ getStorageAdapter: () => ({}) }));
vi.mock('../../../services/llm/LLMService.js', () => ({ LLMService: class {} }));
vi.mock('../../../services/secrets/ApiKeyService.js', () => ({ ApiKeyService: class {} }));
vi.mock('../../../services/usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../services/simulation/SavedBridgeService.js', () => ({
  SavedBridgeService: class {
    async presetForApply() { return state.preset; }
    async judgeFit(input: { simulationId: string }) {
      return state.preset
        ? {
            verdict: state.fitVerdict === 'artifact' ? { path: 'artifact', sameContent: true } : { path: 'recipe', why: 'anchors-missing', missing: [] },
            description: `judged against ${input.simulationId}`,
            preset: state.preset,
          }
        : null;
    }
  },
}));
vi.mock('../../../services/simulation/SimulationService.js', () => ({
  SimulationService: class {
    async applySavedBridgeBody(input: { persistSection: (tx: unknown, r: unknown) => Promise<void> }) {
      state.applied += 1;
      await input.persistSection({ update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: 'sec-1' }] }) }) }) }, { sectionUrl: 'https://x/entry', bridgeHash: 'h' });
      return { sectionUrl: 'https://x/entry', bridgeHash: 'h' };
    }
  },
}));
vi.mock('../../../services/simulation/SimulationImportService.js', () => ({
  SimulationImportService: class {
    async importSimulation(input: { destProjectId: string; sourceSimulationId: string }) {
      state.imported.push(input);
      const row = { id: 'sim-copy', project_id: input.destProjectId, name: 'Boids', entry_file: 'https://cdn/copy/index.html', imported_from_simulation_id: input.sourceSimulationId };
      state.sims.push(row);
      return { ok: true, simulation: row, copiedObjects: 0, reusedObjects: 12 };
    }
  },
}));

const { registerBridgePresetRoutes } = await import('../bridgePresets.controller.js');

type Handler = (req: unknown, reply: unknown) => Promise<unknown>;
interface Captured { code: number; body: unknown }

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Captured> {
  const routes: Array<{ method: string; path: string; handler: Handler }> = [];
  const record = (m: string) => (p: string, a: unknown, b?: unknown) =>
    routes.push({ method: m, path: p, handler: (typeof a === 'function' ? a : b) as Handler });
  await registerBridgePresetRoutes({ get: record('GET'), post: record('POST'), delete: record('DELETE') } as never);
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`no ${method} ${path}`);
  const captured: Captured = { code: 200, body: undefined };
  const reply = { code(c: number) { captured.code = c; return reply; }, send(b: unknown) { captured.body = b; return reply; } };
  await route.handler({ params: { id: 'proj-dest', sectionId: 'sec-1', presetId: 'preset-1' }, body, dbUser: { id: 'u1' } }, reply);
  return captured;
}

const FIT = '/api/v1/projects/:id/sections/:sectionId/bridge-presets/:presetId/fit';
const APPLY = '/api/v1/projects/:id/sections/:sectionId/bridge-presets/:presetId/apply';

const SOURCE = { id: 'sim-source', project_id: 'proj-other', name: 'Boids', entry_file: 'https://cdn/src/index.html', imported_from_simulation_id: null };

beforeEach(() => {
  state.project = { id: 'proj-dest', editable: true };
  state.section = { id: 'sec-1', project_id: 'proj-dest', simulation_id: null };
  state.preset = { id: 'preset-1', label: 'Plucking a boid', source_simulation_id: 'sim-source', main_body: 'return function(){}', simple_ui: true, auto_script: true, sim_prompt: 'pluck' };
  state.sims = [SOURCE];
  state.fitVerdict = 'artifact';
  state.imported = [];
  state.sectionUpdates = [];
  state.applied = 0;
});

describe('GET …/fit on a section with no simulation', () => {
  it('answers instead of refusing, and says the package would be brought', async () => {
    const res = await call('GET', FIT);
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({
      path: 'recipe',
      verdict: { path: 'recipe', why: 'no-target-simulation' },
      bring: { needed: true, possible: true, source_name: 'Boids' },
    });
    expect((res.body as { bring: { description: string } }).bring.description).toMatch(/Brings “Boids”/);
  });

  it('a setup whose simulation is gone says it cannot be brought', async () => {
    state.sims = [];
    const res = await call('GET', FIT);
    expect(res.body).toMatchObject({ bring: { needed: true, possible: false } });
    expect((res.body as { bring: { description: string } }).bring.description).toMatch(/no longer exists/);
  });

  it('a section that HAS a simulation is judged as before, and needs nothing brought', async () => {
    state.section = { id: 'sec-1', project_id: 'proj-dest', simulation_id: 'sim-here' };
    state.sims = [SOURCE, { id: 'sim-here', project_id: 'proj-dest', name: 'Lattice' }];
    const res = await call('GET', FIT);
    expect(res.body).toMatchObject({ path: 'artifact', bring: { needed: false } });
    expect((res.body as { description: string }).description).toBe('judged against sim-here');
  });
});

describe('POST …/apply with bring_simulation', () => {
  it('imports the package, attaches it to the section, applies the script, and hands the row back', async () => {
    const res = await call('POST', APPLY, { bring_simulation: true });
    expect(res.code).toBe(200);
    expect(state.imported).toEqual([expect.objectContaining({ destProjectId: 'proj-dest', sourceSimulationId: 'sim-source' })]);
    expect(state.sectionUpdates[0]).toEqual({ simulation_id: 'sim-copy' });
    expect(state.applied).toBe(1);
    expect(res.body).toMatchObject({ path: 'artifact', brought: { imported: true, simulation: { id: 'sim-copy' } } });
  });

  it('a copy this project already received is attached — no second import', async () => {
    state.sims = [SOURCE, { id: 'sim-earlier', project_id: 'proj-dest', name: 'Boids', imported_from_simulation_id: 'sim-source' }];
    const res = await call('POST', APPLY, { bring_simulation: true });
    expect(state.imported).toEqual([]);
    expect(state.sectionUpdates[0]).toEqual({ simulation_id: 'sim-earlier' });
    expect(res.body).toMatchObject({ brought: { imported: false, simulation: { id: 'sim-earlier' } } });
  });

  it('the setup’s own simulation, already in this project, is attached rather than copied', async () => {
    state.sims = [{ ...SOURCE, project_id: 'proj-dest' }];
    await call('POST', APPLY, { bring_simulation: true });
    expect(state.imported).toEqual([]);
    expect(state.sectionUpdates[0]).toEqual({ simulation_id: 'sim-source' });
  });

  it('without the intent it refuses, and says how to proceed', async () => {
    const res = await call('POST', APPLY, {});
    expect(res.code).toBe(400);
    expect((res.body as { message: string }).message).toMatch(/bring the simulation too/);
    expect(state.imported).toEqual([]);
    expect(state.applied).toBe(0);
  });

  it('a section that already has a simulation is never swapped', async () => {
    state.section = { id: 'sec-1', project_id: 'proj-dest', simulation_id: 'sim-here' };
    state.sims = [SOURCE, { id: 'sim-here', project_id: 'proj-dest', name: 'Lattice' }];
    await call('POST', APPLY, { bring_simulation: true });
    expect(state.imported).toEqual([]);
    expect(state.sectionUpdates).toEqual([]);
    expect(state.applied).toBe(1);
  });

  it('a script that does not fit still leaves the package attached, and says so in the 409', async () => {
    state.fitVerdict = 'recipe';
    const res = await call('POST', APPLY, { bring_simulation: true });
    expect(res.code).toBe(409);
    expect(res.body).toMatchObject({ path: 'recipe', brought: { imported: true, simulation: { id: 'sim-copy' } } });
    expect(state.sectionUpdates[0]).toEqual({ simulation_id: 'sim-copy' });
    expect(state.applied).toBe(0);
  });
});
