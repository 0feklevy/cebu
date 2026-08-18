/**
 * observability-004 — an expired token, a clock skew and a misconfigured project must not look
 * the same in the logs.
 *
 * The classifier is a pure function so the cases can be enumerated against the SHAPES
 * firebase-admin 12.7 actually throws (checked against
 * node_modules/firebase-admin/lib/auth/token-verifier.js and lib/utils/error.js — several distinct
 * operator situations collapse into the single vendor code `auth/argument-error`, which is exactly
 * why classifying on `err.code` alone is not enough).
 *
 * The other half of the contract is that NOTHING here may put the token in a log line, including
 * via a vendor message that happens to quote it.
 */
import { describe, it, expect } from 'vitest';
import type { AuthFailureReason } from '../authFailureReason.js';
import { classifyAuthFailure, AUTH_FAILURE_LEVEL } from '../authFailureReason.js';

/** A FirebaseAuthError as firebase-admin constructs it: `auth/`-prefixed code + prose message. */
function fbError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code: `auth/${code}` });
}

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.PAYLOAD-THAT-IS-A-LIVE-CREDENTIAL.sig';

function reasonOf(err: unknown): AuthFailureReason {
  return classifyAuthFailure(err, TOKEN).reason;
}

describe('classifyAuthFailure', () => {
  it('separates an expired token from everything else', () => {
    expect(reasonOf(fbError('id-token-expired', 'Firebase ID token has expired. Get a fresh ID token from your client app and try again (auth/id-token-expired).')))
      .toBe('token_expired');
  });

  it('separates a revoked token', () => {
    expect(reasonOf(fbError('id-token-revoked', 'The Firebase ID token has been revoked.'))).toBe('token_revoked');
  });

  it('separates a disabled user', () => {
    expect(reasonOf(fbError('user-disabled', 'The user record is disabled.'))).toBe('user_disabled');
  });

  it('separates a MISCONFIGURED PROJECT from a bad token, though the vendor code is identical', () => {
    // Both arrive as auth/argument-error. One is a caller with a junk token; the other is this
    // deployment pointed at the wrong Firebase project, which no amount of client retrying fixes.
    const audience = fbError('argument-error', 'Firebase ID token has incorrect "aud" (audience) claim. Expected "flowvid-prod" but got "flowvid-staging". Make sure the ID token comes from the same Firebase project as the service account used to authenticate this SDK.');
    const issuer = fbError('argument-error', 'Firebase ID token has incorrect "iss" (issuer) claim. Expected "https://securetoken.google.com/flowvid-prod" but got "https://securetoken.google.com/flowvid-staging". Make sure the ID token comes from the same Firebase project as the service account used to authenticate this SDK.');
    expect(reasonOf(audience)).toBe('project_mismatch');
    expect(reasonOf(issuer)).toBe('project_mismatch');
  });

  it('separates CLOCK SKEW, which is a host problem and not a token problem', () => {
    for (const message of [
      'Firebase ID token has "iat" claim in the future. Make sure the ID token comes from a client whose clock is correct.',
      'jwt not active',
      'The provided token is used too early.',
    ]) {
      expect(reasonOf(fbError('argument-error', message)), message).toBe('clock_skew');
    }
  });

  it('calls a genuinely broken token malformed', () => {
    for (const message of [
      'Firebase ID token has invalid signature.',
      'Firebase ID token has no "kid" claim.',
      'jwt malformed',
      'Decoding Firebase ID token failed. Make sure you passed the entire string JWT which represents an ID token.',
    ]) {
      expect(reasonOf(fbError('argument-error', message)), message).toBe('token_malformed');
    }
  });

  it('separates "we cannot reach or trust our own credentials" from anything the caller did', () => {
    expect(reasonOf(fbError('internal-error', 'An internal error has occurred.'))).toBe('firebase_unavailable');
    expect(reasonOf(fbError('invalid-credential', 'Invalid credential object provided.'))).toBe('firebase_unavailable');
    expect(reasonOf(Object.assign(new Error('getaddrinfo ENOTFOUND www.googleapis.com'), { code: 'ENOTFOUND' })))
      .toBe('firebase_unavailable');
  });

  it('recognises the SDK never having been configured at all', () => {
    // services/firebase.ts throws this plain Error when FIREBASE_* env vars are missing — every
    // request then 401s, and before this the logs said nothing whatsoever.
    expect(reasonOf(new Error('Firebase Admin environment variables not configured'))).toBe('admin_not_configured');
  });

  it('falls back to unknown rather than guessing', () => {
    expect(reasonOf(new Error('something nobody anticipated'))).toBe('unknown');
    expect(reasonOf('a string')).toBe('unknown');
    expect(reasonOf(undefined)).toBe('unknown');
  });

  it('grades the reasons by who has to act', () => {
    // A 3am page should not fire for a user whose token aged out; it must fire for a deployment
    // that cannot verify ANY token.
    expect(AUTH_FAILURE_LEVEL.token_expired).toBe('debug');
    expect(AUTH_FAILURE_LEVEL.token_revoked).toBe('debug');
    expect(AUTH_FAILURE_LEVEL.token_malformed).toBe('warn');
    expect(AUTH_FAILURE_LEVEL.project_mismatch).toBe('error');
    expect(AUTH_FAILURE_LEVEL.clock_skew).toBe('error');
    expect(AUTH_FAILURE_LEVEL.admin_not_configured).toBe('error');
    expect(AUTH_FAILURE_LEVEL.firebase_unavailable).toBe('error');
  });
});

describe('the token never reaches the log payload', () => {
  it('is not carried in any field, for any reason', () => {
    for (const err of [
      fbError('id-token-expired', 'expired'),
      fbError('argument-error', 'Firebase ID token has invalid signature.'),
      new Error('Firebase Admin environment variables not configured'),
      new Error('nope'),
    ]) {
      const payload = classifyAuthFailure(err, TOKEN);
      expect(JSON.stringify(payload), String(err)).not.toContain(TOKEN);
      expect(JSON.stringify(payload)).not.toContain('PAYLOAD-THAT-IS-A-LIVE-CREDENTIAL');
    }
  });

  it('scrubs the token even when the vendor quotes it back at us', () => {
    // Not hypothetical insurance: the vendor's final fallback is `new FirebaseAuthError(..., error.message)`
    // with whatever the JWT library said, and this file cannot pin what a future version puts there.
    const leaky = fbError('argument-error', `jwt malformed: ${TOKEN}`);
    const payload = classifyAuthFailure(leaky, TOKEN);
    const serialized = JSON.stringify(payload);
    expect(serialized, 'a vendor message carried the token into the log payload').not.toContain(TOKEN);
    expect(serialized).toContain('[redacted]');
  });

  it('still says enough to debug with', () => {
    const payload = classifyAuthFailure(fbError('argument-error', 'Firebase ID token has invalid signature.'), TOKEN);
    expect(payload.reason).toBe('token_malformed');
    expect(payload.vendorCode).toBe('auth/argument-error');
    expect(payload.detail).toContain('invalid signature');
  });

  it('refuses a vendor code that is not code-shaped, rather than logging it', () => {
    const weird = Object.assign(new Error('x'), { code: { nested: 'object' } });
    expect(classifyAuthFailure(weird, TOKEN).vendorCode).toBeUndefined();
  });
});
