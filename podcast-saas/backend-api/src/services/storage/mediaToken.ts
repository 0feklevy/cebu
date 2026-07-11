// Stateless, expiring media-access tokens (fiji's hasValidArtifactToken pattern,
// security-002). Embedded as a PATH segment (`/hls-public/t/{token}/hls/...`) so
// HLS's relative child-playlist/segment URLs resolve inside the same token prefix
// and the whole ladder is covered by one mint — no player changes needed.
//
// Scope = the first two key segments (`hls/{videoFileId}` or `videos/{projectId}`),
// so one token authorizes exactly one video's media and nothing else.

import { createHmac, timingSafeEqual, scryptSync } from 'crypto';

const DEFAULT_TTL_SEC = 7 * 24 * 60 * 60; // 7 days — media URLs are re-minted per config fetch

function getMediaSecret(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (hex) return Buffer.from(hex, 'hex');
  // Dev fallback (mirrors ApiKeyService) — set ENCRYPTION_KEY in prod.
  return scryptSync('dev-secret-change-in-prod', 'podcast-saas-media-salt', 32);
}

/** The token scope for a storage key: its first two path segments, or null if unsupported. */
export function mediaKeyScope(key: string): string | null {
  const parts = key.split('/');
  if (parts.length < 2) return null;
  if (parts[0] !== 'hls' && parts[0] !== 'videos') return null;
  if (!parts[1]) return null;
  return `${parts[0]}/${parts[1]}`;
}

function sign(scope: string, exp: number): string {
  return createHmac('sha256', getMediaSecret()).update(`${scope}.${exp}`).digest('hex').slice(0, 32);
}

/** Mint a URL-safe token authorizing `scope` until now+ttl. */
export function mintMediaToken(scope: string, ttlSec = DEFAULT_TTL_SEC): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${exp}-${sign(scope, exp)}`;
}

/** Verify a token minted for `scope`. False on expiry, malformed input, or bad signature. */
export function verifyMediaToken(scope: string, token: string): boolean {
  const dash = token.indexOf('-');
  if (dash <= 0) return false;
  const exp = Number(token.slice(0, dash));
  const sig = token.slice(dash + 1);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = sign(scope, exp);
  if (sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Split an optional leading `t/{token}/` segment off a wildcard media path.
 * `/hls-public/t/abc/hls/vf/run/master.m3u8` → { key: 'hls/vf/run/master.m3u8', token: 'abc' }.
 */
export function splitMediaTokenPrefix(raw: string): { key: string; token: string | null } {
  if (raw.startsWith('t/')) {
    const idx = raw.indexOf('/', 2);
    if (idx > 2) return { key: raw.slice(idx + 1), token: raw.slice(2, idx) };
  }
  return { key: raw, token: null };
}
