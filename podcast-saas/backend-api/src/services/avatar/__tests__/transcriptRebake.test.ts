/**
 * Transcript propagation ↔ the persona invariant (subject: services/transcriptPropagation.ts).
 *
 * When captions become ready the avatar's knowledge changes, which means the saved Anam persona is
 * now describing an older video. Two things must therefore happen, and neither did:
 *
 *  1. The new transcript REVISION is recorded on avatar_config first, before any vendor call. Even
 *     if every Anam call then fails, /avatar/start can see that the baked persona predates this
 *     script and will inline the fresh transcript instead of confidently answering from a stale one.
 *
 *  2. The persona is re-baked. The old condition required `avatarId && voiceId` to be present in
 *     the config, so every video that INHERITS its avatar/voice from the base character persona
 *     (i.e. the user never opened the avatar picker) silently skipped the re-bake and its persona
 *     stayed stale forever. upsertVideoPersona resolves those inherited values itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hashTranscript, verifyStatefulPersona } from '../personaFingerprint.js';
import type { AvatarPersonaConfig } from '../anamService.js';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const VTT = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nToday we derive the photoelectric equation and its Nobel citation.\n';
const TRANSCRIPT = 'Today we derive the photoelectric equation and its Nobel citation.';

const mocks = vi.hoisted(() => ({
  projectRow: { current: null as Record<string, unknown> | null },
  writes: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      projects: { findFirst: vi.fn(async () => mocks.projectRow.current) },
      video_files: { findMany: vi.fn(async () => []) },
    },
    update: () => ({
      set: (v: Record<string, unknown>) => {
        mocks.writes.push(v);
        if (v.avatar_config && mocks.projectRow.current) mocks.projectRow.current.avatar_config = v.avatar_config;
        return { where: async () => undefined };
      },
    }),
  },
}));
vi.mock('../../../db/schema.js', () => ({ projects: Symbol('projects'), video_files: Symbol('video_files') }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn(), or: vi.fn(), isNull: vi.fn() }));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../llm/systemAi.js', () => ({
  getOpenAIClient: vi.fn(async () => null),
  isGenerationPaused: vi.fn(async () => true),   // keep the SEO sink inert
  recordChatUsage: vi.fn(async () => {}),
}));

const anam = vi.hoisted(() => ({
  ensureKnowledgeGroup: vi.fn(async () => 'grp-1'),
  ensureKnowledgeTool: vi.fn(async () => 'tool-rag-1'),
  uploadKnowledgeDocument: vi.fn(async () => ({ id: 'doc-1' })),
  deleteKnowledgeDocument: vi.fn(async () => true),
  upsertVideoPersona: vi.fn(async () => 'persona-rebaked'),
  resolveAnamKeyForProject: vi.fn(async () => 'anam_sk_test'),
}));
vi.mock('../anamService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../anamService.js')>();
  return { ...actual, ...anam };
});
vi.mock('../anamKey.js', () => ({ resolveAnamKeyForProject: anam.resolveAnamKeyForProject }));

import { propagateTranscript } from '../../transcriptPropagation.js';

function savedConfig(): AvatarPersonaConfig | undefined {
  return mocks.writes.filter((w) => w.avatar_config).at(-1)?.avatar_config as AvatarPersonaConfig | undefined;
}

function run(config: AvatarPersonaConfig): void {
  mocks.projectRow.current = { id: PROJECT_ID, title: 'Lesson 1', topic: 'x', created_by: 'owner-1', avatar_config: config };
  propagateTranscript({ id: 'video-1', project_id: PROJECT_ID, is_broll: false }, VTT);
}

describe('transcript propagation — the persona follows the script', () => {
  beforeEach(() => {
    mocks.writes.length = 0;
    vi.clearAllMocks();
    anam.ensureKnowledgeGroup.mockResolvedValue('grp-1');
    anam.ensureKnowledgeTool.mockResolvedValue('tool-rag-1');
    anam.uploadKnowledgeDocument.mockResolvedValue({ id: 'doc-1' });
    anam.upsertVideoPersona.mockResolvedValue('persona-rebaked');
    anam.resolveAnamKeyForProject.mockResolvedValue('anam_sk_test');
  });

  it('re-bakes a persona whose avatar and voice are INHERITED (nothing pinned in the config)', async () => {
    run({ characterId: 'einstein', personaId: 'persona-1' });
    await vi.waitFor(() => expect(anam.upsertVideoPersona).toHaveBeenCalledTimes(1));
    expect(anam.upsertVideoPersona.mock.calls[0][3]).toBe('persona-1');   // updates in place
  });

  it('the re-baked persona carries the new transcript', async () => {
    run({ characterId: 'einstein', personaId: 'persona-1', avatarId: 'av-1', voiceId: 'vo-1' });
    await vi.waitFor(() => expect(anam.upsertVideoPersona).toHaveBeenCalledTimes(1));
    const baked = anam.upsertVideoPersona.mock.calls[0][1] as AvatarPersonaConfig;
    expect(baked.knowledge).toContain('photoelectric');
  });

  it('records the fingerprint so the next start takes the one-round-trip stateful path', async () => {
    run({ characterId: 'einstein', personaId: 'persona-1', avatarId: 'av-1', voiceId: 'vo-1' });
    await vi.waitFor(() => expect(savedConfig()?.personaBaked).toBeDefined());
    const cfg = savedConfig()!;
    expect(cfg.personaId).toBe('persona-rebaked');
    expect(cfg.transcriptHash).toBe(hashTranscript(TRANSCRIPT));
    expect(cfg.personaBaked?.transcriptHash).toBe(hashTranscript(TRANSCRIPT));
    expect(verifyStatefulPersona(cfg)).toBe('healthy');
  });

  it('records the new transcript revision even when the vendor knowledge upload fails', async () => {
    anam.ensureKnowledgeGroup.mockRejectedValue(new Error('anam down'));
    run({ characterId: 'einstein', personaId: 'persona-1', avatarId: 'av-1', voiceId: 'vo-1' });
    // The revision is recorded up front, so start sees "the persona predates this script".
    await vi.waitFor(() => expect(savedConfig()?.transcriptHash).toBe(hashTranscript(TRANSCRIPT)));
    const cfg = savedConfig()!;
    expect(verifyStatefulPersona(cfg)).not.toBe('healthy');
  });

  it('a failed re-bake records no baked state (the persona is never claimed to be current)', async () => {
    anam.upsertVideoPersona.mockRejectedValue(Object.assign(new Error('Anam persona update failed (500)'), { status: 500 }));
    run({ characterId: 'einstein', personaId: 'persona-1', avatarId: 'av-1', voiceId: 'vo-1' });
    await vi.waitFor(() => expect(anam.upsertVideoPersona).toHaveBeenCalled());
    await vi.waitFor(() => expect(savedConfig()?.knowledgeToolId).toBe('tool-rag-1'));
    expect(savedConfig()?.personaBaked).toBeUndefined();
  });

  it('a project with no persona yet is left for the start path to bake', async () => {
    run({ characterId: 'einstein' });
    await vi.waitFor(() => expect(savedConfig()?.transcriptHash).toBe(hashTranscript(TRANSCRIPT)));
    expect(anam.upsertVideoPersona).not.toHaveBeenCalled();
  });
});
