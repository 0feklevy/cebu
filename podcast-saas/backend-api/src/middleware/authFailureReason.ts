/**
 * observability-004 — why a token failed to verify, in words an operator can act on.
 *
 * THE PROBLEM. `firebaseAuthMiddleware` wrapped the whole verify in `catch { 401 }` with no
 * logging at all, so four completely different situations were indistinguishable from outside:
 *
 *   • a user's token aged out (normal; the client refreshes and retries),
 *   • this container's clock drifted (every token in the fleet fails, and no client change helps),
 *   • the deployment points at the wrong Firebase project (same, but the fix is a config change),
 *   • FIREBASE_* was never configured (every request 401s from boot).
 *
 * Only the first is routine. The other three are outages, and they produced exactly the same
 * silence.
 *
 * WHY NOT JUST LOG `err.code`. Because firebase-admin collapses most of them into ONE code.
 * `auth/argument-error` (AuthClientErrorCode.INVALID_ARGUMENT) is what
 * `lib/auth/token-verifier.js` throws for an audience mismatch, an issuer mismatch, an invalid
 * signature, a missing `kid`, AND for whatever text the JWT library produced. The distinctions an
 * operator needs live in the message, so this reads the message — carefully, and only to CHOOSE a
 * label from a closed set.
 *
 * REDACTION. The payload this returns is meant to be logged verbatim, so it may never carry the
 * token. Two things enforce that: nothing here copies the token into the payload, and `detail` —
 * the vendor's own prose — is passed through a scrubber first. That second part is not decorative:
 * the vendor's final fallback is `new FirebaseAuthError(INVALID_ARGUMENT, error.message)` with an
 * unbounded string from the JWT library, and this module cannot pin what a future version puts in
 * it.
 */

/** Closed set of situations. Add a member here, not a free-form string at a call site. */
export type AuthFailureReason =
  | 'token_expired'          // routine: the client will refresh
  | 'token_revoked'          // the session was invalidated server-side
  | 'user_disabled'          // the account was disabled
  | 'token_malformed'        // junk / wrong signature / not a Firebase ID token
  | 'clock_skew'             // this host's (or the client's) clock is wrong — no token can pass
  | 'project_mismatch'       // token minted for a DIFFERENT Firebase project than we verify against
  | 'admin_not_configured'   // FIREBASE_* env missing — every request 401s
  | 'firebase_unavailable'   // we could not reach or trust Google's key material
  | 'unknown';               // deliberately not guessed

/** What the payload for one failed verify looks like. Assembled field-by-field — never a spread. */
export interface AuthFailure {
  readonly reason: AuthFailureReason;
  /** The vendor's own code (`auth/argument-error`), when it is shaped like a code. */
  readonly vendorCode?: string;
  /** The vendor's message, with any occurrence of the token replaced. */
  readonly detail?: string;
}

/**
 * Who has to do something about it. An expired token is the single most common event on a busy
 * API and must not drown the log, let alone page anyone; the three deployment faults must be
 * loud, because each of them fails EVERY request and previously logged nothing at all.
 */
export const AUTH_FAILURE_LEVEL: Record<AuthFailureReason, 'debug' | 'warn' | 'error'> = {
  token_expired: 'debug',
  token_revoked: 'debug',
  user_disabled: 'debug',
  token_malformed: 'warn',
  unknown: 'warn',
  clock_skew: 'error',
  project_mismatch: 'error',
  admin_not_configured: 'error',
  firebase_unavailable: 'error',
};

/** Vendor codes with a 1:1 meaning. Everything else needs the message to disambiguate. */
const BY_VENDOR_CODE: Record<string, AuthFailureReason> = {
  'auth/id-token-expired': 'token_expired',
  'auth/session-cookie-expired': 'token_expired',
  'auth/id-token-revoked': 'token_revoked',
  'auth/session-cookie-revoked': 'token_revoked',
  'auth/user-disabled': 'user_disabled',
  'auth/internal-error': 'firebase_unavailable',
  'auth/invalid-credential': 'firebase_unavailable',
  'auth/certificate-fetch-failed': 'firebase_unavailable',
};

/** Node/undici network codes: we could not reach Google's certificate endpoint. */
const NETWORK_CODES = new Set([
  'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT',
]);

/** A code we are willing to put in a log field: short, and code-shaped. */
const VENDOR_CODE_RE = /^[A-Za-z0-9._/-]{1,64}$/;

/** Longest vendor message kept. The prose is long; the diagnosis is at the front. */
const MAX_DETAIL_LENGTH = 300;

function messageOf(err: unknown): string {
  return err instanceof Error && typeof err.message === 'string' ? err.message : '';
}

function codeOf(err: unknown): string | undefined {
  const raw = (err as { code?: unknown })?.code;
  if (typeof raw !== 'string') return undefined;
  return VENDOR_CODE_RE.test(raw) ? raw : undefined;
}

/**
 * The token must never appear in a log line. `token` may be any length, so this is a plain
 * substring replace rather than a regex (a token is not a safe regex source).
 */
function scrub(text: string, token: string | undefined): string {
  if (!token || token.length < 8) return text;
  return text.split(token).join('[redacted]');
}

/** Classify one verify failure into a loggable payload. Never throws, never returns the token. */
export function classifyAuthFailure(err: unknown, token?: string): AuthFailure {
  const vendorCode = codeOf(err);
  const message = messageOf(err);
  const lower = message.toLowerCase();

  const detailRaw = scrub(message, token).slice(0, MAX_DETAIL_LENGTH);
  const detail = detailRaw.length > 0 ? detailRaw : undefined;
  const base = { vendorCode, detail } as const;

  // services/firebase.ts throws this plain Error before the SDK is ever reached.
  if (message === 'Firebase Admin environment variables not configured') {
    return { reason: 'admin_not_configured', ...base };
  }

  const mapped = vendorCode ? BY_VENDOR_CODE[vendorCode] : undefined;
  if (mapped) return { reason: mapped, ...base };

  if (vendorCode && NETWORK_CODES.has(vendorCode)) {
    return { reason: 'firebase_unavailable', ...base };
  }

  // Clock first: an "iat in the future" token is not malformed, and telling an operator it is
  // sends them to debug the client instead of the host clock. Checked before the project match
  // because both can quote the project name.
  if (
    lower.includes('"iat" claim in the future') ||
    lower.includes('iat claim in the future') ||
    lower.includes('used too early') ||
    lower.includes('not active') ||
    lower.includes("clock")
  ) {
    return { reason: 'clock_skew', ...base };
  }

  // The aud/iss mismatch texts, which firebase-admin also reports as auth/argument-error.
  if (
    lower.includes('(audience) claim') ||
    lower.includes('(issuer) claim') ||
    lower.includes('same firebase project')
  ) {
    return { reason: 'project_mismatch', ...base };
  }

  if (vendorCode === 'auth/argument-error' || vendorCode === 'auth/invalid-id-token') {
    return { reason: 'token_malformed', ...base };
  }

  return { reason: 'unknown', ...base };
}
