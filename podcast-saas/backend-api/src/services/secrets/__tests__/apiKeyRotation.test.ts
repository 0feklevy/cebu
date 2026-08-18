/**
 * Platform API-key rotation against a REAL Postgres engine (PGlite).
 *
 * THE BUG THIS SUITE EXISTS FOR (backend-005)
 * `setSystemKey` was DELETE-then-INSERT with nothing holding the two together. The delete commits
 * on its own, so ANY failure of the insert — an FK that no longer resolves, a lost connection, a
 * pod evicted between the two statements — leaves the platform with NO key for that provider at
 * all. Every LLM/TTS call for every tenant then fails until an admin notices and re-enters a
 * secret nobody has a copy of. Losing the new key is an inconvenience; losing the OLD one is an
 * outage, and a rotation that can only ever downgrade to "no key" is worse than not rotating.
 *
 * The invariant: rotation is ATOMIC. Either the new key replaces the old one, or the old one is
 * still there. There is no window in which the provider has neither.
 *
 * The insert is made to fail here the way production would: `created_by` references users(id), so
 * an admin id that has since been deleted is a real 23503 from a real engine — not a stubbed throw
 * that could pass against code with no transaction at all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../../../db/schema.js';

const h = vi.hoisted(() => ({ dbRef: { current: null as unknown as Record<string, unknown> } }));

vi.mock('../../../db/index.js', () => ({
  db: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      const target = h.dbRef.current;
      const v = target[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ApiKeyService, encryptKey, decryptKey } from '../ApiKeyService.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');

let pg: PGlite;
let adminId: string;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}

/** Every system key row for a provider (user_id IS NULL is what "system" means here). */
const systemKeys = (provider: string): Promise<Array<{ id: string; encrypted_key: string }>> =>
  rows(`SELECT id, encrypted_key FROM api_keys WHERE provider=$1 AND user_id IS NULL ORDER BY created_at`, [provider]);

beforeEach(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  h.dbRef.current = drizzle(pg, { schema }) as unknown as Record<string, unknown>;

  const [admin] = await rows<{ id: string }>(
    `INSERT INTO users (firebase_uid, email) VALUES ('uid-admin', 'admin@test') RETURNING id`);
  adminId = admin!.id;
});

afterEach(async () => { await pg.close(); });

describe('ApiKeyService.setSystemKey — rotation is atomic', () => {
  it('keeps the OLD key when writing the new one fails', async () => {
    const svc = new ApiKeyService();
    await svc.setSystemKey('claude', 'sk-old-live-key', adminId);
    expect(await systemKeys('claude')).toHaveLength(1);

    // A deleted admin — the insert's created_by FK no longer resolves. Real 23503, real engine.
    const goneAdmin = randomUUID();
    await expect(svc.setSystemKey('claude', 'sk-new-key', goneAdmin)).rejects.toThrow();

    const after = await systemKeys('claude');
    expect(after, 'a failed rotation must not leave the platform with no key').toHaveLength(1);
    expect(decryptKey(after[0]!.encrypted_key)).toBe('sk-old-live-key');
  });

  it('a failed rotation does not poison the in-process cache either', async () => {
    const svc = new ApiKeyService();
    await svc.setSystemKey('claude', 'sk-old-live-key', adminId);
    expect(await svc.getSystemKey('claude')).toBe('sk-old-live-key');

    await expect(svc.setSystemKey('claude', 'sk-new-key', randomUUID())).rejects.toThrow();

    // Cache cleared or not, the answer has to be the key that is actually stored.
    expect(await new ApiKeyService().getSystemKey('claude')).toBe('sk-old-live-key');
    expect(await svc.getSystemKey('claude')).toBe('sk-old-live-key');
  });

  it('still replaces the key on the happy path — exactly one row survives', async () => {
    const svc = new ApiKeyService();
    await svc.setSystemKey('claude', 'sk-old-live-key', adminId);
    await svc.setSystemKey('claude', 'sk-new-live-key', adminId);

    const after = await systemKeys('claude');
    expect(after).toHaveLength(1);
    expect(decryptKey(after[0]!.encrypted_key)).toBe('sk-new-live-key');
    expect(await svc.getSystemKey('claude')).toBe('sk-new-live-key');
  });

  it('rotating one provider never touches another provider’s key', async () => {
    const svc = new ApiKeyService();
    await svc.setSystemKey('claude', 'sk-claude', adminId);
    await svc.setSystemKey('openai', 'sk-openai', adminId);

    await expect(svc.setSystemKey('claude', 'sk-claude-2', randomUUID())).rejects.toThrow();

    expect(decryptKey((await systemKeys('claude'))[0]!.encrypted_key)).toBe('sk-claude');
    expect(decryptKey((await systemKeys('openai'))[0]!.encrypted_key)).toBe('sk-openai');
  });

  it('encrypt/decrypt round-trips (the fixture above is not lying about what is stored)', () => {
    expect(decryptKey(encryptKey('sk-round-trip'))).toBe('sk-round-trip');
  });
});
