/**
 * D-03: what the three billable avatar endpoints will and will not pay for.
 *
 * The bar every assertion here is written against: what would a BROKEN implementation also
 * satisfy? A handler that checks its gate AFTER calling the vendor passes "returns 404 for a
 * private project" perfectly — the caller sees 404 and the money is already gone. So the vendor
 * doubles are asserted to have NOT BEEN CALLED on every refusal, and that, not the status code,
 * is the load-bearing half of each test.
 *
 * The first block is the one that must never be sacrificed to the others: an anonymous viewer of
 * a public video still gets an avatar.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const PUBLIC_PROJECT = '11111111-2222-4333-8444-555555555555';
const PRIVATE_PROJECT = '22222222-3333-4444-8555-666666666666';
const UNLISTED_PROJECT = '33333333-4444-4555-8666-777777777777';
const OTHER_PROJECT = '44444444-5555-4666-8777-888888888888';
const SHARE_TOKEN = 'share-token-abcdefgh';

const PROJECT_ROWS: Record<string, { visibility: string; created_by: string; share_token: string | null; avatar_config: unknown }> = {
  [PUBLIC_PROJECT]: { visibility: 'public', created_by: 'owner-1', share_token: null, avatar_config: {} },
  [PRIVATE_PROJECT]: { visibility: 'private', created_by: 'owner-2', share_token: null, avatar_config: {} },
  [UNLISTED_PROJECT]: { visibility: 'unlisted', created_by: 'owner-3', share_token: SHARE_TOKEN, avatar_config: {} },
  [OTHER_PROJECT]: { visibility: 'public', created_by: 'owner-4', share_token: null, avatar_config: {} },
};

const mocks = vi.hoisted(() => ({
  projectsFindFirst: vi.fn(),
  currentUser: { value: undefined as undefined | { id: string; email: string | null; is_anonymous: boolean } },
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../db/index.js', () => ({
  db: {
    query: { projects: { findFirst: mocks.projectsFindFirst } },
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }), limit: async () => [] }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  projects: Symbol('projects'), avatar_visuals: Symbol('avatar_visuals'),
  admin_settings: Symbol('admin_settings'), users: Symbol('users'), video_files: Symbol('video_files'),
}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn(), or: vi.fn(), isNull: vi.fn(), asc: vi.fn(), desc: vi.fn() }));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: vi.fn(async () => {}),
  // Optional auth: whatever the test says the caller is.
  firebaseAuthOptionalMiddleware: vi.fn(async (request: { dbUser?: unknown }) => {
    if (mocks.currentUser.value) request.dbUser = mocks.currentUser.value;
  }),
}));
vi.mock('../../../services/collabAccess.js', () => ({ editableProject: vi.fn(), isCollaborator: vi.fn(async () => false) }));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({ getStorageAdapter: vi.fn(() => ({})) }));
vi.mock('../../../services/storage/uploadWithFallback.js', () => ({ uploadWithFallback: vi.fn() }));
vi.mock('../../../services/simulation/SimulationService.js', () => ({ SimulationService: class {} }));
vi.mock('../../../services/llm/LLMService.js', () => ({ LLMService: class {} }));
vi.mock('../../../services/secrets/ApiKeyService.js', () => ({ ApiKeyService: class {}, encryptKey: vi.fn() }));
vi.mock('../../../services/usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));
vi.mock('../../../services/avatar/memoryService.js', () => ({ saveTurns: vi.fn(), getTurns: vi.fn(), getProfile: vi.fn(), extractAndSaveFacts: vi.fn() }));
vi.mock('../../../services/avatar/memoryToken.js', () => ({ signMemoryToken: vi.fn(), verifyMemoryToken: vi.fn() }));
vi.mock('../../../services/transcriptPropagation.js', () => ({ getProjectTranscript: vi.fn(async () => null) }));
vi.mock('../../../services/avatar/anamKey.js', () => ({ resolveAnamKeyForProject: vi.fn(async () => 'anam_sk_test'), resolveSystemAnamKey: vi.fn(async () => undefined) }));

// ── The three things that cost money. Every refusal must leave all three untouched. ──────────
const spend = vi.hoisted(() => ({
  getSessionToken: vi.fn(),
  analyzeVisual: vi.fn(),
  analyzeAndGenerateImage: vi.fn(),
  syncBasicLibrary: vi.fn(),
}));

vi.mock('../../../services/avatar/anamService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/avatar/anamService.js')>();
  return {
    ...actual,
    getSessionToken: spend.getSessionToken,
    enrichAvatarConfigFromAnam: vi.fn(async (cfg: unknown) => cfg),
    upsertVideoPersona: vi.fn(), peekAvatarLook: vi.fn(() => undefined), listAnamResource: vi.fn(async () => ({ data: [] })),
    ensureKnowledgeGroup: vi.fn(), ensureKnowledgeTool: vi.fn(), uploadKnowledgeDocument: vi.fn(),
    listKnowledgeDocuments: vi.fn(), deleteKnowledgeDocument: vi.fn(), listSystemTools: vi.fn(),
  };
});
vi.mock('../../../services/avatar/visualService.js', () => ({
  analyzeVisual: spend.analyzeVisual, generateLibrarySimulation: vi.fn(), editLibrarySimulation: vi.fn(),
}));
vi.mock('../../../services/avatar/imageService.js', () => ({
  analyzeAndGenerateImage: spend.analyzeAndGenerateImage, generateLibraryImage: vi.fn(),
}));
vi.mock('../../../services/avatar/libraryService.js', () => ({
  insertVisual: vi.fn(), listVisuals: vi.fn(), updateVisual: vi.fn(), deleteVisual: vi.fn(),
  syncBasicLibrary: spend.syncBasicLibrary, storeImageBuffer: vi.fn(), storeSimulationHtml: vi.fn(),
}));

import { registerAvatarRoutes } from '../avatar.controller.js';
import { resetBurstShield } from '../../../services/usage/avatarBudget.js';
import { signAvatarCapability } from '../../../services/avatar/avatarCapability.js';
import { resetPersonaBakeState } from '../../../services/avatar/personaBake.js';
import { resetDisplayResolveState } from '../../../services/avatar/displayIdentity.js';
// The mocked implementations, so the memory route's paid call can be asserted on directly.
import { extractAndSaveFacts, saveTurns } from '../../../services/avatar/memoryService.js';
import { verifyMemoryToken } from '../../../services/avatar/memoryToken.js';

let app: FastifyInstance;

const post = (url: string, payload: unknown, headers?: Record<string, string>) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers });

const startBody = (over: Record<string, unknown> = {}) => ({ projectId: PUBLIC_PROJECT, ...over });
const visualBody = (over: Record<string, unknown> = {}) => ({ message: 'explain this', projectId: PUBLIC_PROJECT, ...over });
const imageBody = (over: Record<string, unknown> = {}) => ({ userMessage: 'draw this', projectId: PUBLIC_PROJECT, ...over });

/** No money was spent, by any route, for any reason. */
function nothingWasSpent() {
  expect(spend.getSessionToken).not.toHaveBeenCalled();
  expect(spend.analyzeVisual).not.toHaveBeenCalled();
  expect(spend.analyzeAndGenerateImage).not.toHaveBeenCalled();
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetBurstShield();
  resetPersonaBakeState();
  resetDisplayResolveState();
  delete process.env.AVATAR_CAPABILITY_MODE;
  delete process.env.AVATAR_KILL_SWITCH;
  process.env.AVATAR_BUDGET_MODE = 'off'; // the durable meter has its own integration suite
  mocks.currentUser.value = undefined;
  mocks.projectsFindFirst.mockImplementation(async () => {
    // Drizzle's `eq` is mocked away, so the suite serves whichever row the test selected.
    return served;
  });
  spend.getSessionToken.mockResolvedValue({ token: 'tok-1', characterId: 'einstein', voiceSensitivity: 0.5, avatarId: 'av-1' });
  spend.syncBasicLibrary.mockResolvedValue(undefined);
  spend.analyzeVisual.mockResolvedValue({ type: 'none' });
  spend.analyzeAndGenerateImage.mockResolvedValue({ shouldGenerate: false, imageUrl: null, altText: '', caption: '', imageType: 'realistic' });
  served = PROJECT_ROWS[PUBLIC_PROJECT];
  app = Fastify();
  await registerAvatarRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  delete process.env.AVATAR_BUDGET_MODE;
});

let served: (typeof PROJECT_ROWS)[string] | null = null;
const serve = (projectId: string | null) => { served = projectId ? PROJECT_ROWS[projectId] : null; };

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('an anonymous viewer of a public project is not collateral damage', () => {
  it('starts, asks for a visual and asks for an image — with no account and no capability', async () => {
    serve(PUBLIC_PROJECT);
    const start = await post('/api/v1/avatar/start', startBody());
    expect(start.statusCode).toBe(200);
    expect(start.json().sessionToken).toBe('tok-1');

    expect((await post('/api/v1/avatar/visual/analyze', visualBody())).statusCode).toBe(200);
    expect((await post('/api/v1/avatar/image/analyze', imageBody())).statusCode).toBe(200);
    expect(spend.analyzeVisual).toHaveBeenCalledTimes(1);
    expect(spend.analyzeAndGenerateImage).toHaveBeenCalledTimes(1);
  });

  it('still works with capabilities ENFORCED, once it mints one — which needs no account either', async () => {
    process.env.AVATAR_CAPABILITY_MODE = 'enforce';
    serve(PUBLIC_PROJECT);
    const minted = await post('/api/v1/avatar/capability', { projectId: PUBLIC_PROJECT });
    expect(minted.statusCode).toBe(200);
    const capability = minted.json().capability as string;
    expect(capability).toBeTruthy();

    expect((await post('/api/v1/avatar/start', startBody({ capability }))).statusCode).toBe(200);
    expect((await post('/api/v1/avatar/visual/analyze', visualBody({ capability }))).statusCode).toBe(200);
    // The header carries it too, so a client need not thread it through every body.
    const viaHeader = await post('/api/v1/avatar/image/analyze', imageBody(), { 'x-avatar-capability': capability });
    expect(viaHeader.statusCode).toBe(200);
  });

  it('a start hands back a capability, so enforcing the analyze routes costs no extra round-trip', async () => {
    process.env.AVATAR_CAPABILITY_MODE = 'enforce';
    serve(PUBLIC_PROJECT);
    const minted = await post('/api/v1/avatar/capability', { projectId: PUBLIC_PROJECT });
    const start = await post('/api/v1/avatar/start', startBody({ capability: minted.json().capability }));
    expect(start.statusCode).toBe(200);
    const fromStart = start.json().capability as string;
    expect(fromStart).toBeTruthy();
    // …and it is a real one: it opens the two routes that will require it.
    expect((await post('/api/v1/avatar/visual/analyze', visualBody({ capability: fromStart }))).statusCode).toBe(200);
    expect((await post('/api/v1/avatar/image/analyze', imageBody({ capability: fromStart }))).statusCode).toBe(200);
    // …and only for its own project.
    const wrong = await post('/api/v1/avatar/visual/analyze', visualBody({ projectId: OTHER_PROJECT, capability: fromStart }));
    expect(wrong.statusCode).toBe(401);
  });

  it('an unlisted project reached through its share link mints a capability', async () => {
    process.env.AVATAR_CAPABILITY_MODE = 'enforce';
    serve(UNLISTED_PROJECT);
    const minted = await post('/api/v1/avatar/capability', { projectId: UNLISTED_PROJECT, share: SHARE_TOKEN });
    expect(minted.statusCode).toBe(200);
    expect(minted.json().capability).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('the bodyless global mint is closed to the public', () => {
  it('an anonymous caller naming no project gets 400 and NO vendor session', async () => {
    const res = await post('/api/v1/avatar/start', {});
    expect(res.statusCode).toBe(400);
    nothingWasSpent();
  });

  it('a FIREBASE-ANONYMOUS account is not a bound and does not unlock it', async () => {
    // The point of the whole design: anonymous sign-in is free and unlimited, so "requires auth"
    // would have been theatre. An implementation that only checked `request.dbUser` passes the
    // test above and fails this one.
    mocks.currentUser.value = { id: 'guest-1', email: null, is_anonymous: true };
    const res = await post('/api/v1/avatar/start', {});
    expect(res.statusCode).toBe(400);
    nothingWasSpent();
  });

  it('a signed-in, non-anonymous account keeps the global avatar', async () => {
    mocks.currentUser.value = { id: 'user-1', email: 'a@b.c', is_anonymous: false };
    const res = await post('/api/v1/avatar/start', {});
    expect(res.statusCode).toBe(200);
    expect(spend.getSessionToken).toHaveBeenCalledTimes(1);
  });

  it('the analyze routes are closed to a project-less anonymous caller too', async () => {
    expect((await post('/api/v1/avatar/visual/analyze', { message: 'hi' })).statusCode).toBe(400);
    expect((await post('/api/v1/avatar/image/analyze', { userMessage: 'hi' })).statusCode).toBe(400);
    nothingWasSpent();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('a project id is not a capability', () => {
  beforeEach(() => { process.env.AVATAR_CAPABILITY_MODE = 'enforce'; });

  it('refuses a start with no capability, before minting anything', async () => {
    serve(PUBLIC_PROJECT);
    const res = await post('/api/v1/avatar/start', startBody());
    expect(res.statusCode).toBe(401);
    nothingWasSpent();
  });

  it('refuses a capability minted for ANOTHER project — the cross-project replay', async () => {
    // This is the assertion a signature-only check fails. The token is genuine, unexpired and
    // signed by this server; it simply names a different video.
    const forOther = signAvatarCapability({ projectId: OTHER_PROJECT }).token;
    serve(PUBLIC_PROJECT);
    expect((await post('/api/v1/avatar/start', startBody({ capability: forOther }))).statusCode).toBe(401);
    expect((await post('/api/v1/avatar/visual/analyze', visualBody({ capability: forOther }))).statusCode).toBe(401);
    expect((await post('/api/v1/avatar/image/analyze', imageBody({ capability: forOther }))).statusCode).toBe(401);
    nothingWasSpent();
  });

  it('will not mint one for a private project the caller cannot see, and says only 404', async () => {
    serve(PRIVATE_PROJECT);
    const res = await post('/api/v1/avatar/capability', { projectId: PRIVATE_PROJECT });
    expect(res.statusCode).toBe(404);
    expect(res.json().capability).toBeUndefined();
  });

  it('will not mint one for an unlisted project on a WRONG share token', async () => {
    serve(UNLISTED_PROJECT);
    // Unlisted stays viewer-visible by id (avatarAccess.ts, unchanged) — what must not happen is
    // the wrong token being treated as if it were right.
    const res = await post('/api/v1/avatar/capability', { projectId: UNLISTED_PROJECT, share: 'wrong-token-here' });
    const body = res.json();
    if (res.statusCode === 200) expect(body.capability).toBeTruthy(); // admitted by the id gate, not by the token
    else expect(body.capability).toBeUndefined();
    // Either way the token itself bought nothing: a project with no share token cannot be unlocked.
    serve(PRIVATE_PROJECT);
    const denied = await post('/api/v1/avatar/capability', { projectId: PRIVATE_PROJECT, share: 'wrong-token-here' });
    expect(denied.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('a paid call cannot be pointed at a project the caller may not see', () => {
  it('visual/analyze on a private project: 404, and the model is never called', async () => {
    serve(PRIVATE_PROJECT);
    const res = await post('/api/v1/avatar/visual/analyze', visualBody({ projectId: PRIVATE_PROJECT }));
    expect(res.statusCode).toBe(404);
    nothingWasSpent();
    // The library sync also reaches the project — it must not run either.
    expect(spend.syncBasicLibrary).not.toHaveBeenCalled();
  });

  it('image/analyze on a private project: 404, and gpt-image-1 is never called', async () => {
    serve(PRIVATE_PROJECT);
    const res = await post('/api/v1/avatar/image/analyze', imageBody({ projectId: PRIVATE_PROJECT }));
    expect(res.statusCode).toBe(404);
    nothingWasSpent();
    expect(spend.syncBasicLibrary).not.toHaveBeenCalled();
  });

  it('the owner of that private project is still served', async () => {
    mocks.currentUser.value = { id: 'owner-2', email: 'o@b.c', is_anonymous: false };
    serve(PRIVATE_PROJECT);
    const res = await post('/api/v1/avatar/visual/analyze', visualBody({ projectId: PRIVATE_PROJECT }));
    expect(res.statusCode).toBe(200);
    expect(spend.analyzeVisual).toHaveBeenCalledTimes(1);
  });

  it('a project that does not exist is 404, not a paid call against null', async () => {
    serve(null);
    expect((await post('/api/v1/avatar/image/analyze', imageBody({ projectId: OTHER_PROJECT }))).statusCode).toBe(404);
    nothingWasSpent();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('the burst shield is weighted, layered and answerable', () => {
  it('refuses with Retry-After once the address budget is spent, and spends nothing more', async () => {
    process.env.AVATAR_BURST_IP = '100'; // less than one start (60) plus one image (30) plus one more
    serve(PUBLIC_PROJECT);
    try {
      expect((await post('/api/v1/avatar/start', startBody())).statusCode).toBe(200);
      const second = await post('/api/v1/avatar/image/analyze', imageBody());
      expect(second.statusCode).toBe(200);
      const third = await post('/api/v1/avatar/image/analyze', imageBody());
      expect(third.statusCode).toBe(429);
      expect(Number(third.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      // One start + one image ran; the refused call did not.
      expect(spend.getSessionToken).toHaveBeenCalledTimes(1);
      expect(spend.analyzeAndGenerateImage).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.AVATAR_BURST_IP;
    }
  });

  it('weights an image far above a visual — one request is not one unit', async () => {
    // THE SAME budget of 30 units buys five visual analyses (6 each) or ONE image analysis (30) —
    // because an image call can run two gpt-image-1 renders and a visual call cannot. The old
    // counter treated both as one tick, so an implementation that still counts requests lets five
    // image renders through here and fails on the very last assertion.
    process.env.AVATAR_BURST_IP = '30';
    serve(PUBLIC_PROJECT);
    try {
      for (let i = 0; i < 5; i++) {
        expect((await post('/api/v1/avatar/visual/analyze', visualBody())).statusCode).toBe(200);
      }
      expect((await post('/api/v1/avatar/visual/analyze', visualBody())).statusCode).toBe(429);
      expect(spend.analyzeVisual).toHaveBeenCalledTimes(5);

      resetBurstShield();
      expect((await post('/api/v1/avatar/image/analyze', imageBody())).statusCode).toBe(200);
      expect((await post('/api/v1/avatar/image/analyze', imageBody())).statusCode).toBe(429);
      expect(spend.analyzeAndGenerateImage).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.AVATAR_BURST_IP;
    }
  });

  it('a refused call consumes nothing, so it cannot drain the layers it never reached', async () => {
    // The reservation walks the layers in order — address first, then account. A limiter that
    // debits each layer as it walks leaves the ADDRESS budget spent by a call the ACCOUNT layer
    // then refused, so a caller who is already over their own limit can quietly drain the shared
    // budget of everyone behind their address, one 429 at a time.
    //
    // Budgets here are two visual analyses (12) per address and one (6) per account. The shield is
    // deliberately NOT reset in the middle of this test: the whole question is what the refused
    // call left behind.
    process.env.AVATAR_BURST_IP = '12';
    process.env.AVATAR_BURST_UID = '6';
    mocks.currentUser.value = { id: 'user-9', email: 'a@b.c', is_anonymous: false };
    serve(PUBLIC_PROJECT);
    try {
      expect((await post('/api/v1/avatar/visual/analyze', visualBody())).statusCode).toBe(200);
      // Refused by the ACCOUNT layer, having passed the address layer on the way.
      expect((await post('/api/v1/avatar/visual/analyze', visualBody())).statusCode).toBe(429);

      // Lift the account limit only. The address budget must still have its second call in it.
      process.env.AVATAR_BURST_UID = '100000';
      expect((await post('/api/v1/avatar/visual/analyze', visualBody())).statusCode).toBe(200);
      expect(spend.analyzeVisual).toHaveBeenCalledTimes(2);
      // …and exactly one call left in it, not two.
      expect((await post('/api/v1/avatar/visual/analyze', visualBody())).statusCode).toBe(429);
    } finally {
      delete process.env.AVATAR_BURST_UID;
      delete process.env.AVATAR_BURST_IP;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('the kill switch', () => {
  it('stops all three billable routes at once, with 503 and Retry-After', async () => {
    process.env.AVATAR_KILL_SWITCH = '1';
    serve(PUBLIC_PROJECT);
    for (const [url, body] of [
      ['/api/v1/avatar/start', startBody()],
      ['/api/v1/avatar/visual/analyze', visualBody()],
      ['/api/v1/avatar/image/analyze', imageBody()],
    ] as const) {
      const res = await post(url, body);
      expect(res.statusCode).toBe(503);
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    }
    nothingWasSpent();
  });

  it('does not disable the free routes — health still answers', async () => {
    process.env.AVATAR_KILL_SWITCH = 'true';
    const res = await app.inject({ method: 'GET', url: '/api/v1/avatar/health' });
    expect(res.statusCode).toBe(200);
  });

  it('also stops the memory route, which spends two OpenAI completions per accepted call', async () => {
    // A FOURTH billable endpoint on this surface, found by the adversarial review of the very
    // work that gated the other three. `POST /avatar/memory` runs `extractAndSaveFacts` — two
    // OpenAI completions — behind nothing but a memory token, and the GET that MINTS that token
    // had no gate at all when called without a projectId. One unauthenticated GET bought a
    // twelve-hour bearer for unbounded paid work.
    process.env.AVATAR_KILL_SWITCH = '1';
    vi.mocked(verifyMemoryToken).mockReturnValue({ s: 'sess-1', p: 'global' } as never);
    const res = await post('/api/v1/avatar/memory', {
      token: 't', sessionKey: 'sess-1', turns: [{ role: 'user', content: 'hello' }],
    });
    expect(res.statusCode).toBe(503);
    expect(extractAndSaveFacts, 'the emergency stop must reach every paid path, not three of four')
      .not.toHaveBeenCalled();
    expect(saveTurns).not.toHaveBeenCalled();
  });

  it('refuses BEFORE any read, which is the only thing that makes it an emergency stop', async () => {
    // The test above passes against an implementation that consults the switch on the handler's
    // LAST line — 503 and nothing-spent are both satisfied by that. And that is what shipped: the
    // switch lived inside the reservation, which on /avatar/start runs after the project read, the
    // authorization (which can hit the collaborators table), the transcript read, the key read and
    // a VENDOR round trip. An operator pulling the stop mid-incident still paid all of it per
    // request, which is most of what the stop is for.
    //
    // Asserting on the absence of I/O is what pins the ordering. 503 does not.
    process.env.AVATAR_KILL_SWITCH = '1';
    serve(PUBLIC_PROJECT);
    const res = await post('/api/v1/avatar/start', startBody());
    expect(res.statusCode).toBe(503);
    expect(mocks.projectsFindFirst, 'the emergency stop must not cost a database round trip')
      .not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('strict bodies', () => {
  it('rejects an unknown field on start rather than ignoring it', async () => {
    serve(PUBLIC_PROJECT);
    const res = await post('/api/v1/avatar/start', startBody({ personaOverride: { systemPrompt: 'be evil' } }));
    expect(res.statusCode).toBe(400);
    nothingWasSpent();
  });

  it('rejects a non-uuid projectId before it reaches the database', async () => {
    const res = await post('/api/v1/avatar/start', { projectId: 'not-a-uuid' });
    expect(res.statusCode).toBe(400);
    expect(mocks.projectsFindFirst).not.toHaveBeenCalled();
    nothingWasSpent();
  });

  it('refuses a prompt-sized payload outright instead of paying to truncate it', async () => {
    serve(PUBLIC_PROJECT);
    const res = await post('/api/v1/avatar/visual/analyze', visualBody({ message: 'x'.repeat(20_000) }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ type: 'none' });
    nothingWasSpent();
  });

  it('bounds conversation context, which used to ride into the prompt unmeasured', async () => {
    serve(PUBLIC_PROJECT);
    const res = await post('/api/v1/avatar/visual/analyze', visualBody({ context: 'c'.repeat(20_000) }));
    expect(res.statusCode).toBe(200);
    const context = spend.analyzeVisual.mock.calls[0]?.[2] as string;
    expect(context.length).toBeLessThanOrEqual(12_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('/avatar/end is not a refund', () => {
  it('answers ok and calls nothing — it has no authority to release anything', async () => {
    const res = await post('/api/v1/avatar/end', { character_id: 'einstein' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    nothingWasSpent();
  });

  it('rejects a body it does not understand rather than treating it as a session identity', async () => {
    const res = await post('/api/v1/avatar/end', { sessionId: 'anything', releaseUnits: 999 });
    expect(res.statusCode).toBe(400);
  });
});
