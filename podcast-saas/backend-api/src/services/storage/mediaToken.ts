// Stateless, expiring media-access tokens (fiji's hasValidArtifactToken pattern,
// security-002). Embedded as a PATH segment (`/hls-public/t/{token}/hls/...`) so
// HLS's relative child-playlist/segment URLs resolve inside the same token prefix
// and the whole ladder is covered by one mint — no player changes needed.
//
// Scope = the first two key segments (`hls/{videoFileId}` or `videos/{projectId}`),
// so one token authorizes exactly one video's media and nothing else.

import { createHmac, timingSafeEqual } from 'crypto';
import { encryptionKeyOrDevFallback } from '../security/encryptionKey.js';

const DAY_SEC = 24 * 60 * 60;
// Minimum validity of a default mint, in days. Media URLs are re-minted per config fetch.
const MIN_TTL_DAYS = 7;

/**
 * The HMAC secret. Delegated to `encryptionKeyOrDevFallback` so a present-but-misconfigured
 * ENCRYPTION_KEY THROWS here instead of silently decoding to a truncated or empty key —
 * `Buffer.from('not-hex', 'hex')` is a zero-length buffer and `createHmac` signs happily with
 * it, which meant a mistyped key produced media tokens anyone could forge (security-004).
 * Absent (dev) still derives the documented fallback.
 */
function getMediaSecret(): Buffer {
  return encryptionKeyOrDevFallback('podcast-saas-media-salt');
}

/** The token scope for a storage key: its first two path segments, or null if unsupported. */
export function mediaKeyScope(key: string): string | null {
  const parts = key.split('/');
  if (parts.length < 2) return null;
  // `exports/{projectId}` — linear-export masters (migration 058): the download link is a plain
  // <a> navigation, which cannot carry an Authorization header, so the local adapter needs the
  // same scoped-token URL shape the video routes use. Cloud adapters presign instead.
  if (parts[0] !== 'hls' && parts[0] !== 'videos' && parts[0] !== 'exports') return null;
  if (!parts[1]) return null;
  return `${parts[0]}/${parts[1]}`;
}

function sign(scope: string, exp: number): string {
  return createHmac('sha256', getMediaSecret()).update(`${scope}.${exp}`).digest('hex').slice(0, 32);
}

/**
 * Mint a URL-safe token authorizing `scope`.
 *
 * DEFAULT MINTS ARE DAY-QUANTIZED FOR CACHE-KEY STABILITY. The token is embedded in every
 * media URL, and the player config re-mints on every fetch — with a second-granularity
 * `exp = now + 7d`, every fetch produced a DIFFERENT URL for the same immutable bytes, so
 * browser/CDN caches missed on 100% of re-fetches. Quantizing `exp` to a UTC-day boundary
 * (`(floor(now/86400) + 8) * 86400`) makes every default mint within one UTC day for one
 * scope string-identical, while validity always stays in [7d, 8d]. Verification is
 * unchanged — it only checks `exp > now` plus the HMAC — so fine-grained tokens minted
 * before this change keep verifying until they expire.
 *
 * An explicit `ttlSec` keeps the exact fine-grained behaviour (`exp = now + ttlSec`);
 * tests use it to fabricate expired/short-lived tokens.
 */
export function mintMediaToken(scope: string, ttlSec?: number): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = ttlSec === undefined
    ? (Math.floor(nowSec / DAY_SEC) + MIN_TTL_DAYS + 1) * DAY_SEC
    : nowSec + ttlSec;
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
