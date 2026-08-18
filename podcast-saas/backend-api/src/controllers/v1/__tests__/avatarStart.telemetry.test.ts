/**
 * POST /api/v1/avatar/start emits ONE redacted, phase-level line per start.
 *
 * The night audit's first finding was that the endpoint users called "very very slow" was also
 * the endpoint that logged nothing but failures — there was no way to attribute a slow start to
 * authorization, the database reads, the vendor mint, or the cosmetic name/portrait work that ran
 * after the token was already in hand.
 *
 * This suite pins the observability contract at the ROUTE level (startTelemetry.test.ts pins the
 * recorder itself): every start — success, denial, vendor failure — produces exactly one
 * structured line, it carries durations for the phases that actually ran, and it never carries a
 * token, an API key, a transcript, a system prompt or a persona body.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const SECRET = {
  token: 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXBlIjoiZXBoZW1lcmFsIn0.c2ln-NOT-A-REAL-TOKEN',
  apiKey: 'anam_sk_live_TESTKEY_0000000000000000',
  transcript: 'In this lesson we derive the photoelectric equation and explain the Nobel citation.',
  systemPrompt: 'You are Albert Einstein. SECRET-PROMPT-MARKER.',
  knowledge: 'SECRET-KNOWLEDGE-MARKER: internal course notes.',
};

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';

const mocks = vi.hoisted(() => {
  const logLines: Array<{ level: string; payload: Record<string, unknown>; msg: string }> = [];
  const log = (level: string) => (payload: unknown, msg?: unknown) => {
    if (payload && typeof payload === 'object') {
      logLines.push({ level, payload: payload as Record<string, unknown>, msg: String(msg ?? '') });
    }
  };
  return { projects: { findFirst: vi.fn() }, logLines, log };
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
  firebaseAuthOptionalMiddleware: vi.fn(async () => {}),
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
  avatarProjectAllowed: vi.fn(() => true),
  avatarProjectAllowedAsync: svc.avatarProjectAllowedAsync,
}));
vi.mock('../../../services/transcriptPropagation.js', () => ({ getProjectTranscript: svc.getProjectTranscript }));
vi.mock('../../../services/avatar/anamKey.js', () => ({ resolveAnamKeyForProject: svc.resolveAnamKeyForProject }));

import { registerAvatarRoutes } from '../avatar.controller.js';
import { resetBurstShield } from '../../../services/usage/avatarBudget.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAvatarRoutes(app);
  await app.ready();
  return app;
}

function startLines() {
  return mocks.logLines.filter((l) => l.payload.evt === 'avatar_start');
}

describe('POST /avatar/start — phase instrumentation', () => {
  beforeEach(() => {
    mocks.logLines.length = 0;
    vi.clearAllMocks();
    resetBurstShield();
    mocks.projects.findFirst.mockResolvedValue({
      id: PROJECT_ID,
      visibility: 'public',
      created_by: 'owner-1',
      avatar_config: { characterId: 'einstein', systemPrompt: SECRET.systemPrompt, knowledge: SECRET.knowledge, avatarId: 'av-1', voiceId: 'vo-1', avatarName: 'Julia', avatarImageUrl: 'https://img/j.png' },
    });
    svc.avatarProjectAllowedAsync.mockResolvedValue(true);
    svc.resolveAnamKeyForProject.mockResolvedValue(SECRET.apiKey);
    svc.getProjectTranscript.mockResolvedValue(SECRET.transcript);
    svc.enrichAvatarConfigFromAnam.mockImplementation(async (cfg: unknown) => cfg);
    svc.getSessionToken.mockResolvedValue({ token: SECRET.token, characterId: 'einstein', voiceSensitivity: 0.5, avatarId: 'av-1' });
  });

  it('logs exactly one structured line for a successful start, with per-phase durations', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload: { projectId: PROJECT_ID } });
    await app.close();

    expect(res.statusCode).toBe(200);
    const lines = startLines();
    expect(lines).toHaveLength(1);
    const p = lines[0].payload;
    expect(lines[0].level).toBe('info');
    expect(p.outcome).toBe('ok');
    expect(p.status).toBe(200);
    expect(p.projectId).toBe(PROJECT_ID);
    expect(typeof p.cid).toBe('string');
    expect(Number.isFinite(p.totalMs as number)).toBe(true);

    // Authorization, the project read, the key read and the mint are always attributable.
    const phases = p.phasesMs as Record<string, number>;
    for (const phase of ['project_read', 'authorize', 'key_read', 'mint']) {
      expect(phases, `missing phase ${phase}`).toHaveProperty(phase);
      expect(Number.isFinite(phases[phase])).toBe(true);
    }
  });

  it('logs the failure outcome and the vendor status when the mint fails', async () => {
    svc.getSessionToken.mockRejectedValue(Object.assign(new Error('Anam API error (502)'), { status: 502 }));
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload: { projectId: PROJECT_ID } });
    await app.close();

    expect(res.statusCode).toBe(502);
    const lines = startLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].payload.outcome).toBe('error');
    expect(lines[0].payload.status).toBe(502);
    expect((lines[0].payload.phasesMs as Record<string, number>).mint).toBeDefined();
  });

  it('logs one line for a denied (404) project without leaking whether it exists', async () => {
    svc.avatarProjectAllowedAsync.mockResolvedValue(false);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload: { projectId: PROJECT_ID } });
    await app.close();

    expect(res.statusCode).toBe(404);
    const lines = startLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].payload.outcome).toBe('not_found');
    expect(lines[0].payload.status).toBe(404);
  });

  it('REDACTION: no log line from a start carries the token, key, transcript, prompt or knowledge', async () => {
    const app = await buildApp();
    await app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload: { projectId: PROJECT_ID } });
    svc.getSessionToken.mockRejectedValue(Object.assign(new Error(`upstream said ${SECRET.token}`), { status: 500 }));
    await app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload: { projectId: PROJECT_ID } });
    await app.close();

    const serialized = JSON.stringify(startLines());
    for (const [name, secret] of Object.entries(SECRET)) {
      expect(serialized, `leaked ${name}`).not.toContain(secret);
      expect(serialized, `leaked ${name} fragment`).not.toContain(secret.slice(0, 20));
    }
    expect(startLines()).toHaveLength(2);
  });
});
