import { describe, expect, it } from 'vitest';
import { buildReport, renderMarkdown } from '../report.js';
import { finding } from '../severity.js';

describe('release report', () => {
  const base = {
    runId: 'rel-20260716-1',
    state: 'FAILED' as const,
    stages: [
      { stage: 'plan', status: 'success' as const, durationMs: 1200 },
      { stage: 'verify', status: 'failure' as const, durationMs: 340_000 },
    ],
    findings: [
      finding('lint.warnings', 'WARNING', 'lint', '3 lint warnings'),
      finding('csp.frame-src.missing-firebase-auth-origin', 'CRITICAL', 'csp', 'CSP blocks the Firebase auth iframe', {
        detail: 'frame-src lacks https://cebu-1a10f.firebaseapp.com',
        remediation: 'Deploy the shared/src/csp.ts fix (commit 255d06f).',
      }),
    ],
    gate: {
      blocked: true,
      shouldRollback: false,
      counts: { CRITICAL: 1, HIGH: 0, WARNING: 1, INFO: 0 },
      reasons: ['1 CRITICAL finding(s) — release policy always blocks on CRITICAL.'],
    },
  };

  it('sorts findings most-severe-first and stamps the schema', () => {
    const r = buildReport(base);
    expect(r.schema).toBe('flowvid.release-report/v1');
    expect(r.findings[0].severity).toBe('CRITICAL');
  });

  it('redacts secrets that leak into any field', () => {
    const r = buildReport({
      ...base,
      logs: ['docker login with ghp_abcdefghijklmnopqrst123456 failed'],
    });
    expect(JSON.stringify(r)).not.toContain('ghp_abcdefghijklmnopqrst123456');
  });

  it('renders Markdown with verdict, findings table, and stages', () => {
    const md = renderMarkdown(buildReport(base));
    expect(md).toContain('# Release report');
    expect(md).toContain('Blocked: **YES**');
    expect(md).toContain('CSP blocks the Firebase auth iframe');
    expect(md).toContain('| plan | success |');
    // Markdown must never carry secrets either.
    expect(md).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
  });
});
