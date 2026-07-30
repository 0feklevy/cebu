import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkRequiredEvidence,
  cmdGate,
  cmdPlaywrightSummary,
  summarizePlaywrightReport,
  writeJsonFile,
  type CommandContext,
} from '../commands.js';
import { RELEASE_CONFIG } from '../config.js';

/**
 * Regression suite for the v0.1.5 incident: the post-deploy gate published a
 * RELEASE even though `playwright-summary` failed with ENOENT and produced no
 * evidence. Root cause: the summary step passed a RELATIVE --report path, but
 * `pnpm --filter ops-release` runs the CLI with cwd = ops/release, so
 * `client-web/e2e-results/results.json` resolved under ops/release and did not
 * exist; the gate then silently ignored the missing playwright-summary.json.
 */

let dir: string;

function ctx(): CommandContext {
  return {
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetchImpl: fetch,
    config: RELEASE_CONFIG,
    monorepoRoot: dir,
    appRoot: dir,
    log: () => {},
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pw-evidence-'));
});

/** A realistic Playwright JSON report: 6 passed, 3 skipped (the successful v0.1.5 shape). */
function pwReport(specs: Array<{ title: string; ok: boolean; status: string }>): string {
  return JSON.stringify({
    suites: [
      {
        title: 'production-audit.spec.ts',
        specs: specs.map((s) => ({ title: s.title, ok: s.ok, tests: [{ results: [{ status: s.status }] }] })),
      },
    ],
  });
}

const SIX_PASS_THREE_SKIP = pwReport([
  { title: 'audit: public homepage', ok: true, status: 'passed' },
  { title: 'audit: login entry point + Firebase auth iframe', ok: true, status: 'passed' },
  { title: 'home page makes no localhost requests', ok: true, status: 'passed' },
  { title: 'no stale service worker remains registered', ok: true, status: 'passed' },
  { title: 'Firebase auth iframe is allowed by CSP', ok: true, status: 'passed' },
  { title: 'audit: admin login + preview', ok: true, status: 'passed' },
  { title: 'audit: public/shared project page', ok: true, status: 'skipped' },
  { title: 'audit: playlist lobby', ok: true, status: 'skipped' },
  { title: 'public content page loads banners/thumbnails', ok: true, status: 'skipped' },
]);

describe('summarizePlaywrightReport — totals', () => {
  it('counts passed / skipped / failed and lists failure titles', () => {
    const s = summarizePlaywrightReport(SIX_PASS_THREE_SKIP);
    expect(s).toMatchObject({ total: 9, passed: 6, skipped: 3, failed: 0 });
    expect(s.failures).toEqual([]);
  });

  it('a failed required test is counted and surfaces its title', () => {
    const s = summarizePlaywrightReport(
      pwReport([
        { title: 'audit: public homepage', ok: false, status: 'failed' },
        { title: 'audit: login entry point', ok: true, status: 'passed' },
      ]),
    );
    expect(s).toMatchObject({ total: 2, passed: 1, failed: 1, skipped: 0 });
    expect(s.failures).toEqual(['audit: public homepage']);
  });
});

describe('cmdPlaywrightSummary — a successful run creates the expected JSON file', () => {
  it('writes a stamped summary with passed/skipped/failed totals and run identity', () => {
    const report = join(dir, 'results.json');
    writeFileSync(report, SIX_PASS_THREE_SKIP);
    const out = join(dir, 'playwright-summary.json');

    const res = cmdPlaywrightSummary(ctx(), { reportFile: report, out, runId: 'rel-42-1', gitSha: 'a'.repeat(40) });
    expect(res.exitCode).toBe(0);
    expect(res.findings).toEqual([]); // 6 passed / 3 skipped is a valid success

    const doc = JSON.parse(readFileSync(out, 'utf8'));
    expect(doc.schema).toBe('flowvid.playwright-summary/v1');
    expect(doc).toMatchObject({ total: 9, passed: 6, skipped: 3, failed: 0, runId: 'rel-42-1', gitSha: 'a'.repeat(40) });
    expect(typeof doc.generatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(doc.generatedAt))).toBe(false);
  });

  it('skipped optional (credential-dependent) tests do not cause failure', () => {
    const report = join(dir, 'results.json');
    writeFileSync(report, SIX_PASS_THREE_SKIP);
    const res = cmdPlaywrightSummary(ctx(), { reportFile: report, out: join(dir, 'playwright-summary.json') });
    expect(res.exitCode).toBe(0);
    expect(res.summary.skipped).toBe(3);
  });

  it('a failed required test yields a CRITICAL finding and non-zero exit', () => {
    const report = join(dir, 'results.json');
    writeFileSync(report, pwReport([{ title: 'audit: public homepage', ok: false, status: 'failed' }]));
    const res = cmdPlaywrightSummary(ctx(), { reportFile: report, out: join(dir, 'playwright-summary.json') });
    expect(res.exitCode).toBe(1);
    expect(res.findings[0]).toMatchObject({ id: 'playwright.failures', severity: 'CRITICAL' });
  });

  it('fails closed (throws) when the JSON report is absent — never fabricates a clean 0-failure summary', () => {
    const out = join(dir, 'playwright-summary.json');
    expect(() => cmdPlaywrightSummary(ctx(), { reportFile: join(dir, 'does-not-exist.json'), out })).toThrow(/not found|fail closed/i);
    // Critically: no summary file is produced, so the gate below sees it as missing.
    expect(() => readFileSync(out, 'utf8')).toThrow();
  });
});

describe('checkRequiredEvidence — the gate refuses missing / stale / corrupt evidence', () => {
  const REQUIRED = ['vm-findings.json', 'endpoints.json', 'csp-client-web.json', 'csp-admin-web.json', 'browser-findings.json', 'playwright-summary.json'];

  function writeAllEvidence(overrides: Partial<Record<string, unknown>> = {}) {
    for (const name of REQUIRED) {
      if (name in overrides) continue;
      writeJsonFile(join(dir, name), name === 'playwright-summary.json'
        ? { schema: 'flowvid.playwright-summary/v1', runId: 'rel-NEW', gitSha: 'b'.repeat(40), total: 9, passed: 6, skipped: 3, failed: 0, failures: [], findings: [] }
        : { findings: [] });
    }
    for (const [name, value] of Object.entries(overrides)) {
      if (value !== undefined) writeJsonFile(join(dir, name), value);
    }
  }

  const files = () => REQUIRED.map((n) => join(dir, n));

  it('a missing required file is a CRITICAL finding', () => {
    writeAllEvidence({ 'playwright-summary.json': undefined }); // never written
    const findings = checkRequiredEvidence(files());
    expect(findings.some((f) => f.id === 'evidence.missing' && f.severity === 'CRITICAL')).toBe(true);
  });

  it('a malformed (non-JSON) required file is a CRITICAL finding', () => {
    writeAllEvidence();
    writeFileSync(join(dir, 'playwright-summary.json'), '{ this is not json');
    const findings = checkRequiredEvidence(files());
    expect(findings.some((f) => f.id === 'evidence.unreadable' && f.severity === 'CRITICAL')).toBe(true);
  });

  it('a summary from another RUN is rejected as stale', () => {
    writeAllEvidence({
      'playwright-summary.json': { schema: 'flowvid.playwright-summary/v1', runId: 'rel-OLD', gitSha: 'b'.repeat(40), total: 6, passed: 6, skipped: 0, failed: 0, failures: [], findings: [] },
    });
    const findings = checkRequiredEvidence(files(), { runId: 'rel-NEW', gitSha: 'b'.repeat(40) }, ['playwright-summary.json']);
    expect(findings.some((f) => f.id === 'evidence.stale-run' && f.severity === 'CRITICAL')).toBe(true);
  });

  it('a summary from another COMMIT is rejected as stale', () => {
    writeAllEvidence({
      'playwright-summary.json': { schema: 'flowvid.playwright-summary/v1', runId: 'rel-NEW', gitSha: 'c'.repeat(40), total: 6, passed: 6, skipped: 0, failed: 0, failures: [], findings: [] },
    });
    const findings = checkRequiredEvidence(files(), { runId: 'rel-NEW', gitSha: 'b'.repeat(40) }, ['playwright-summary.json']);
    expect(findings.some((f) => f.id === 'evidence.stale-commit' && f.severity === 'CRITICAL')).toBe(true);
  });

  it('an identity-bearing summary that carries NO identity is rejected (cannot prove freshness)', () => {
    writeAllEvidence({
      'playwright-summary.json': { total: 6, passed: 6, skipped: 0, failed: 0, failures: [], findings: [] },
    });
    const findings = checkRequiredEvidence(files(), { runId: 'rel-NEW', gitSha: 'b'.repeat(40) }, ['playwright-summary.json']);
    expect(findings.some((f) => f.id === 'evidence.no-identity')).toBe(true);
    expect(findings.some((f) => f.id === 'evidence.no-commit')).toBe(true);
  });

  it('current-run evidence with matching identity produces no findings', () => {
    writeAllEvidence();
    const findings = checkRequiredEvidence(files(), { runId: 'rel-NEW', gitSha: 'b'.repeat(40) }, ['playwright-summary.json']);
    expect(findings).toEqual([]);
  });

  it('non-identity-bearing evidence without a runId is NOT flagged (only the summary must be stamped)', () => {
    writeAllEvidence();
    // endpoints.json has no runId and is not identity-bearing.
    const findings = checkRequiredEvidence([join(dir, 'endpoints.json')], { runId: 'rel-NEW', gitSha: 'b'.repeat(40) }, ['playwright-summary.json']);
    expect(findings).toEqual([]);
  });
});

describe('cmdGate fail-closed — v0.1.5 reproduction (old behavior vs corrected)', () => {
  const REQUIRED = ['vm-findings.json', 'endpoints.json', 'csp-client-web.json', 'csp-admin-web.json', 'browser-findings.json', 'playwright-summary.json'];

  function seedCleanEvidenceExceptSummary() {
    for (const name of REQUIRED.filter((n) => n !== 'playwright-summary.json')) {
      writeJsonFile(join(dir, name), { findings: [] });
    }
    // playwright-summary.json deliberately NOT written — this is the ENOENT incident.
  }

  it('OLD behavior: without --require, a missing playwright-summary.json is silently tolerated (the bug)', () => {
    seedCleanEvidenceExceptSummary();
    const res = cmdGate(ctx(), {
      findingsFiles: REQUIRED.map((n) => join(dir, n)),
      phase: 'post-deploy',
    });
    // This is exactly why v0.1.5 published despite the ENOENT: the gate passed.
    expect(res.decision.blocked).toBe(false);
  });

  it('CORRECTED behavior: with --require, the missing summary BLOCKS the gate and demands rollback', () => {
    seedCleanEvidenceExceptSummary();
    const res = cmdGate(ctx(), {
      findingsFiles: REQUIRED.map((n) => join(dir, n)),
      requiredFiles: REQUIRED.map((n) => join(dir, n)),
      identityBearing: ['playwright-summary.json'],
      expect: { runId: 'rel-NEW', gitSha: 'b'.repeat(40) },
      phase: 'post-deploy',
      out: join(dir, 'gate.json'),
    });
    expect(res.exitCode).toBe(1);
    expect(res.decision.blocked).toBe(true);
    expect(res.decision.shouldRollback).toBe(true);
    expect(res.findings.some((f) => f.id === 'evidence.missing')).toBe(true);
  });

  it('SUCCESS fixture: a valid current-run summary + all evidence present passes the gate', () => {
    for (const name of REQUIRED.filter((n) => n !== 'playwright-summary.json')) {
      writeJsonFile(join(dir, name), { findings: [] });
    }
    writeJsonFile(join(dir, 'playwright-summary.json'), {
      schema: 'flowvid.playwright-summary/v1', runId: 'rel-NEW', gitSha: 'b'.repeat(40),
      total: 9, passed: 6, skipped: 3, failed: 0, failures: [], findings: [],
    });
    const res = cmdGate(ctx(), {
      findingsFiles: REQUIRED.map((n) => join(dir, n)),
      requiredFiles: REQUIRED.map((n) => join(dir, n)),
      identityBearing: ['playwright-summary.json'],
      expect: { runId: 'rel-NEW', gitSha: 'b'.repeat(40) },
      phase: 'post-deploy',
    });
    expect(res.exitCode).toBe(0);
    expect(res.decision.blocked).toBe(false);
  });

  it('a stale downloaded summary (wrong run) cannot count as current evidence', () => {
    for (const name of REQUIRED.filter((n) => n !== 'playwright-summary.json')) {
      writeJsonFile(join(dir, name), { findings: [] });
    }
    writeJsonFile(join(dir, 'playwright-summary.json'), {
      schema: 'flowvid.playwright-summary/v1', runId: 'rel-STALE', gitSha: 'b'.repeat(40),
      total: 6, passed: 6, skipped: 0, failed: 0, failures: [], findings: [],
    });
    const res = cmdGate(ctx(), {
      findingsFiles: REQUIRED.map((n) => join(dir, n)),
      requiredFiles: REQUIRED.map((n) => join(dir, n)),
      identityBearing: ['playwright-summary.json'],
      expect: { runId: 'rel-NEW', gitSha: 'b'.repeat(40) },
      phase: 'post-deploy',
    });
    expect(res.decision.blocked).toBe(true);
  });
});

// ── Static wiring: the workflow + Playwright config reference ONE canonical path ──
describe('release.yml wiring (the v0.1.5 ENOENT + fail-open fix)', () => {
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  const MONOREPO = join(HERE, '..', '..', '..', '..'); // …/podcast-saas
  const release = readFileSync(join(MONOREPO, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  const pwConfig = readFileSync(join(MONOREPO, 'client-web', 'playwright.config.ts'), 'utf8');

  it('Playwright emits the canonical JSON report at e2e-results/results.json', () => {
    expect(pwConfig).toMatch(/\['json',\s*\{\s*outputFile:\s*'e2e-results\/results\.json'\s*\}\]/);
  });

  it('the summary step reads an ABSOLUTE report path (no cwd-relative form that ENOENT-ed under ops/release)', () => {
    expect(release).toContain('${{ github.workspace }}/podcast-saas/client-web/e2e-results/results.json');
    // the exact broken form must never come back
    expect(release).not.toContain('--report client-web/e2e-results/results.json');
  });

  it('the summary is stamped with the current run id and commit', () => {
    expect(release).toMatch(/playwright-summary[\s\S]*?--run-id "\$RUN_ID"[\s\S]*?--git-sha "\$\{\{ needs\.plan\.outputs\.git_sha \}\}"/);
  });

  it('stale evidence is deleted BEFORE the browser run (no old artifact can satisfy the gate)', () => {
    const iReset = release.indexOf('rm -f "$ART/playwright-summary.json"');
    const iRmDir = release.indexOf('rm -rf e2e-results');
    const iTest = release.indexOf('npx playwright test');
    const iSummary = release.indexOf('release-cli playwright-summary');
    expect(iReset).toBeGreaterThan(-1);
    expect(iRmDir).toBeGreaterThan(-1);
    expect(iReset).toBeLessThan(iTest); // deleted before the run
    expect(iTest).toBeLessThan(iSummary); // run before summarize
  });

  it('the post-deploy gate REQUIRES every browser-evidence file and validates run identity (fail closed)', () => {
    for (const f of ['vm-findings.json', 'endpoints.json', 'csp-client-web.json', 'csp-admin-web.json', 'browser-findings.json', 'playwright-summary.json']) {
      expect(release, f).toContain(f);
    }
    expect(release).toMatch(/gate --phase post-deploy[\s\S]*?--require[\s\S]*?playwright-summary\.json/);
    expect(release).toMatch(/--identity-bearing playwright-summary\.json/);
    expect(release).toMatch(/--expect-run-id "\$RUN_ID"/);
    expect(release).toMatch(/--expect-git-sha "\$\{\{ needs\.plan\.outputs\.git_sha \}\}"/);
  });

  it('a blocked gate fails the deploy job, and publish requires that job to succeed (no RELEASE without evidence)', () => {
    // deploy job hard-fails on a blocked gate…
    expect(release).toMatch(/Fail the job if deployment or verification failed[\s\S]*?steps\.gate\.outcome == 'failure'[\s\S]*?exit 1/);
    // …and the publish (RELEASED) job only runs when deploy succeeded.
    expect(release).toMatch(/publish:[\s\S]*?needs\.deploy\.result == 'success'/);
  });
});
