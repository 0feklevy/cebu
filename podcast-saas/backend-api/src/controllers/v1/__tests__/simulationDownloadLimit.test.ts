/**
 * GET /projects/:id/simulations/:simId/download.zip — the one route in this group where the
 * unbounded buffer is on the way OUT (security-007 / performance-005).
 *
 * The route read every object in the package into memory (`zip.addFile(rel, await
 * storage.readObject(key))`), then called `zip.toBuffer()`, which serialises the lot into a
 * SECOND full-size allocation, and sent that. Peak heap was therefore roughly twice the package —
 * and the package size was not bounded by the 250 MB upload cap, because the legacy branch zips
 * the whole `storage_prefix`, which accumulates every revision the simulation has ever had plus
 * its captured posters. A large enough package is an OOM kill of the API triggered by one GET.
 *
 * The fix cannot be "stream the zip": adm-zip has no streaming writer (`writeZip` goes through
 * `compressToBuffer` too), and adding a zip dependency is not this change. What it CAN do — and
 * what this suite pins — is refuse before the heap fills:
 *
 *   1  the total is summed as objects are read, and the route bails the moment it crosses the cap
 *   2  it bails EARLY — the remaining objects are never read, so the refusal costs the cap, not
 *      the package
 *   3  the answer is a 413 that names the limit, not a dead process
 *   4  a package inside the cap still downloads
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const PROJECT_ID = 'proj-1';
const SIM_ID = 'sim-1';
const PREFIX = `simulations/${PROJECT_ID}/${SIM_ID}`;
const URL_PATH = `/api/v1/projects/${PROJECT_ID}/simulations/${SIM_ID}/download.zip`;

const mocks = vi.hoisted(() => ({
  mockSimulations: { findFirst: vi.fn() },
  mockProjects: { findFirst: vi.fn() },
  mockStorage: {
    readObject: vi.fn(),
    listObjects: vi.fn(),
    uploadFile: vi.fn(),
    deleteFile: vi.fn(),
    deleteWithPrefix: vi.fn(),
    getSimPublicUrl: vi.fn((key: string) => `https://cdn.example.com/${key}`),
  },
  readActiveRevisionPackage: vi.fn(async (): Promise<{ revisionId: string; entryKey: string; files: { key: string; relPath: string }[] } | null> => null),
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: { simulations: mocks.mockSimulations, projects: mocks.mockProjects, timeline_sections: { findMany: vi.fn() } },
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn() })) })) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn() })) })),
    transaction: vi.fn(),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  simulations: Symbol('simulations'), sim_revisions: Symbol('sim_revisions'),
  timeline_sections: Symbol('timeline_sections'), system_prompts: Symbol('system_prompts'),
  api_keys: Symbol('api_keys'), admin_settings: Symbol('admin_settings'),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})), and: vi.fn(() => ({})), or: vi.fn(() => ({})), desc: vi.fn(() => ({})),
  asc: vi.fn(() => ({})), isNull: vi.fn(() => ({})), isNotNull: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})), exists: vi.fn(() => ({})), sql: vi.fn(() => ({})),
}));
vi.mock('../../../services/collabAccess.js', () => ({
  editableProject: vi.fn(async () => ({ id: PROJECT_ID, created_by: 'user-1' })),
}));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: (req: Record<string, unknown>, _r: unknown, done: () => void) => {
    req.dbUser = { id: 'user-1', email: 'u@example.com' };
    done();
  },
}));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => mocks.mockStorage,
}));
vi.mock('../../../services/simulation/activeRevisionPackage.js', () => ({
  readActiveRevisionPackage: mocks.readActiveRevisionPackage,
}));
vi.mock('../../../services/llm/LLMService.js', () => ({ LLMService: class {} }));
vi.mock('../../../services/secrets/ApiKeyService.js', () => ({ ApiKeyService: class {} }));
vi.mock('../../../services/usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const FAKE_SIM = {
  id: SIM_ID, project_id: PROJECT_ID, name: 'My Sim',
  storage_prefix: PREFIX, entry_file: `${PREFIX}/index.html`,
  status: 'ready', error: null, active_revision_id: null, active_revision_entry_key: null,
};

/** `count` objects of `each` bytes under the sim prefix. */
function seedPackage(count: number, each: number): void {
  const keys = Array.from({ length: count }, (_, i) => `${PREFIX}/asset-${i}.bin`);
  mocks.mockStorage.listObjects.mockResolvedValue(keys);
  mocks.mockStorage.readObject.mockImplementation(async () => Buffer.alloc(each, 0x61));
}

async function buildApp(): Promise<FastifyInstance> {
  const { registerSimulationsRoutes } = await import('../simulations.controller.js');
  const app = Fastify();
  await registerSimulationsRoutes(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mockSimulations.findFirst.mockResolvedValue(FAKE_SIM);
  mocks.mockProjects.findFirst.mockResolvedValue({ id: PROJECT_ID, created_by: 'user-1' });
  mocks.readActiveRevisionPackage.mockResolvedValue(null);
});

afterEach(() => {
  delete process.env.MAX_SIM_DOWNLOAD_BYTES;
  vi.resetModules();
});

describe('download.zip refuses a package it cannot assemble in memory', () => {
  it('answers 413 instead of building a zip larger than the cap', async () => {
    process.env.MAX_SIM_DOWNLOAD_BYTES = String(64 * 1024);
    vi.resetModules();
    seedPackage(40, 16 * 1024); // 640 KiB, ten times the cap
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: URL_PATH });

    expect(res.statusCode).toBe(413);
    await app.close();
  });

  it('stops READING once it crosses the cap — the refusal costs the cap, not the package', async () => {
    process.env.MAX_SIM_DOWNLOAD_BYTES = String(64 * 1024);
    vi.resetModules();
    seedPackage(40, 16 * 1024);
    const app = await buildApp();

    await app.inject({ method: 'GET', url: URL_PATH });

    // 64 KiB cap / 16 KiB objects → the 5th read is the one that crosses it. Anything close to
    // 40 means the route read the whole package before deciding, which is the bug.
    expect(mocks.mockStorage.readObject.mock.calls.length).toBeLessThanOrEqual(6);
    await app.close();
  });

  it('names the limit so the caller knows what happened', async () => {
    process.env.MAX_SIM_DOWNLOAD_BYTES = String(64 * 1024);
    vi.resetModules();
    seedPackage(40, 16 * 1024);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: URL_PATH });

    expect(res.json<{ message: string }>().message).toMatch(/\d+(\.\d+)?\s*(KB|MB|GB)/);
    await app.close();
  });

  it('still serves a package inside the cap', async () => {
    process.env.MAX_SIM_DOWNLOAD_BYTES = String(1024 * 1024);
    vi.resetModules();
    seedPackage(4, 1024);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: URL_PATH });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    await app.close();
  });

  it('applies to the REVISIONED branch too, not only the legacy prefix scan', async () => {
    process.env.MAX_SIM_DOWNLOAD_BYTES = String(64 * 1024);
    vi.resetModules();
    mocks.readActiveRevisionPackage.mockResolvedValue({
      revisionId: 'rev-1',
      entryKey: `${PREFIX}/revisions/rev-1/package/index.html`,
      files: Array.from({ length: 40 }, (_, i) => ({
        key: `${PREFIX}/revisions/rev-1/package/asset-${i}.bin`,
        relPath: `asset-${i}.bin`,
      })),
    });
    mocks.mockStorage.readObject.mockImplementation(async () => Buffer.alloc(16 * 1024, 0x61));
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: URL_PATH });

    expect(res.statusCode).toBe(413);
    expect(mocks.mockStorage.readObject.mock.calls.length).toBeLessThanOrEqual(6);
    await app.close();
  });
});
