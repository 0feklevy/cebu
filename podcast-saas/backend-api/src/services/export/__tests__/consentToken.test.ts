/**
 * Consent, bound to one exact plan.
 *
 * The property under test is not "the signature verifies" — it is that a token authorises exactly
 * what it was issued for. A valid signature over the wrong project, the wrong user, or a plan that
 * has since changed is precisely the case this exists to refuse, and each of those is a way the old
 * naked `allow_degraded: true` boolean could be spent on something the user never saw.
 */

import { describe, it, expect } from 'vitest';

import {
  issueConsentToken,
  verifyConsentToken,
  consentSecret,
  ConsentInvalid,
  ConsentSecretMissing,
  CONSENT_TTL_MS,
  CONSENT_TOKEN_VERSION,
} from '../consentToken.js';

const ENV = { EXPORT_CONSENT_SECRET: 'x'.repeat(48) } as NodeJS.ProcessEnv;
const NOW = 1_700_000_000_000;
const BASE = {
  projectId: 'p-1',
  userId: 'u-1',
  fingerprint: 'a'.repeat(64),
};

const token = (over: Partial<typeof BASE> = {}, nowMs = NOW): string =>
  issueConsentToken({ ...BASE, ...over, nowMs }, ENV);

describe('the signing secret', () => {
  it('is required — there is no default key, because a default key is a forgeable one', () => {
    expect(() => consentSecret({} as NodeJS.ProcessEnv)).toThrow(ConsentSecretMissing);
  });

  it('refuses a short secret rather than signing weakly', () => {
    expect(() => consentSecret({ EXPORT_CONSENT_SECRET: 'short' } as NodeJS.ProcessEnv))
      .toThrow(/at least 32 characters/);
  });

  it('comes from its OWN variable — never a database URL or another borrowed secret', () => {
    // A key derived from something else fails open the day that something else is rotated, logged,
    // or shared with a subsystem that has no business signing consent.
    const env = { DATABASE_URL: 'postgres://user:pass@host/db', QUEUE_DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv;
    expect(() => consentSecret(env)).toThrow(ConsentSecretMissing);
  });
});

describe('verifyConsentToken', () => {
  it('accepts a token spent on exactly what it was issued for', () => {
    const claims = verifyConsentToken({ token: token(), ...BASE, nowMs: NOW + 1000 }, ENV);
    expect(claims).toMatchObject({ v: CONSENT_TOKEN_VERSION, policy: 'allow_poster', projectId: 'p-1' });
  });

  it('refuses a token for a DIFFERENT project', () => {
    expect(() => verifyConsentToken({ token: token(), ...BASE, projectId: 'p-2', nowMs: NOW }, ENV))
      .toThrow(/different project/);
  });

  it('refuses a token issued by a DIFFERENT user', () => {
    // A shared or leaked token must not let one collaborator spend another's agreement.
    expect(() => verifyConsentToken({ token: token(), ...BASE, userId: 'u-2', nowMs: NOW }, ENV))
      .toThrow(/different user/);
  });

  it('refuses a token whose PLAN has changed — the substitutions agreed to are not the ones that would happen', () => {
    const err = (() => {
      try {
        verifyConsentToken({ token: token(), ...BASE, fingerprint: 'b'.repeat(64), nowMs: NOW }, ENV);
      } catch (e) { return e as ConsentInvalid; }
    })();
    expect(err).toBeInstanceOf(ConsentInvalid);
    expect(err!.reason).toBe('plan_changed');
    expect(err!.message).toMatch(/review the new plan/);
  });

  it('expires, so a tab left open cannot agree on behalf of a project rewritten since', () => {
    expect(() => verifyConsentToken({ token: token(), ...BASE, nowMs: NOW + CONSENT_TTL_MS + 1 }, ENV))
      .toThrow(/expired/);
    // …and is still good one millisecond before.
    expect(() => verifyConsentToken({ token: token(), ...BASE, nowMs: NOW + CONSENT_TTL_MS - 1 }, ENV))
      .not.toThrow();
  });

  it('refuses a TAMPERED payload even though its shape is perfect', () => {
    const good = token();
    const [payload, signature] = good.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    claims.fingerprint = 'b'.repeat(64);           // a plan the user never saw
    const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;

    const err = (() => {
      try { verifyConsentToken({ token: forged, ...BASE, fingerprint: 'b'.repeat(64), nowMs: NOW }, ENV); }
      catch (e) { return e as ConsentInvalid; }
    })();
    expect(err!.reason).toBe('bad_signature');
  });

  it('refuses a token signed with a different key', () => {
    const other = { EXPORT_CONSENT_SECRET: 'y'.repeat(48) } as NodeJS.ProcessEnv;
    expect(() => verifyConsentToken({ token: token(), ...BASE, nowMs: NOW }, other)).toThrow(/signature/);
  });

  it('refuses missing, malformed and non-string tokens', () => {
    for (const bad of [undefined, null, '', 'no-dot', 42, {}, true]) {
      expect(() => verifyConsentToken({ token: bad, ...BASE, nowMs: NOW }, ENV)).toThrow(ConsentInvalid);
    }
  });

  it('refuses an old token VERSION rather than reinterpreting its claims', async () => {
    const claims = { v: 0, projectId: 'p-1', userId: 'u-1', policy: 'allow_poster', fingerprint: 'a'.repeat(64), exp: NOW + 1000 };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', ENV.EXPORT_CONSENT_SECRET!).update(payload).digest('base64url');
    expect(() => verifyConsentToken({ token: `${payload}.${sig}`, ...BASE, nowMs: NOW }, ENV))
      .toThrow(/no longer accepted/);
  });
});
