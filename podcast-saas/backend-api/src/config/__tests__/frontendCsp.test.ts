import { describe, it, expect } from 'vitest';
import { buildFrontendCsp, firebaseAuthFrameOrigin } from 'shared/src/csp';

const API = 'https://api.flowvidco.com';
const AUTH_DOMAIN = 'cebu-1a10f.firebaseapp.com';

// Extract a single directive's value from a CSP string.
function directive(csp: string, name: string): string {
  const part = csp.split(';').map((s) => s.trim()).find((s) => s === name || s.startsWith(name + ' '));
  return part ? part.slice(name.length).trim() : '';
}

describe('firebaseAuthFrameOrigin', () => {
  it('derives the https origin from a bare auth-domain host', () => {
    expect(firebaseAuthFrameOrigin('cebu-1a10f.firebaseapp.com')).toBe('https://cebu-1a10f.firebaseapp.com');
  });
  it('tolerates a value that already carries a scheme / path / port', () => {
    expect(firebaseAuthFrameOrigin('https://cebu-1a10f.firebaseapp.com/')).toBe('https://cebu-1a10f.firebaseapp.com');
    expect(firebaseAuthFrameOrigin('cebu-1a10f.firebaseapp.com:443/__/auth')).toBe('https://cebu-1a10f.firebaseapp.com');
  });
  it('returns empty (never widens the policy) for missing/invalid/localhost/wildcard input', () => {
    expect(firebaseAuthFrameOrigin(undefined)).toBe('');
    expect(firebaseAuthFrameOrigin('')).toBe('');
    expect(firebaseAuthFrameOrigin('localhost')).toBe('');
    expect(firebaseAuthFrameOrigin('127.0.0.1')).toBe('');
    expect(firebaseAuthFrameOrigin('*.firebaseapp.com')).toBe('');
    expect(firebaseAuthFrameOrigin('nodot')).toBe('');
  });
});

describe('production frontend CSP', () => {
  const prod = buildFrontendCsp({ apiUrl: API, firebaseAuthDomain: AUTH_DOMAIN, includeStripe: true, dev: false });

  it('includes the configured Firebase Auth Domain in frame-src (the incident fix)', () => {
    expect(directive(prod, 'frame-src')).toContain('https://cebu-1a10f.firebaseapp.com');
  });

  it('keeps the FlowVid API iframe source and Stripe supported in frame-src', () => {
    const fs = directive(prod, 'frame-src');
    expect(fs).toContain(API);
    expect(fs).toContain('https://js.stripe.com');
    expect(fs.startsWith("'self'")).toBe(true);
  });

  it('never contains localhost/127.0.0.1/http: in production', () => {
    expect(prod).not.toMatch(/localhost|127\.0\.0\.1|0\.0\.0\.0/);
    expect(prod).not.toMatch(/http:\/\//); // only https:/wss:/self allowed
  });

  it('keeps frame-ancestors restrictive (must NOT be weakened)', () => {
    expect(directive(prod, 'frame-ancestors')).toBe("'none'");
  });

  it('does not use a firebaseapp.com wildcard or a bare * in frame-src', () => {
    const fs = directive(prod, 'frame-src');
    expect(fs).not.toContain('*.firebaseapp.com');
    expect(fs.split(/\s+/)).not.toContain('*');
  });

  it('admin-web variant (no Stripe) still allows the API + Firebase auth iframe', () => {
    const admin = buildFrontendCsp({ apiUrl: API, firebaseAuthDomain: AUTH_DOMAIN, includeStripe: false, dev: false });
    const fs = directive(admin, 'frame-src');
    expect(fs).toContain('https://cebu-1a10f.firebaseapp.com');
    expect(fs).toContain(API);
    expect(fs).not.toContain('js.stripe.com');
    expect(admin).not.toMatch(/localhost/);
  });
});

describe('development frontend CSP', () => {
  it('adds localhost sources only in development', () => {
    const dev = buildFrontendCsp({ apiUrl: 'http://localhost:8080', firebaseAuthDomain: AUTH_DOMAIN, includeStripe: true, dev: true });
    expect(dev).toContain('http://localhost:8080');
    expect(directive(dev, 'frame-ancestors')).toBe("'none'"); // still restrictive even in dev
  });
});
