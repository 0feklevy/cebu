/**
 * THE READ PATHS DESCRIBE THE PACKAGE THAT IS SERVED (audit D-04).
 *
 * The Files tab, the download ZIP and the Minimal-UI control scan all answer "what is in this
 * simulation?", and all three answered it from storage rather than from the manifest. For a
 * revisioned package that is wrong in both directions at once, and each direction has its own
 * failure that a naive test would miss:
 *
 *   - `listObjects(storage_prefix)` returns EVERY revision's every file plus the captured posters.
 *     A test that only asserted "the live entry appears in the list" passes against that, because
 *     the live entry is in there — alongside three retired copies of it. So these assert the exact
 *     set, and name the retired revision's file and the poster as things that must NOT be there.
 *   - the control scan read `<prefix>/<entry_file>`, the pre-revision copy. A test whose two
 *     documents contain the same controls cannot tell the two reads apart, so the fixture's legacy
 *     and live entries deliberately expose DIFFERENT controls.
 *
 * A legacy simulation keeps every one of these paths exactly as it had them, and that is asserted
 * here too rather than assumed: `active_revision_id IS NULL` really does mean the mutable prefix is
 * what is served.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import AdmZip from 'adm-zip';
import { registerSimulationsRoutes } from '../simulations.controller.js';

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
  db: { query: { simulations: mocks.mockSimulations, projects: mocks.mockProjects } },
}));

vi.mock('../../../db/schema.js', () => ({
  simulations:       Symbol('simulations'),
  sim_revisions:     Symbol('sim_revisions'),
  timeline_sections: Symbol('timeline_sections'),
  system_prompts:    Symbol('system_prompts'),
}));

vi.mock('drizzle-orm', () => ({
  eq:  vi.fn(() => ({ type: 'eq' })),
  and: vi.fn(() => ({ type: 'and' })),
  isNotNull: vi.fn(() => ({ type: 'isNotNull' })),
  inArray: vi.fn(() => ({ type: 'inArray' })),
  isNull: vi.fn(() => ({ type: 'isNull' })),
  sql: vi.fn(() => ({ type: 'sql' })),
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
const ACTIVE_REV = 'rev-active-1111';
const OLD_REV    = 'rev-retired-0000';
const REV_ROOT   = `${PREFIX}/revisions/${ACTIVE_REV}`;
const OLD_ROOT   = `${PREFIX}/revisions/${OLD_REV}`;

const url = (suffix: string) => `/api/v1/projects/${PROJECT_ID}/simulations/${SIM_ID}/${suffix}`;

const FAKE_PROJECT = { id: PROJECT_ID, created_by: 'user-1' };

const LEGACY_SIM = {
  id: SIM_ID, project_id: PROJECT_ID, name: 'My Sim',
  storage_prefix: PREFIX, entry_file: `${PREFIX}/index.html`,
  bridge_functions: [], status: 'ready', error: null,
  active_revision_id: null, active_revision_entry_key: null,
};

const REVISIONED_SIM = {
  ...LEGACY_SIM,
  active_revision_id: ACTIVE_REV,
  active_revision_entry_key: `${REV_ROOT}/package/index.html`,
};

/** The live manifest: one entry, one asset, one runtime — and one POSTER that is not package content. */
const ACTIVE_MANIFEST = {
  manifestVersion: 1,
  simulationId: SIM_ID, projectId: PROJECT_ID,
  revisionId: ACTIVE_REV, revisionNumber: 4,
  bridgeProtocolVersion: 2, runtimeProtocolVersion: 1,
  entry: 'package/index.html',
  runtime: ['package/bridge.js'],
  files: [
    { path: 'package/index.html',      role: 'entry',   hash: 'a'.repeat(64), bytes: 20, contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache' },
    { path: 'package/assets/app.js',   role: 'asset',   hash: 'b'.repeat(64), bytes: 10, contentType: 'application/javascript', cacheControl: 'immutable' },
    { path: 'package/bridge.js',       role: 'runtime', hash: 'c'.repeat(64), bytes: 10, contentType: 'application/javascript', cacheControl: 'immutable' },
    { path: 'posters/main/high.webp',  role: 'poster',  hash: 'd'.repeat(64), bytes: 99, contentType: 'image/webp', cacheControl: 'immutable' },
  ],
  variants: [{ variantKey: 'main', configHashes: [] }],
  posters: [], qualityProfiles: ['high'], externalDependencies: [],
  generatedFrom: {}, canary: { classification: null, ranAt: null, engine: null },
  createdAt: new Date(0).toISOString(), createdBy: 'test',
};

/** The document a viewer LOADS. Its control is deliberately not the legacy one's. */
const LIVE_ENTRY_HTML = [
  '<html><head></head><body>',
  '  <label for="live-only">Live control</label>',
  '  <input type="range" id="live-only">',
  '</body></html>',
].join('\n');

/** The pre-revision copy still sitting in the mutable prefix — a different control entirely. */
const LEGACY_ENTRY_HTML = [
  '<html><head></head><body>',
  '  <label for="legacy-only">Stale control</label>',
  '  <input type="range" id="legacy-only">',
  '</body></html>',
].join('\n');

/**
 * Storage that holds EVERYTHING a real revisioned package accumulates: the mutable prefix, the
 * retired revision, the posters and the live revision. Any read path that asks storage rather than
 * the manifest will find all of it — which is exactly the failure being tested for.
 */
function primeRevisionedStorage() {
  mockStorage.listObjects.mockResolvedValue([
    `${PREFIX}/index.html`,
    `${PREFIX}/bridge.js`,
    `${OLD_ROOT}/manifest.json`,
    `${OLD_ROOT}/package/index.html`,
    `${OLD_ROOT}/package/bridge.js`,
    `${REV_ROOT}/manifest.json`,
    `${REV_ROOT}/package/index.html`,
    `${REV_ROOT}/package/assets/app.js`,
    `${REV_ROOT}/package/bridge.js`,
    `${REV_ROOT}/posters/main/high.webp`,
  ]);
  mockStorage.readObject.mockImplementation(async (key: string) => {
    if (key === `${REV_ROOT}/manifest.json`)          return Buffer.from(JSON.stringify(ACTIVE_MANIFEST));
    if (key === `${REV_ROOT}/package/index.html`)     return Buffer.from(LIVE_ENTRY_HTML);
    if (key === `${REV_ROOT}/package/assets/app.js`)  return Buffer.from('// live app');
    if (key === `${REV_ROOT}/package/bridge.js`)      return Buffer.from('// live bridge');
    if (key === `${REV_ROOT}/posters/main/high.webp`) return Buffer.from('poster-bytes');
    if (key === `${PREFIX}/index.html`)               return Buffer.from(LEGACY_ENTRY_HTML);
    if (key === `${PREFIX}/bridge.js`)                return Buffer.from('// stale bridge');
    if (key === `${OLD_ROOT}/package/index.html`)     return Buffer.from('<html>retired</html>');
    throw new Error(`NoSuchKey: ${key}`);
  });
}

async function makeApp() {
  const app = Fastify();
  await registerSimulationsRoutes(app);
  return app;
}

let app: Awaited<ReturnType<typeof makeApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  mockStorage.getSimPublicUrl.mockImplementation((key: string) => `https://cdn.example.com/sim-public/${key}`);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in tests')));
  mockProjects.findFirst.mockResolvedValue(FAKE_PROJECT);
  app = await makeApp();
});

// ── Revisioned ────────────────────────────────────────────────────────────────

describe('a revisioned package reads from its ACTIVE revision', () => {
  beforeEach(() => {
    mockSimulations.findFirst.mockResolvedValue({ ...REVISIONED_SIM });
    primeRevisionedStorage();
  });

  it('lists the live package only — no retired revision, no posters, no manifest', async () => {
    const res = await app.inject({ method: 'GET', url: url('files') });

    expect(res.statusCode).toBe(200);
    const files = res.json() as Array<{ key: string; filename: string; isText: boolean }>;

    // Exactly the live package's three files, and nothing else.
    expect(files.map((f) => f.key).sort()).toEqual([
      `${REV_ROOT}/package/assets/app.js`,
      `${REV_ROOT}/package/bridge.js`,
      `${REV_ROOT}/package/index.html`,
    ]);
    // Every key points into the ACTIVE revision — never the retired one, never the mutable prefix.
    expect(files.every((f) => f.key.startsWith(`${REV_ROOT}/`))).toBe(true);
    expect(files.some((f) => f.key.startsWith(`${OLD_ROOT}/`))).toBe(false);
    expect(files.some((f) => f.key === `${PREFIX}/index.html`)).toBe(false);
    // Posters and the manifest are system-owned evidence, not package content.
    expect(files.some((f) => f.key.includes('/posters/'))).toBe(false);
    expect(files.some((f) => f.key.endsWith('manifest.json'))).toBe(false);
    // The list came from the manifest; storage was never asked to enumerate anything.
    expect(mockStorage.listObjects).not.toHaveBeenCalled();
  });

  it('zips the live package at the paths the customer uploaded it under', async () => {
    const res = await app.inject({ method: 'GET', url: url('download.zip') });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const names = new AdmZip(res.rawPayload).getEntries().map((e) => e.entryName).sort();

    // Re-uploadable: `index.html`, not `revisions/<id>/package/index.html`.
    expect(names).toEqual(['assets/app.js', 'bridge.js', 'index.html']);
    const entry = new AdmZip(res.rawPayload).getEntry('index.html')!.getData().toString('utf8');
    expect(entry).toBe(LIVE_ENTRY_HTML);
    expect(mockStorage.listObjects).not.toHaveBeenCalled();
  });

  it('scans the LIVE entry document for Minimal-UI controls, not the stale copy', async () => {
    const res = await app.inject({ method: 'GET', url: url('ui-controls') });

    expect(res.statusCode).toBe(200);
    const controls = (res.json() as { controls: Array<{ selector: string }> }).controls;
    // The two documents expose different controls precisely so this cannot pass by coincidence.
    expect(controls.map((c) => c.selector)).toEqual(['#live-only']);
    expect(mockStorage.readObject).toHaveBeenCalledWith(`${REV_ROOT}/package/index.html`);
    expect(mockStorage.readObject).not.toHaveBeenCalledWith(`${PREFIX}/index.html`);
  });

  it('409s rather than reporting an empty package when the active revision is unreadable', async () => {
    mockStorage.readObject.mockRejectedValue(new Error('NoSuchKey'));

    for (const suffix of ['files', 'download.zip', 'ui-controls']) {
      const res = await app.inject({ method: 'GET', url: url(suffix) });
      expect(res.statusCode, suffix).toBe(409);
      expect(res.json().code, suffix).toBe('SIM_ACTIVE_REVISION_UNREADABLE');
    }
  });
});

// ── Legacy ────────────────────────────────────────────────────────────────────

describe('a legacy package keeps reading from its mutable prefix', () => {
  beforeEach(() => {
    mockSimulations.findFirst.mockResolvedValue({ ...LEGACY_SIM });
    mockStorage.listObjects.mockResolvedValue([`${PREFIX}/index.html`, `${PREFIX}/bridge.js`]);
    mockStorage.readObject.mockImplementation(async (key: string) => {
      if (key === `${PREFIX}/index.html`) return Buffer.from(LEGACY_ENTRY_HTML);
      if (key === `${PREFIX}/bridge.js`)  return Buffer.from('// bridge');
      throw new Error(`NoSuchKey: ${key}`);
    });
  });

  it('lists the mutable prefix, exactly as before', async () => {
    const res = await app.inject({ method: 'GET', url: url('files') });

    expect(res.statusCode).toBe(200);
    expect((res.json() as Array<{ key: string }>).map((f) => f.key).sort())
      .toEqual([`${PREFIX}/bridge.js`, `${PREFIX}/index.html`]);
    expect(mockStorage.listObjects).toHaveBeenCalledWith(PREFIX);
  });

  it('zips the mutable prefix, exactly as before', async () => {
    const res = await app.inject({ method: 'GET', url: url('download.zip') });

    expect(res.statusCode).toBe(200);
    expect(new AdmZip(res.rawPayload).getEntries().map((e) => e.entryName).sort())
      .toEqual(['bridge.js', 'index.html']);
  });

  it('scans the stored entry HTML, exactly as before', async () => {
    const res = await app.inject({ method: 'GET', url: url('ui-controls') });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { controls: Array<{ selector: string }> }).controls.map((c) => c.selector))
      .toEqual(['#legacy-only']);
    expect(mockStorage.readObject).toHaveBeenCalledWith(`${PREFIX}/index.html`);
  });
});
