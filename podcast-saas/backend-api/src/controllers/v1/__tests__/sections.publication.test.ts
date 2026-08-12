/**
 * The sections controller's half of the staged-publication contract (audit P0.4).
 *
 * TWO THINGS MOVED, AND BOTH ARE CONTRACTS SOMETHING ELSE READS.
 *
 * (a) `classifySimulationError` and `ERROR_MESSAGES` moved to MODULE SCOPE and gained a `conflict`
 *     case. A lost activation compare-and-set means a concurrent publication for the same
 *     simulation won and NOTHING was overwritten — the loser's bytes sit in an inactive revision
 *     prefix. The correct client response is a retry, so it must not arrive as a generic failure,
 *     and it must not arrive as a 404 either: `RevisionConflict('createDraft', 'simulation not
 *     found')` renders a message containing "not found", and the pre-existing `not_found` arm would
 *     happily claim it. Ordering inside the classifier is therefore load-bearing.
 *
 * (b) The section row is no longer written by the controller after the service resolves. The
 *     controller hands the service a `persistSection` hook and the service runs it INSIDE the
 *     revision-activation transaction — except on the reuse path, which publishes nothing and so
 *     has no transaction to join. That path is the one remaining bare row write, and this file
 *     pins that it stayed bare and kept its own guards.
 *
 * The service is mocked here on purpose: `bridgePublication.test.ts` drives the real publication
 * against a real Postgres. What is under test in this file is the CONTROLLER's contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import {
  registerSectionsRoutes, classifySimulationError, ERROR_MESSAGES,
} from '../sections.controller.js';

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
    mockGenerate:   vi.fn(),
    mockReuse:      vi.fn(),
    mockMechanical: vi.fn(),
  };
});

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      projects:          mocks.mockProjects,
      timeline_sections: mocks.mockSections,
      simulations:       mocks.mockSimulations,
      video_files:       mocks.mockVideoFiles,
    },
    update: mocks.mockUpdate,
  },
}));

vi.mock('../../../db/schema.js', () => ({
  projects:          Symbol('projects'),
  timeline_sections: Symbol('timeline_sections'),
  simulations:       Symbol('simulations'),
  video_files:       Symbol('video_files'),
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
  mockProjects, mockSections, mockSimulations, mockUpdate,
  mockUpdateSet, mockUpdateReturning, mockGenerate, mockReuse, mockMechanical,
} = mocks;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-1';
const SECTION_ID = 'sec-1';
const SIM_ID     = 'sim-1';
const PROMPT     = 'the prompt';
const OWN_URL    = `https://cdn.example.com/sim-public/simulations/${PROJECT_ID}/${SIM_ID}/index.html?section=${SECTION_ID}&v=abc123`;

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

/**
 * A publishing service double — the same shape `sections.uiControls.test.ts` uses.
 *
 * The real service runs `persistSection` inside the activation transaction, so a double that
 * merely resolves models a service that published without persisting the section, which the
 * controller now (correctly, loudly) rejects. This one calls the hook exactly as the service does.
 */
const publishing =
  <T extends object>(result: T) =>
  async (opts: { persistSection?: (tx: unknown, pub: T) => Promise<void> }): Promise<T> => {
    await opts.persistSection?.({ update: mocks.mockUpdate }, result);
    return result;
  };

/**
 * A lost compare-and-set, as the real one arrives.
 *
 * Deliberately a SECOND COPY of the class rather than an import of `RevisionService`'s: production
 * matches on `err.name`, not `instanceof`, precisely so a duplicated class (two bundles, a re-export,
 * a test double) still classifies. Constructing it this way is what tests that decision.
 */
class RevisionConflict extends Error {
  constructor(stage: string, detail: string) {
    super(`revision ${stage}: ${detail}`);
    this.name = 'RevisionConflict';
  }
}

const STREAM_URL = `/api/v1/projects/${PROJECT_ID}/sections/${SECTION_ID}/generate-sim-script/stream`;
const POST_URL   = `/api/v1/projects/${PROJECT_ID}/sections/${SECTION_ID}/generate-sim-script`;
const getStreamUrl = `${STREAM_URL}?${new URLSearchParams({ prompt: PROMPT }).toString()}`;

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

  mockProjects.findFirst.mockResolvedValue({ id: PROJECT_ID, created_by: 'user-1' });
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

// ── (8a) classifySimulationError — the new case and every pre-existing one ────

describe('classifySimulationError', () => {
  it('maps a lost activation compare-and-set to `conflict`', () => {
    expect(classifySimulationError(new RevisionConflict('demote', 'incumbent is no longer active')))
      .toBe('conflict');
    expect(classifySimulationError(new RevisionConflict('promote', 'another revision is already active')))
      .toBe('conflict');
    expect(classifySimulationError(new RevisionConflict('pointer', 'active_revision_id moved under us')))
      .toBe('conflict');
  });

  it('matches on the NAME, so a foreign copy of the class still classifies', () => {
    // The production comment says the check is name-based so it cannot be defeated by a second copy
    // of the class. A bare Error carrying the name is the minimal form of that.
    const bare = Object.assign(new Error('anything at all'), { name: 'RevisionConflict' });
    expect(classifySimulationError(bare)).toBe('conflict');
  });

  it('classifies a conflict as a conflict even when its detail reads like another case', () => {
    // `RevisionConflict('createDraft', 'simulation not found')` is a real message this service
    // produces, and `not_found` maps to HTTP 404 — "re-upload the simulation" for what is actually
    // "retry, someone else went first". The conflict arm running FIRST is what prevents that.
    expect(classifySimulationError(new RevisionConflict('createDraft', 'simulation not found')))
      .toBe('conflict');
    // Same trap in the other direction: a genuine not-found is still a not-found.
    expect(classifySimulationError(new Error('Simulation not found'))).toBe('not_found');
  });

  it('still classifies every pre-existing case (it moved to module scope in this change)', () => {
    const abort = new Error('anything'); abort.name = 'AbortError';
    expect(classifySimulationError(abort)).toBe('aborted');
    expect(classifySimulationError(new Error('generation cancelled'))).toBe('aborted');
    expect(classifySimulationError(new Error('Provider overloaded'))).toBe('ai_overloaded');
    expect(classifySimulationError(new Error('status 529 from upstream'))).toBe('ai_overloaded');
    expect(classifySimulationError(new Error('rate_limit_error'))).toBe('limit_exceeded');
    expect(classifySimulationError(new Error('HTTP 429'))).toBe('limit_exceeded');
    expect(classifySimulationError(new Error('No HTML entry file found in simulation'))).toBe('not_found');
    expect(classifySimulationError(new Error('LLM returned a non-JSON plan'))).toBe('validation_error');
    expect(classifySimulationError(new Error('something else went wrong'))).toBe('generation_error');
    // A non-Error rejection must not crash the classifier on the way to the error frame.
    expect(classifySimulationError('a string')).toBe('generation_error');
    expect(classifySimulationError(undefined)).toBe('generation_error');
  });

  it('every classification it can return has a message', () => {
    // An unmapped key falls through to the generic text, which would silently turn a specific
    // failure into "Generation failed. Please try again." — checked structurally rather than hoped.
    const produced = [
      classifySimulationError(new RevisionConflict('demote', 'x')),
      classifySimulationError(Object.assign(new Error('x'), { name: 'AbortError' })),
      classifySimulationError(new Error('overloaded')),
      classifySimulationError(new Error('rate_limit')),
      classifySimulationError(new Error('not found')),
      classifySimulationError(new Error('non-json plan')),
      classifySimulationError(new Error('?')),
    ];
    for (const key of produced) expect(ERROR_MESSAGES[key], `no ERROR_MESSAGES.${key}`).toBeTruthy();
  });
});

describe('ERROR_MESSAGES.conflict', () => {
  it('tells the user to retry and that nothing was lost', () => {
    // A conflict is not a fault: the loser's bytes went into an inactive revision prefix and the
    // winner's package is intact. Wording that alarms, or that omits the retry, sends the user to
    // support for a condition they can resolve by pressing the button again.
    expect(ERROR_MESSAGES.conflict).toMatch(/retry/i);
    expect(ERROR_MESSAGES.conflict).toMatch(/nothing was overwritten/i);
    expect(ERROR_MESSAGES.conflict).not.toMatch(/failed|error|corrupt/i);
  });
});

// ── (8b) the conflict reaches the client ──────────────────────────────────────

describe('a conflict surfaced by the generation routes', () => {
  beforeEach(() => {
    mockSections.findFirst.mockResolvedValue(makeSection({ ...META_BASE, prompt: 'older prompt' }));
    mockGenerate.mockRejectedValue(new RevisionConflict('demote', 'incumbent is no longer active'));
  });

  it('the SSE error frame carries errorType `conflict` and the retryable message', async () => {
    const res = await app.inject({ method: 'GET', url: getStreamUrl });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: error');
    const frame = res.body.split('event: error\n')[1]!.split('\n\n')[0]!.replace(/^data: /, '');
    expect(JSON.parse(frame)).toEqual({ error: ERROR_MESSAGES.conflict, errorType: 'conflict' });
    expect(res.body).not.toContain('event: done');
  });

  it('does not report the conflict as a 404 on the JSON route', async () => {
    // The failure this guards: a `RevisionConflict` whose detail contains "not found" classified as
    // `not_found`, which is the one errorType mapped to HTTP 404 — telling the user to re-upload a
    // simulation that is perfectly fine.
    mockGenerate.mockRejectedValue(new RevisionConflict('createDraft', 'simulation not found'));
    const res = await app.inject({
      method: 'POST', url: POST_URL,
      payload: { prompt: PROMPT, simple_ui: false, auto_script: true },
    });
    expect(res.json().errorType).toBe('conflict');
    expect(res.json().message).toBe(ERROR_MESSAGES.conflict);
    expect(res.statusCode).not.toBe(404);
    // 409, not the generic 500 this used to return. A lost CAS is not a fault: the loser
    // overwrote nothing and the remedy is to retry. Reporting it as 5xx also meant an expected,
    // self-resolving condition raised the error rate alerting watches.
    expect(res.statusCode).toBe(409);
  });

  it('a conflict never leaves a section row written', async () => {
    // The hook runs inside the activation transaction, so a lost CAS means it was never called —
    // there is no path by which the controller writes the row for a publication that did not land.
    await app.inject({ method: 'GET', url: getStreamUrl });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('the mechanical (zero-LLM) path reports a conflict the same way', async () => {
    // Both publishing entry points go through the same activation, so both can lose the same CAS.
    mockSections.findFirst.mockResolvedValue(makeSection(META_BASE));
    mockMechanical.mockRejectedValue(new RevisionConflict('pointer', 'active_revision_id moved under us'));
    const res = await app.inject({
      method: 'POST', url: POST_URL,
      payload: { prompt: '', simple_ui: true, auto_script: true, ui_controls: { controls: [], show: [], hide: ['#a'] } },
    });
    expect(res.json().errorType).toBe('conflict');
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ── (8c) the loud guard behind the hook ───────────────────────────────────────

describe('the section update is only ever the service’s in-transaction hook', () => {
  it('a service that resolves WITHOUT running the hook is rejected, not silently accepted', async () => {
    // Before P0.4 the controller wrote the row itself after the service resolved. Now the service
    // owns that write, so a service change that stops invoking the hook would return the stale
    // pre-generation row while the pointer had moved. It must be loud instead.
    mockSections.findFirst.mockResolvedValue(makeSection({ ...META_BASE, prompt: 'older prompt' }));
    mockGenerate.mockResolvedValue(GEN_RESULT);   // resolves, never calls persistSection

    const res = await app.inject({
      method: 'POST', url: POST_URL,
      payload: { prompt: PROMPT, simple_ui: false, auto_script: true },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().errorType).toBe('generation_error');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('a hook whose row has vanished aborts the publication with a plain-language reason', async () => {
    // The hook throws inside the activation transaction, which rolls the whole activation back —
    // the message is what the user sees for a section deleted mid-generation.
    mockSections.findFirst.mockResolvedValue(makeSection({ ...META_BASE, prompt: 'older prompt' }));
    mockUpdateReturning.mockResolvedValue([]);    // the UPDATE matched nothing

    const res = await app.inject({
      method: 'POST', url: POST_URL,
      payload: { prompt: PROMPT, simple_ui: false, auto_script: true },
    });
    expect(res.statusCode).toBe(500);
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);   // it tried, inside the transaction
  });

  it('the whole patch — not just simulation_url/sim_meta — is written inside the hook', async () => {
    // Splitting the write would put half the section's state outside the activation transaction,
    // which is the precise thing this finding closed.
    mockSections.findFirst.mockResolvedValue(makeSection({ ...META_BASE, prompt: 'older prompt' }));
    const res = await app.inject({
      method: 'POST', url: POST_URL,
      payload: { prompt: PROMPT, simple_ui: true, auto_script: false },
    });
    expect(res.statusCode).toBe(200);
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet.mock.calls[0][0]).toMatchObject({
      simple_ui: true, auto_script: false, sim_script: 'main',
      sim_prompt: PROMPT, simulation_url: GEN_RESULT.sectionUrl,
    });
  });
});

// ── (9) the reuse path: the one flow with no activation to join ───────────────

describe('the reuse path publishes nothing', () => {
  beforeEach(() => {
    // canReuse: same prompt, own URL, runtime-param bridge, unchanged selection.
    mockSections.findFirst.mockResolvedValue(makeSection(META_BASE));
  });

  it('regenerates nothing: no publication, no revision, no activation transaction', async () => {
    const res = await app.inject({
      method: 'POST', url: POST_URL,
      payload: { prompt: PROMPT, simple_ui: false, auto_script: true },
    });
    expect(res.statusCode).toBe(200);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockMechanical).not.toHaveBeenCalled();
    expect(mockReuse).toHaveBeenCalledWith(OWN_URL);
    // The signature is the contract: `reuseBridgeScript(url)` takes NO persistSection, because
    // there is no activation transaction for a section write to join.
    expect(mockReuse.mock.calls[0]).toHaveLength(1);
  });

  it('keeps its own BARE row write, and that write does not touch sim_meta', async () => {
    const res = await app.inject({
      method: 'POST', url: POST_URL,
      payload: { prompt: PROMPT, simple_ui: true, auto_script: false },
    });
    expect(res.statusCode).toBe(200);
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    const patch = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    // Only the toggles + the (unchanged) URL. A reuse produced no new bytes, so re-stamping
    // sim_meta would advertise a fresh generation that never happened.
    expect(patch).toEqual({
      simple_ui: true, auto_script: false, sim_script: 'main', simulation_url: OWN_URL,
    });
    expect('sim_meta' in patch).toBe(false);
    expect('sim_prompt' in patch).toBe(false);
  });

  it('still refuses to report success when the row vanished under it', async () => {
    // The bare write keeps the same guard the in-transaction hook has; without a transaction it is
    // the ONLY thing standing between a deleted section and a 200.
    mockUpdateReturning.mockResolvedValue([]);
    const res = await app.inject({
      method: 'POST', url: POST_URL,
      payload: { prompt: PROMPT, simple_ui: false, auto_script: true },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().errorType).toBe('generation_error');
  });

  it('returns the row the bare write produced, not the pre-generation row', async () => {
    const fresh = { ...makeSection(META_BASE), simple_ui: true };
    mockUpdateReturning.mockResolvedValue([fresh]);
    const res = await app.inject({
      method: 'POST', url: POST_URL,
      payload: { prompt: PROMPT, simple_ui: true, auto_script: true },
    });
    expect(res.json()).toMatchObject({ id: SECTION_ID, simple_ui: true });
  });

  /**
   * THE ABORT CHECK ON THIS PATH IS PINNED FROM SOURCE, AND HERE IS WHY.
   *
   * `if (signal.aborted) throw` sits between `reuseBridgeScript` and the bare UPDATE. Both routes
   * construct their `AbortController` and then call `generateOrReuseSection` with NO await in
   * between — the reuse branch runs to that check in the same synchronous turn — so through the
   * HTTP transport the signal cannot yet be aborted, and `app.inject` has no way to disconnect a
   * client mid-turn. Driving it would mean asserting against a control flow this code does not
   * have. So the guard is pinned structurally instead, with comments stripped so prose cannot
   * satisfy the assertion (the technique `bridgeVerdictClear.test.ts` uses).
   *
   * It is not decoration: the moment anything awaits before it — an async reuse, a lookup, a
   * pre-write hook — the branch becomes live, and this is what stops it being deleted first.
   */
  it('keeps an abort check of its own before the bare write', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'sections.controller.ts'), 'utf-8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const from = src.indexOf('if (canReuse) {');
    const reuseBranch = src.slice(from, src.indexOf('const simRow = await db.query.simulations.findFirst', from));
    // Prove the slice is the branch before asserting about its contents — an indexOf that missed
    // would hand back an empty string, and `not.toMatch` would then pass for the wrong reason.
    expect(from).toBeGreaterThan(0);
    expect(reuseBranch).toMatch(/svc\.reuseBridgeScript\(/);
    expect(reuseBranch, 'the reuse branch no longer checks the abort signal').toMatch(/signal\.aborted/);
    expect(reuseBranch, 'the reuse branch no longer guards against a deleted section')
      .toMatch(/This section was removed during generation/);
    // …and it must remain OUTSIDE the activation contract: no hook is threaded through it.
    expect(reuseBranch).not.toMatch(/persistSection/);
  });
});
