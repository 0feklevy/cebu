import { describe, expect, it } from 'vitest';
import { auditCspHeader, auditLiveCsp, parseCsp, type CspExpectation } from '../csp-audit.js';

const EXP: CspExpectation = {
  app: 'client-web',
  apiOrigin: 'https://api.flowvidco.com',
  firebaseAuthOrigin: 'https://cebu-1a10f.firebaseapp.com',
  stripeOrigin: 'https://js.stripe.com',
  production: true,
};

/** The exact production policy shape AFTER the fix (commit 255d06f). */
const GOOD =
  "default-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'none'; " +
  "frame-src 'self' https://api.flowvidco.com https://js.stripe.com https://cebu-1a10f.firebaseapp.com; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; " +
  "font-src 'self' data: https:; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https: wss:";

/** The v0.1.1 INCIDENT policy — Firebase auth origin missing from frame-src. */
const V011 = GOOD.replace(' https://cebu-1a10f.firebaseapp.com', '');

describe('parseCsp', () => {
  it('splits directives and keeps the first occurrence', () => {
    const csp = parseCsp("frame-src 'self' https://a.example; frame-src https://evil.example; frame-ancestors 'none'");
    expect(csp.get('frame-src')).toEqual(["'self'", 'https://a.example']);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
  });
});

describe('auditCspHeader — the Firebase incident', () => {
  it('passes the fixed production policy', () => {
    expect(auditCspHeader(GOOD, EXP)).toEqual([]);
  });

  it('detects the v0.1.1 production policy as a CRITICAL release blocker', () => {
    const findings = auditCspHeader(V011, EXP);
    const hit = findings.find((f) => f.id === 'csp.client-web.frame-src.missing-firebase-auth-origin');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('CRITICAL');
    expect(findings.filter((f) => f.severity === 'CRITICAL')).toHaveLength(1);
  });
});

describe('auditCspHeader — hygiene', () => {
  it('flags a missing header', () => {
    expect(auditCspHeader(null, EXP)[0].id).toBe('csp.client-web.missing-header');
  });

  it('flags weakened frame-ancestors (separate directive from frame-src)', () => {
    const findings = auditCspHeader(GOOD.replace("frame-ancestors 'none'", 'frame-ancestors *'), EXP);
    expect(findings.some((f) => f.id === 'csp.client-web.frame-ancestors.weakened')).toBe(true);
    // and the wildcard itself is caught too
    expect(findings.some((f) => f.id === 'csp.client-web.broad-wildcard')).toBe(true);
  });

  it('flags localhost sources in production', () => {
    const findings = auditCspHeader(GOOD.replace('frame-src', 'frame-src http://localhost:8080'), EXP);
    expect(findings.some((f) => f.id === 'csp.client-web.non-public-source' && f.severity === 'CRITICAL')).toBe(true);
  });

  it('flags http: scheme sources in production', () => {
    const findings = auditCspHeader(GOOD + '; script-src-elem http:', EXP);
    expect(findings.some((f) => f.id === 'csp.client-web.http-source')).toBe(true);
  });

  it('flags bare * wildcards', () => {
    const findings = auditCspHeader(GOOD.replace("connect-src 'self' https: wss:", 'connect-src *'), EXP);
    expect(findings.some((f) => f.id === 'csp.client-web.broad-wildcard')).toBe(true);
  });

  it('admin-web does not require Stripe', () => {
    const adminCsp = GOOD.replace(' https://js.stripe.com', '');
    expect(
      auditCspHeader(adminCsp, { ...EXP, app: 'admin-web', stripeOrigin: undefined }),
    ).toEqual([]);
  });
});

describe('auditCoopHeader (Firebase popup flow guard)', () => {
  it('absent COOP header → no findings (current production state, popups work)', async () => {
    const { auditCoopHeader } = await import('../csp-audit.js');
    expect(auditCoopHeader('client-web', null)).toEqual([]);
    expect(auditCoopHeader('client-web', undefined)).toEqual([]);
  });

  it('strict same-origin COOP → HIGH (would sever the signInWithPopup opener)', async () => {
    const { auditCoopHeader } = await import('../csp-audit.js');
    const findings = auditCoopHeader('client-web', 'same-origin');
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe('csp.client-web.coop-breaks-popup-auth');
    expect(findings[0].severity).toBe('HIGH');
  });

  it('same-origin-allow-popups → INFO only (popup-compatible)', async () => {
    const { auditCoopHeader } = await import('../csp-audit.js');
    const findings = auditCoopHeader('client-web', 'same-origin-allow-popups');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('INFO');
  });
});

describe('auditLiveCsp', () => {
  it('audits the header returned by fetch (mocked)', async () => {
    const fakeFetch = (async () =>
      new Response('<html></html>', { status: 200, headers: { 'content-security-policy': V011 } })) as typeof fetch;
    const res = await auditLiveCsp('https://flowvidco.com', EXP, fakeFetch);
    expect(res.status).toBe(200);
    expect(res.findings.some((f) => f.id.includes('missing-firebase-auth-origin'))).toBe(true);
  });

  it('reports unreachable pages as CRITICAL', async () => {
    const fakeFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const res = await auditLiveCsp('https://flowvidco.com', EXP, fakeFetch);
    expect(res.findings[0].id).toBe('csp.client-web.unreachable');
  });
});
