/**
 * The spend capability, and specifically the two properties that a plausible-but-wrong
 * implementation would NOT have.
 *
 * A capability that merely "verifies its own signature" satisfies every requirement anybody states
 * out loud — "the route needs a capability", "an expired one is refused", "a tampered one is
 * refused" — and is still broken in the two ways that matter on this surface:
 *
 *   1. it authorizes spend against a project it was never minted for, which is the whole hole
 *      (the two analyze routes accepted an arbitrary project id and reached its private library);
 *   2. it accepts the avatar's OTHER stateless token, because both fall back to DATABASE_URL for
 *      their key, so "reuse signMemoryToken" would look like a tidy simplification and would turn
 *      a 12-hour read token into an unlimited spend token.
 *
 * Both are asserted below, in a way a signature-only implementation fails.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  capabilityMode, signAvatarCapabilityWith, verifyAvatarCapabilityWith,
} from '../avatarCapability.js';
import { signMemoryTokenWith, verifyMemoryTokenWith } from '../memoryToken.js';

const SECRET = 'shared-secret-both-token-types-would-derive';
const PROJECT_A = '11111111-2222-4333-8444-555555555555';
const PROJECT_B = '99999999-8888-4777-8666-555555555555';

describe('avatar spend capability — binding', () => {
  it('authorizes the project it was minted for', () => {
    const { token, jti } = signAvatarCapabilityWith(SECRET, { projectId: PROJECT_A });
    const payload = verifyAvatarCapabilityWith(SECRET, token, { projectId: PROJECT_A });
    expect(payload).not.toBeNull();
    expect(payload!.p).toBe(PROJECT_A);
    expect(payload!.j).toBe(jti);
  });

  it('does NOT authorize a different project, even though the signature is perfectly valid', () => {
    // The failure this refuses: a viewer holds a legitimate capability for a public video and
    // points a paid call at somebody else's project. Signature-only verification says yes.
    const { token } = signAvatarCapabilityWith(SECRET, { projectId: PROJECT_A });
    expect(verifyAvatarCapabilityWith(SECRET, token, { projectId: PROJECT_A })).not.toBeNull();
    expect(verifyAvatarCapabilityWith(SECRET, token, { projectId: PROJECT_B })).toBeNull();
  });

  it('mints a distinct nonce each time, so the meter can bill one popup open', () => {
    const a = signAvatarCapabilityWith(SECRET, { projectId: PROJECT_A });
    const b = signAvatarCapabilityWith(SECRET, { projectId: PROJECT_A });
    expect(a.jti).not.toBe(b.jti);
    expect(a.token).not.toBe(b.token);
  });

  it('expires, and is refused the instant it does', () => {
    const now = 1_700_000_000_000;
    const { token } = signAvatarCapabilityWith(SECRET, { projectId: PROJECT_A, ttlSec: 60, now });
    expect(verifyAvatarCapabilityWith(SECRET, token, { projectId: PROJECT_A, now: now + 59_000 })).not.toBeNull();
    expect(verifyAvatarCapabilityWith(SECRET, token, { projectId: PROJECT_A, now: now + 61_000 })).toBeNull();
  });

  it('refuses a body edited to name another project, and a foreign key', () => {
    const { token } = signAvatarCapabilityWith(SECRET, { projectId: PROJECT_A });
    const [body, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), p: PROJECT_B }),
    ).toString('base64url');
    expect(verifyAvatarCapabilityWith(SECRET, `${forged}.${mac}`, { projectId: PROJECT_B })).toBeNull();
    expect(verifyAvatarCapabilityWith('another-secret', token, { projectId: PROJECT_A })).toBeNull();
  });
});

describe('avatar spend capability — domain separation from the memory token', () => {
  // Both token types resolve to the same secret in every deployment that sets neither dedicated
  // env var (both fall back to DATABASE_URL). Only the domain tag in the MAC input keeps them
  // apart, so these two tests are the only thing standing between "reuse signMemoryToken" and a
  // read token that authorizes unlimited billable calls.

  it('a genuine, currently-valid memory token is NOT a spend capability', () => {
    // Deliberately shaped so it satisfies every FIELD check a capability makes — v, p, j, u, e are
    // all present and well-formed. If verification still refuses it, the reason can only be the
    // domain tag, which is exactly the property under test.
    const payload = {
      v: 1, p: PROJECT_A, j: 'nonce-1', u: null,
      e: Date.now() + 60_000, s: 'session-key',
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const memoryMac = createHmac('sha256', SECRET).update(body).digest('base64url');
    const token = `${body}.${memoryMac}`;

    // It really is a valid memory token — not a broken string that anything would reject.
    expect(verifyMemoryTokenWith(SECRET, token)).not.toBeNull();
    // …and it buys nothing.
    expect(verifyAvatarCapabilityWith(SECRET, token, { projectId: PROJECT_A })).toBeNull();
  });

  it('a spend capability is NOT a memory token either', () => {
    const { token } = signAvatarCapabilityWith(SECRET, { projectId: PROJECT_A });
    expect(verifyMemoryTokenWith(SECRET, token)).toBeNull();
  });

  it('the two constructions disagree on the same body — the tag, not the payload, separates them', () => {
    const memory = signMemoryTokenWith(SECRET, PROJECT_A, 'session-key');
    const [body, memoryMac] = memory.split('.');
    const domainMac = createHmac('sha256', SECRET)
      .update(`flowvid.avatar-capability.v1.${body}`).digest('base64url');
    expect(domainMac).not.toBe(memoryMac);
  });
});

describe('avatar spend capability — rollout mode', () => {
  const withMode = <T>(value: string | undefined, fn: () => T): T => {
    const prev = process.env.AVATAR_CAPABILITY_MODE;
    if (value === undefined) delete process.env.AVATAR_CAPABILITY_MODE;
    else process.env.AVATAR_CAPABILITY_MODE = value;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.AVATAR_CAPABILITY_MODE;
      else process.env.AVATAR_CAPABILITY_MODE = prev;
    }
  };

  it('defaults to shadow — shipping the backend cannot break a viewer that sends nothing yet', () => {
    expect(withMode(undefined, capabilityMode)).toBe('shadow');
  });

  it('honours enforce and off, and treats anything else as shadow rather than as off', () => {
    expect(withMode('enforce', capabilityMode)).toBe('enforce');
    expect(withMode('off', capabilityMode)).toBe('off');
    // A typo must not silently disable the check.
    expect(withMode('ENFORCED', capabilityMode)).toBe('shadow');
    expect(withMode('', capabilityMode)).toBe('shadow');
  });
});
