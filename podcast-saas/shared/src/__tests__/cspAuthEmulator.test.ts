/**
 * The dev-only auth-emulator allowance in the frontend CSP.
 *
 * WHY IT EXISTS: `FirebaseAuthProvider` signs guests in anonymously on mount. With
 * `connectAuthEmulator` active the SDK posts to `http://127.0.0.1:9099/identitytoolkit…`, and
 * `connect-src` refused it — so sign-in failed *silently* inside the provider's catch and the page
 * ran unauthenticated while looking healthy. The sim-pool loopback gate is what surfaced it.
 *
 * WHY IT IS DANGEROUS IF WRONG: this is the one place a CSP can be widened by an environment
 * variable. Every assertion below is about it staying shut — in production, for a non-loopback
 * host, and for a malformed value.
 */
import { describe, it, expect } from 'vitest';
import { authEmulatorOrigin, buildFrontendCsp } from '../csp.js';

const connectSrc = (csp: string) =>
  csp.split('; ').find((d) => d.startsWith('connect-src')) ?? '';

describe('authEmulatorOrigin', () => {
  it('accepts a loopback host:port in development', () => {
    expect(authEmulatorOrigin('127.0.0.1:9099', true)).toBe('http://127.0.0.1:9099');
    expect(authEmulatorOrigin('localhost:9099', true)).toBe('http://localhost:9099');
    expect(authEmulatorOrigin('::1:9099', true)).toBe('');   // ambiguous parse → refused, not guessed
  });

  // THE PRODUCTION GUARD. A variable left set in a deployed environment must change nothing.
  it('returns nothing in production, whatever the value', () => {
    for (const v of ['127.0.0.1:9099', 'localhost:9099', 'evil.example.com:9099']) {
      expect(authEmulatorOrigin(v, false), v).toBe('');
    }
  });

  it('refuses a NON-loopback host even in development', () => {
    for (const v of ['evil.example.com:9099', '10.0.0.5:9099', 'auth.internal:9099', '0.0.0.0:9099']) {
      expect(authEmulatorOrigin(v, true), v).toBe('');
    }
  });

  // SECURITY REGRESSION. `value.split(':')[0]` is NOT the host: for
  // `localhost:9099@attacker.example.com` it yields "localhost", so a naive loopback check passes,
  // while `new URL('http://' + value)` resolves to attacker.example.com because the leading text is
  // userinfo. A validator that checks a split and then interpolates the RAW value would point
  // authentication (and connect-src) at a remote host.
  it('refuses a userinfo bypass that makes a remote host look like loopback', () => {
    for (const v of [
      'localhost:9099@attacker.example.com',
      '127.0.0.1:9099@attacker.example.com',
      'localhost:9099@127.0.0.1.attacker.example.com:80',
      'user:pass@localhost:9099',
      'localhost:9099\\@attacker.example.com',
    ]) {
      expect(authEmulatorOrigin(v, true), v).toBe('');
    }
  });

  it('re-emits the origin from PARSED parts, never from the caller string', () => {
    // Any trailing path/query is dropped rather than carried into the emitted source.
    expect(authEmulatorOrigin('127.0.0.1:9099/evil?x=1', true)).toBe('http://127.0.0.1:9099');
  });

  it('refuses malformed values rather than emitting a broken source', () => {
    for (const v of ['', '127.0.0.1', '127.0.0.1:', ':9099', '127.0.0.1:abc', 'localhost:99 99']) {
      expect(authEmulatorOrigin(v, true), JSON.stringify(v)).toBe('');
    }
    expect(authEmulatorOrigin(undefined, true)).toBe('');
  });

  it('strips a scheme or path rather than trusting the shape', () => {
    expect(authEmulatorOrigin('http://127.0.0.1:9099/', true)).toBe('http://127.0.0.1:9099');
    expect(authEmulatorOrigin('https://localhost:9099/x?y', true)).toBe('http://localhost:9099');
  });
});

describe('buildFrontendCsp — the emulator never widens a production policy', () => {
  const base = { apiUrl: 'https://api.example.com', firebaseAuthDomain: 'p.firebaseapp.com' };

  it('adds the loopback emulator to connect-src in development', () => {
    const csp = buildFrontendCsp({ ...base, dev: true, authEmulatorHost: '127.0.0.1:9099' });
    expect(connectSrc(csp)).toContain('http://127.0.0.1:9099');
  });

  it('does NOT add it in a production policy', () => {
    const csp = buildFrontendCsp({ ...base, dev: false, authEmulatorHost: '127.0.0.1:9099' });
    expect(connectSrc(csp)).not.toContain('9099');
    expect(csp).not.toContain('http://127.0.0.1');
  });

  it('does not add a non-loopback host in development', () => {
    const csp = buildFrontendCsp({ ...base, dev: true, authEmulatorHost: 'evil.example.com:9099' });
    expect(connectSrc(csp)).not.toContain('evil.example.com');
  });

  it('leaves the policy byte-identical when the variable is absent', () => {
    const without = buildFrontendCsp({ ...base, dev: true });
    const withUndef = buildFrontendCsp({ ...base, dev: true, authEmulatorHost: undefined });
    expect(withUndef).toBe(without);
    // and the production policy is unchanged by the feature existing at all
    expect(buildFrontendCsp({ ...base, dev: false, authEmulatorHost: undefined }))
      .toBe(buildFrontendCsp({ ...base, dev: false }));
  });

  it('never weakens frame-ancestors', () => {
    const csp = buildFrontendCsp({ ...base, dev: true, authEmulatorHost: '127.0.0.1:9099' });
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
