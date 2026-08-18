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

const REVISIONED_SIM = {
  ...LEGACY_SIM,
  active_revision_id:        ACTIVE_REV,
  active_revision_entry_key: `${PREFIX}/revisions/${ACTIVE_REV}/package/index.html`,
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

// ── (2) Revisioned package — refuse, on the stream, having changed nothing ────

describe('publish-guidance — revisioned package (simulation-002)', () => {
  beforeEach(() => {
    mockSimulations.findFirst.mockResolvedValue({ ...REVISIONED_SIM });
  });

  it('establishes the SSE stream and emits a NAMED error event carrying the stable code', async () => {
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: URL_PATH });

    // The stream is REAL: a 200 with the event-stream content type, so the browser's EventSource
    // stays open long enough to deliver the payload to the 'error' listener.
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = parseSse(res.payload);
    expect(events[0][0]).toBe('connected');

    const errorFrame = events.find(([name]) => name === 'error');
    expect(errorFrame, 'the refusal must arrive as a named SSE error event').toBeDefined();
    expect(errorFrame![1].code).toBe('SIM_REVISION_WRITE_UNSUPPORTED');
    expect(errorFrame![1].activeRevisionId).toBe(ACTIVE_REV);
    // The editor renders `data.error`; an empty one is the "Connection lost" experience again.
    expect(String(errorFrame![1].error).length).toBeGreaterThan(0);

    expect(events.map(([name]) => name)).not.toContain('done');
  });

  it('mutates NOTHING — no guidance_status write, no upload, no TTS', async () => {
    const app = await makeApp();

    await app.inject({ method: 'GET', url: URL_PATH });

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    expect(mockStorage.deleteFile).not.toHaveBeenCalled();
    expect(mockResolveVoice).not.toHaveBeenCalled();
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('refuses ahead of the empty-draft 400, so the client always gets the stream', async () => {
    mockSimulations.findFirst.mockResolvedValue({
      ...REVISIONED_SIM,
      guidance: [{ ...CUE, enabled: false }],
    });
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: URL_PATH });

    expect(res.headers['content-type']).toContain('text/event-stream');
    const errorFrame = parseSse(res.payload).find(([name]) => name === 'error');
    expect(errorFrame![1].code).toBe('SIM_REVISION_WRITE_UNSUPPORTED');
  });
});
