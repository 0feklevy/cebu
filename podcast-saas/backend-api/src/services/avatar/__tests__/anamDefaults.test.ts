/**
 * Admin-first Anam defaults (077): the admin_settings row wins, env is the fallback, and a broken
 * read NEVER takes the start path down.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  row: null as Record<string, string | null> | null,
  throws: false,
}));
vi.mock('../../../db/index.js', () => ({
  db: { select: () => ({ from: () => ({ limit: async () => { if (dbMock.throws) throw new Error('db down'); return dbMock.row ? [dbMock.row] : []; } }) }) },
}));
vi.mock('../../../db/schema.js', () => ({ admin_settings: { avatar_default_avatar_id: 1, avatar_default_voice_id: 2, avatar_default_llm_id: 3 } }));

import { resolveAnamDefaults, invalidateAnamDefaultsCache } from '../anamDefaults.js';
import { ANAM_ENV } from '../anamService.js';

const savedEnv = { ...ANAM_ENV };
beforeEach(() => {
  Object.assign(ANAM_ENV, savedEnv);
  ANAM_ENV.ANAM_AVATAR_ID = 'env-av';
  ANAM_ENV.ANAM_VOICE_ID = 'env-vo';
  ANAM_ENV.ANAM_LLM_ID = 'env-llm';
  dbMock.row = null; dbMock.throws = false;
  invalidateAnamDefaultsCache();
});

describe('resolution order', () => {
  it('the admin row wins over env', async () => {
    dbMock.row = { avatar_default_avatar_id: 'admin-av', avatar_default_voice_id: 'admin-vo', avatar_default_llm_id: 'admin-llm' };
    expect(await resolveAnamDefaults()).toEqual({ avatarId: 'admin-av', voiceId: 'admin-vo', llmId: 'admin-llm' });
  });

  it('an EMPTY admin field falls to env per-field, not wholesale', async () => {
    dbMock.row = { avatar_default_avatar_id: 'admin-av', avatar_default_voice_id: null, avatar_default_llm_id: '' };
    expect(await resolveAnamDefaults()).toEqual({ avatarId: 'admin-av', voiceId: 'env-vo', llmId: 'env-llm' });
  });

  it('a broken read degrades to env — never throws into the start path', async () => {
    dbMock.throws = true;
    expect(await resolveAnamDefaults()).toEqual({ avatarId: 'env-av', voiceId: 'env-vo', llmId: 'env-llm' });
  });

  it('caches briefly and the seam clears it', async () => {
    dbMock.row = { avatar_default_avatar_id: 'admin-av', avatar_default_voice_id: 'v', avatar_default_llm_id: 'l' };
    await resolveAnamDefaults();
    dbMock.row = { avatar_default_avatar_id: 'changed', avatar_default_voice_id: 'v', avatar_default_llm_id: 'l' };
    expect((await resolveAnamDefaults()).avatarId).toBe('admin-av');   // cached
    invalidateAnamDefaultsCache();
    expect((await resolveAnamDefaults()).avatarId).toBe('changed');    // seam cleared it
  });
});
