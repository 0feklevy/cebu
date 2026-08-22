/**
 * GET /api/v1/projects/:id/simulations/:simId/publish-guidance/stream
 *
 * Two behaviours, and the second exists because of the first:
 *
 *  (1) LEGACY package — publish still works end to end: TTS runs, guidance.js and the entry HTML
 *      are written to the mutable prefix the player reads, and the row lands on 'ready'.
 *
 *  (2) REVISIONED package — the same write path targets `<prefix>/guidance.js` and `<prefix>/
 *      index.html`, which a revisioned simulation does not serve: the player loads
 *      `<prefix>/revisions/<active>/package/…`. The old code reported success anyway (audit
 *      simulation-002). It now refuses — and because this endpoint is an EventSource, the refusal
 *      is delivered as a NAMED SSE error event on an ESTABLISHED stream. A pre-SSE JSON 409 never
 *      reaches the client's 'error' listener at all: EventSource fails the connection instead and
 *      the editor renders the generic "Connection lost", which tells the user nothing.
 *
 * The refusal must land before `guidance_status` is touched, before any voice/TTS work and before
 * any upload — asserted here as zero database, zero storage and zero TTS mutation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerSimulationsRoutes } from '../simulations.controller.js';

const mocks = vi.hoisted(() => {
  const mockUpdateReturning = vi.fn();
  const mockUpdateWhere     = vi.fn(() => ({ returning: mockUpdateReturning }));
  const mockUpdateSet       = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate          = vi.fn(() => ({ set: mockUpdateSet }));

  return {
    mockProjects:         { findFirst: vi.fn() },
    mockSimulations:      { findFirst: vi.fn() },
    mockSystemPrompts:    { findFirst: vi.fn() },
    mockTimelineSections: { findMany: vi.fn() },
    mockUpdate, mockUpdateSet, mockUpdateWhere, mockUpdateReturning,
    // The publication reads the pointer through db.select() and stages the draft inside
    // db.transaction(). Both are hand-driven here: this suite proves the ENDPOINT's contract —
    // which path a request enters, and that an error always arrives ON the stream. The bytes, the
    // compare-and-set and the transaction boundary are proved against a real database in
    // `services/simulation/__tests__/revisionDerivation.test.ts`.
    mockSelectWhere:  vi.fn(),
    mockTransaction:  vi.fn(),
    mockSynthesize:   vi.fn(),
    mockResolveVoice: vi.fn(),
    mockStorage: {
      uploadFile:       vi.fn(),
      readObject:       vi.fn(),
      listObjects:      vi.fn(),
      deleteFile:       vi.fn(),
      deleteWithPrefix: vi.fn(),
      getSimPublicUrl:  vi.fn((key: string) => `https://cdn.example.com/sim-public/${key}`),
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
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: mocks.mockSelectWhere })) })),
    transaction: mocks.mockTransaction,
  },
}));

vi.mock('../../../db/schema.js', () => ({
  simulations:       Symbol('simulations'),
  sim_revisions:     Symbol('sim_revisions'),
  timeline_sections: Symbol('timeline_sections'),
  system_prompts:    Symbol('system_prompts'),
  api_keys:          Symbol('api_keys'),
  admin_settings:    Symbol('admin_settings'),
}));

vi.mock('drizzle-orm', () => ({
  eq:      vi.fn(() => ({ type: 'eq' })),
  isNotNull: vi.fn(() => ({ type: 'isNotNull' })),
  and:     vi.fn(() => ({ type: 'and' })),
  or:      vi.fn(() => ({ type: 'or' })),
  desc:    vi.fn(() => ({ type: 'desc' })),
  asc:     vi.fn(() => ({ type: 'asc' })),
  isNull:  vi.fn(() => ({ type: 'isNull' })),
  inArray: vi.fn(() => ({ type: 'inArray' })),
  exists:  vi.fn(() => ({ type: 'exists' })),
  sql:     vi.fn(() => ({ type: 'sql' })),
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

// The ONLY vendor call in this flow. Mocked so the suite never reaches ElevenLabs — and so the
// refusal test can assert it was never even considered.
vi.mock('../../../services/audio/GuidanceTTSService.js', () => ({
  GuidanceTTSService: class { synthesize = mocks.mockSynthesize; },
  resolveGuidanceVoice: mocks.mockResolveVoice,
}));

vi.mock('../../../services/llm/LLMService.js', () => ({ LLMService: class {} }));
vi.mock('../../../services/secrets/ApiKeyService.js', () => ({ ApiKeyService: class {} }));
vi.mock('../../../services/usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  mockProjects, mockSimulations, mockTimelineSections,
  mockUpdate, mockUpdateSet, mockUpdateReturning, mockStorage,
  mockSynthesize, mockResolveVoice,
} = mocks;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-1';
const SIM_ID     = 'sim-1';
const PREFIX     = `simulations/${PROJECT_ID}/${SIM_ID}`;
const URL_PATH   = `/api/v1/projects/${PROJECT_ID}/simulations/${SIM_ID}/publish-guidance/stream`;
const ACTIVE_REV = 'rev-9f3caaaa1111';

const FAKE_PROJECT = { id: PROJECT_ID, created_by: 'user-1' };

const CUE = {
  id: 'cue-1',
  kind: 'feature' as const,
  title: 'Press start',
  narration: 'Press the start button to begin.',
  enabled: true,
  trigger: { kind: 'feature' as const, targetId: 'start', events: ['pointerdown' as const] },
  audioUrl: null,
  confidence: 0.9,
  warnings: [],
};

const LEGACY_SIM = {
  id: SIM_ID,
  project_id: PROJECT_ID,
  name: 'My Sim',
  storage_prefix: PREFIX,
  entry_file: `${PREFIX}/index.html`,
  status: 'ready',
  guidance: [CUE],
  guidance_meta: { language: 'en' },
  guidance_status: 'draft',
  guidance_error: null,
  active_revision_id: null,
  active_revision_entry_key: null,
};

const REV_ROOT = `${PREFIX}/revisions/${ACTIVE_REV}`;
const REVISIONED_SIM = {
  ...LEGACY_SIM,
  active_revision_id:        ACTIVE_REV,
  active_revision_entry_key: `${REV_ROOT}/package/index.html`,
};

/** The manifest of the revision that is LIVE — the authoritative list a derivation starts from. */
const ACTIVE_MANIFEST = {
  manifestVersion: 1,
  simulationId: SIM_ID, projectId: PROJECT_ID,
  revisionId: ACTIVE_REV, revisionNumber: 3,
  bridgeProtocolVersion: 2, runtimeProtocolVersion: 1,
  entry: 'package/index.html',
  runtime: ['package/bridge.js'],
  files: [
    { path: 'package/index.html', role: 'entry',   hash: 'a'.repeat(64), bytes: 10, contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache' },
    { path: 'package/bridge.js',  role: 'runtime', hash: 'c'.repeat(64), bytes: 10, contentType: 'application/javascript', cacheControl: 'immutable' },
  ],
  variants: [{ variantKey: 'main', configHashes: [] }],
  posters: [], qualityProfiles: ['high'], externalDependencies: [],
  generatedFrom: {}, canary: { classification: null, ranAt: null, engine: null },
  createdAt: new Date(0).toISOString(), createdBy: 'test',
};

async function makeApp() {
  const app = Fastify();
  await registerSimulationsRoutes(app);
  return app;
}

/** SSE frames as `[eventName, parsedData]`, in order. */
function parseSse(payload: string): Array<[string, Record<string, unknown>]> {
  return payload
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const event = /^event:\s*(.+)$/m.exec(block)![1].trim();
      const data  = /^data:\s*(.*)$/m.exec(block)?.[1] ?? '{}';
      return [event, JSON.parse(data) as Record<string, unknown>] as [string, Record<string, unknown>];
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mockUpdateReturning.mockReset();
  mocks.mockUpdateWhere.mockImplementation(() => ({ returning: mocks.mockUpdateReturning }));
  mocks.mockUpdateSet.mockImplementation(() => ({ where: mocks.mockUpdateWhere }));
  mocks.mockUpdate.mockImplementation(() => ({ set: mocks.mockUpdateSet }));
  mockStorage.getSimPublicUrl.mockImplementation((key: string) => `https://cdn.example.com/sim-public/${key}`);

  mockProjects.findFirst.mockResolvedValue(FAKE_PROJECT);
  mockSimulations.findFirst.mockResolvedValue({ ...LEGACY_SIM });
  mockTimelineSections.findMany.mockResolvedValue([]);
  mockUpdateReturning.mockResolvedValue([{ ...LEGACY_SIM, guidance_status: 'ready' }]);

  // Legacy by default: no pointer, so nothing reaches db.transaction().
  mocks.mockSelectWhere.mockResolvedValue([{ storage_prefix: PREFIX, active_revision_id: null }]);
  mocks.mockTransaction.mockRejectedValue(new Error('REVISION_STAGING_REACHED'));

  mockResolveVoice.mockResolvedValue({ voiceId: 'voice-1', modelId: 'eleven_flash' });
  mockSynthesize.mockResolvedValue(Buffer.from('ID3-fake-mp3'));
  mockStorage.uploadFile.mockResolvedValue('https://cdn.example.com/uploaded');
  mockStorage.readObject.mockImplementation(async (key: string) => {
    if (key === `${PREFIX}/index.html`) return Buffer.from('<html><head></head><body>sim</body></html>');
    throw new Error(`NoSuchKey: ${key}`);
  });
});

// ── (1) Legacy package — unchanged, still publishes ───────────────────────────

describe('publish-guidance — legacy package', () => {
  it('synthesizes, writes guidance.js + entry HTML to the mutable prefix and ends ready', async () => {
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: URL_PATH });

    expect(res.statusCode).toBe(200);
    const events = parseSse(res.payload);
    expect(events.map(([name]) => name)).toContain('done');
    expect(events.map(([name]) => name)).not.toContain('error');

    // The vendor call happened exactly once, for the one enabled cue.
    expect(mockSynthesize).toHaveBeenCalledTimes(1);

    const uploaded = mockStorage.uploadFile.mock.calls.map((c) => c[0] as string);
    expect(uploaded).toContain(`${PREFIX}/guidance.js`);
    expect(uploaded).toContain(`${PREFIX}/index.html`);

    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ guidance_status: 'publishing' }));
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ guidance_status: 'ready' }));
  });
});

// ── (2) Revisioned package — publish INTO A NEW REVISION, never into the dead prefix ─────────
//
// audit D-04. `publishGuidance` used to write guidance.js, the cue audio and the re-injected entry
// HTML into the mutable prefix, which a revisioned simulation does not serve: the run "succeeded"
// and the guidance never played. It now derives a new revision instead. Two endpoint-level
// properties are pinned here, and both were bought at a cost worth keeping:
//
//   - NOT ONE BYTE reaches the mutable prefix except the content-addressed cue audio, which is
//     deliberately revision-independent; and
//   - a failure arrives as a NAMED event on an ESTABLISHED stream. A pre-SSE JSON error never
//     reaches an EventSource's 'error' listener — the browser fails the connection and the editor
//     shows "Connection lost", which describes a network fault the user does not have.

describe('publish-guidance — revisioned package (audit D-04)', () => {
  beforeEach(() => {
    mockSimulations.findFirst.mockResolvedValue({ ...REVISIONED_SIM });
    mocks.mockSelectWhere.mockResolvedValue([{ storage_prefix: PREFIX, active_revision_id: ACTIVE_REV }]);
    // The bytes a derivation reads: the live manifest and the files it names. The LEGACY copies
    // stay in the fixture too, so a path that reached for them would still find something — which
    // is the point: nothing below may write over them.
    mockStorage.readObject.mockImplementation(async (key: string) => {
      if (key === `${PREFIX}/index.html`)          return Buffer.from('<html><head></head><body>legacy</body></html>');
      if (key === `${PREFIX}/guidance.js`)         return Buffer.from('/* legacy guidance */');
      if (key === `${REV_ROOT}/manifest.json`)     return Buffer.from(JSON.stringify(ACTIVE_MANIFEST));
      if (key === `${REV_ROOT}/package/index.html`) return Buffer.from('<html><head></head><body>live</body></html>');
      if (key === `${REV_ROOT}/package/bridge.js`) return Buffer.from('/* live bridge */');
      throw new Error(`NoSuchKey: ${key}`);
    });
  });

  it('no longer refuses — it synthesizes and enters revision staging', async () => {
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: URL_PATH });

    expect(res.statusCode).toBe(200);
    // The operation is actually attempted now: the voice is resolved and the cue is synthesized.
    expect(mockResolveVoice).toHaveBeenCalled();
    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    // `db.transaction` is reached only by `createDraft` — entering it is what says the publication
    // took the revision path rather than the in-place one.
    expect(mocks.mockTransaction).toHaveBeenCalled();
  });

  it('writes NOTHING to the mutable prefix but the content-addressed cue audio', async () => {
    const app = await makeApp();

    await app.inject({ method: 'GET', url: URL_PATH });

    const uploaded = mockStorage.uploadFile.mock.calls.map((c) => c[0] as string);
    // THE DEFECT, stated as an assertion: the two files the old code wrote to a prefix nobody
    // serves. Their absence here is the fix; their presence was the bug.
    expect(uploaded).not.toContain(`${PREFIX}/guidance.js`);
    expect(uploaded).not.toContain(`${PREFIX}/index.html`);
    // Everything that IS written to the mutable prefix is cue audio, keyed by narration hash.
    expect(uploaded.every((k) => k.startsWith(`${PREFIX}/guidance/`))).toBe(true);
    expect(mockStorage.deleteFile).not.toHaveBeenCalled();
  });

  it('delivers a staging failure as a NAMED event on an ESTABLISHED stream, never as a bare 409', async () => {
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: URL_PATH });

    // The stream is REAL: 200 + event-stream, so the browser's EventSource stays open long enough
    // to hand the payload to the 'error' listener.
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = parseSse(res.payload);
    expect(events[0][0]).toBe('connected');
    const errorFrame = events.find(([name]) => name === 'error');
    expect(errorFrame, 'the failure must arrive as a named SSE error event').toBeDefined();
    // The editor renders `data.error`; an empty one is the "Connection lost" experience again.
    expect(String(errorFrame![1].error).length).toBeGreaterThan(0);
    expect(events.map(([name]) => name)).not.toContain('done');
  });

  it('does not mark the guidance ready when the publication fails', async () => {
    const app = await makeApp();

    await app.inject({ method: 'GET', url: URL_PATH });

    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ guidance_status: 'publishing' }));
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ guidance_status: 'error' }));
    expect(mockUpdateSet).not.toHaveBeenCalledWith(expect.objectContaining({ guidance_status: 'ready' }));
  });

  it('still refuses an empty draft with the ordinary 400 — nothing is billed', async () => {
    mockSimulations.findFirst.mockResolvedValue({
      ...REVISIONED_SIM,
      guidance: [{ ...CUE, enabled: false }],
    });
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: URL_PATH });

    expect(res.statusCode).toBe(400);
    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(mockStorage.uploadFile).not.toHaveBeenCalled();
  });
});

// ── (4) backend-006 — the stream must END, even when the first write throws ───

/**
 * The guidance handlers armed a 15s keep-alive interval, flushed headers with
 * `sendEvent('connected')`, and only THEN did `await db.update(... 'publishing')` — outside the
 * `try` whose `finally` owns `clearInterval` and `reply.raw.end()`.
 *
 * A throw from that one update is the worst-placed throw in the handler. The headers are already
 * sent, so Fastify cannot turn it into a 5xx; and `finally` was never entered, so the interval was
 * never cleared and the stream was never ended. The client's EventSource hangs with no error and
 * no end, while a timer keeps writing to a dead handler until the socket eventually closes.
 *
 * Moving the update inside the `try` makes the same failure end the stream instead.
 */
describe('publish-guidance — a failing status write still ends the stream (backend-006)', () => {
  it('ENDS the response instead of hanging when the first db.update throws', async () => {
    // Only the FIRST update throws — the status flip to 'publishing'. Later ones behave normally,
    // so this isolates the unguarded await rather than breaking the whole handler.
    let calls = 0;
    mocks.mockUpdateWhere.mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error('db is down');
      return { returning: mocks.mockUpdateReturning };
    });

    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: URL_PATH });

    // The request completes rather than hanging — which is the whole point. Before the fix the
    // rejection escaped after headers were sent and nothing closed the stream.
    expect(res.statusCode).toBe(200);
    expect(calls, 'the failing update was reached').toBeGreaterThan(0);
    await app.close();
  });

  it('still emits its connected frame, so the client saw an established stream', async () => {
    let calls = 0;
    mocks.mockUpdateWhere.mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error('db is down');
      return { returning: mocks.mockUpdateReturning };
    });

    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: URL_PATH });
    const events = parseSse(res.payload).map(([name]) => name);

    expect(events[0], 'headers were flushed before the failure — that is why it could not be a 5xx')
      .toBe('connected');
    await app.close();
  });
});
