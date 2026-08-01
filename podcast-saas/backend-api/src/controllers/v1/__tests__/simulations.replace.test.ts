/**
 * D8 — POST /api/v1/projects/:id/simulations/:simId/replace
 *
 * Covers:
 *  (c) happy path — same entry name: stale file deleted, generated artifacts preserved
 *      and re-wired (bridge.js keeps its current ?v= hash), row ends 'ready'
 *  (d) different entry name — clear 409 before any processing starts
 *  (e) permission guard — same collabAccess gate as the upload endpoint
 *  plus: busy sim (status processing) → 409, and empty upload → 400.
 *
 * Uses the real SimulationService.processReplace against a mocked storage adapter;
 * db/auth/collab access are mocked in the style of sections.sim.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import AdmZip from 'adm-zip';
import { createHash } from 'crypto';
import { registerSimulationsRoutes } from '../simulations.controller.js';

// ── Mocks (hoisted so they're available inside vi.mock factories) ──────────────

const mocks = vi.hoisted(() => {
  const mockUpdateReturning = vi.fn();
  const mockUpdateWhere     = vi.fn(() => ({ returning: mockUpdateReturning }));
  const mockUpdateSet       = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate          = vi.fn(() => ({ set: mockUpdateSet }));

  return {
    mockProjects:    { findFirst: vi.fn() },
    mockSimulations: { findFirst: vi.fn() },
    mockSystemPrompts: { findFirst: vi.fn() },
    // The bridge-compatibility gate reads this package's sections for their Minimal-UI selection.
    mockTimelineSections: { findMany: vi.fn() },
    mockUpdate, mockUpdateSet, mockUpdateWhere, mockUpdateReturning,
    mockStorage: {
      uploadFile:      vi.fn(),
      readObject:      vi.fn(),
      listObjects:     vi.fn(),
      deleteFile:      vi.fn(),
      deleteWithPrefix: vi.fn(),
      getSimPublicUrl: vi.fn((key: string) => `https://cdn.example.com/sim-public/${key}`),
    },
  };
});

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      simulations:       mocks.mockSimulations,
      projects:          mocks.mockProjects,
      system_prompts:    mocks.mockSystemPrompts,
      timeline_sections: mocks.mockTimelineSections,
    },
    update: mocks.mockUpdate,
  },
}));

vi.mock('../../../db/schema.js', () => ({
  simulations:       Symbol('simulations'),
  timeline_sections: Symbol('timeline_sections'),
  system_prompts:    Symbol('system_prompts'),
  api_keys:          Symbol('api_keys'),
  admin_settings:    Symbol('admin_settings'),
}));

vi.mock('drizzle-orm', () => ({
  eq:      vi.fn(() => ({ type: 'eq' })),
  and:     vi.fn(() => ({ type: 'and' })),
  or:      vi.fn(() => ({ type: 'or' })),
  desc:    vi.fn(() => ({ type: 'desc' })),
  asc:     vi.fn(() => ({ type: 'asc' })),
  isNull:  vi.fn(() => ({ type: 'isNull' })),
  inArray: vi.fn(() => ({ type: 'inArray' })),
  exists:  vi.fn(() => ({ type: 'exists' })),
  sql:     vi.fn(() => ({ type: 'sql' })),
}));

// Same collabAccess gate as the upload endpoint: the projects fixture decides access.
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

// Keep the heavy LLM/keys/usage graph out — the replace flow never calls them.
vi.mock('../../../services/llm/LLMService.js', () => ({ LLMService: class {} }));
vi.mock('../../../services/secrets/ApiKeyService.js', () => ({ ApiKeyService: class {} }));
vi.mock('../../../services/usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { mockProjects, mockSimulations, mockTimelineSections, mockUpdate, mockUpdateSet, mockUpdateReturning, mockStorage } = mocks;

// ── Fixtures & helpers ────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-1';
const SIM_ID     = 'sim-1';
const PREFIX     = `simulations/${PROJECT_ID}/${SIM_ID}`;
const URL_PATH   = `/api/v1/projects/${PROJECT_ID}/simulations/${SIM_ID}/replace`;

const FAKE_PROJECT = { id: PROJECT_ID, created_by: 'user-1' };
const FAKE_SIM = {
  id: SIM_ID,
  project_id: PROJECT_ID,
  name: 'My Sim',
  storage_prefix: PREFIX,
  entry_file: `${PREFIX}/index.html`,
  bridge_functions: [],
  status: 'ready',
  error: null,
};

const BRIDGE_CONTENT   = '(function(){ /* combined bridge */ })();';
const GUIDANCE_CONTENT = ';(function(){ /* guidance overlay */ })();';
const bridgeHash   = createHash('sha256').update(BRIDGE_CONTENT).digest('hex').slice(0, 12);
const guidanceHash = createHash('sha256').update(GUIDANCE_CONTENT).digest('hex').slice(0, 12);

const NEW_INDEX_HTML = '<html><head><title>v2</title></head><body><script src="app.js"></script></body></html>';

function makeZip(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) zip.addFile(path, Buffer.from(content));
  return zip.toBuffer();
}

function multipartPayload(parts: Array<{ name: string; filename?: string; content: Buffer | string }>): {
  payload: Buffer; headers: Record<string, string>;
} {
  const boundary = '----vitest-boundary-1337';
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(
      p.filename !== undefined
        ? `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
        : `Content-Disposition: form-data; name="${p.name}"\r\n\r\n`,
    ));
    chunks.push(Buffer.isBuffer(p.content) ? p.content : Buffer.from(p.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function zipRequest(files: Record<string, string>) {
  return multipartPayload([{ name: 'file', filename: 'sim.zip', content: makeZip(files) }]);
}

async function makeApp() {
  const app = Fastify();
  await app.register(multipart);
  await registerSimulationsRoutes(app);
  return app;
}

/** Storage fixture: sim already has user files + generated artifacts in the bucket. */
function primeStorage() {
  mockStorage.listObjects.mockResolvedValue([
    `${PREFIX}/index.html`,
    `${PREFIX}/app.js`,
    `${PREFIX}/legacy.js`,               // stale — absent from the new bundle
    `${PREFIX}/bridge.js`,               // generated — must be preserved
    `${PREFIX}/guidance.js`,             // generated — must be preserved
    `${PREFIX}/guidance/understanding.md`, // generated — must be preserved
    `${PREFIX}/guidance/en/cue1.abc.mp3`,  // generated — must be preserved
  ]);
  mockStorage.readObject.mockImplementation(async (key: string) => {
    if (key === `${PREFIX}/bridge.js`)   return Buffer.from(BRIDGE_CONTENT);
    if (key === `${PREFIX}/guidance.js`) return Buffer.from(GUIDANCE_CONTENT);
    throw new Error(`NoSuchKey: ${key}`);
  });
  mockStorage.uploadFile.mockResolvedValue('https://cdn.example.com/uploaded');
  mockStorage.deleteFile.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-wire chains after clearAllMocks resets implementations.
  mocks.mockUpdateReturning.mockReset();
  mocks.mockUpdateWhere.mockImplementation(() => ({ returning: mocks.mockUpdateReturning }));
  mocks.mockUpdateSet.mockImplementation(() => ({ where: mocks.mockUpdateWhere }));
  mocks.mockUpdate.mockImplementation(() => ({ set: mocks.mockUpdateSet }));
  mockStorage.getSimPublicUrl.mockImplementation((key: string) => `https://cdn.example.com/sim-public/${key}`);

  mockProjects.findFirst.mockResolvedValue(FAKE_PROJECT);
  mockSimulations.findFirst.mockResolvedValue({ ...FAKE_SIM });
  mockTimelineSections.findMany.mockResolvedValue([]);
  // CAS claim succeeds by default.
  mockUpdateReturning.mockResolvedValue([{ ...FAKE_SIM, status: 'processing' }]);
  primeStorage();
});

// ── (c) Happy path ────────────────────────────────────────────────────────────

describe('POST …/simulations/:simId/replace — happy path', () => {
  it('accepts a same-entry-name ZIP, swaps files, preserves generated artifacts and ends ready', async () => {
    const app = await makeApp();
    const { payload, headers } = zipRequest({ 'index.html': NEW_INDEX_HTML, 'app.js': 'var v2 = true;' });

    const res = await app.inject({ method: 'POST', url: URL_PATH, payload, headers });

    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('processing');

    // CAS claim: ready → processing.
    expect(mockUpdateSet).toHaveBeenCalledWith({ status: 'processing', error: null });

    // Background swap finishes → row goes back to ready with the same entry key.
    await vi.waitFor(() => {
      expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
        status: 'ready',
        entry_file: `${PREFIX}/index.html`,
      }));
    });

    // New files were uploaded over the same keys.
    const uploadedKeys = mockStorage.uploadFile.mock.calls.map((c) => c[0] as string);
    expect(uploadedKeys).toContain(`${PREFIX}/index.html`);
    expect(uploadedKeys).toContain(`${PREFIX}/app.js`);
    // Generated artifacts are NOT re-uploaded by the swap.
    expect(uploadedKeys).not.toContain(`${PREFIX}/bridge.js`);
    expect(uploadedKeys).not.toContain(`${PREFIX}/guidance.js`);

    // The new entry HTML got the full system re-injection.
    const entryCall = mockStorage.uploadFile.mock.calls.find((c) => c[0] === `${PREFIX}/index.html`)!;
    const entryHtml = (entryCall[1] as Buffer).toString('utf-8');
    expect(entryHtml.split('<!-- sim-raf-gate v4 -->').length - 1).toBe(1);       // one head gate
    expect(entryHtml).toContain("d.type === 'simPause'");
    expect(entryHtml).toContain(`bridge.js?v=${bridgeHash}`);                     // current bridge hash
    expect(entryHtml).toContain(`guidance.js?v=${guidanceHash}`);                 // current guidance hash
    expect(entryHtml).toContain('<!-- SIM_BRIDGE_SCRIPT_START -->');
    expect(entryHtml).toContain('<!-- SIM_GUIDANCE_SCRIPT_START -->');
    expect(entryHtml).not.toContain('/* sim-bridge v2');                          // combined bridge supersedes inline

    // Stale user file deleted; generated artifacts preserved.
    const deletedKeys = mockStorage.deleteFile.mock.calls.map((c) => c[0] as string);
    expect(deletedKeys).toEqual([`${PREFIX}/legacy.js`]);
  });

  it('falls back to the inline bridge template when no bridge.js was ever generated', async () => {
    mockStorage.listObjects.mockResolvedValue([`${PREFIX}/index.html`]);
    mockStorage.readObject.mockRejectedValue(new Error('NoSuchKey'));

    const app = await makeApp();
    // app.js ships with the bundle: the entry references it, and the structural gate refuses an
    // upload whose entry points at a file the replacement would delete.
    const { payload, headers } = zipRequest({ 'index.html': NEW_INDEX_HTML, 'app.js': 'var v2 = true;' });
    const res = await app.inject({ method: 'POST', url: URL_PATH, payload, headers });

    expect(res.statusCode).toBe(202);
    await vi.waitFor(() => {
      expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
    });

    const entryCall = mockStorage.uploadFile.mock.calls.find((c) => c[0] === `${PREFIX}/index.html`)!;
    const entryHtml = (entryCall[1] as Buffer).toString('utf-8');
    expect(entryHtml).toContain('<!-- sim-raf-gate v4 -->');
    expect(entryHtml.split('/* sim-bridge v2').length - 1).toBe(1);   // inline template, once
    expect(entryHtml).not.toContain('SIM_BRIDGE_SCRIPT_START');
  });
});

// ── (d) Different entry name ──────────────────────────────────────────────────

describe('POST …/replace — entry-name mismatch', () => {
  it('rejects a renamed entry HTML with a clear 409 before any processing', async () => {
    const app = await makeApp();
    const { payload, headers } = zipRequest({ 'main.html': NEW_INDEX_HTML, 'app.js': 'x' });

    const res = await app.inject({ method: 'POST', url: URL_PATH, payload, headers });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.message).toContain('same entry file name');
    expect(body.message).toContain('index.html');
    expect(body.expectedEntryFile).toBe('index.html');

    // Nothing was claimed, uploaded, or deleted.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    expect(mockStorage.deleteFile).not.toHaveBeenCalled();
  });
});

// ── (e) Permission guard ──────────────────────────────────────────────────────

describe('POST …/replace — guards', () => {
  it('404s when the user has no edit access to the project (collabAccess gate)', async () => {
    mockProjects.findFirst.mockResolvedValue(undefined);
    const app = await makeApp();
    const { payload, headers } = zipRequest({ 'index.html': NEW_INDEX_HTML });

    const res = await app.inject({ method: 'POST', url: URL_PATH, payload, headers });

    expect(res.statusCode).toBe(404);
    expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('404s when the simulation does not belong to the project', async () => {
    mockSimulations.findFirst.mockResolvedValue(undefined);
    const app = await makeApp();
    const { payload, headers } = zipRequest({ 'index.html': NEW_INDEX_HTML });

    const res = await app.inject({ method: 'POST', url: URL_PATH, payload, headers });

    expect(res.statusCode).toBe(404);
  });

  it('409s while the simulation is still processing', async () => {
    mockSimulations.findFirst.mockResolvedValue({ ...FAKE_SIM, status: 'processing' });
    const app = await makeApp();
    const { payload, headers } = zipRequest({ 'index.html': NEW_INDEX_HTML });

    const res = await app.inject({ method: 'POST', url: URL_PATH, payload, headers });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('processing');
  });

  it('400s when neither a ZIP nor a bundle is uploaded', async () => {
    const app = await makeApp();
    const { payload, headers } = multipartPayload([{ name: 'name', content: 'ignored' }]);

    const res = await app.inject({ method: 'POST', url: URL_PATH, payload, headers });

    expect(res.statusCode).toBe(400);
  });
});

// ── Bridge-compatibility gate ─────────────────────────────────────────────────
//
// A replace PRESERVES bridge.js, so the new files must keep providing the DOM/JS anchors its
// section bodies bind to. The gate runs on the decoded upload BEFORE the CAS claim, so a refusal
// leaves the live simulation completely untouched.

const SECTION_ID = 'sec-aaaa-1111';
/** A combined bridge whose one section drives the sim through a class + a window global. */
const REAL_BRIDGE = `(function(){ var __SECTIONS__ = {
/* @@SIM_BRIDGE:${SECTION_ID}@@ */
'${SECTION_ID}': function (params) {
  var panel = document.querySelector('.controls-scroll');
  if (window.app && window.app.rig) window.app.setMode(2);
  return function cleanup() {};
},
/* @@/SIM_BRIDGE:${SECTION_ID}@@ */
}; })();`;

/** Files that still satisfy the bridge (the anchors live in app.js, built at runtime). */
const COMPATIBLE_APP_JS = `
  window.app = { rig: {}, setMode: function (n) { this.mode = n; } };
  var el = document.createElement('div'); el.className = 'controls-scroll';
`;
/** The "change was too big" version: the panel class and the API method were renamed. */
const BROKEN_APP_JS = `
  window.app = { camera: {}, applyMode: function (n) { this.mode = n; } };
  var el = document.createElement('div'); el.className = 'panel-scroll';
`;

function primeBridge(bridgeJs: string) {
  mockStorage.readObject.mockImplementation(async (key: string) => {
    if (key === `${PREFIX}/bridge.js`)   return Buffer.from(bridgeJs);
    if (key === `${PREFIX}/guidance.js`) return Buffer.from(GUIDANCE_CONTENT);
    throw new Error(`NoSuchKey: ${key}`);
  });
}

describe('POST …/replace — bridge-compatibility gate', () => {
  it('allows a slightly-edited simulation that still satisfies the bridge', async () => {
    primeBridge(REAL_BRIDGE);
    const app = await makeApp();
    const { payload, headers } = zipRequest({
      'index.html': NEW_INDEX_HTML,
      'app.js': `${COMPATIBLE_APP_JS}\n// v2: retuned constants\nvar SPEED = 1.25;\n`,
    });

    const res = await app.inject({ method: 'POST', url: URL_PATH, payload, headers });

    expect(res.statusCode).toBe(202);
    expect(mockUpdateSet).toHaveBeenCalledWith({ status: 'processing', error: null });
  });

  it('REFUSES a replacement that would break the bridge — and touches nothing', async () => {
    primeBridge(REAL_BRIDGE);
    const app = await makeApp();
    const { payload, headers } = zipRequest({ 'index.html': NEW_INDEX_HTML, 'app.js': BROKEN_APP_JS });

    const res = await app.inject({ method: 'POST', url: URL_PATH, payload, headers });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.message).toContain('the existing bridge would stop working');
    expect(body.compatibility.compatible).toBe(false);
    expect(body.compatibility.summary).toMatchObject({ sectionsTotal: 1, sectionsBroken: 1 });
    // The refusal names the section and exactly what disappeared.
    const broken = body.compatibility.sections.find((s: { status: string }) => s.status === 'broken');
    expect(broken.sectionId).toBe(SECTION_ID);
    expect(JSON.stringify(broken.missing)).toContain('controls-scroll');

    // NOTHING was claimed, uploaded, or deleted — production is untouched.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    expect(mockStorage.deleteFile).not.toHaveBeenCalled();
  });

  it('ONE broken section refuses the whole replace even when other sections are fine', async () => {
    const OTHER = 'sec-bbbb-2222';
    primeBridge(
      REAL_BRIDGE.replace(
        '}; })();',
        `/* @@SIM_BRIDGE:${OTHER}@@ */\n'${OTHER}': function (params) { return function () {}; },\n/* @@/SIM_BRIDGE:${OTHER}@@ */\n}; })();`,
      ),
    );
    const app = await makeApp();
    const { payload, headers } = zipRequest({ 'index.html': NEW_INDEX_HTML, 'app.js': BROKEN_APP_JS });

    const res = await app.inject({ method: 'POST', url: URL_PATH, payload, headers });

    expect(res.statusCode).toBe(409);
    expect(res.json().compatibility.summary).toMatchObject({ sectionsTotal: 2, sectionsOk: 1, sectionsBroken: 1 });
    expect(mockStorage.uploadFile).not.toHaveBeenCalled();
  });

  it('?dry_run=true reports compatibility without replacing anything', async () => {
    primeBridge(REAL_BRIDGE);
    const app = await makeApp();
    const { payload, headers } = zipRequest({ 'index.html': NEW_INDEX_HTML, 'app.js': COMPATIBLE_APP_JS });

    const res = await app.inject({ method: 'POST', url: `${URL_PATH}?dry_run=true`, payload, headers });

    expect(res.statusCode).toBe(200);
    expect(res.json().compatibility.compatible).toBe(true);
    // Preflight is read-only.
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockStorage.uploadFile).not.toHaveBeenCalled();
  });

  it('?dry_run=true surfaces the refusal without a 409 (so the UI can preview it)', async () => {
    primeBridge(REAL_BRIDGE);
    const app = await makeApp();
    const { payload, headers } = zipRequest({ 'index.html': NEW_INDEX_HTML, 'app.js': BROKEN_APP_JS });

    const res = await app.inject({ method: 'POST', url: `${URL_PATH}?dry_run=true`, payload, headers });

    expect(res.statusCode).toBe(200);
    expect(res.json().compatibility.compatible).toBe(false);
    expect(mockStorage.uploadFile).not.toHaveBeenCalled();
  });

  it('a package with no generated bridge is always compatible (nothing to preserve)', async () => {
    mockStorage.readObject.mockRejectedValue(new Error('NoSuchKey'));
    const app = await makeApp();
    const { payload, headers } = zipRequest({ 'index.html': NEW_INDEX_HTML, 'app.js': BROKEN_APP_JS });

    const res = await app.inject({ method: 'POST', url: URL_PATH, payload, headers });

    expect(res.statusCode).toBe(202);
  });

  it('refuses an upload whose entry references a file the bundle does not contain', async () => {
    primeBridge(REAL_BRIDGE);
    const app = await makeApp();
    const { payload, headers } = zipRequest({ 'index.html': NEW_INDEX_HTML });   // app.js missing

    const res = await app.inject({ method: 'POST', url: URL_PATH, payload, headers });

    expect(res.statusCode).toBe(409);
    expect(res.json().compatibility.structural.join(' ')).toContain('app.js');
    expect(mockStorage.uploadFile).not.toHaveBeenCalled();
  });
});
