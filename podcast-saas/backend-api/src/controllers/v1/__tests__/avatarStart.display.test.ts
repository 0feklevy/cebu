/**
 * The token must not wait for the popup's name and portrait.
 *
 * After the mint returned — the viewer's token already in hand — the handler went back to the
 * vendor for cosmetics: GET /personas/:id to learn which avatar a stateful session uses, then
 * describeAvatar(), which pages the whole account avatar listing. Up to four more round-trips
 * between having the token and sending it, purely so the popup could show a face and a name.
 *
 * The face and the name are not dropped here. They come from persisted metadata or a bounded
 * cache when we have them, and otherwise they are resolved AFTER the response and persisted, so
 * the next open has them. What never happens again is holding a minted token behind them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';

const mocks = vi.hoisted(() => {
  const logLines: Array<{ level: string; payload: Record<string, unknown> }> = [];
  const log = (level: string) => (payload: unknown) => {
    if (payload && typeof payload === 'object') logLines.push({ level, payload: payload as Record<string, unknown> });
  };
  return { projects: { findFirst: vi.fn() }, writes: [] as Array<Record<string, unknown>>, logLines, log };
});

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(mocks.log('info')), warn: vi.fn(mocks.log('warn')),
    error: vi.fn(mocks.log('error')), debug: vi.fn(mocks.log('debug')),
  },
}));
vi.mock('../../../db/index.js', () => ({
  db: {
    query: { projects: mocks.projects },
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }), limit: async () => [] }) }),
    update: () => ({ set: (v: Record<string, unknown>) => { mocks.writes.push(v); return { where: async () => undefined }; } }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  projects: Symbol('projects'), avatar_visuals: Symbol('avatar_visuals'),
  admin_settings: Symbol('admin_settings'), users: Symbol('users'), video_files: Symbol('video_files'),
}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn(), or: vi.fn(), isNull: vi.fn(), asc: vi.fn(), desc: vi.fn() }));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: vi.fn(async () => {}), firebaseAuthOptionalMiddleware: vi.fn(async () => {}),
}));
vi.mock('../../../services/collabAccess.js', () => ({ editableProject: vi.fn(), isCollaborator: vi.fn(async () => false) }));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({ getStorageAdapter: vi.fn(() => ({})) }));
vi.mock('../../../services/storage/uploadWithFallback.js', () => ({ uploadWithFallback: vi.fn() }));
vi.mock('../../../services/simulation/SimulationService.js', () => ({ SimulationService: class {} }));
vi.mock('../../../services/llm/LLMService.js', () => ({ LLMService: class {} }));
vi.mock('../../../services/secrets/ApiKeyService.js', () => ({ ApiKeyService: class {}, encryptKey: vi.fn() }));
vi.mock('../../../services/usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));
vi.mock('../../../services/avatar/visualService.js', () => ({ analyzeVisual: vi.fn(), generateLibrarySimulation: vi.fn(), editLibrarySimulation: vi.fn() }));
vi.mock('../../../services/avatar/imageService.js', () => ({ analyzeAndGenerateImage: vi.fn(), generateLibraryImage: vi.fn() }));
vi.mock('../../../services/avatar/libraryService.js', () => ({
  insertVisual: vi.fn(), listVisuals: vi.fn(), updateVisual: vi.fn(), deleteVisual: vi.fn(),
  syncBasicLibrary: vi.fn(), storeImageBuffer: vi.fn(), storeSimulationHtml: vi.fn(),
}));
vi.mock('../../../services/avatar/memoryService.js', () => ({ saveTurns: vi.fn(), getTurns: vi.fn(), getProfile: vi.fn(), extractAndSaveFacts: vi.fn() }));
vi.mock('../../../services/avatar/memoryToken.js', () => ({ signMemoryToken: vi.fn(), verifyMemoryToken: vi.fn() }));

const svc = vi.hoisted(() => ({
  getSessionToken: vi.fn(),
  getProjectTranscript: vi.fn(),
  resolveAnamKeyForProject: vi.fn(),
  avatarProjectAllowedAsync: vi.fn(),
  enrichAvatarConfigFromAnam: vi.fn(),
  describeAvatar: vi.fn(),
  getPersona: vi.fn(),
  upsertVideoPersona: vi.fn(),
  peekAvatarLook: vi.fn(),
}));

vi.mock('../../../services/avatar/anamService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/avatar/anamService.js')>();
  return {
    ...actual,
    getSessionToken: svc.getSessionToken,
    enrichAvatarConfigFromAnam: svc.enrichAvatarConfigFromAnam,
    describeAvatar: svc.describeAvatar,
    getPersona: svc.getPersona,
    upsertVideoPersona: svc.upsertVideoPersona,
    peekAvatarLook: svc.peekAvatarLook,
    listAnamResource: vi.fn(async () => ({ data: [] })),
    ensureKnowledgeGroup: vi.fn(), ensureKnowledgeTool: vi.fn(), uploadKnowledgeDocument: vi.fn(),
    listKnowledgeDocuments: vi.fn(), deleteKnowledgeDocument: vi.fn(), listSystemTools: vi.fn(),
  };
});
vi.mock('../../../services/avatar/avatarAccess.js', () => ({
  avatarProjectAllowed: vi.fn(() => true), avatarProjectAllowedAsync: svc.avatarProjectAllowedAsync,
}));
vi.mock('../../../services/transcriptPropagation.js', () => ({ getProjectTranscript: svc.getProjectTranscript }));
vi.mock('../../../services/avatar/anamKey.js', () => ({ resolveAnamKeyForProject: svc.resolveAnamKeyForProject }));

import { registerAvatarRoutes } from '../avatar.controller.js';
import { resetBurstShield } from '../../../services/usage/avatarBudget.js';
import { bakedStateFor, hashTranscript } from '../../../services/avatar/personaFingerprint.js';
import { resetPersonaBakeState } from '../../../services/avatar/personaBake.js';
import { pendingDisplayResolves, resetDisplayResolveState } from '../../../services/avatar/displayIdentity.js';
import type { AvatarPersonaConfig } from '../../../services/avatar/anamService.js';

/** A healthy stateful project that never pinned an avatar (defaults resolved from the account) —
 *  the exact case whose name/portrait used to cost extra vendor round-trips on every start. */
function statefulNoAvatar(extra: Partial<AvatarPersonaConfig> = {}): AvatarPersonaConfig {
  const stored: AvatarPersonaConfig = { characterId: 'einstein', llmId: 'llm-1', transcriptHash: hashTranscript(null), ...extra };
  return { ...stored, personaId: 'persona-1', personaBaked: bakedStateFor(stored) };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAvatarRoutes(app);
  await app.ready();
  return app;
}

async function start(config: AvatarPersonaConfig) {
  mocks.projects.findFirst.mockResolvedValue({ id: PROJECT_ID, visibility: 'public', created_by: 'owner-1', avatar_config: config });
  const app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload: { projectId: PROJECT_ID } });
  await app.close();
  return res;
}

function startLine() {
  return mocks.logLines.filter((l) => l.payload.evt === 'avatar_start').at(-1)!.payload;
}

describe('POST /avatar/start — cosmetics never hold the token', () => {
  beforeEach(() => {
    mocks.logLines.length = 0;
    mocks.writes.length = 0;
    vi.clearAllMocks();
    resetBurstShield();
    resetPersonaBakeState();
    resetDisplayResolveState();
    svc.avatarProjectAllowedAsync.mockResolvedValue(true);
    svc.resolveAnamKeyForProject.mockResolvedValue('anam_sk_test');
    svc.getProjectTranscript.mockResolvedValue(null);
    svc.enrichAvatarConfigFromAnam.mockImplementation(async (cfg: unknown) => cfg);
    svc.getSessionToken.mockResolvedValue({ token: 'tok-1', characterId: 'einstein', voiceSensitivity: 0.5 });
    svc.peekAvatarLook.mockReturnValue(undefined);
    svc.getPersona.mockResolvedValue({ id: 'persona-1', avatarId: 'av-resolved' });
    svc.describeAvatar.mockResolvedValue({ displayName: 'Julia', variantName: 'Studio', imageUrl: 'https://img/julia.png' });
  });

  it('responds before any identity lookup runs, then resolves and persists it in the background', async () => {
    const res = await start(statefulNoAvatar());
    expect(res.statusCode).toBe(200);
    // At response time neither cosmetic vendor call had been made.
    expect(svc.getPersona).not.toHaveBeenCalled();
    expect(svc.describeAvatar).not.toHaveBeenCalled();
    expect(startLine().flags).toContain('display_deferred');

    await pendingDisplayResolves();
    expect(svc.getPersona).toHaveBeenCalledTimes(1);
    expect(svc.describeAvatar).toHaveBeenCalledTimes(1);
    const saved = mocks.writes.filter((w) => w.avatar_config).at(-1)!.avatar_config as AvatarPersonaConfig;
    expect(saved.personaDisplay).toEqual({ avatarId: 'av-resolved', displayName: 'Julia', variantName: 'Studio', imageUrl: 'https://img/julia.png' });
  });

  it('the next open serves the real face and name from persisted metadata, with no vendor call', async () => {
    const res = await start(statefulNoAvatar({
      personaDisplay: { avatarId: 'av-resolved', displayName: 'Julia', variantName: 'Studio', imageUrl: 'https://img/julia.png' },
    }));
    const body = JSON.parse(res.payload);
    expect(body.avatarDisplay.displayName).toBe('Julia');
    expect(body.avatarDisplay.portrait).toBe('https://img/julia.png');
    expect(body.avatarDisplay.nametag).toBe('Julia · Studio');
    expect(svc.getPersona).not.toHaveBeenCalled();
    expect(svc.describeAvatar).not.toHaveBeenCalled();
    expect(startLine().flags).toContain('display_cached');
  });

  it('a bounded in-memory cache answers for an avatar this process already described', async () => {
    svc.peekAvatarLook.mockReturnValue({ avatarId: 'av-hot', displayName: 'Pnina', variantName: '', imageUrl: 'https://img/pnina.png' });
    svc.getSessionToken.mockResolvedValue({ token: 'tok-1', characterId: 'einstein', voiceSensitivity: 0.5, avatarId: 'av-hot' });
    const res = await start(statefulNoAvatar());
    const body = JSON.parse(res.payload);
    expect(body.avatarDisplay.displayName).toBe('Pnina');
    expect(body.avatarDisplay.portrait).toBe('https://img/pnina.png');
    expect(svc.describeAvatar).not.toHaveBeenCalled();
    expect(startLine().flags).toContain('display_cached');
  });

  it('a video that pinned its avatar keeps answering from its own saved identity', async () => {
    const res = await start(statefulNoAvatar({ avatarId: 'av-1', avatarName: 'Albert', avatarImageUrl: 'https://img/albert.png' }));
    const body = JSON.parse(res.payload);
    expect(body.avatarDisplay.displayName).toBe('Albert');
    expect(body.avatarDisplay.portrait).toBe('https://img/albert.png');
    expect(svc.getPersona).not.toHaveBeenCalled();
    expect(svc.describeAvatar).not.toHaveBeenCalled();
    await pendingDisplayResolves();
    expect(svc.describeAvatar).not.toHaveBeenCalled();
  });

  it('a failing identity lookup is invisible to the viewer', async () => {
    svc.getPersona.mockRejectedValue(new Error('vendor down'));
    svc.describeAvatar.mockRejectedValue(new Error('vendor down'));
    const res = await start(statefulNoAvatar());
    expect(res.statusCode).toBe(200);
    await expect(pendingDisplayResolves()).resolves.toBeUndefined();
    expect(mocks.writes.some((w) => (w.avatar_config as AvatarPersonaConfig | undefined)?.personaDisplay)).toBe(false);
  });

  it('two concurrent starts resolve the identity once', async () => {
    mocks.projects.findFirst.mockResolvedValue({ id: PROJECT_ID, visibility: 'public', created_by: 'owner-1', avatar_config: statefulNoAvatar() });
    const app = await buildApp();
    await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload: { projectId: PROJECT_ID } }),
      app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload: { projectId: PROJECT_ID } }),
    ]);
    await app.close();
    await pendingDisplayResolves();
    expect(svc.describeAvatar).toHaveBeenCalledTimes(1);
  });
});
