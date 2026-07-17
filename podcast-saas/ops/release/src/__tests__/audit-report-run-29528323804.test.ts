import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { cmdBrowserAudit, cmdGate, cmdReport, writeJsonFile, type CommandContext } from '../commands.js';
import { RELEASE_CONFIG } from '../config.js';
import { runCommand } from '../run.js';

/**
 * Offline fixture reproducing production-audit run 29528323804 (2026-07-16,
 * the first real Production Audit failure) and proving the fixed pipeline:
 *   - the two anonymous protected-401 routes are NOT HIGH any more (INFO diagnostics);
 *   - the matching console errors and the COOP popup message do not block;
 *   - REAL failures (broken image / localhost / core CSP) still block;
 *   - the audit report gets an explicit verdict + Started timestamp
 *     (the failed run said "Final state: UNKNOWN" and "Started: —").
 */

let dir: string;
const ctx = (): CommandContext => ({
  run: runCommand,
  fetchImpl: fetch,
  config: RELEASE_CONFIG,
  monorepoRoot: dir,
  appRoot: dir,
  log: () => {},
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'audit-fixture-'));
});

/** The browser-audit content of the failed run, as the OLD spec recorded it. */
const RUN_29528323804_BROWSER_AUDIT = {
  schema: 'flowvid.browser-audit/v1',
  baseUrl: 'https://flowvidco.com',
  generatedAt: '2026-07-16T19:38:00.000Z',
  pages: [
    {
      url: 'https://flowvidco.com/',
      status: 200,
      consoleErrors: ['Failed to load resource: the server responded with a status of 401 ()'],
      consoleSecurityWarnings: [],
      pageErrors: [],
      cspViolations: [],
      mixedContent: [],
      requestsFailed: [],
      responses5xx: [],
      unexpected4xx: [{ url: 'https://api.flowvidco.com/api/v1/playlists?with_items=true', status: 401 }],
      nonPublicRequests: [],
      brokenImages: [],
      iframes: [],
      serviceWorkers: 0,
    },
    {
      url: 'https://flowvidco.com/#login',
      status: 200,
      consoleErrors: [
        'Failed to load resource: the server responded with a status of 401 ()',
        'Failed to load resource: the server responded with a status of 401 ()',
        'Cross-Origin-Opener-Policy policy would block the window.closed call.',
      ],
      consoleSecurityWarnings: ['Cross-Origin-Opener-Policy policy would block the window.closed call.'],
      pageErrors: [],
      cspViolations: [],
      mixedContent: [],
      requestsFailed: [],
      responses5xx: [],
      unexpected4xx: [
        { url: 'https://api.flowvidco.com/api/v1/projects', status: 401 },
        { url: 'https://api.flowvidco.com/api/v1/playlists', status: 401 },
      ],
      nonPublicRequests: [],
      brokenImages: [],
      iframes: [],
      serviceWorkers: 0,
    },
  ],
};

function runPipeline(browserAudit: unknown): { gateBlocked: boolean; art: string } {
  const art = join(dir, 'artifacts');
  writeJsonFile(join(art, 'browser-audit.json'), browserAudit);
  cmdBrowserAudit(ctx(), { reportFile: join(art, 'browser-audit.json'), out: join(art, 'browser-findings.json') });
  writeJsonFile(join(art, 'endpoints.json'), {
    endpoints: [
      { name: 'app', url: 'https://flowvidco.com', httpStatus: 200, ok: true },
      { name: 'api-health', url: 'https://api.flowvidco.com/health', httpStatus: 200, ok: true },
      { name: 'admin', url: 'https://admin.flowvidco.com', httpStatus: 200, ok: true },
    ],
    findings: [],
  });
  const gate = cmdGate(ctx(), {
    findingsFiles: [join(art, 'browser-findings.json'), join(art, 'endpoints.json')],
    phase: 'post-deploy',
    out: join(art, 'gate.json'),
  });
  return { gateBlocked: gate.decision.blocked, art };
}

describe('run 29528323804 replayed through the fixed pipeline', () => {
  it('no longer blocks: the three anonymous 401s are INFO, console lines absorbed, COOP benign', () => {
    const { gateBlocked, art } = runPipeline(RUN_29528323804_BROWSER_AUDIT);
    expect(gateBlocked).toBe(false);

    const findings = JSON.parse(readFileSync(join(art, 'browser-findings.json'), 'utf8')).findings as Array<{
      id: string;
      severity: string;
    }>;
    expect(findings.filter((f) => f.id === 'browser.required-resource-4xx')).toHaveLength(0);
    expect(findings.filter((f) => f.id === 'browser.expected-auth-rejection').every((f) => f.severity === 'INFO')).toBe(true);
    expect(findings.filter((f) => f.id === 'browser.known-benign-warning').every((f) => f.severity === 'INFO')).toBe(true);
    // The duplicate console lines were absorbed by the rejections; no console-errors finding remains.
    expect(findings.filter((f) => f.id === 'browser.console-errors')).toHaveLength(0);
    expect(findings.filter((f) => f.id === 'browser.security-warnings')).toHaveLength(0);
  });

  it('the SAME run with a real failure added still blocks (no blanket green)', () => {
    const withRealFailure = JSON.parse(JSON.stringify(RUN_29528323804_BROWSER_AUDIT));
    withRealFailure.pages[0].brokenImages = ['https://api.flowvidco.com/local-storage/thumbnails/t.png'];
    withRealFailure.pages[1].cspViolations = ['frame-src blocked https://cebu-1a10f.firebaseapp.com/__/auth/iframe'];
    withRealFailure.pages[1].nonPublicRequests = [{ url: 'http://localhost:8080/x', kind: 'loopback' }];
    const { gateBlocked, art } = runPipeline(withRealFailure);
    expect(gateBlocked).toBe(true);
    const findings = JSON.parse(readFileSync(join(art, 'browser-findings.json'), 'utf8')).findings as Array<{ id: string; severity: string }>;
    expect(findings.some((f) => f.id === 'browser.broken-images' && f.severity === 'HIGH')).toBe(true);
    expect(findings.some((f) => f.id === 'browser.csp-core-flow-blocked' && f.severity === 'CRITICAL')).toBe(true);
    expect(findings.some((f) => f.id === 'browser.non-public-request' && f.severity === 'CRITICAL')).toBe(true);
  });

  it('the audit report now has an explicit verdict and a Started timestamp (no UNKNOWN, no missing Started)', () => {
    const { art } = runPipeline(RUN_29528323804_BROWSER_AUDIT);
    const { report } = cmdReport(ctx(), {
      dir: art,
      meta: {
        runId: 'audit-29528323804-1',
        kind: 'audit',
        startedAt: '2026-07-16T19:31:18Z',
        endedAt: '2026-07-16T19:40:02Z',
        actor: 'schedule',
      },
      outJson: join(dir, 'audit-report.json'),
      outMd: join(dir, 'audit-report.md'),
    });
    expect(report.kind).toBe('audit');
    expect(report.state).toBe('AUDIT_PASSED');
    expect(report.startedAt).toBe('2026-07-16T19:31:18Z');

    const md = readFileSync(join(dir, 'audit-report.md'), 'utf8');
    expect(md).toContain('# Production audit report');
    expect(md).not.toContain('UNKNOWN');
    expect(md).toContain('| Started | 2026-07-16T19:31:18Z |');
  });
});

describe('audit/rollback report state mapping', () => {
  it('audit with a blocking gate → AUDIT_FAILED; without any gate → UNKNOWN', () => {
    const art = join(dir, 'a1');
    writeJsonFile(join(art, 'gate.json'), {
      decision: { blocked: true, shouldRollback: true, counts: { CRITICAL: 1, HIGH: 0, WARNING: 0, INFO: 0 }, reasons: ['x'] },
      findings: [],
    });
    const failed = cmdReport(ctx(), {
      dir: art,
      meta: { runId: 'a1', kind: 'audit' },
      outJson: join(art, 'r.json'),
      outMd: join(art, 'r.md'),
    });
    expect(failed.report.state).toBe('AUDIT_FAILED');

    const art2 = join(dir, 'a2');
    writeJsonFile(join(art2, 'endpoints.json'), { endpoints: [], findings: [] });
    const unknown = cmdReport(ctx(), {
      dir: art2,
      meta: { runId: 'a2', kind: 'audit' },
      outJson: join(art2, 'r.json'),
      outMd: join(art2, 'r.md'),
    });
    expect(unknown.report.state).toBe('UNKNOWN'); // no gate ran — never claim success
  });

  it('rollback kind maps a passing gate to ROLLED_BACK (truthful, not a fake release state)', () => {
    const art = join(dir, 'rb');
    writeJsonFile(join(art, 'gate.json'), {
      decision: { blocked: false, shouldRollback: false, counts: { CRITICAL: 0, HIGH: 0, WARNING: 0, INFO: 0 }, reasons: [] },
      findings: [],
    });
    const res = cmdReport(ctx(), {
      dir: art,
      meta: { runId: 'rb1', kind: 'rollback', version: 'v0.1.2' },
      outJson: join(art, 'r.json'),
      outMd: join(art, 'r.md'),
    });
    expect(res.report.state).toBe('ROLLED_BACK');
    expect(readFileSync(join(art, 'r.md'), 'utf8')).toContain('# Rollback report — v0.1.2');
  });

  it('release kind keeps the state-machine behavior (unchanged)', () => {
    const art = join(dir, 'rel');
    writeJsonFile(join(art, 'endpoints.json'), { endpoints: [], findings: [] });
    const res = cmdReport(ctx(), {
      dir: art,
      meta: { runId: 'rel1' },
      outJson: join(art, 'r.json'),
      outMd: join(art, 'r.md'),
    });
    expect(res.report.state).toBe('UNKNOWN'); // no state.json in this fixture — releases still require it
  });
});
