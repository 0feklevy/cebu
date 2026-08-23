/**
 * WHICH Anam key a mint uses — the question at the centre of the 2026-08-23 outage.
 *
 * The admin screen stored keys for four vendors and the avatar was not one of them, so the one
 * screen that looks like the source of truth silently was not: rotating the key there fixed
 * nothing while the avatar kept minting with the container's env var. The order under test:
 *
 *   owner BYOK (admin-enabled)  →  Admin → API Keys platform key  →  undefined (env, downstream)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  settingsRow: { byok: false } as { byok: boolean } | undefined,
  ownerRow: undefined as { anam_api_key_encrypted: string | null } | undefined,
  systemKey: null as string | null,
  systemKeyThrows: false,
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    select: () => ({ from: () => ({ limit: async () => [mocks.settingsRow] }) }),
    query: {
      projects: { findFirst: async () => ({ created_by: 'owner-1' }) },
      users: { findFirst: async () => mocks.ownerRow },
    },
  },
}));
vi.mock('../../../db/schema.js', () => ({
  admin_settings: { avatar_byok_enabled: Symbol('byok') }, projects: {}, users: {},
}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn(), isNull: vi.fn() }));
vi.mock('../../secrets/ApiKeyService.js', () => ({
  ApiKeyService: class {
    async getSystemKey(provider: string) {
      if (mocks.systemKeyThrows) throw new Error('keystore down');
      return provider === 'anam' ? mocks.systemKey : null;
    }
  },
  decryptKey: (v: string) => {
    if (v === 'enc-broken') throw new Error('bad ciphertext');
    return v.replace(/^enc-/, '');
  },
}));

import { resolveAnamKeyForProject, resolveSystemAnamKey } from '../anamKey.js';

beforeEach(() => {
  mocks.settingsRow = { byok: false };
  mocks.ownerRow = undefined;
  mocks.systemKey = null;
  mocks.systemKeyThrows = false;
});

describe('the resolution order', () => {
  it('BYOK owner key wins over everything when the admin enabled it', async () => {
    mocks.settingsRow = { byok: true };
    mocks.ownerRow = { anam_api_key_encrypted: 'enc-owner-key' };
    mocks.systemKey = 'admin-key';
    expect(await resolveAnamKeyForProject('p-1')).toBe('owner-key');
  });

  it('falls to the ADMIN platform key when BYOK is off — the outage fix', async () => {
    // The single behaviour that did not exist on 2026-08-23: an admin rotating the key in the
    // screen built for exactly that now actually changes what the avatar mints with.
    mocks.systemKey = 'admin-key';
    expect(await resolveAnamKeyForProject('p-1')).toBe('admin-key');
  });

  it('falls to the admin key when BYOK is ON but the owner never set one', async () => {
    mocks.settingsRow = { byok: true };
    mocks.ownerRow = { anam_api_key_encrypted: null };
    mocks.systemKey = 'admin-key';
    expect(await resolveAnamKeyForProject('p-1')).toBe('admin-key');
  });

  it('a BYOK key that fails to DECRYPT falls through rather than failing the start', async () => {
    mocks.settingsRow = { byok: true };
    mocks.ownerRow = { anam_api_key_encrypted: 'enc-broken' };
    mocks.systemKey = 'admin-key';
    expect(await resolveAnamKeyForProject('p-1')).toBe('admin-key');
  });

  it('answers undefined when nothing is stored anywhere — the env var stays the last fallback', async () => {
    expect(await resolveAnamKeyForProject('p-1')).toBeUndefined();
  });

  it('serves the admin key with NO project too — the project-less start path', async () => {
    // Without this, one rotation fixes every project video and not the global popup.
    mocks.systemKey = 'admin-key';
    expect(await resolveSystemAnamKey()).toBe('admin-key');
  });

  it('a broken keystore degrades to the env fallback, never to a thrown start', async () => {
    mocks.systemKeyThrows = true;
    expect(await resolveAnamKeyForProject('p-1')).toBeUndefined();
    expect(await resolveSystemAnamKey()).toBeUndefined();
  });
});
