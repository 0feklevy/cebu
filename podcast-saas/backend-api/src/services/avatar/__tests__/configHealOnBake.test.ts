/**
 * B1 from the #127 adversarial review: a poisoned avatar_config row must HEAL, not merely be
 * tolerated. `patchAvatarConfig` persists its merge — so sanitizing its read repairs the row
 * durably the first time any patch lands. Left raw, a poisoned row re-failed the bake every five
 * minutes forever and pinned every viewer to the slow ephemeral mint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  row: { avatar_config: {} as Record<string, unknown> | null },
  written: null as Record<string, unknown> | null,
}));
vi.mock('../../../db/index.js', () => ({
  db: {
    query: { projects: { findFirst: async () => dbMock.row } },
    update: () => ({ set: (v: { avatar_config: Record<string, unknown> }) => { dbMock.written = v.avatar_config; return { where: async () => undefined }; } }),
  },
}));
vi.mock('../../../db/schema.js', () => ({ projects: {} }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { patchAvatarConfig } from '../personaBake.js';

beforeEach(() => { dbMock.written = null; });

describe('patchAvatarConfig heals stored poison', () => {
  it('a wrong-typed stored field is REPAIRED by the next unrelated patch', async () => {
    dbMock.row.avatar_config = { systemPrompt: 123, avatarId: 'real-avatar', knowledge: { nested: 1 } };

    const merged = await patchAvatarConfig('proj-1', { voiceId: 'v-9' });

    expect(merged).toEqual({ avatarId: 'real-avatar', voiceId: 'v-9' });
    // And the WRITE carries the healed shape — the poison is gone from the row, not just from
    // this call's return value.
    expect(dbMock.written).toEqual({ avatarId: 'real-avatar', voiceId: 'v-9' });
  });

  it('a clean row round-trips byte-identical (no re-bake storm)', async () => {
    dbMock.row.avatar_config = { avatarId: 'a-1', voiceSensitivity: 0.4 };
    const merged = await patchAvatarConfig('proj-1', { greeting: 'hi' });
    expect(merged).toEqual({ avatarId: 'a-1', voiceSensitivity: 0.4, greeting: 'hi' });
  });
});
