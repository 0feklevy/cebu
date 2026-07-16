import { describe, expect, it } from 'vitest';
import { auditBrowserReport, parseBrowserAudit, type BrowserAuditReport, type PageAudit } from '../asset-audit.js';

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

describe('auditBrowserReport', () => {
  it('clean pages produce no findings (true green, not false green)', () => {
    expect(auditBrowserReport(report([cleanPage('/'), cleanPage('/login')]))).toEqual([]);
  });

  it('localhost requests from the production browser are CRITICAL', () => {
    const page = { ...cleanPage('/'), nonPublicRequests: [{ url: 'http://localhost:8080/local-storage/t.png', kind: 'loopback' }] };
    const findings = auditBrowserReport(report([page]));
    expect(findings.some((f) => f.id === 'browser.non-public-request' && f.severity === 'CRITICAL')).toBe(true);
  });

  it('CSP violations on core flows (Firebase auth) are CRITICAL; others HIGH', () => {
    const page = {
      ...cleanPage('/'),
      cspViolations: [
        "frame-src blocked https://cebu-1a10f.firebaseapp.com/__/auth/iframe",
        'img-src blocked https://random.example/x.png',
      ],
    };
    const findings = auditBrowserReport(report([page]));
    expect(findings.find((f) => f.id === 'browser.csp-core-flow-blocked')?.severity).toBe('CRITICAL');
    expect(findings.find((f) => f.id === 'browser.csp-violation')?.severity).toBe('HIGH');
  });

  it('HTTP-200 page with broken images is still HIGH (the false-green incident)', () => {
    const page = { ...cleanPage('/p/x'), brokenImages: ['https://api.flowvidco.com/thumb.png'] };
    const findings = auditBrowserReport(report([page]));
    expect(findings.some((f) => f.id === 'browser.broken-images' && f.severity === 'HIGH')).toBe(true);
  });

  it('unavailable page and mixed content are CRITICAL; 5xx and 4xx-required are HIGH', () => {
    const page = {
      ...cleanPage('/'),
      status: 502,
      mixedContent: ['http://cdn.example/script.js'],
      responses5xx: [{ url: 'https://api.flowvidco.com/player-config', status: 500 }],
      unexpected4xx: [{ url: 'https://api.flowvidco.com/captions.vtt', status: 404 }],
    };
    const ids = auditBrowserReport(report([page])).map((f) => `${f.severity}:${f.id}`);
    expect(ids).toContain('CRITICAL:browser.page-unavailable');
    expect(ids).toContain('CRITICAL:browser.mixed-content');
    expect(ids).toContain('HIGH:browser.http-5xx');
    expect(ids).toContain('HIGH:browser.required-resource-4xx');
  });

  it('stale service workers and console errors are WARNING', () => {
    const page = { ...cleanPage('/'), serviceWorkers: 1, consoleErrors: ['boom'] };
    const findings = auditBrowserReport(report([page]));
    expect(findings.every((f) => f.severity === 'WARNING')).toBe(true);
  });

  it('parses only its own schema', () => {
    expect(() => parseBrowserAudit('{"schema":"x"}')).toThrow(/schema/);
  });
});
