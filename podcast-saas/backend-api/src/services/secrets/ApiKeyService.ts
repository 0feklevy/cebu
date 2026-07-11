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

export class ApiKeyService {
  private cache: Map<string, { value: string; expiresAt: number }> = new Map();

  async getSystemKey(provider: 'claude' | 'openai' | 'gemini' | 'elevenlabs'): Promise<string | null> {
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
    provider: 'claude' | 'openai' | 'gemini' | 'elevenlabs',
    plainKey: string,
    createdBy: string,
  ): Promise<void> {
    const encrypted = encryptKey(plainKey);

    // Upsert: delete old then insert
    await db.delete(api_keys).where(
      and(eq(api_keys.provider, provider), isNull(api_keys.user_id)),
    );
    await db.insert(api_keys).values({
      provider,
      encrypted_key: encrypted,
      created_by: createdBy,
    });

    // Invalidate cache
    this.cache.delete(`system:${provider}`);
  }

  async removeSystemKey(provider: 'claude' | 'openai' | 'gemini' | 'elevenlabs'): Promise<void> {
    await db.delete(api_keys).where(
      and(eq(api_keys.provider, provider), isNull(api_keys.user_id)),
    );
    this.cache.delete(`system:${provider}`);
  }

  async getKeyStatus(): Promise<
    Array<{
      provider: 'claude' | 'openai' | 'gemini' | 'elevenlabs';
      is_set: boolean;
      created_at: Date | null;
      created_by: string | null;
    }>
  > {
    const rows = await db.query.api_keys.findMany({
      where: isNull(api_keys.user_id),
    });

    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    const providers: Array<'claude' | 'openai' | 'gemini' | 'elevenlabs'> = ['claude', 'openai', 'gemini', 'elevenlabs'];

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
