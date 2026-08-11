/**
 * Minimal-UI control picker — the generation contract on
 * GET /api/v1/projects/:id/sections/:sid/generate-sim-script/stream.
 *
 * Covers:
 *  (a) ?ui_controls= validation — oversized / non-JSON / bad shape → clean HTTP 400
 *      BEFORE the response switches to SSE
 *  (b) the canReuse selection-equality matrix (SimulationService mocked):
 *        stored absent + incoming absent  → reuse
 *        stored X + incoming X (any order)→ reuse
 *        stored X + incoming Y            → regenerate
 *        stored absent + incoming X       → regenerate (selection added)
 *        stored X + incoming absent       → regenerate (selection removed)
 *  (c) persistence — regeneration writes sim_meta.planVersion '7' and the NORMALIZED
 *      selection (sorted show/hide), and passes it to generateBridgeScript
 *  (d) the JSON POST sibling route — ui_controls accepted, validated with
 *      SimUiSelectionSchema, and threaded identically (canReuse equality + persist +
 *      service plumbing); without it any POST call would wipe sim_meta.uiControls
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerSectionsRoutes } from '../sections.controller.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const mockUpdateReturning = vi.fn();
  const mockUpdateWhere     = vi.fn(() => ({ returning: mockUpdateReturning }));
  const mockUpdateSet       = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate          = vi.fn(() => ({ set: mockUpdateSet }));
  return {
    mockProjects:    { findFirst: vi.fn() },
    mockSections:    { findFirst: vi.fn() },
    mockSimulations: { findFirst: vi.fn() },
    mockVideoFiles:  { findFirst: vi.fn() },
    mockUpdate, mockUpdateSet, mockUpdateWhere, mockUpdateReturning,
    mockGenerate:  vi.fn(),
    mockReuse:     vi.fn(),
    mockMechanical: vi.fn(),
  };
});

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      projects:          mocks.mockProjects,
      timeline_sections: mocks.mockSections,
      simulations:       mocks.mockSimulations,
      video_files:        mocks.mockVideoFiles,
    },
    update: mocks.mockUpdate,
  },
}));

vi.mock('../../../db/schema.js', () => ({
  projects:          Symbol('projects'),
  timeline_sections: Symbol('timeline_sections'),
  simulations:       Symbol('simulations'),
  video_files:        Symbol('video_files'),
}));

vi.mock('drizzle-orm', () => ({
  eq:  vi.fn(() => ({ type: 'eq' })),
  and: vi.fn(() => ({ type: 'and' })),
  asc: vi.fn(() => ({ type: 'asc' })),
}));

vi.mock('../../../services/collabAccess.js', () => ({
  editableProject: vi.fn((_id: string, _user: unknown) => mocks.mockProjects.findFirst()),
}));

vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: (req: Record<string, unknown>, _reply: unknown, done: () => void) => {
    req.dbUser = { id: 'user-1' };
    done();
  },
}));

// The generation service itself is mocked — these tests pin the CONTROLLER contract
// (validation, canReuse decision, sim_meta persistence), not bridge generation.
vi.mock('../../../services/simulation/SimulationService.js', () => ({
  SimulationService: class {
    generateBridgeScript = mocks.mockGenerate;
    reuseBridgeScript    = mocks.mockReuse;
    applyMinimalUiOnly   = mocks.mockMechanical;
  },
}));

vi.mock('../../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({ getSimPublicUrl: (key: string) => `https://cdn.example.com/sim-public/${key}` }),
}));
vi.mock('../../../services/llm/LLMService.js', () => ({ LLMService: class {} }));
vi.mock('../../../services/secrets/ApiKeyService.js', () => ({ ApiKeyService: class {} }));
vi.mock('../../../services/usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));

const {
  mockProjects, mockSections, mockSimulations,
  mockUpdateSet, mockUpdateReturning, mockGenerate, mockReuse, mockMechanical,
} = mocks;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-1';
const SECTION_ID = 'sec-1';
const SIM_ID     = 'sim-1';
const PROMPT     = 'the prompt';
const OWN_URL    = `https://cdn.example.com/sim-public/simulations/${PROJECT_ID}/${SIM_ID}/index.html?section=${SECTION_ID}&v=abc123`;

const FAKE_PROJECT = { id: PROJECT_ID, created_by: 'user-1' };

const SELECTION = {
  controls: [
    { selector: '#a', kind: 'button', label: 'A' },
    { selector: '#b', kind: 'slider', label: 'B' },
  ],
  show: ['#a'],
  hide: ['#b'],
};

const META_BASE = {
  planVersion: '7', generatedBy: 'llm', prompt: PROMPT,
  supportsRuntimeParams: true, sourceHash: 'srchash', conversationHistory: [],
};

const makeSection = (simMeta: Record<string, unknown> | null) => ({
  id: SECTION_ID, project_id: PROJECT_ID, video_file_id: 'vid-1',
  start_sec: 0, end_sec: 10, type: 'simulation',
  simulation_id: SIM_ID, simulation_url: OWN_URL,
  sim_prompt: PROMPT, sim_script: 'main', sim_meta: simMeta,
});

const GEN_RESULT = {
  sectionUrl: OWN_URL.replace('abc123', 'def456'),
  conversationHistory: [], sourceHash: 'srchash2', bridgeHash: 'def456',
  mainBody: 'return function cleanup() {};', provider: 'anthropic', model: 'm',
  confidence: 0.9, confidenceLevel: 'high', warnings: [], validationErrors: [],
  validationWarnings: [], retryCount: 0, retryReason: null, contextTruncated: false,
};

const streamUrl = (uiControls?: string) => {
  const params = new URLSearchParams({ prompt: PROMPT });
  if (uiControls !== undefined) params.set('ui_controls', uiControls);
  return `/api/v1/projects/${PROJECT_ID}/sections/${SECTION_ID}/generate-sim-script/stream?${params.toString()}`;
};

/**
 * A publishing service double.
 *
 * Since audit P0.4 the section row is no longer written by the controller after the service
 * resolves: the controller hands the service a `persistSection` hook and the REAL service runs
 * it inside the revision-activation transaction, so the pointer flip and the section row commit
 * together. A double that merely resolves therefore models a service that published without
 * ever persisting the section — which the controller now (correctly, loudly) rejects.
 *
 * So the double calls the hook exactly as the service does, handing it the mocked `db` as the
 * transaction handle: the assertions below still read the row write off `mockUpdateSet`, and
 * "the hook ran exactly once" is now part of what every case here pins.
 */
const publishing =
  <T extends object>(result: T) =>
  async (opts: { persistSection?: (tx: unknown, pub: T) => Promise<void> }): Promise<T> => {
    await opts.persistSection?.({ update: mocks.mockUpdate }, result);
    return result;
  };

async function makeApp() {
  const app = Fastify();
  await registerSectionsRoutes(app);
  return app;
}

let app: Awaited<ReturnType<typeof makeApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.mockUpdateReturning.mockReset();
  mocks.mockUpdateWhere.mockImplementation(() => ({ returning: mocks.mockUpdateReturning }));
  mocks.mockUpdateSet.mockImplementation(() => ({ where: mocks.mockUpdateWhere }));
  mocks.mockUpdate.mockImplementation(() => ({ set: mocks.mockUpdateSet }));

  mockProjects.findFirst.mockResolvedValue(FAKE_PROJECT);
  mockSimulations.findFirst.mockResolvedValue({
    id: SIM_ID, project_id: PROJECT_ID, entry_file: `simulations/${PROJECT_ID}/${SIM_ID}/index.html`,
  });
  mockGenerate.mockImplementation(publishing(GEN_RESULT));
  mockReuse.mockImplementation((url: string) => ({ sectionUrl: url }));
  mockMechanical.mockImplementation(
    publishing({ sectionUrl: OWN_URL.replace('abc123', 'mech01'), bridgeHash: 'mech01' }),
  );
  mockUpdateReturning.mockResolvedValue([makeSection(META_BASE)]);
  app = await makeApp();
});

// ── (a) ui_controls validation — clean 400s before SSE ────────────────────────

describe('ui_controls query param validation', () => {
  beforeEach(() => {
    mockSections.findFirst.mockResolvedValue(makeSection(META_BASE));
  });

  it('rejects oversized payloads (> 8192 chars) with 400', async () => {
    const huge = JSON.stringify({ controls: [], show: [], hide: [] }).padEnd(8193, ' ');
    const res = await app.inject({ method: 'GET', url: streamUrl(huge) });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/too large/);
  });

  it('rejects non-JSON with 400', async () => {
    const res = await app.inject({ method: 'GET', url: streamUrl('not-json{') });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/valid JSON/);
  });

  it('rejects garbage shapes with 400', async () => {
    // The unified GenerateSimScriptSchema now validates ui_controls, so the 400 body carries
    // the precise Zod issue (field-prefixed) rather than the old bespoke "invalid shape".
    for (const bad of ['42', '"str"', '{"controls":"x","show":[],"hide":[]}', '{"show":[],"hide":[]}']) {
      const res = await app.inject({ method: 'GET', url: streamUrl(bad) });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/ui_controls|Expected|Required|Invalid/i);
    }
  });

  it('rejects over-limit arrays and over-long selectors with 400', async () => {
    const manySelectors = Array.from({ length: 101 }, (_, i) => `#c${i}`);
    const tooMany = JSON.stringify({ controls: [], show: [], hide: manySelectors });
    expect((await app.inject({ method: 'GET', url: streamUrl(tooMany) })).statusCode).toBe(400);
    const longSel = JSON.stringify({ controls: [], show: [], hide: ['#' + 'x'.repeat(300)] });
    expect((await app.inject({ method: 'GET', url: streamUrl(longSel) })).statusCode).toBe(400);
  });

  it('treats an empty ui_controls param as absent (no 400)', async () => {
    const res = await app.inject({ method: 'GET', url: streamUrl('') });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: done');
  });
});

// ── (b) canReuse selection-equality matrix ────────────────────────────────────

describe('canReuse — selection equality matrix', () => {
  const inject = (uiControls?: string) => app.inject({ method: 'GET', url: streamUrl(uiControls) });

  it('stored absent + incoming absent → reuse', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection(META_BASE));
    const res = await inject();
    expect(res.body).toContain('event: done');
    expect(mockReuse).toHaveBeenCalledWith(OWN_URL);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('stored selection + identical incoming selection → reuse (order-insensitive)', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection({ ...META_BASE, uiControls: SELECTION }));
    // Same content, shuffled arrays — normalization must make these equal.
    const shuffled = { ...SELECTION, show: [...SELECTION.show].reverse(), hide: [...SELECTION.hide].reverse() };
    const res = await inject(JSON.stringify(shuffled));
    expect(res.body).toContain('event: done');
    expect(mockReuse).toHaveBeenCalledWith(OWN_URL);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('stored selection + DIFFERENT incoming selection → regenerate', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection({ ...META_BASE, uiControls: SELECTION }));
    const different = { ...SELECTION, show: ['#b'], hide: ['#a'] };
    const res = await inject(JSON.stringify(different));
    expect(res.body).toContain('event: done');
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockReuse).not.toHaveBeenCalled();
  });

  it('same picks with drifted controls metadata → reuse (labels/kinds/order are scan metadata)', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection({ ...META_BASE, uiControls: SELECTION }));
    const drifted = {
      controls: [{ selector: '#a', kind: 'other', label: 'Relabeled by a rescan' }],
      show: SELECTION.show, hide: SELECTION.hide,
    };
    const res = await inject(JSON.stringify(drifted));
    expect(res.body).toContain('event: done');
    expect(mockReuse).toHaveBeenCalledWith(OWN_URL);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('stored absent + incoming selection (ADDED) → regenerate', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection(META_BASE));
    const res = await inject(JSON.stringify(SELECTION));
    expect(res.body).toContain('event: done');
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockReuse).not.toHaveBeenCalled();
  });

  it('stored selection + incoming absent (REMOVED) → regenerate', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection({ ...META_BASE, uiControls: SELECTION }));
    const res = await inject();
    expect(res.body).toContain('event: done');
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockReuse).not.toHaveBeenCalled();
  });

  it('prompt/url/runtime-params guards still apply on top of selection equality', async () => {
    // Same selection but a URL scoped to ANOTHER section — must regenerate.
    mockSections.findFirst.mockResolvedValue({
      ...makeSection({ ...META_BASE, uiControls: SELECTION }),
      simulation_url: OWN_URL.replace(`section=${SECTION_ID}`, 'section=other-sec'),
    });
    const res = await inject(JSON.stringify(SELECTION));
    expect(res.body).toContain('event: done');
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });
});

// ── (c) persistence + generation plumbing ─────────────────────────────────────

describe('regeneration persistence', () => {
  it('writes planVersion 7 and the NORMALIZED selection to sim_meta, and passes it to the service', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection(META_BASE));
    const unsorted = {
      controls: SELECTION.controls,
      show: ['#b', '#a'],   // deliberately unsorted
      hide: ['#z', '#c'],
    };
    const res = await app.inject({ method: 'GET', url: streamUrl(JSON.stringify(unsorted)) });
    expect(res.body).toContain('event: done');

    // Service received the normalized selection.
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const genOpts = mockGenerate.mock.calls[0][0];
    expect(genOpts.uiControls).toEqual({ controls: SELECTION.controls, show: ['#a', '#b'], hide: ['#c', '#z'] });

    // sim_meta persisted with planVersion '7' + normalized uiControls.
    const setArg = mockUpdateSet.mock.calls[0][0] as { sim_meta: Record<string, unknown> };
    expect(setArg.sim_meta.planVersion).toBe('7');
    expect(setArg.sim_meta.uiControls).toEqual({ controls: SELECTION.controls, show: ['#a', '#b'], hide: ['#c', '#z'] });
  });

  it('writes planVersion 7 with uiControls omitted when no selection was sent', async () => {
    // Force regeneration despite no selection: stored prompt differs.
    mockSections.findFirst.mockResolvedValue(makeSection({ ...META_BASE, prompt: 'older prompt' }));
    const res = await app.inject({ method: 'GET', url: streamUrl() });
    expect(res.body).toContain('event: done');
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const setArg = mockUpdateSet.mock.calls[0][0] as { sim_meta: Record<string, unknown> };
    expect(setArg.sim_meta.planVersion).toBe('7');
    expect(setArg.sim_meta.uiControls).toBeUndefined();
  });
});

// ── (d) JSON POST sibling route — same ui_controls contract ───────────────────

describe('POST /generate-sim-script — ui_controls parity with the SSE route', () => {
  const POST_URL = `/api/v1/projects/${PROJECT_ID}/sections/${SECTION_ID}/generate-sim-script`;
  const postBody = (uiControls?: unknown) => ({
    prompt: PROMPT, simple_ui: false, auto_script: true,
    ...(uiControls !== undefined ? { ui_controls: uiControls } : {}),
  });
  const post = (uiControls?: unknown) =>
    app.inject({ method: 'POST', url: POST_URL, payload: postBody(uiControls) });

  it('rejects an invalid ui_controls shape with 400', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection(META_BASE));
    for (const bad of [42, 'str', { controls: 'x', show: [], hide: [] }, { show: [], hide: [] }]) {
      const res = await post(bad);
      expect(res.statusCode).toBe(400);
    }
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockReuse).not.toHaveBeenCalled();
  });

  it('rejects selectors containing forbidden characters with 400', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection(META_BASE));
    const res = await post({ controls: [], show: [], hide: ['body{display:none}'] });
    expect(res.statusCode).toBe(400);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('stored selection + identical incoming selection → reuse (order-insensitive)', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection({ ...META_BASE, uiControls: SELECTION }));
    const shuffled = { ...SELECTION, show: [...SELECTION.show].reverse(), hide: [...SELECTION.hide].reverse() };
    const res = await post(shuffled);
    expect(res.statusCode).toBe(200);
    expect(mockReuse).toHaveBeenCalledWith(OWN_URL);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('stored selection + incoming absent (REMOVED) → regenerate, sim_meta.uiControls dropped', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection({ ...META_BASE, uiControls: SELECTION }));
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockReuse).not.toHaveBeenCalled();
    const setArg = mockUpdateSet.mock.calls[0][0] as { sim_meta: Record<string, unknown> };
    expect(setArg.sim_meta.uiControls).toBeUndefined();
  });

  it('stored absent + incoming selection (ADDED) → regenerate; NORMALIZED selection reaches service and sim_meta', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection(META_BASE));
    const unsorted = { controls: SELECTION.controls, show: ['#b', '#a'], hide: ['#z', '#c'] };
    const res = await post(unsorted);
    expect(res.statusCode).toBe(200);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const genOpts = mockGenerate.mock.calls[0][0];
    expect(genOpts.uiControls).toEqual({ controls: SELECTION.controls, show: ['#a', '#b'], hide: ['#c', '#z'] });
    const setArg = mockUpdateSet.mock.calls[0][0] as { sim_meta: Record<string, unknown> };
    expect(setArg.sim_meta.planVersion).toBe('7');
    expect(setArg.sim_meta.uiControls).toEqual({ controls: SELECTION.controls, show: ['#a', '#b'], hide: ['#c', '#z'] });
  });

  it('stored selection + DIFFERENT incoming selection → regenerate', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection({ ...META_BASE, uiControls: SELECTION }));
    const res = await post({ ...SELECTION, show: ['#b'], hide: ['#a'] });
    expect(res.statusCode).toBe(200);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockReuse).not.toHaveBeenCalled();
  });

  it('same picks with drifted controls metadata → STILL reuse (show/hide-only equality)', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection({ ...META_BASE, uiControls: SELECTION }));
    const drifted = {
      controls: [{ selector: '#a', kind: 'other', label: 'Relabeled by a rescan' }],
      show: SELECTION.show, hide: SELECTION.hide,
    };
    const res = await post(drifted);
    expect(res.statusCode).toBe(200);
    expect(mockReuse).toHaveBeenCalledWith(OWN_URL);
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});

// ── (e) No-prompt mechanical Minimal-UI path — zero LLM ───────────────────────

describe('generate without a prompt → mechanical minimize-UI (no LLM)', () => {
  const POST_URL = `/api/v1/projects/${PROJECT_ID}/sections/${SECTION_ID}/generate-sim-script`;

  it('empty prompt + a selection ⇒ applyMinimalUiOnly, NOT the LLM; updates only the UI selection', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection(META_BASE));
    const res = await app.inject({
      method: 'POST', url: POST_URL,
      payload: { prompt: '', simple_ui: true, auto_script: true, ui_controls: SELECTION },
    });
    expect(res.statusCode).toBe(200);
    expect(mockMechanical).toHaveBeenCalledTimes(1);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockReuse).not.toHaveBeenCalled();
    const setArg = mockUpdateSet.mock.calls[0][0] as { sim_meta: Record<string, unknown>; sim_prompt?: unknown };
    // Provenance PRESERVED (the bridge body is unchanged) — the section stays LLM-authored,
    // keeps its built prompt, and sim_prompt is not touched; only the selection changed.
    expect(setArg.sim_meta.generatedBy).toBe('llm');
    expect(setArg.sim_meta.prompt).toBe(PROMPT);
    expect(setArg.sim_meta.planVersion).toBe('7');
    expect(setArg.sim_meta.uiControls).toEqual(SELECTION);
    expect('sim_prompt' in setArg).toBe(false);   // authoring prompt preserved (not nulled)
  });

  it('a FRESH section (no prior bridge) minimized with no prompt is labeled generatedBy:mechanical', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection(null));
    const res = await app.inject({
      method: 'POST', url: POST_URL,
      payload: { prompt: '', simple_ui: true, auto_script: true, ui_controls: SELECTION },
    });
    expect(res.statusCode).toBe(200);
    expect(mockMechanical).toHaveBeenCalledTimes(1);
    const setArg = mockUpdateSet.mock.calls[0][0] as { sim_meta: Record<string, unknown> };
    expect(setArg.sim_meta.generatedBy).toBe('mechanical');
    expect(setArg.sim_meta.uiControls).toEqual(SELECTION);
  });

  it('a "hide ALL" (None) selection with no prompt is valid and runs mechanically', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection(META_BASE));
    const hideAll = { controls: SELECTION.controls, show: [], hide: ['#a', '#b'] };
    const res = await app.inject({
      method: 'POST', url: POST_URL,
      payload: { prompt: '', simple_ui: true, auto_script: true, ui_controls: hideAll },
    });
    expect(res.statusCode).toBe(200);
    expect(mockMechanical).toHaveBeenCalledTimes(1);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('empty prompt AND no selection ⇒ 400 (nothing to do)', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection(META_BASE));
    const res = await app.inject({
      method: 'POST', url: POST_URL,
      payload: { prompt: '', simple_ui: false, auto_script: true },
    });
    expect(res.statusCode).toBe(400);
    expect(mockMechanical).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});

// ── (f) POST stream route — body-carried selection, no URL-size cap ────────────

describe('POST /generate-sim-script/stream — SSE over a JSON body (no ui_controls cap)', () => {
  const STREAM_URL = `/api/v1/projects/${PROJECT_ID}/sections/${SECTION_ID}/generate-sim-script/stream`;

  it('accepts a ui_controls body far larger than the old 8192-char URL cap and streams done', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection(META_BASE));
    // ~100 controls with long structural selectors — would blow the legacy URL cap.
    const controls = Array.from({ length: 100 }, (_, i) => ({
      selector: `#controls > div:nth-of-type(${i}) > section > label:nth-of-type(2) > input#field_${i}`,
      kind: 'toggle' as const, label: `Control number ${i} with a fairly long human label`,
    }));
    const big = { controls, show: [controls[0].selector], hide: controls.slice(1).map(c => c.selector) };
    expect(JSON.stringify(big).length).toBeGreaterThan(8192);

    const res = await app.inject({
      method: 'POST', url: STREAM_URL,
      payload: { prompt: PROMPT, simple_ui: true, auto_script: true, ui_controls: big },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: done');
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('a bad body is a clean 400 BEFORE the stream opens', async () => {
    mockSections.findFirst.mockResolvedValue(makeSection(META_BASE));
    const res = await app.inject({
      method: 'POST', url: STREAM_URL,
      payload: { prompt: PROMPT, simple_ui: 'yes', auto_script: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type'] ?? '').not.toContain('event-stream');
  });
});
