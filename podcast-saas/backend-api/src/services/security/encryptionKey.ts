// The one place ENCRYPTION_KEY is turned into bytes (security-004).
//
// ── WHY A MISCONFIGURED KEY USED TO BE INVISIBLE ────────────────────────────────────────────
// Both consumers did `Buffer.from(process.env.ENCRYPTION_KEY, 'hex')` and used whatever came
// back. Node's hex decoder does not throw on bad input: it decodes the longest valid prefix and
// returns THAT, so a misconfigured value silently becomes a shorter key — usually a zero-length
// one:
//
//     Buffer.from('hunter2-not-hex', 'hex').length === 0     // an EMPTY key
//     Buffer.from('abzz',            'hex').length === 1     // 1 byte of the 32 expected
//     Buffer.from('abcd',            'hex').length === 2     // short but "valid" hex
//
// `createHmac` accepts a zero-length key without complaint. So a deploy that set ENCRYPTION_KEY
// to a passphrase instead of 64 hex characters went on minting and verifying media tokens signed
// with NO SECRET — every private project's media URL forgeable by anyone who can run sha256 —
// and nothing in the logs said so. (ApiKeyService is louder by accident: `createCipheriv` rejects
// a key that is not exactly 32 bytes. But it fails per request, at use time, not at boot, and its
// failure is caught and logged as "Failed to decrypt API key".)
//
// ── THE RULE ────────────────────────────────────────────────────────────────────────────────
// PRESENT ⇒ VALID. If the variable exists in the environment at all it must be exactly 64 hex
// characters (32 bytes — what AES-256-GCM requires, and what the dev fallback derives). An empty
// string counts as present: a deploy system that injects `ENCRYPTION_KEY=` has misconfigured it,
// and the failure mode of accepting that is precisely the one above.
//
// ABSENT ⇒ documented dev fallback outside production, fatal inside it. That is unchanged
// behaviour; this module only makes a SET value have to be real.
//
// Surrounding whitespace is trimmed before validating, because a trailing newline is an artifact
// of how secrets are pasted and piped, not an operator decision. Nothing else is repaired.

import { scryptSync } from 'crypto';

/** AES-256-GCM's key size, and therefore the only size this app accepts. */
export const ENCRYPTION_KEY_BYTES = 32;

/** Named once so every message and test agrees on the spelling. */
export const ENCRYPTION_KEY_ENV = 'ENCRYPTION_KEY';

const HEX_RE = /^[0-9a-fA-F]+$/;

/**
 * Why `raw` cannot be used as the encryption key, or null when it can.
 *
 * `undefined` (variable absent) is NOT a problem here — absence is handled by the caller, which
 * knows whether it is running in production. An empty string IS a problem: it means someone set
 * the variable and got the value wrong.
 */
export function encryptionKeyProblem(raw: string | undefined): string | null {
  if (raw === undefined) return null;

  const value = raw.trim();
  const want = `${ENCRYPTION_KEY_ENV} must be ${ENCRYPTION_KEY_BYTES * 2} hex characters ` +
    `(${ENCRYPTION_KEY_BYTES} bytes). Generate one with: openssl rand -hex ${ENCRYPTION_KEY_BYTES}`;

  if (value.length === 0) {
    return `${ENCRYPTION_KEY_ENV} is set but empty. ${want}`;
  }
  if (!HEX_RE.test(value)) {
    // Never echo the value — it is a secret even when it is the wrong secret.
    return `${ENCRYPTION_KEY_ENV} is not hexadecimal (it contains non-hex characters), so it ` +
      `decodes to a TRUNCATED or EMPTY key and would sign tokens with effectively no secret. ${want}`;
  }
  if (value.length !== ENCRYPTION_KEY_BYTES * 2) {
    return `${ENCRYPTION_KEY_ENV} is ${value.length} hex characters, which is ` +
      `${Math.floor(value.length / 2)} bytes, not ${ENCRYPTION_KEY_BYTES}. ${want}`;
  }
  return null;
}

/**
 * Boot gate. Throws when the process must not start:
 *   - the key is present but unusable (any environment — a bad key is never better than none)
 *   - the key is absent in production (the in-source dev fallback must never ship)
 */
export function assertEncryptionKeyConfig(
  raw: string | undefined,
  opts: { production: boolean },
): void {
  const problem = encryptionKeyProblem(raw);
  if (problem) throw new Error(problem);
  if (raw === undefined && opts.production) {
    throw new Error(`${ENCRYPTION_KEY_ENV} must be set in production — refusing to start`);
  }
}

/** Read the env and fail fast. Call once, at process start. */
export function assertEncryptionKeyEnv(): void {
  assertEncryptionKeyConfig(process.env[ENCRYPTION_KEY_ENV], {
    production: process.env.NODE_ENV === 'production',
  });
}

/**
 * The 32-byte secret, or a deterministic dev-only derivation when the variable is absent.
 *
 * THROWS when the variable is present but unusable — the whole point of this module. Callers on a
 * request path therefore fail loudly instead of degrading to an empty HMAC key, which is what
 * makes the misconfiguration observable even in a process that skipped the boot gate (a worker,
 * a one-off script, a test harness).
 *
 * `devSalt` keeps each consumer's fallback distinct, exactly as the in-line fallbacks did.
 */
export function encryptionKeyOrDevFallback(devSalt: string): Buffer {
  const raw = process.env[ENCRYPTION_KEY_ENV];
  const problem = encryptionKeyProblem(raw);
  if (problem) throw new Error(problem);
  if (raw === undefined) {
    return scryptSync('dev-secret-change-in-prod', devSalt, ENCRYPTION_KEY_BYTES);
  }
  return Buffer.from(raw.trim(), 'hex');
}
