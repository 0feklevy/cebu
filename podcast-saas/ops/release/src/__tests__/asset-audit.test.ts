import { describe, expect, it } from 'vitest';
import {
  auditBrowserReport,
  classify4xx,
  COOP_WINDOW_CLOSED_RE,
  parseBrowserAudit,
  type BrowserAuditReport,
  type PageAudit,
} from '../asset-audit.js';
import { RELEASE_CONFIG } from '../config.js';
import { evaluateGate } from '../severity.js';

const cleanPage = (url: string): PageAudit => ({
  url,
  status: 200,
  consoleErrors: [],
  consoleSecurityWarnings: [],
  pageErrors: [],
  cspViolations: [],
  mixedContent: [],
  requestsFailed: [],
  responses5xx: [],
  unexpected4xx: [],
  nonPublicRequests: [],
  brokenImages: [],
  iframes: [],
  serviceWorkers: 0,
});

const report = (pages: PageAudit[]): BrowserAuditReport => ({
  schema: 'flowvid.browser-audit/v1',
  baseUrl: 'https://flowvidco.com',
  pages,
});

const API = 'https://api.flowvidco.com';

describe('classify4xx — deterministic context-aware classifier', () => {
  const cases: Array<[string, Parameters<typeof classify4xx>[0], 'anonymous' | 'authenticated', string]> = [
    ['anonymous protected projects 401', { url: `${API}/api/v1/projects`, status: 401, type: 'fetch' }, 'anonymous', 'expected-auth-rejection'],
    ['anonymous protected playlists 401 (query variant)', { url: `${API}/api/v1/playlists?with_items=true`, status: 401, type: 'xhr' }, 'anonymous', 'expected-auth-rejection'],
    ['anonymous protected 403', { url: `${API}/api/v1/projects`, status: 403, type: 'fetch' }, 'anonymous', 'expected-auth-rejection'],
    ['AUTHENTICATED protected 401 is a real failure', { url: `${API}/api/v1/projects`, status: 401, type: 'fetch' }, 'authenticated', 'required-resource-failure'],
    ['image 401 is never downgraded', { url: `${API}/local-storage/thumbnails/x.png`, status: 401, type: 'image' }, 'anonymous', 'required-resource-failure'],
    ['media 401 is never downgraded', { url: `${API}/hls-public/master.m3u8`, status: 401, type: 'media' }, 'anonymous', 'required-resource-failure'],
    ['404 is never downgraded (even on a protected route)', { url: `${API}/api/v1/projects`, status: 404, type: 'fetch' }, 'anonymous', 'required-resource-failure'],
    ['required public API 404', { url: `${API}/health`, status: 404, type: 'fetch' }, 'anonymous', 'required-resource-failure'],
    ['required public API 401 (health must never require auth)', { url: `${API}/health`, status: 401, type: 'fetch' }, 'anonymous', 'required-resource-failure'],
    ['non-listed API route 401 (no blanket /api/v1 rule)', { url: `${API}/api/v1/projects/abc/player-config`, status: 401, type: 'fetch' }, 'anonymous', 'required-resource-failure'],
    ['other-origin 401 is not a protected route', { url: 'https://flowvidco.com/api/v1/projects', status: 401, type: 'fetch' }, 'anonymous', 'required-resource-failure'],
  ];
  for (const [name, entry, ctx, expected] of cases) {
    it(name, () => {
      expect(classify4xx(entry, ctx, RELEASE_CONFIG)).toBe(expected);
    });
  }
});

describe('auditBrowserReport — the run 29528323804 classes', () => {
  it('anonymous protected 401s (old-shape report, no authContext/type) → INFO diagnostic, gate NOT blocked', () => {
    // Exactly what the failed audit artifact contained for these routes.
    const home = { ...cleanPage('https://flowvidco.com/'), unexpected4xx: [{ url: `${API}/api/v1/playlists?with_items=true`, status: 401 }] };
    const login = {
      ...cleanPage('https://flowvidco.com/#login'),
      unexpected4xx: [
        { url: `${API}/api/v1/projects`, status: 401 },
        { url: `${API}/api/v1/playlists`, status: 401 },
      ],
    };
    const findings = auditBrowserReport(report([home, login]));
    expect(findings.filter((f) => f.id === 'browser.required-resource-4xx')).toHaveLength(0);
    const info = findings.filter((f) => f.id === 'browser.expected-auth-rejection');
    expect(info).toHaveLength(2);
    expect(info.every((f) => f.severity === 'INFO')).toBe(true);
    expect(evaluateGate(findings, 'post-deploy').blocked).toBe(false);
  });

  it('pre-classified expectedAuthRejections from the new spec → same INFO diagnostic', () => {
    const page = { ...cleanPage('/'), authContext: 'anonymous' as const, expectedAuthRejections: [{ url: `${API}/api/v1/projects`, status: 401 }] };
    const findings = auditBrowserReport(report([page]));
    expect(findings.map((f) => `${f.severity}:${f.id}`)).toEqual(['INFO:browser.expected-auth-rejection']);
  });

  it('AUTHENTICATED protected API 401 stays HIGH', () => {
    const page = { ...cleanPage('/admin'), authContext: 'authenticated' as const, unexpected4xx: [{ url: `${API}/api/v1/projects`, status: 401, type: 'fetch' }] };
    const findings = auditBrowserReport(report([page]));
    expect(findings.some((f) => f.id === 'browser.required-resource-4xx' && f.severity === 'HIGH')).toBe(true);
    expect(evaluateGate(findings, 'post-deploy').blocked).toBe(true);
  });

  it('image/media 401 stays HIGH even while anonymous', () => {
    const page = { ...cleanPage('/'), unexpected4xx: [{ url: `${API}/local-storage/thumbnails/t.png`, status: 401, type: 'image' }] };
    const findings = auditBrowserReport(report([page]));
    expect(findings.some((f) => f.id === 'browser.required-resource-4xx' && f.severity === 'HIGH')).toBe(true);
  });

  it('required public API 404 stays HIGH', () => {
    const page = { ...cleanPage('/'), unexpected4xx: [{ url: `${API}/health`, status: 404, type: 'fetch' }] };
    const findings = auditBrowserReport(report([page]));
    expect(findings.some((f) => f.id === 'browser.required-resource-4xx' && f.severity === 'HIGH')).toBe(true);
  });

  it('API 500 blocks (HIGH under the unapproved gate)', () => {
    const page = { ...cleanPage('/'), responses5xx: [{ url: `${API}/api/v1/projects`, status: 500 }] };
    const findings = auditBrowserReport(report([page]));
    expect(findings.some((f) => f.id === 'browser.http-5xx' && f.severity === 'HIGH')).toBe(true);
    expect(evaluateGate(findings, 'post-deploy').blocked).toBe(true);
  });

  it('localhost requests stay CRITICAL', () => {
    const page = { ...cleanPage('/'), nonPublicRequests: [{ url: 'http://localhost:8080/local-storage/t.png', kind: 'loopback' }] };
    const findings = auditBrowserReport(report([page]));
    const gate = evaluateGate(findings, 'post-deploy');
    expect(findings.some((f) => f.id === 'browser.non-public-request' && f.severity === 'CRITICAL')).toBe(true);
    expect(gate.blocked && gate.shouldRollback).toBe(true);
  });

  it('Firebase/Stripe/core frame CSP violations stay CRITICAL', () => {
    const page = { ...cleanPage('/'), cspViolations: ['frame-src blocked https://cebu-1a10f.firebaseapp.com/__/auth/iframe'] };
    const findings = auditBrowserReport(report([page]));
    expect(findings.some((f) => f.id === 'browser.csp-core-flow-blocked' && f.severity === 'CRITICAL')).toBe(true);
  });
});

describe('console-error correlation (no duplicate findings for one expected 401)', () => {
  it('absorbs at most one matching console line per expected rejection; unrelated errors kept', () => {
    const page = {
      ...cleanPage('/'),
      unexpected4xx: [{ url: `${API}/api/v1/playlists`, status: 401 }], // old-shape → reclassified
      consoleErrors: [
        'Failed to load resource: the server responded with a status of 401 ()',
        'ReferenceError: boom is not defined',
      ],
    };
    const findings = auditBrowserReport(report([page]));
    const rejection = findings.find((f) => f.id === 'browser.expected-auth-rejection');
    const consoleFinding = findings.find((f) => f.id === 'browser.console-errors');
    expect(rejection?.detail).toContain('console line(s) absorbed');
    expect(consoleFinding?.message).toContain('1 console error(s)'); // only the unrelated one remains
    expect(consoleFinding?.detail).toContain('boom');
    expect(evaluateGate(findings, 'post-deploy').blocked).toBe(false); // WARNING + INFO only
  });

  it('without any expected rejection, 401 console lines are NOT absorbed', () => {
    const page = { ...cleanPage('/'), consoleErrors: ['Failed to load resource: the server responded with a status of 401 ()'] };
    const findings = auditBrowserReport(report([page]));
    expect(findings.find((f) => f.id === 'browser.console-errors')?.message).toContain('1 console error(s)');
  });
});

describe('known-benign COOP popup message', () => {
  const COOP_MSG = 'Cross-Origin-Opener-Policy policy would block the window.closed call.';

  it('matches the exact message only', () => {
    expect(COOP_WINDOW_CLOSED_RE.test(COOP_MSG)).toBe(true);
    expect(COOP_WINDOW_CLOSED_RE.test('Cross-Origin-Opener-Policy blocked a frame')).toBe(false);
  });

  it('is INFO wherever it appears (security warnings, console errors, or pre-bucketed)', () => {
    const page = {
      ...cleanPage('/'),
      consoleSecurityWarnings: [COOP_MSG],
      consoleErrors: [COOP_MSG],
      knownBenignWarnings: [COOP_MSG],
    };
    const findings = auditBrowserReport(report([page]));
    expect(findings.map((f) => `${f.severity}:${f.id}`)).toEqual(['INFO:browser.known-benign-warning']);
    expect(evaluateGate(findings, 'post-deploy').blocked).toBe(false);
  });

  it('does NOT absorb other security warnings', () => {
    const page = { ...cleanPage('/'), consoleSecurityWarnings: [COOP_MSG, 'Refused to frame https://evil.example because it violates CSP'] };
    const findings = auditBrowserReport(report([page]));
    expect(findings.some((f) => f.id === 'browser.security-warnings' && f.severity === 'HIGH')).toBe(true);
  });
});

describe('unchanged severities (safety invariants)', () => {
  it('clean pages produce no findings (true green, not false green)', () => {
    expect(auditBrowserReport(report([cleanPage('/'), cleanPage('/login')]))).toEqual([]);
  });

  it('HTTP-200 page with broken images is still HIGH (the false-green incident)', () => {
    const page = { ...cleanPage('/p/x'), brokenImages: ['https://api.flowvidco.com/thumb.png'] };
    const findings = auditBrowserReport(report([page]));
    expect(findings.some((f) => f.id === 'browser.broken-images' && f.severity === 'HIGH')).toBe(true);
  });

  it('unavailable page and mixed content are CRITICAL', () => {
    const page = { ...cleanPage('/'), status: 502, mixedContent: ['http://cdn.example/script.js'] };
    const ids = auditBrowserReport(report([page])).map((f) => `${f.severity}:${f.id}`);
    expect(ids).toContain('CRITICAL:browser.page-unavailable');
    expect(ids).toContain('CRITICAL:browser.mixed-content');
  });

  it('stale service workers stay WARNING', () => {
    const page = { ...cleanPage('/'), serviceWorkers: 1 };
    expect(auditBrowserReport(report([page]))[0].severity).toBe('WARNING');
  });

  it('parses only its own schema', () => {
    expect(() => parseBrowserAudit('{"schema":"x"}')).toThrow(/schema/);
  });
});
