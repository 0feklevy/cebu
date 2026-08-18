/**
 * THE ROOT CAUSE: /avatar/start threw the pre-baked personaId away.
 *
 * Measured against the vendored SDK, a start costs ONE vendor round-trip with a 118-byte body when
 * it references the persona already saved in the Anam account, and three (small account) to six
 * (large account) round-trips with a 29,705-byte inline persona body when it does not. The endpoint
 * discarded the stored personaId on every start whose project had no RAG knowledge tool, so the
 * common case was the expensive one — the user-visible "very very slow" start.
 *
 * Deleting the discard alone would be wrong: the reason it existed is real. A persona baked before
 * the video had captions does not know the video, and a persona baked from an older prompt answers
 * as the older prompt. So the fix is an invariant, not a deletion — the stored persona is trusted
 * exactly while a persisted fingerprint of the semantic config (including the transcript revision)
 * still matches, it is marked baked only after a successful vendor upsert, and a project that has
 * no fingerprint yet takes the ephemeral path ONCE and then heals itself in the background.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { bakedStateFor, hashTranscript, verifyStatefulPersona } from '../../../services/avatar/personaFingerprint.js';
import type { AvatarPersonaConfig } from '../../../services/avatar/anamService.js';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const TRANSCRIPT = 'In this lesson we derive the photoelectric equation and explain the Nobel citation.';

const mocks = vi.hoisted(() => {
  const logLines: Array<{ level: string; payload: Record<string, unknown> }> = [];
  const log = (level: string) => (payload: unknown) => {
    if (payload && typeof payload === 'object') logLines.push({ level, payload: payload as Record<string, unknown> });
  };
  return {
    projects: { findFirst: vi.fn() },
    writes: [] as Array<Record<string, unknown>>,
    logLines,
    log,
  };
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
import { resetBurstShield } from '../../../services/usage/avatarBudget.js';
import { pendingPersonaBakes, resetPersonaBakeState } from '../../../services/avatar/personaBake.js';

const SAVED: AvatarPersonaConfig = {
  characterId: 'einstein',
  systemPrompt: 'You are Albert.',
  avatarId: 'av-1',
  voiceId: 'vo-1',
  llmId: 'llm-1',
  avatarName: 'Julia',
  avatarImageUrl: 'https://img/j.png',
};

/** A project whose saved persona was baked from exactly `cfg` + the current transcript. */
function healthyConfig(cfg: AvatarPersonaConfig = SAVED): AvatarPersonaConfig {
  const stored = { ...cfg, transcriptHash: hashTranscript(TRANSCRIPT) };
  return { ...stored, personaId: 'persona-1', personaBaked: bakedStateFor(stored) };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerAvatarRoutes(app);
  await app.ready();
  return app;
}

async function start(config: AvatarPersonaConfig, payload: Record<string, unknown> = { projectId: PROJECT_ID }) {
  mocks.projects.findFirst.mockResolvedValue({ id: PROJECT_ID, visibility: 'public', created_by: 'owner-1', avatar_config: config });
  const app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload });
  await app.close();
  return res;
}

function mintedConfig(): AvatarPersonaConfig {
  return svc.getSessionToken.mock.calls.at(-1)![1] as AvatarPersonaConfig;
}

function startLine() {
  return mocks.logLines.filter((l) => l.payload.evt === 'avatar_start').at(-1)!.payload;
}

/** The avatar_config the background bake persisted, if any. */
function bakedWrite(): AvatarPersonaConfig | undefined {
  const write = mocks.writes.filter((w) => w.avatar_config).at(-1);
  return write?.avatar_config as AvatarPersonaConfig | undefined;
}

describe('POST /avatar/start — the stored persona is used when it still describes the config', () => {
  beforeEach(() => {
    mocks.logLines.length = 0;
    mocks.writes.length = 0;
    vi.clearAllMocks();
    resetBurstShield();
    resetPersonaBakeState();
    svc.avatarProjectAllowedAsync.mockResolvedValue(true);
    svc.resolveAnamKeyForProject.mockResolvedValue('anam_sk_test');
    svc.getProjectTranscript.mockResolvedValue(TRANSCRIPT);
    svc.enrichAvatarConfigFromAnam.mockImplementation(async (cfg: unknown) => cfg);
    svc.getSessionToken.mockResolvedValue({ token: 'tok-1', characterId: 'einstein', voiceSensitivity: 0.5, avatarId: 'av-1' });
    svc.upsertVideoPersona.mockResolvedValue('persona-new');
  });

  it('a healthy fingerprint mints STATEFULLY: the stored personaId survives and no persona body is inlined', async () => {
    const res = await start(healthyConfig());
    expect(res.statusCode).toBe(200);

    const cfg = mintedConfig();
    expect(cfg.personaId).toBe('persona-1');
    // The 29 KB inline body is exactly what the stateful path must NOT carry.
    expect(cfg.knowledge ?? '').not.toContain('VIDEO TRANSCRIPT');
    expect(startLine().path).toBe('stateful');
    expect(startLine().flags).not.toContain('self_heal_queued');

    await pendingPersonaBakes();
    expect(svc.upsertVideoPersona).not.toHaveBeenCalled();
  });

  it('an old project with a personaId but no fingerprint works, takes the ephemeral path ONCE, and heals', async () => {
    const legacy: AvatarPersonaConfig = { ...SAVED, personaId: 'persona-legacy' };
    const res = await start(legacy);
    expect(res.statusCode).toBe(200);

    // This start is ephemeral and the transcript rides inline, so answers stay correct.
    expect(mintedConfig().personaId).toBeUndefined();
    expect(mintedConfig().knowledge).toContain('VIDEO TRANSCRIPT');
    expect(mintedConfig().knowledge).toContain('photoelectric');
    expect(startLine().path).toBe('ephemeral');
    expect(startLine().flags).toContain('fingerprint_absent');
    expect(startLine().flags).toContain('self_heal_queued');

    // …and the background bake makes the NEXT start stateful.
    await pendingPersonaBakes();
    expect(svc.upsertVideoPersona).toHaveBeenCalledTimes(1);
    const healed = bakedWrite()!;
    expect(healed.personaId).toBe('persona-new');
    expect(healed.personaBaked?.transcriptHash).toBe(hashTranscript(TRANSCRIPT));
    expect(verifyStatefulPersona(healed)).toBe('healthy');
  });

  it('the persona the self-heal bakes carries the transcript (a stateful session must still know the video)', async () => {
    await start({ ...SAVED, personaId: 'persona-legacy' });
    await pendingPersonaBakes();
    const bakedCfg = svc.upsertVideoPersona.mock.calls[0][1] as AvatarPersonaConfig;
    expect(bakedCfg.knowledge).toContain('photoelectric');
  });

  it('a prompt edited since the bake invalidates the persona (config_changed → ephemeral + re-bake)', async () => {
    const stale = { ...healthyConfig(), systemPrompt: 'You are someone else entirely.' };
    await start(stale);
    expect(mintedConfig().personaId).toBeUndefined();
    expect(startLine().flags).toContain('fingerprint_miss');
    await pendingPersonaBakes();
    expect(svc.upsertVideoPersona).toHaveBeenCalledTimes(1);
  });

  it('a NEW transcript revision invalidates the persona and the fresh transcript rides inline', async () => {
    const staleTranscript = { ...healthyConfig(), transcriptHash: 'hash-of-an-older-script' };
    svc.getProjectTranscript.mockResolvedValue('A completely new script about black hole thermodynamics.');
    await start(staleTranscript);
    expect(mintedConfig().personaId).toBeUndefined();
    expect(mintedConfig().knowledge).toContain('black hole thermodynamics');
    expect(startLine().flags).toContain('fingerprint_miss');
  });

  it('a bake that the vendor rejects marks NOTHING baked (the invariant is only written on success)', async () => {
    svc.upsertVideoPersona.mockRejectedValue(Object.assign(new Error('Anam persona create failed (400)'), { status: 400 }));
    const res = await start({ ...SAVED, personaId: 'persona-legacy' });
    expect(res.statusCode).toBe(200);            // the viewer still gets a working session
    await pendingPersonaBakes();
    expect(bakedWrite()).toBeUndefined();
  });

  it('two viewers arriving together on a cold project cause at most ONE bake', async () => {
    mocks.projects.findFirst.mockResolvedValue({
      id: PROJECT_ID, visibility: 'public', created_by: 'owner-1',
      avatar_config: { ...SAVED, personaId: 'persona-legacy' },
    });
    const app = await buildApp();
    await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload: { projectId: PROJECT_ID } }),
      app.inject({ method: 'POST', url: '/api/v1/avatar/start', payload: { projectId: PROJECT_ID } }),
    ]);
    await app.close();
    await pendingPersonaBakes();
    expect(svc.upsertVideoPersona).toHaveBeenCalledTimes(1);
  });

  it('a per-request character override neither invalidates the project persona nor re-bakes it', async () => {
    // The popup starts with no character_id, but a reconnect echoes back the character the server
    // resolved. If a request-scoped character could redefine what the project's persona IS, two
    // clients disagreeing would re-bake the persona back and forth forever, and every start would
    // pay the inline-persona price. The project's own config decides what was baked.
    const res = await start(healthyConfig(), { projectId: PROJECT_ID, character_id: 'darwin' });
    expect(res.statusCode).toBe(200);
    expect(mintedConfig().personaId).toBe('persona-1');
    expect(startLine().path).toBe('stateful');
    await pendingPersonaBakes();
    expect(svc.upsertVideoPersona).not.toHaveBeenCalled();
  });

  it('a project with no persona at all still works and is baked for next time', async () => {
    const res = await start({ ...SAVED });
    expect(res.statusCode).toBe(200);
    expect(mintedConfig().knowledge).toContain('VIDEO TRANSCRIPT');
    await pendingPersonaBakes();
    expect(bakedWrite()?.personaId).toBe('persona-new');
  });
});
