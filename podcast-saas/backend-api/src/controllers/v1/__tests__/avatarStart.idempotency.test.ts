/**
 * Two viewers opening the SAME video must each get their own usable token.
 *
 * An Anam session token is single-use per stream. The old six-second reuse window was keyed on the
 * persona config + API key, which is a property of the VIDEO — so the second viewer of a popular
 * public video got a token whose session the first viewer had already consumed, and their stream
 * was refused. That is the bug this suite exists to prevent from returning.
 *
 * Deduping is still available where it is safe: a client that sends `startKey` (one random value
 * per popup open) gets its retries collapsed, scoped to that project and caller only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';

const mocks = vi.hoisted(() => ({ projects: { findFirst: vi.fn() } }));

vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../db/index.js', () => ({
  db: {
    query: { projects: mocks.projects },
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
  mints: { n: 0 },
  getSessionToken: vi.fn(),
  getProjectTranscript: vi.fn(),
  resolveAnamKeyForProject: vi.fn(),
  avatarProjectAllowedAsync: vi.fn(),
  enrichAvatarConfigFromAnam: vi.fn(),
  describeAvatar: vi.fn(),
  getPersona: vi.fn(),
  upsertVideoPersona: vi.fn(),
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
import { resetStartIdempotency } from '../../../services/avatar/startIdempotency.js';
import { resetPersonaBakeState } from '../../../services/avatar/personaBake.js';
import { bakedStateFor, hashTranscript } from '../../../services/avatar/personaFingerprint.js';

/** A healthy (stateful) project: every viewer of it produces the identical persona config,
 *  which is exactly the case the config-keyed cache used to collapse. */
const CFG = (() => {
  const stored = { characterId: 'einstein', avatarId: 'av-1', voiceId: 'vo-1', llmId: 'llm-1', transcriptHash: hashTranscript(null) };
  return { ...stored, personaId: 'persona-1', personaBaked: bakedStateFor(stored) };
})();

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAvatarRoutes(app);
  await app.ready();
  return app;
}

function tokenOf(res: { payload: string }): string {
  return JSON.parse(res.payload).sessionToken;
}

describe('POST /avatar/start — one token per viewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStartIdempotency();
    resetPersonaBakeState();
    svc.mints.n = 0;
    mocks.projects.findFirst.mockResolvedValue({ id: PROJECT_ID, visibility: 'public', created_by: 'owner-1', avatar_config: CFG });
    svc.avatarProjectAllowedAsync.mockResolvedValue(true);
    svc.resolveAnamKeyForProject.mockResolvedValue('anam_sk_test');
    svc.getProjectTranscript.mockResolvedValue(null);
    svc.enrichAvatarConfigFromAnam.mockImplementation(async (cfg: unknown) => cfg);
    svc.getSessionToken.mockImplementation(async () => {
      // A real mint is not instantaneous; overlap the two viewers on purpose.
      await new Promise((r) => setTimeout(r, 5));
      return { token: `tok-${++svc.mints.n}`, characterId: 'einstein', voiceSensitivity: 0.5, avatarId: 'av-1' };
    });
  });

  it('two viewers opening the same project CONCURRENTLY each receive a distinct usable token', async () => {
    const app = await buildApp();
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload: { projectId: PROJECT_ID }, remoteAddress: '203.0.113.10' }),
      app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload: { projectId: PROJECT_ID }, remoteAddress: '203.0.113.11' }),
    ]);
    await app.close();

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(tokenOf(a)).toBeTruthy();
    expect(tokenOf(b)).toBeTruthy();
    expect(tokenOf(a)).not.toBe(tokenOf(b));
    expect(svc.mints.n).toBe(2);
  });

  it('two viewers arriving back-to-back (inside the old six-second window) also get distinct tokens', async () => {
    const app = await buildApp();
    const a = await app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload: { projectId: PROJECT_ID }, remoteAddress: '203.0.113.10' });
    const b = await app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload: { projectId: PROJECT_ID }, remoteAddress: '203.0.113.11' });
    await app.close();
    expect(tokenOf(a)).not.toBe(tokenOf(b));
  });

  it('the SAME popup open asking twice is deduped to one mint', async () => {
    const app = await buildApp();
    const payload = { projectId: PROJECT_ID, startKey: 'popup-open-aaaaaaaa-bbbb-cccc' };
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload, remoteAddress: '203.0.113.10' }),
      app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload, remoteAddress: '203.0.113.10' }),
    ]);
    await app.close();
    expect(tokenOf(a)).toBe(tokenOf(b));
    expect(svc.mints.n).toBe(1);
  });

  it('the same startKey from a DIFFERENT viewer is not shared', async () => {
    const app = await buildApp();
    const payload = { projectId: PROJECT_ID, startKey: 'popup-open-aaaaaaaa-bbbb-cccc' };
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload, remoteAddress: '203.0.113.10' }),
      app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload, remoteAddress: '198.51.100.7' }),
    ]);
    await app.close();
    expect(tokenOf(a)).not.toBe(tokenOf(b));
    expect(svc.mints.n).toBe(2);
  });

  it('a failed start is not replayed to the next attempt of the same popup open', async () => {
    svc.getSessionToken.mockRejectedValueOnce(Object.assign(new Error('Anam API error (502)'), { status: 502 }));
    const app = await buildApp();
    const payload = { projectId: PROJECT_ID, startKey: 'popup-open-dddddddd-eeee-ffff' };
    const first = await app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload, remoteAddress: '203.0.113.10' });
    const second = await app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload, remoteAddress: '203.0.113.10' });
    await app.close();
    expect(first.statusCode).toBe(502);
    expect(second.statusCode).toBe(200);
    expect(tokenOf(second)).toBeTruthy();
  });
});
