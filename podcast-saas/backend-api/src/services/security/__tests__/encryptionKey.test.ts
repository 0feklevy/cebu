/**
 * security-004 — a misconfigured ENCRYPTION_KEY must be FATAL, never silently downgraded.
 *
 * Node's hex decoder does not reject bad input. It decodes the longest valid prefix and
 * returns that, so `Buffer.from(x, 'hex')` on a misconfigured value yields a SHORTER key —
 * often a zero-length one — with no error anywhere:
 *
 *     Buffer.from('hunter2-not-hex', 'hex').length === 0
 *     Buffer.from('abzz',            'hex').length === 1
 *     Buffer.from('abcd',            'hex').length === 2
 *
 * `createHmac` accepts a zero-length key without complaint. Before this guard, a deploy that
 * set ENCRYPTION_KEY to a passphrase (rather than 64 hex chars) went on minting and verifying
 * media tokens signed with NO SECRET — every private project's media URL forgeable by anyone
 * who can run sha256 — and nothing in the logs said so.
 *
 * The properties here are the agreement:
 *   1  a key that is present but not exactly 32 bytes of hex is REFUSED, not truncated
 *   2  the refusal names the variable, so an operator can act on it
 *   3  an absent key still falls back to the documented dev secret (this is not a new
 *      requirement to set it outside production — only a requirement that a SET value be real)
 *   4  a correct key keeps working
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mintMediaToken, verifyMediaToken } from '../../storage/mediaToken.js';
import {
  assertEncryptionKeyConfig,
  encryptionKeyProblem,
  ENCRYPTION_KEY_ENV,
} from '../encryptionKey.js';

const REAL_KEY = 'a'.repeat(64); // 32 bytes of valid hex
const SCOPE = 'videos/11111111-1111-1111-1111-111111111111';

let saved: string | undefined;
let wasPresent = false;

beforeEach(() => {
  wasPresent = 'ENCRYPTION_KEY' in process.env;
  saved = process.env.ENCRYPTION_KEY;
});

afterEach(() => {
  if (wasPresent) process.env.ENCRYPTION_KEY = saved as string;
  else delete process.env.ENCRYPTION_KEY;
});

describe('mediaToken refuses to sign with a misconfigured ENCRYPTION_KEY', () => {
  it('refuses a NON-HEX key instead of HMACing with an empty secret', () => {
    process.env.ENCRYPTION_KEY = 'hunter2-not-hex-at-all';
    expect(() => mintMediaToken(SCOPE)).toThrow(/ENCRYPTION_KEY/);
  });

  it('refuses a SHORT hex key instead of HMACing with 2 bytes', () => {
    process.env.ENCRYPTION_KEY = 'abcd';
    expect(() => mintMediaToken(SCOPE)).toThrow(/ENCRYPTION_KEY/);
  });

  it('refuses an EMPTY key rather than silently using the dev fallback', () => {
    process.env.ENCRYPTION_KEY = '';
    expect(() => mintMediaToken(SCOPE)).toThrow(/ENCRYPTION_KEY/);
  });

  it('refuses a key that is hex but the wrong length for AES-256', () => {
    process.env.ENCRYPTION_KEY = 'ab'.repeat(16); // 16 bytes, not 32
    expect(() => mintMediaToken(SCOPE)).toThrow(/ENCRYPTION_KEY/);
  });

  it('refuses on VERIFY too — a bad key must not quietly accept forged tokens', () => {
    process.env.ENCRYPTION_KEY = REAL_KEY;
    const token = mintMediaToken(SCOPE);
    process.env.ENCRYPTION_KEY = 'not-hex';
    expect(() => verifyMediaToken(SCOPE, token)).toThrow(/ENCRYPTION_KEY/);
  });

  it('still mints and verifies with a correct 32-byte hex key', () => {
    process.env.ENCRYPTION_KEY = REAL_KEY;
    const token = mintMediaToken(SCOPE);
    expect(verifyMediaToken(SCOPE, token)).toBe(true);
    expect(verifyMediaToken('videos/other', token)).toBe(false);
  });

  it('still falls back to the dev secret when the variable is absent entirely', () => {
    delete process.env.ENCRYPTION_KEY;
    const token = mintMediaToken(SCOPE);
    expect(verifyMediaToken(SCOPE, token)).toBe(true);
  });
});

describe('the boot gate names the variable and says what a good value looks like', () => {
  it('reports a problem for every way the value can be wrong', () => {
    for (const bad of ['', '   ', 'hunter2', 'abcd', 'zz'.repeat(32), 'ab'.repeat(16), REAL_KEY + 'ab']) {
      const problem = encryptionKeyProblem(bad);
      expect(problem, `expected a problem for ${JSON.stringify(bad)}`).toBeTruthy();
      expect(problem).toContain(ENCRYPTION_KEY_ENV);
      expect(problem).toMatch(/openssl rand -hex 32/);
    }
  });

  it('never echoes the secret back into the log line', () => {
    expect(encryptionKeyProblem('super-secret-passphrase')).not.toContain('super-secret-passphrase');
  });

  it('accepts a correct key, and tolerates the newline a pasted secret carries', () => {
    expect(encryptionKeyProblem(REAL_KEY)).toBeNull();
    expect(encryptionKeyProblem(`${REAL_KEY}\n`)).toBeNull();
    expect(encryptionKeyProblem(undefined)).toBeNull();
  });

  it('refuses to start in production with no key at all', () => {
    expect(() => assertEncryptionKeyConfig(undefined, { production: true }))
      .toThrow(/ENCRYPTION_KEY must be set in production/);
    expect(() => assertEncryptionKeyConfig(undefined, { production: false })).not.toThrow();
  });

  it('refuses a bad key OUTSIDE production too — a broken key is never better than none', () => {
    expect(() => assertEncryptionKeyConfig('not-hex', { production: false }))
      .toThrow(/ENCRYPTION_KEY/);
  });
});
