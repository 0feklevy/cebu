/**
 * resolveAnamKeyForProject re-read the `projects` row to learn the owner — a second query for a
 * row the /avatar/start handler had ALREADY loaded (it needs avatar_config, visibility and
 * created_by to authorize). One redundant round-trip to the database on every single start.
 *
 * The caller can hand over the owner it already has; the read stays for callers that cannot.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  byok: { enabled: true },
  projectFindFirst: vi.fn(async () => ({ created_by: 'owner-1' })),
  userFindFirst: vi.fn(async () => ({ anam_api_key_encrypted: 'encrypted-blob' })),
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    select: () => ({ from: () => ({ limit: async () => [{ byok: mocks.byok.enabled }] }) }),
    query: {
      projects: { findFirst: mocks.projectFindFirst },
      users: { findFirst: mocks.userFindFirst },
    },
  },
}));
vi.mock('../../../db/schema.js', () => ({ projects: Symbol('projects'), users: Symbol('users'), admin_settings: Symbol('admin_settings') }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));
vi.mock('../../secrets/ApiKeyService.js', () => ({ decryptKey: vi.fn(() => 'anam_sk_decrypted'), ApiKeyService: class { async getSystemKey() { return null; } } }));

import { resolveAnamKeyForProject } from '../anamKey.js';

describe('resolveAnamKeyForProject — no duplicate projects query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.byok.enabled = true;
    mocks.projectFindFirst.mockResolvedValue({ created_by: 'owner-1' });
    mocks.userFindFirst.mockResolvedValue({ anam_api_key_encrypted: 'encrypted-blob' });
  });

  it('uses the owner the caller already loaded instead of re-reading the project', async () => {
    await expect(resolveAnamKeyForProject('project-1', 'owner-1')).resolves.toBe('anam_sk_decrypted');
    expect(mocks.projectFindFirst).not.toHaveBeenCalled();
    expect(mocks.userFindFirst).toHaveBeenCalledTimes(1);
  });

  it('still reads the project when the caller has no owner to give', async () => {
    await expect(resolveAnamKeyForProject('project-1')).resolves.toBe('anam_sk_decrypted');
    expect(mocks.projectFindFirst).toHaveBeenCalledTimes(1);
  });

  it('short-circuits before any owner lookup when BYOK is off', async () => {
    mocks.byok.enabled = false;
    await expect(resolveAnamKeyForProject('project-1', 'owner-1')).resolves.toBeUndefined();
    expect(mocks.projectFindFirst).not.toHaveBeenCalled();
    expect(mocks.userFindFirst).not.toHaveBeenCalled();
  });
});
