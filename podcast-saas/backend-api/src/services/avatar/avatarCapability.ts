import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

/**
 * Short-lived capability for the BILLABLE avatar endpoints (`/avatar/start`,
 * `/avatar/visual/analyze`, `/avatar/image/analyze`).
 *
 * ── WHY THIS EXISTS AND WHY IT IS NOT THE SHARE TOKEN ──────────────────────────────────────
 *
 * The three routes above mint a vendor session or run gpt-image-1 for anyone who can POST. The
 * only bound was an in-process per-IP counter (per replica, reset on deploy). Requiring Firebase
 * auth is not the fix: anonymous avatar use is intentional (public/shared viewers expose Ask
 * Avatar and guests sign in anonymously), so a disposable anonymous account passes any such check.
 *
 * The question asked before this file was written was whether the EXISTING share/session token
 * could carry an avatar scope instead. It cannot, and the evidence is in the three canonical
 * viewer entry points:
 *
 *   • GET /api/v1/projects/:id/player-config  — a PUBLIC project reached by UUID. The viewer holds
 *     no token of any kind; `requireProjectAccess` admits it on `visibility === 'public'` alone.
 *   • GET /api/v1/public/permalink/:slug/config — a slug. Again no token.
 *   • GET /api/v1/share/:shareToken            — the ONLY path where the viewer holds a token.
 *
 * So on two of the three paths there is no existing credential to scope, which settles it. And on
 * the third, `projects.share_token` is the wrong thing to reuse anyway: it is a permanent
 * project-level bearer secret (migration 016) with no expiry, no per-session identity and no
 * revocation short of rotating the share link itself. Scoping it would make avatar SPEND authority
 * as long-lived as the share link and would make "stop this abuser" mean "break the link for every
 * legitimate viewer".
 *
 * What this file therefore does is NOT invent a new credential mechanism — it reuses the one the
 * avatar surface already has. `memoryToken.ts` is the same construction (stateless HMAC over a
 * base64url body, minted behind the visibility gate, verified with no DB round-trip so it is
 * cluster-safe). This module is that mechanism with the two properties a spend capability needs
 * and a memory token does not: a per-mint nonce (`jti`) so the limiter can meter one popup open
 * rather than one project, and a short TTL.
 *
 * ── DOMAIN SEPARATION ─────────────────────────────────────────────────────────────────────
 * Both token types can resolve to the SAME secret (both fall back to DATABASE_URL). The MAC here
 * therefore covers a domain tag that the memory token's MAC does not, so a memory token can never
 * be replayed as a spend capability even when the secrets are identical. avatarCapability.test.ts
 * asserts that in both directions; without the tag, a plausible "just reuse signMemoryToken"
 * implementation would pass every other test in this file.
 */

/** Included in the MAC input, never in the body. Bump on any breaking payload change. */
const DOMAIN = 'flowvid.avatar-capability.v1';

const DEFAULT_TTL_SEC = 30 * 60;
const MIN_TTL_SEC = 60;
const MAX_TTL_SEC = 60 * 60;

/**
 * HMAC key, mirroring memoryToken.ts: a dedicated secret when configured, else the memory secret,
 * else DATABASE_URL (always present, shared by every replica, high entropy) so a horizontally
 * scaled cluster verifies without a new required env var.
 */
function resolveSecret(): string {
  return process.env.AVATAR_CAPABILITY_SECRET
    || process.env.AVATAR_MEMORY_SECRET
    || process.env.DATABASE_URL
    || 'insecure-dev-only-secret';
}

export function capabilityTtlSec(): number {
  const raw = Number(process.env.AVATAR_CAPABILITY_TTL_SEC);
  if (!Number.isFinite(raw)) return DEFAULT_TTL_SEC;
  return Math.min(MAX_TTL_SEC, Math.max(MIN_TTL_SEC, Math.floor(raw)));
}

export interface AvatarCapabilityPayload {
  /** Payload version. */
  v: 1;
  /** The project this capability authorizes spend against — and only this one. */
  p: string;
  /** Nonce / jti: identifies ONE mint, so the meter can bill a popup open rather than a project. */
  j: string;
  /** Firebase-backed user id at mint time, or null for a fully anonymous viewer. Advisory only. */
  u: string | null;
  /** Expiry, epoch ms. */
  e: number;
}

export interface MintedCapability {
  token: string;
  jti: string;
  expiresAt: number;
}

function mac(secret: string, body: string): string {
  return createHmac('sha256', secret).update(`${DOMAIN}.${body}`).digest('base64url');
}

export function signAvatarCapabilityWith(
  secret: string,
  input: { projectId: string; uid?: string | null; ttlSec?: number; jti?: string; now?: number },
): MintedCapability {
  const now = input.now ?? Date.now();
  const jti = input.jti ?? randomUUID();
  const expiresAt = now + (input.ttlSec ?? capabilityTtlSec()) * 1000;
  const payload: AvatarCapabilityPayload = { v: 1, p: input.projectId, j: jti, u: input.uid ?? null, e: expiresAt };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${body}.${mac(secret, body)}`, jti, expiresAt };
}

/**
 * Verify a capability. `projectId`, when given, is REQUIRED to match the bound project — a
 * capability minted for a project the caller may view must not authorize spend that reaches a
 * different project's library.
 */
export function verifyAvatarCapabilityWith(
  secret: string,
  token: string | undefined | null,
  opts: { projectId?: string | null; now?: number } = {},
): AvatarCapabilityPayload | null {
  if (!token || typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(secret, body));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: AvatarCapabilityPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as AvatarCapabilityPayload;
  } catch {
    return null;
  }
  if (payload?.v !== 1) return null;
  if (typeof payload.p !== 'string' || !payload.p) return null;
  if (typeof payload.j !== 'string' || !payload.j) return null;
  if (typeof payload.e !== 'number' || !Number.isFinite(payload.e)) return null;
  if (payload.u !== null && typeof payload.u !== 'string') return null;
  if (payload.e < (opts.now ?? Date.now())) return null;
  if (opts.projectId && payload.p !== opts.projectId) return null;
  return payload;
}

export const signAvatarCapability = (
  input: { projectId: string; uid?: string | null; ttlSec?: number },
): MintedCapability => signAvatarCapabilityWith(resolveSecret(), input);

export const verifyAvatarCapability = (
  token: string | undefined | null,
  opts: { projectId?: string | null } = {},
): AvatarCapabilityPayload | null => verifyAvatarCapabilityWith(resolveSecret(), token, opts);

/**
 * Rollout control for the capability REQUIREMENT (not for the meter — see avatarBudget.ts).
 *
 *   off      — do not look at capabilities at all.
 *   shadow   — verify one when presented (and use its jti as a limiter dimension), but never
 *              reject a caller for not having one. This is the default so that shipping the
 *              backend cannot break public/unlisted/shared playback before the viewer sends one.
 *   enforce  — a valid capability bound to the request's project is mandatory.
 */
export type CapabilityMode = 'off' | 'shadow' | 'enforce';

export function capabilityMode(): CapabilityMode {
  const raw = (process.env.AVATAR_CAPABILITY_MODE || '').trim().toLowerCase();
  return raw === 'enforce' || raw === 'off' ? raw : 'shadow';
}
