/**
 * The write CHOKEPOINT, observed at its riskiest gate: PUT /avatar/config.
 *
 * `effective` passes through enrichAvatarConfigFromAnam, which reflects VENDOR fields with `||`
 * — any truthy object sails through — so this writer could store the exact wrong-typed poison
 * the read seams exist to survive (incident 2026-08-23). The claim under test: whatever the
 * vendor reflection produces, the row that reaches the database is clean.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const OWNER = { id: 'owner-1', email: 'o@x.t', is_anonymous: false };
const PROJECT = vi.hoisted(() => ({ id: '11111111-2222-4333-8444-555555555555', visibility: 'private', created_by: 'owner-1', share_token: null, avatar_config: {}, title: 'T' }));

const captured = vi.hoisted(() => ({ writes: [] as Record<string, unknown>[] }));
const enrich = vi.hoisted(() => ({ fn: vi.fn(async (cfg: unknown) => cfg) }));

vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../db/index.js', () => ({
  db: {
    query: { projects: { findFirst: async () => PROJECT } },
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }), limit: async () => [] }) }),
    update: () => ({ set: (v: Record<string, unknown>) => { if ('avatar_config' in v) captured.writes.push(v.avatar_config as Record<string, unknown>); return { where: async () => undefined }; } }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  projects: Symbol('projects'), avatar_visuals: Symbol('v'), admin_settings: Symbol('a'), users: Symbol('u'), video_files: Symbol('f'),
}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn(), or: vi.fn(), isNull: vi.fn(), asc: vi.fn(), desc: vi.fn() }));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: vi.fn(async (req: { dbUser?: unknown }) => { req.dbUser = OWNER; }),
  firebaseAuthOptionalMiddleware: vi.fn(async (req: { dbUser?: unknown }) => { req.dbUser = OWNER; }),
}));
vi.mock('../../../services/collabAccess.js', () => ({ editableProject: vi.fn(async () => PROJECT), isCollaborator: vi.fn(async () => false) }));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({ getStorageAdapter: vi.fn(() => ({})) }));
vi.mock('../../../services/storage/uploadWithFallback.js', () => ({ uploadWithFallback: vi.fn() }));
vi.mock('../../../services/simulation/SimulationService.js', () => ({ SimulationService: class {} }));
vi.mock('../../../services/llm/LLMService.js', () => ({ LLMService: class {} }));
vi.mock('../../../services/secrets/ApiKeyService.js', () => ({ ApiKeyService: class { async getSystemKey() { return null; } }, encryptKey: vi.fn(), decryptKey: vi.fn() }));
vi.mock('../../../services/usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));
vi.mock('../../../services/avatar/memoryService.js', () => ({ saveTurns: vi.fn(), getTurns: vi.fn(), getProfile: vi.fn(), extractAndSaveFacts: vi.fn() }));
vi.mock('../../../services/avatar/memoryToken.js', () => ({ signMemoryToken: vi.fn(), verifyMemoryToken: vi.fn() }));
vi.mock('../../../services/transcriptPropagation.js', () => ({ getProjectTranscript: vi.fn(async () => null) }));
vi.mock('../../../services/avatar/anamKey.js', () => ({ resolveAnamKeyForProject: vi.fn(async () => undefined), resolveSystemAnamKey: vi.fn(async () => undefined) }));
vi.mock('../../../services/avatar/visualService.js', () => ({ analyzeVisual: vi.fn(), generateLibrarySimulation: vi.fn(), editLibrarySimulation: vi.fn() }));
vi.mock('../../../services/avatar/imageService.js', () => ({ analyzeAndGenerateImage: vi.fn(), generateLibraryImage: vi.fn() }));
vi.mock('../../../services/avatar/libraryService.js', () => ({
  insertVisual: vi.fn(), listVisuals: vi.fn(), updateVisual: vi.fn(), deleteVisual: vi.fn(),
  syncBasicLibrary: vi.fn(), storeImageBuffer: vi.fn(), storeSimulationHtml: vi.fn(),
}));
vi.mock('../../../services/avatar/anamService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/avatar/anamService.js')>();
  return {
    ...actual,
    enrichAvatarConfigFromAnam: (...a: unknown[]) => enrich.fn(...(a as [unknown])),
    upsertVideoPersona: vi.fn(async () => 'persona-1'),
    getSessionToken: vi.fn(), peekAvatarLook: vi.fn(() => undefined), listAnamResource: vi.fn(async () => ({ data: [] })),
    ensureKnowledgeGroup: vi.fn(), ensureKnowledgeTool: vi.fn(), uploadKnowledgeDocument: vi.fn(),
    listKnowledgeDocuments: vi.fn(), deleteKnowledgeDocument: vi.fn(), listSystemTools: vi.fn(),
  };
});

import { registerAvatarRoutes } from '../avatar.controller.js';

let app: FastifyInstance;
beforeEach(async () => {
  vi.clearAllMocks();
  captured.writes.length = 0;
  enrich.fn.mockImplementation(async (cfg: unknown) => cfg);
  app = Fastify();
  await registerAvatarRoutes(app);
  await app.ready();
});
afterEach(async () => { await app.close(); });

describe('PUT /avatar/config cannot store what the vendor reflected', () => {
  it('a vendor field that comes back as an OBJECT is dropped before the write', async () => {
    // The exact reflection path: `avatarName: cfg.avatarName || avatar.displayName || ''` — a
    // localized-object displayName is truthy, so without the write-side sanitize it is STORED,
    // and the next start trips over `.trim()` on it.
    enrich.fn.mockImplementation(async (cfg: Record<string, unknown>) => ({
      ...cfg, avatarName: { en: 'Einstein', he: 'איינשטיין' }, avatarImageUrl: 'https://cdn/x.png',
    }));

    const res = await app.inject({
      method: 'PUT', url: `/api/v1/projects/${PROJECT.id}/avatar/config`,
      payload: { avatarId: 'av-1', voiceId: 'v-1' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(captured.writes.length).toBeGreaterThan(0);
    const written = captured.writes.at(-1)!;
    expect(written.avatarName, 'the vendor object reached the row').toBeUndefined();
    expect(written.avatarImageUrl).toBe('https://cdn/x.png');
    expect(written.avatarId).toBe('av-1');
  });

  it('a clean config writes through unmodified fields', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/api/v1/projects/${PROJECT.id}/avatar/config`,
      payload: { avatarId: 'av-2', voiceId: 'v-2', greeting: 'shalom' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const written = captured.writes.at(-1)!;
    expect(written.avatarId).toBe('av-2');
    expect(written.greeting).toBe('shalom');
  });
});
