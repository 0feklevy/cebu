/**
 * OWNER-REPORTED: the avatar still connects as Einstein on a project whose persona was configured
 * to somebody else.
 *
 * The project's configured persona lives in ONE place — `projects.avatar_config` (jsonb):
 * `characterId`, the pinned `avatarId`/`avatarName`/`avatarImageUrl`, the baked `personaId`, and
 * the server-resolved cosmetic `personaDisplay`. Every avatar route that is handed a projectId can
 * read it. Several did not, and instead fell back to DEFAULT_CHARACTER_ID — or let the CALLER's
 * `characterId` win over the project's own.
 *
 * The rule these tests pin down:
 *   • Where a project is named, the PROJECT's configured persona decides. A client-sent character
 *     may not override it — a client default is not a choice, it is the absence of one.
 *   • Where no project is named (the signed-in global path), 'einstein' remains the fallback.
 *   • The start response must carry the project's own display identity, so the popup never has to
 *     guess a name (it guesses 'einstein').
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
vi.mock('../../../services/avatar/libraryService.js', () => ({
  insertVisual: vi.fn(), listVisuals: vi.fn(), updateVisual: vi.fn(), deleteVisual: vi.fn(),
  syncBasicLibrary: vi.fn(async () => {}), storeImageBuffer: vi.fn(), storeSimulationHtml: vi.fn(),
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
  analyzeVisual: vi.fn(),
  analyzeAndGenerateImage: vi.fn(),
}));

vi.mock('../../../services/avatar/visualService.js', () => ({
  analyzeVisual: svc.analyzeVisual, generateLibrarySimulation: vi.fn(), editLibrarySimulation: vi.fn(),
}));
vi.mock('../../../services/avatar/imageService.js', () => ({
  analyzeAndGenerateImage: svc.analyzeAndGenerateImage, generateLibraryImage: vi.fn(),
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
import { resetDisplayResolveState } from '../../../services/avatar/displayIdentity.js';
import type { AvatarPersonaConfig } from '../../../services/avatar/anamService.js';

/** A project whose persona is healthy and baked — the shape the fast start path takes. */
function baked(stored: AvatarPersonaConfig): AvatarPersonaConfig {
  const withHash: AvatarPersonaConfig = { llmId: 'llm-1', transcriptHash: hashTranscript(null), ...stored };
  return { ...withHash, personaId: 'persona-1', personaBaked: bakedStateFor(withHash) };
}

async function buildApp(config: AvatarPersonaConfig | null): Promise<FastifyInstance> {
  mocks.projects.findFirst.mockResolvedValue(
    config === null ? null : { id: PROJECT_ID, visibility: 'public', created_by: 'owner-1', avatar_config: config },
  );
  const app = Fastify();
  await registerAvatarRoutes(app);
  await app.ready();
  return app;
}

async function post(config: AvatarPersonaConfig | null, url: string, payload: Record<string, unknown>) {
  const app = await buildApp(config);
  const res = await app.inject({ method: 'POST', url, payload });
  await app.close();
  return res;
}

describe('avatar routes — the project\'s configured persona is authoritative', () => {
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
    svc.getSessionToken.mockImplementation(async (characterId: string) => ({
      token: 'tok-1', characterId, voiceSensitivity: 0.5,
    }));
    svc.peekAvatarLook.mockReturnValue(undefined);
    svc.analyzeVisual.mockResolvedValue({ type: 'none' });
    svc.analyzeAndGenerateImage.mockResolvedValue({ shouldGenerate: false, imageUrl: null, altText: '', caption: '', imageType: 'realistic' });
  });

  it('/avatar/start: a client-sent character cannot override the project\'s configured one', async () => {
    const res = await post(baked({ characterId: 'darwin' }), '/api/v1/avatar/start', {
      projectId: PROJECT_ID,
      character_id: 'einstein', // what a reconnect / a stale client default sends
    });
    expect(res.statusCode).toBe(200);
    expect(svc.getSessionToken).toHaveBeenCalledWith('darwin', expect.anything(), expect.anything());
    expect(JSON.parse(res.payload).characterId).toBe('darwin');
  });

  it('/avatar/start: the response names the project persona even when no avatar is pinned', async () => {
    // Exactly the owner's project: a saved persona called "Pnina", no pinned avatarId, and no
    // personaDisplay resolved yet (first open, or a resolve that failed). The old response carried
    // only voiceSensitivity, so the popup fell back to its own einstein metadata.
    const res = await post(baked({ characterId: 'einstein', name: 'Pnina' }), '/api/v1/avatar/start', { projectId: PROJECT_ID });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.avatarDisplay?.displayName).toBe('Pnina');
    expect(body.avatarDisplay?.startingLabel).toMatch(/pnina/i);
  });

  it('/avatar/visual/analyze: the project decides, not the caller', async () => {
    const res = await post(baked({ characterId: 'darwin' }), '/api/v1/avatar/visual/analyze', {
      message: 'explain this', characterId: 'einstein', projectId: PROJECT_ID,
    });
    expect(res.statusCode).toBe(200);
    expect(svc.analyzeVisual).toHaveBeenCalledWith('explain this', 'darwin', undefined, { projectId: PROJECT_ID });
  });

  it('/avatar/image/analyze: the project decides, not the caller', async () => {
    const res = await post(baked({ characterId: 'darwin' }), '/api/v1/avatar/image/analyze', {
      userMessage: 'draw a finch', characterId: 'einstein', projectId: PROJECT_ID,
    });
    expect(res.statusCode).toBe(200);
    expect(svc.analyzeAndGenerateImage).toHaveBeenCalledWith('draw a finch', 'darwin', undefined, PROJECT_ID);
  });

  it('a project that configured NO character still resolves to the default', async () => {
    const res = await post(baked({}), '/api/v1/avatar/start', { projectId: PROJECT_ID });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).characterId).toBe('einstein');
  });
});
