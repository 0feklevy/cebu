import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Server-issued capability token for the avatar conversation-memory endpoints.
 *
 * Minted by the (visibility-gated) memory GET and required by the memory POST, so writes
 * can't be made on a trusted-only client `sessionKey` (review security-004/005). The token
 * binds {projectKey, sessionKey} and expires, so it authorizes exactly one session on one
 * project and can't be reused elsewhere. HMAC-SHA256 — no DB lookup to verify (stateless,
 * cluster-safe).
 */
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h — re-minted whenever the memory GET runs

/**
 * HMAC key: a dedicated AVATAR_MEMORY_SECRET if configured, else derived from DATABASE_URL
 * (always present, shared by every instance, high-entropy) so tokens verify across a
 * horizontally-scaled cluster without a new required env var.
 */
function resolveSecret(): string {
  return process.env.AVATAR_MEMORY_SECRET || process.env.DATABASE_URL || 'insecure-dev-only-secret';
}

export interface MemoryTokenPayload {
  p: string; // projectKey (project id, or 'global' for the no-project avatar)
  s: string; // sessionKey
  e: number; // expiry (epoch ms)
}

export function signMemoryTokenWith(secret: string, projectKey: string, sessionKey: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ p: projectKey, s: sessionKey, e: now + TOKEN_TTL_MS })).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyMemoryTokenWith(secret: string, token: string | undefined | null, now = Date.now()): MemoryTokenPayload | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as MemoryTokenPayload;
    if (typeof payload.p !== 'string' || typeof payload.s !== 'string' || typeof payload.e !== 'number') return null;
    if (payload.e < now) return null; // expired
    return payload;
  } catch {
    return null;
  }
}

export const signMemoryToken = (projectKey: string, sessionKey: string): string =>
  signMemoryTokenWith(resolveSecret(), projectKey, sessionKey);

export const verifyMemoryToken = (token: string | undefined | null): MemoryTokenPayload | null =>
  verifyMemoryTokenWith(resolveSecret(), token);
