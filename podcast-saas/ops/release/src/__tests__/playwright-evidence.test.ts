/**
 * Playwright evidence: path resolution, fail-closed summarising, and run identity.
 *
 * These are regression tests for the exact failure chain in production-audit run
 * 31199562890 and in the v0.1.5 release: a Playwright report that was never written, a
 * summary command that resolved its path against the wrong cwd, and a gate that read the
 * resulting silence as "no findings".
 *
 * Ported from the unmerged `fix/playwright-release-summary` branch (a245b9c) and rewritten
 * against the current CommandContext/evidence API.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdGate, cmdPlaywrightSummary, defaultContext, resolveEvidencePath, type CommandContext } from '../commands.js';
import { checkRequiredEvidence, stampArtifact } from '../evidence.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** ops/release/src/__tests__ -> podcast-saas */
const APP_ROOT = join(HERE, '..', '..', '..', '..');

let tmp: string;
const logs: string[] = [];

function ctxWith(appRoot: string): CommandContext {
  return { ...defaultContext(), appRoot, log: (m) => logs.push(m) };
}

const PASSING_REPORT = JSON.stringify({
  suites: [{ title: 'production-smoke.spec.ts', specs: [{ ok: true, title: 'home page loads', tests: [{ results: [{ status: 'passed' }] }] }] }],
});
const FAILING_REPORT = JSON.stringify({
  suites: [{ title: 'production-smoke.spec.ts', specs: [{ ok: false, title: 'home page loads', tests: [{ results: [{ status: 'failed' }] }] }] }],
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pw-evidence-'));
  logs.length = 0;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('evidence path resolution (the `pnpm --filter` cwd defect)', () => {
  // The workflows invoke the CLI through `pnpm --filter ops-release`, which sets cwd to
  // ops/release. A repo-relative --report therefore used to resolve to
  // ops/release/client-web/e2e-results/results.json and throw ENOENT.
  //
  // This test FAILS against main's implementation, which passed opts.reportFile straight
  // to readFileSync and so depended entirely on the caller's cwd.
  const REL = 'client-web/e2e-results/results.json';

  it('resolves a repo-relative report against the app root, not the process cwd', () => {
    const fixture = join(APP_ROOT, REL);
    const created = !existsSync(fixture);
    if (created) {
      mkdirSync(dirname(fixture), { recursive: true });
      writeFileSync(fixture, PASSING_REPORT);
    }
    const originalCwd = process.cwd();
    try {
      // Reproduce the real invocation: cwd is ops/release, exactly as pnpm --filter sets it.
      process.chdir(join(APP_ROOT, 'ops', 'release'));
      expect(existsSync(REL)).toBe(false); // the cwd-relative path genuinely does not exist

      const resolved = resolveEvidencePath(ctxWith(APP_ROOT), REL);
      expect(resolved).toBe(fixture);
      expect(existsSync(resolved)).toBe(true);

      const res = cmdPlaywrightSummary(ctxWith(APP_ROOT), { reportFile: REL, out: join(tmp, 'summary.json') });
      expect(res.exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
      if (created) rmSync(fixture, { force: true });
    }
  });

  it('leaves an absolute report path untouched', () => {
    const abs = join(tmp, 'results.json');
    writeFileSync(abs, PASSING_REPORT);
    expect(resolveEvidencePath(ctxWith(APP_ROOT), abs)).toBe(abs);
  });
});

describe('cmdPlaywrightSummary fails closed', () => {
  it('throws rather than fabricating a clean summary when the report is absent', () => {
    expect(() => cmdPlaywrightSummary(ctxWith(tmp), { reportFile: join(tmp, 'missing.json'), out: join(tmp, 'summary.json') })).toThrow(
      /Playwright JSON report not found/,
    );
    // Critically: it must NOT have written a summary that later reads as 0 failures.
    expect(existsSync(join(tmp, 'summary.json'))).toBe(false);
  });

  it('stamps schema and run identity onto the summary it writes', () => {
    const report = join(tmp, 'results.json');
    writeFileSync(report, PASSING_REPORT);
    const out = join(tmp, 'summary.json');
    cmdPlaywrightSummary(ctxWith(tmp), { reportFile: report, out, runId: 'audit-99-1', gitSha: 'abc123' });
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    expect(doc.schema).toBe('flowvid.playwright-summary/v1');
    expect(doc.runId).toBe('audit-99-1');
    expect(doc.gitSha).toBe('abc123');
    expect(typeof doc.createdAt).toBe('string');
  });

  it('reports a CRITICAL finding when browser tests failed', () => {
    const report = join(tmp, 'results.json');
    writeFileSync(report, FAILING_REPORT);
    const res = cmdPlaywrightSummary(ctxWith(tmp), { reportFile: report });
    expect(res.exitCode).toBe(1);
    expect(res.findings[0].id).toBe('playwright.failures');
    expect(res.findings[0].severity).toBe('CRITICAL');
  });
});

describe('checkRequiredEvidence', () => {
  const write = (name: string, doc: unknown) => {
    const p = join(tmp, name);
    writeFileSync(p, JSON.stringify(doc));
    return p;
  };

  it('evidence.missing — an absent required file is CRITICAL, never silence', () => {
    const f = checkRequiredEvidence([join(tmp, 'nope.json')]);
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe('evidence.missing');
    expect(f[0].severity).toBe('CRITICAL');
  });

  it('evidence.unreadable — malformed JSON is CRITICAL', () => {
    const p = join(tmp, 'bad.json');
    writeFileSync(p, '{not json');
    expect(checkRequiredEvidence([p])[0].id).toBe('evidence.unreadable');
  });

  it('evidence.no-identity — identity-bearing file without a runId', () => {
    const p = write('playwright-summary.json', { total: 1 });
    const f = checkRequiredEvidence([p], { runId: 'r1' }, { identityBearing: ['playwright-summary.json'] });
    expect(f.map((x) => x.id)).toContain('evidence.no-identity');
  });

  it('evidence.no-commit — identity-bearing file without a gitSha', () => {
    const p = write('playwright-summary.json', { runId: 'r1' });
    const f = checkRequiredEvidence([p], { runId: 'r1', gitSha: 'sha1' }, { identityBearing: ['playwright-summary.json'] });
    expect(f.map((x) => x.id)).toContain('evidence.no-commit');
  });

  it('evidence.stale-run — evidence from a previous run is refused', () => {
    const p = write('playwright-summary.json', { runId: 'OLD', gitSha: 'sha1' });
    const f = checkRequiredEvidence([p], { runId: 'NEW', gitSha: 'sha1' });
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe('evidence.stale-run');
  });

  it('evidence.stale-commit — evidence for a different commit is refused', () => {
    const p = write('playwright-summary.json', { runId: 'r1', gitSha: 'OLD' });
    const f = checkRequiredEvidence([p], { runId: 'r1', gitSha: 'NEW' });
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe('evidence.stale-commit');
  });

  it('evidence.collector-error — an error placeholder can never pass as evidence', () => {
    const p = write('browser-findings.json', { auditError: true, reason: 'playwright died', findings: [] });
    const f = checkRequiredEvidence([p], { runId: 'r1' });
    expect(f[0].id).toBe('evidence.collector-error');
    expect(f[0].severity).toBe('CRITICAL');
  });

  it('accepts current, identity-bearing evidence', () => {
    const p = join(tmp, 'playwright-summary.json');
    writeFileSync(p, JSON.stringify(stampArtifact('flowvid.playwright-summary/v1', { total: 1 }, { runId: 'r1', gitSha: 'sha1' })));
    expect(checkRequiredEvidence([p], { runId: 'r1', gitSha: 'sha1' }, { identityBearing: ['playwright-summary.json'] })).toEqual([]);
  });

  it('a non-identity-bearing file may omit identity but must still match if present', () => {
    const ok = join(tmp, 'endpoints.json');
    writeFileSync(ok, JSON.stringify({ findings: [] }));
    expect(checkRequiredEvidence([ok], { runId: 'r1' })).toEqual([]);

    const stale = join(tmp, 'other.json');
    writeFileSync(stale, JSON.stringify({ runId: 'OLD' }));
    expect(checkRequiredEvidence([stale], { runId: 'r1' })[0].id).toBe('evidence.stale-run');
  });
});

describe('the gate refuses to pass on absent or stale evidence', () => {
  it('blocks when a required artifact is missing, even with zero collected findings', () => {
    const empty = join(tmp, 'endpoints.json');
    writeFileSync(empty, JSON.stringify({ findings: [] }));
    const res = cmdGate(ctxWith(tmp), {
      findingsFiles: [empty],
      phase: 'post-deploy',
      requiredFiles: [empty, join(tmp, 'playwright-summary.json')],
      out: join(tmp, 'gate.json'),
    });
    expect(res.exitCode).toBe(1);
    expect(res.decision.blocked).toBe(true);
    expect(res.findings.map((f) => f.id)).toContain('evidence.missing');
  });

  it('blocks on stale evidence that would otherwise report a clean suite', () => {
    const summary = join(tmp, 'playwright-summary.json');
    writeFileSync(summary, JSON.stringify({ runId: 'PREVIOUS', gitSha: 'old', total: 9, failed: 0, findings: [] }));
    const res = cmdGate(ctxWith(tmp), {
      findingsFiles: [summary],
      phase: 'post-deploy',
      requiredFiles: [summary],
      identityBearing: ['playwright-summary.json'],
      expect: { runId: 'CURRENT', gitSha: 'new' },
      out: join(tmp, 'gate.json'),
    });
    expect(res.decision.blocked).toBe(true);
    expect(res.findings.map((f) => f.id)).toEqual(expect.arrayContaining(['evidence.stale-run', 'evidence.stale-commit']));
  });

  it('passes when every required artifact is present and current', () => {
    const summary = join(tmp, 'playwright-summary.json');
    writeFileSync(summary, JSON.stringify(stampArtifact('flowvid.playwright-summary/v1', { failed: 0, findings: [] }, { runId: 'r1', gitSha: 'sha1' })));
    const res = cmdGate(ctxWith(tmp), {
      findingsFiles: [summary],
      phase: 'post-deploy',
      requiredFiles: [summary],
      identityBearing: ['playwright-summary.json'],
      expect: { runId: 'r1', gitSha: 'sha1' },
      out: join(tmp, 'gate.json'),
    });
    expect(res.decision.blocked).toBe(false);
    expect(res.exitCode).toBe(0);
  });
});
