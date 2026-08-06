/**
 * The hermeticity predicate used by viewer-e2e.
 *
 * Two failure directions matter equally and are asserted separately:
 *   • TOO STRICT — rejecting the configured loopback auth emulator makes the check punish the very
 *     change it should reward (replacing a live call to identitytoolkit.googleapis.com with a local
 *     one). That is what happened: viewer-e2e failed on the emulator's own requests.
 *   • TOO LOOSE — approving "any loopback host", or any remote host, turns a hermeticity check into
 *     a formality. The allowance is ONE configured origin, vetted as loopback.
 */
import { describe, it, expect } from 'vitest';
import { isApprovedRequestUrl, isLoopbackOrigin, type HermeticPolicy } from '../e2e/hermeticHosts';

const BASE = 'http://localhost:3010';
const API = 'http://localhost:8080';
const STUBBED = ['https://stub.example.test/'];

const policy = (over: Partial<HermeticPolicy> = {}): HermeticPolicy => ({
  base: BASE, apiOrigin: API, stubbedHosts: STUBBED, authEmulator: 'http://127.0.0.1:9099', ...over,
});

describe('isApprovedRequestUrl — the app, the API and stubs', () => {
  it('approves the app and API origins', () => {
    expect(isApprovedRequestUrl(`${BASE}/projects/x/view`, policy())).toBe(true);
    expect(isApprovedRequestUrl(`${API}/api/v1/projects/x/player-config`, policy())).toBe(true);
    expect(isApprovedRequestUrl(BASE, policy())).toBe(true);           // the bare origin itself
    expect(isApprovedRequestUrl(`${BASE}?probe=1`, policy())).toBe(true);
  });

  // REGRESSION: a bare startsWith(origin) also matched these. The app and API allowances must stop
  // at an origin BOUNDARY, exactly as the emulator allowance always has.
  it('REJECTS prefix collisions against the app and API origins', () => {
    for (const u of [
      'http://localhost:30100/projects/x/view',      // base + extra digit → different port
      'http://localhost:8080.evil.test/api/v1/x',    // API origin as a hostname prefix
    ]) {
      expect(isApprovedRequestUrl(u, policy()), u).toBe(false);
    }
  });

  it('approves non-network schemes', () => {
    for (const u of ['data:text/html,x', 'blob:http://localhost/x', 'about:blank']) {
      expect(isApprovedRequestUrl(u, policy()), u).toBe(true);
    }
  });

  it('approves explicitly stubbed third parties', () => {
    expect(isApprovedRequestUrl('https://stub.example.test/sdk.js', policy())).toBe(true);
  });
});

describe('isApprovedRequestUrl — the auth emulator allowance', () => {
  // REGRESSION (too strict): rejecting the configured emulator is what broke viewer-e2e.
  it('APPROVES the configured loopback emulator, including its paths', () => {
    const p = policy();
    expect(isApprovedRequestUrl('http://127.0.0.1:9099', p)).toBe(true);
    expect(isApprovedRequestUrl('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp', p)).toBe(true);
  });

  it('approves nothing extra when no emulator is configured', () => {
    const p = policy({ authEmulator: null });
    expect(isApprovedRequestUrl('http://127.0.0.1:9099/x', p)).toBe(false);
  });

  // REGRESSION (too loose): the allowance is ONE origin, not "loopback in general".
  it('REJECTS a different loopback port or host than the configured one', () => {
    const p = policy();
    for (const u of [
      'http://127.0.0.1:9100/x',       // different port — another local service
      'http://localhost:9099/x',       // different host spelling than configured
      'http://127.0.0.1:8081/x',
    ]) {
      expect(isApprovedRequestUrl(u, p), u).toBe(false);
    }
  });

  it('REJECTS a prefix-collision host that merely starts with the emulator string', () => {
    // `startsWith` on a bare origin would approve http://127.0.0.1:9099.evil.test
    expect(isApprovedRequestUrl('http://127.0.0.1:9099.evil.test/x', policy())).toBe(false);
  });

  it('refuses to honour a NON-loopback emulator origin even if configured', () => {
    const p = policy({ authEmulator: 'http://attacker.example.com:9099' });
    expect(isApprovedRequestUrl('http://attacker.example.com:9099/x', p)).toBe(false);
  });
});

describe('isApprovedRequestUrl — arbitrary remote hosts stay rejected', () => {
  // REGRESSION: if this ever returns true the suite's verdict depends on someone else's uptime.
  it('rejects every unrelated remote host', () => {
    const p = policy();
    for (const u of [
      'https://identitytoolkit.googleapis.com/v1/accounts:signUp',
      'https://apis.google.com/js/api.js',
      'https://flowvidco.com/',
      'https://cdn.example.com/lib.js',
      'https://www.google-analytics.com/collect',
      'https://xyz.supabase.co/storage/v1/object/x',
    ]) {
      expect(isApprovedRequestUrl(u, p), u).toBe(false);
    }
  });
});

describe('isLoopbackOrigin', () => {
  it('accepts loopback origins', () => {
    for (const o of ['http://127.0.0.1:9099', 'http://localhost:1', 'http://[::1]:9099']) {
      expect(isLoopbackOrigin(o), o).toBe(true);
    }
  });

  it('rejects remote origins, credentials and junk', () => {
    for (const o of [
      'http://attacker.example.com:9099',
      'http://localhost:9099@attacker.example.com',   // userinfo bypass
      'not a url', '', null, undefined,
    ]) {
      expect(isLoopbackOrigin(o as string), String(o)).toBe(false);
    }
  });
});
