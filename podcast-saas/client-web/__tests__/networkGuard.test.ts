/**
 * The loopback guard's admission rule.
 *
 * `installLoopbackGuard` needs a live Playwright page, so its POLICY lives in `classifyGuardUrl`,
 * which this file pins from both directions. The wiring (that the route handler actually consults
 * the verdict) is proven by the guard self-test inside sim-pool.spec.ts, which fires a deliberate
 * non-loopback request and asserts the guard recorded and blocked it.
 */
import { describe, it, expect } from 'vitest';
import { classifyGuardUrl } from '../e2e/networkGuard';

describe('classifyGuardUrl — what a hermetic run may request', () => {
  it('approves schemes that cannot reach a network peer', () => {
    for (const u of ['data:text/html,x', 'blob:http://localhost:3010/abc', 'about:blank']) {
      expect(classifyGuardUrl(u).allow, u).toBe(true);
    }
  });

  it('approves loopback hosts on ANY port — port policy belongs to the hermeticity predicate', () => {
    for (const u of [
      'http://localhost:3010/projects/x/view',
      'http://127.0.0.1:8080/api/v1/health',
      'http://[::1]:9099/identitytoolkit.googleapis.com/v1/x',
    ]) {
      const v = classifyGuardUrl(u);
      expect(v.allow, u).toBe(true);
      expect(v.why, u).toBe('loopback');
    }
  });

  // THE INVARIANT THE GUARD EXISTS FOR. If any of these is ever admitted, a green browser matrix
  // stops proving the run was hermetic and starts depending on someone else's uptime.
  it('blocks every non-loopback host', () => {
    for (const u of [
      'https://identitytoolkit.googleapis.com/v1/accounts:signUp',
      'https://apis.google.com/js/api.js',
      'https://flowvidco.com/media/x.m3u8',
      'https://cdn.example.com/lib.js',
      'https://www.google-analytics.com/collect',
      'https://xyz.supabase.co/storage/v1/object/x',
      'http://127.0.0.1.evil.test/x',        // loopback-lookalike hostname
      'http://198.51.100.1/',                // bare IP, non-loopback
    ]) {
      const v = classifyGuardUrl(u);
      expect(v.allow, u).toBe(false);
      expect(v.why, u).toBe('non-loopback');
    }
  });

  it('blocks an unparseable URL rather than guessing', () => {
    const v = classifyGuardUrl('http://');
    expect(v.allow).toBe(false);
    expect(v.why).toBe('unparseable');
    expect(v.host).toBeNull();
  });

  it('reports the parsed hostname so diagnostics never need the full URL', () => {
    expect(classifyGuardUrl('https://cdn.example.com/lib.js?token=SHOULD-NEVER-PRINT').host)
      .toBe('cdn.example.com');
  });
});
