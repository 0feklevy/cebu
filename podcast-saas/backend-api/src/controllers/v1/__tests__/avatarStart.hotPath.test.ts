/**
 * What a healthy start is allowed to do.
 *
 * The audit measured that EVERY start read `captions_vtt` for every video in the project with no
 * LIMIT — and then, on the stateful path, threw the result away. It also re-read the projects row
 * the handler had already loaded, and (when identity fields were missing) paged the whole account
 * avatar and voice listings before minting. None of that is needed by a start whose saved persona
 * has already been verified to describe the current configuration.
 *
 * So: on the verified-healthy path the transcript read, the account listings and the duplicate
 * projects read do not happen at all. On the fallback path they DO happen — but the two reads that
 * are genuinely independent (the caption transcript and the BYOK key) run concurrently rather than
 * one after the other. Nothing starts before authorization.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const TRANSCRIPT = 'We derive the photoelectric equation and explain the Nobel citation.';

const mocks = vi.hoisted(() => {
  const logLines: Array<{ level: string; payload: Record<string, unknown> }> = [];
  const log = (level: string) => (payload: unknown) => {
    if (payload && typeof payload === 'object') logLines.push({ level, payload: payload as Record<string, unknown> });
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
  listAnamResource: vi.fn(),
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
    listAnamResource: svc.listAnamResource,
    ensureKnowledgeGroup: vi.fn(), ensureKnowledgeTool: vi.fn(), uploadKnowledgeDocument: vi.fn(),
    listKnowledgeDocuments: vi.fn(), deleteKnowledgeDocument: vi.fn(), listSystemTools: vi.fn(),
  };
});
vi.mock('../../../services/avatar/avatarAccess.js', () => ({
  avatarProjectAllowed: vi.fn(() => true), avatarProjectAllowedAsync: svc.avatarProjectAllowedAsync,
}));
vi.mock('../../../services/transcriptPropagation.js', () => ({ getProjectTranscript: svc.getProjectTranscript }));
vi.mock('../../../services/avatar/anamKey.js', () => ({ resolveAnamKeyForProject: svc.resolveAnamKeyForProject, resolveSystemAnamKey: vi.fn(async () => undefined) }));

import { registerAvatarRoutes } from '../avatar.controller.js';
import { resetBurstShield } from '../../../services/usage/avatarBudget.js';
import { bakedStateFor, hashTranscript } from '../../../services/avatar/personaFingerprint.js';
import { resetPersonaBakeState } from '../../../services/avatar/personaBake.js';
import { resetDisplayResolveState } from '../../../services/avatar/displayIdentity.js';
import type { AvatarPersonaConfig } from '../../../services/avatar/anamService.js';

/** A verified-healthy project: fingerprint matches, and it deliberately LACKS the display fields
 *  that used to trigger the account listings. */
const HEALTHY: AvatarPersonaConfig = (() => {
  const stored: AvatarPersonaConfig = {
    characterId: 'einstein', avatarId: 'av-1', voiceId: 'vo-1', llmId: 'llm-1',
    transcriptHash: hashTranscript(TRANSCRIPT),
  };
  return { ...stored, personaId: 'persona-1', personaBaked: bakedStateFor(stored) };
})();

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

const withDeadline = (p: Promise<void>, label: string) =>
  Promise.race([p, new Promise<void>((_r, reject) => setTimeout(() => reject(new Error(`${label} never ran concurrently`)), 500))]);

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

describe('POST /avatar/start — the healthy path does the minimum', () => {
  beforeEach(() => {
    mocks.logLines.length = 0;
    vi.clearAllMocks();
    resetBurstShield();
    resetPersonaBakeState();
    resetDisplayResolveState();
    svc.avatarProjectAllowedAsync.mockResolvedValue(true);
    svc.resolveAnamKeyForProject.mockResolvedValue('anam_sk_test');
    svc.getProjectTranscript.mockResolvedValue(TRANSCRIPT);
    svc.enrichAvatarConfigFromAnam.mockImplementation(async (cfg: unknown) => cfg);
    svc.listAnamResource.mockResolvedValue({ data: [] });
    svc.peekAvatarLook.mockReturnValue(undefined);
    svc.getSessionToken.mockResolvedValue({ token: 'tok-1', characterId: 'einstein', voiceSensitivity: 0.5, avatarId: 'av-1' });
  });

  it('does not read the caption transcript', async () => {
    const res = await start(HEALTHY);
    expect(res.statusCode).toBe(200);
    expect(svc.getProjectTranscript).not.toHaveBeenCalled();
    expect(startLine().phasesMs).not.toHaveProperty('transcript_read');
  });

  it('does not page the account avatar/voice listings', async () => {
    await start({ ...HEALTHY, avatarName: undefined, avatarImageUrl: undefined });
    expect(svc.enrichAvatarConfigFromAnam).not.toHaveBeenCalled();
    expect(svc.listAnamResource).not.toHaveBeenCalled();
    expect(startLine().phasesMs).not.toHaveProperty('persona_enrich');
  });

  it('resolves the BYOK key from the project row it already loaded (no second projects query)', async () => {
    await start(HEALTHY);
    expect(mocks.projects.findFirst).toHaveBeenCalledTimes(1);
    expect(svc.resolveAnamKeyForProject).toHaveBeenCalledWith(PROJECT_ID, 'owner-1');
  });

  it('the whole healthy start is: one project read, the auth gate, the cost reservation, the key read, the mint', async () => {
    await start(HEALTHY);
    // `reserve` joined this list when D-03 made the start buy its own worst-case cost before the
    // vendor is called. It is a PHASE rather than an invisible side effect on purpose: it is the
    // only new I/O on the hot path, and the trace is the sole place a slow start is attributable.
    expect(Object.keys(startLine().phasesMs as object).sort())
      .toEqual(['authorize', 'key_read', 'mint', 'project_read', 'reserve']);
    expect(startLine().path).toBe('stateful');
  });
});

describe('POST /avatar/start — the fallback path parallelizes only what is independent', () => {
  beforeEach(() => {
    mocks.logLines.length = 0;
    vi.clearAllMocks();
    resetBurstShield();
    resetPersonaBakeState();
    resetDisplayResolveState();
    svc.avatarProjectAllowedAsync.mockResolvedValue(true);
    svc.enrichAvatarConfigFromAnam.mockImplementation(async (cfg: unknown) => cfg);
    svc.listAnamResource.mockResolvedValue({ data: [] });
    svc.peekAvatarLook.mockReturnValue(undefined);
    svc.upsertVideoPersona.mockResolvedValue('persona-new');
    svc.getSessionToken.mockResolvedValue({ token: 'tok-1', characterId: 'einstein', voiceSensitivity: 0.5, avatarId: 'av-1' });
  });

  it('the transcript read and the BYOK key read are in flight at the same time', async () => {
    // Each read blocks until the OTHER has started. Sequential code deadlocks and fails the
    // deadline; concurrent code sails through.
    const transcriptStarted = deferred();
    const keyStarted = deferred();
    svc.getProjectTranscript.mockImplementation(async () => {
      transcriptStarted.resolve();
      await withDeadline(keyStarted.promise, 'the key read');
      return TRANSCRIPT;
    });
    svc.resolveAnamKeyForProject.mockImplementation(async () => {
      keyStarted.resolve();
      await withDeadline(transcriptStarted.promise, 'the transcript read');
      return 'anam_sk_test';
    });

    const res = await start({ characterId: 'einstein', avatarId: 'av-1', voiceId: 'vo-1' });
    expect(res.statusCode).toBe(200);
    // Both resolved, so both were genuinely in flight together.
    const [, cfg, key] = svc.getSessionToken.mock.calls.at(-1)!;
    expect((cfg as AvatarPersonaConfig).knowledge).toContain('photoelectric');
    expect(key).toBe('anam_sk_test');
  });

  it('nothing runs before the authorization gate has passed', async () => {
    svc.avatarProjectAllowedAsync.mockResolvedValue(false);
    svc.getProjectTranscript.mockResolvedValue(TRANSCRIPT);
    svc.resolveAnamKeyForProject.mockResolvedValue('anam_sk_test');
    const res = await start({ characterId: 'einstein' });
    expect(res.statusCode).toBe(404);
    expect(svc.getProjectTranscript).not.toHaveBeenCalled();
    expect(svc.resolveAnamKeyForProject).not.toHaveBeenCalled();
    expect(svc.getSessionToken).not.toHaveBeenCalled();
  });
});
