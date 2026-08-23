import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { db } from '../../db/index.js';
import { api_keys } from '../../db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (hex) return Buffer.from(hex, 'hex');
  // Fallback: derive from a fixed salt (dev only — set ENCRYPTION_KEY in prod)
  return scryptSync('dev-secret-change-in-prod', 'podcast-saas-salt', 32);
}

export function encryptKey(plaintext: string): string {
  const iv = randomBytes(12);
  const key = getEncryptionKey();
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptKey(ciphertext: string): string {
  const [ivHex, tagHex, encHex] = ciphertext.split(':');
  if (!ivHex || !tagHex || !encHex) throw new Error('Invalid ciphertext format');
  const key = getEncryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(encHex, 'hex')).toString('utf8') + decipher.final('utf8');
}

// Decrypted keys are cached with a TTL, not forever: ApiKeyService is instantiated
// per call-site, so an admin rotating a key through one instance can't invalidate the
// others — the TTL bounds how long any instance keeps serving the old key.
const CACHE_TTL_MS = 5 * 60_000;

/**
 * The vendors whose PLATFORM key can be set from Admin → API Keys.
 *
 * 'anam' joined on 2026-08-23, during the avatar outage: every other vendor read the admin-stored
 * key first with the env var as fallback, while the avatar path read ONLY the env var — so an
 * owner who rotated the Anam key in the admin screen changed nothing, and the avatar kept minting
 * with whatever the container was started with. An admin screen that LOOKS like the source of
 * truth and silently is not is worse than no screen.
 */
export type SystemKeyProvider = 'claude' | 'openai' | 'gemini' | 'elevenlabs' | 'anam';

export class ApiKeyService {
  private cache: Map<string, { value: string; expiresAt: number }> = new Map();

  async getSystemKey(provider: SystemKeyProvider): Promise<string | null> {
    const cacheKey = `system:${provider}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const row = await db.query.api_keys.findFirst({
      where: and(eq(api_keys.provider, provider), isNull(api_keys.user_id)),
    });

    if (!row) return null;

    try {
      const decrypted = decryptKey(row.encrypted_key);
      this.cache.set(cacheKey, { value: decrypted, expiresAt: Date.now() + CACHE_TTL_MS });
      return decrypted;
    } catch (err) {
      logger.error({ err, provider }, 'Failed to decrypt API key');
      return null;
    }
  }

  /** Drop all cached keys (e.g. after an admin rotation in this process). */
  invalidateCache(): void {
    this.cache.clear();
  }

  async setSystemKey(
    provider: SystemKeyProvider,
    plainKey: string,
    createdBy: string,
  ): Promise<void> {
    const encrypted = encryptKey(plainKey);

    // ONE TRANSACTION, because the two statements are one fact.
    //
    // This used to be a bare DELETE followed by a bare INSERT. The delete committed on its own, so
    // anything that stopped the insert — a `created_by` FK that no longer resolves, a dropped
    // connection, a pod evicted between the two — left the platform with NO key for this provider
    // and every tenant's calls failing, with no copy of the secret anywhere to restore from.
    // Losing the NEW key is an inconvenience; losing the OLD one is an outage, so the only
    // acceptable outcomes are "replaced" and "unchanged".
    //
    // Deliberately NOT an ON CONFLICT upsert: `api_keys` has no unique key on
    // (provider, user_id IS NULL) to conflict against, and adding one would have to reckon with
    // rows this table has accumulated since migration 001. Delete-then-insert inside a
    // transaction needs no schema change and gives the same guarantee.
    await db.transaction(async (tx) => {
      await tx.delete(api_keys).where(
        and(eq(api_keys.provider, provider), isNull(api_keys.user_id)),
      );
      await tx.insert(api_keys).values({
        provider,
        encrypted_key: encrypted,
        created_by: createdBy,
      });
    });

    // Only AFTER the commit. Dropping the cache entry before the write is durable would publish a
    // rotation that never happened: the next reader would re-load from the DB and, on a rollback,
    // re-cache the OLD key — harmless — but on a partial write would cache nothing at all.
    this.cache.delete(`system:${provider}`);
  }

  async removeSystemKey(provider: SystemKeyProvider): Promise<void> {
    await db.delete(api_keys).where(
      and(eq(api_keys.provider, provider), isNull(api_keys.user_id)),
    );
    this.cache.delete(`system:${provider}`);
  }

  async getKeyStatus(): Promise<
    Array<{
      provider: SystemKeyProvider;
      is_set: boolean;
      created_at: Date | null;
      created_by: string | null;
    }>
  > {
    const rows = await db.query.api_keys.findMany({
      where: isNull(api_keys.user_id),
    });

    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    const providers: SystemKeyProvider[] = ['claude', 'openai', 'gemini', 'elevenlabs', 'anam'];

    return providers.map((p) => {
      const row = byProvider.get(p);
      return {
        provider: p,
        is_set: !!row,
        created_at: row?.created_at ?? null,
        created_by: row?.created_by ?? null,
      };
    });
  }
}
