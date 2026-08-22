import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdPlaywrightSummary, defaultContext, summarizePlaywrightReport } from '../commands.js';

/**
 * A RELEASE-BLOCKING FLOW THAT DID NOT RUN IS NOT A FLOW THAT PASSED.
 *
 * The production audit gates the deploy, and most of its checks are written
 * `test.skip(!process.env.SMOKE_PUBLIC_PATH, …)`. That is correct for a developer running the
 * suite by hand. In CI it meant an unset repository variable removed the check outright: the
 * spec reported `skipped`, the summary counted it, no finding was raised, the gate passed, and
 * the release deployed having verified nothing about that flow — with nothing anywhere red.
 *
 * These tests are the reason that is no longer possible. They matter most for the change the
 * owner asked for: with the Required Reviewer gone, this gate is the last thing between a
 * broken candidate and production, and "the check silently did not run" is precisely the
 * failure a human clicking Approve would also never have caught.
 */

/** A Playwright JSON report with the given spec outcomes. */
function report(specs: Array<{ title: string; status: 'passed' | 'failed' | 'skipped' }>): string {
  return JSON.stringify({
    suites: [
      {
        title: 'production-audit.spec.ts',
        specs: specs.map((s) => ({
          title: s.title,
          ok: s.status === 'passed',
          tests: [{ status: s.status, results: [{ status: s.status }] }],
        })),
      },
    ],
  });
}

function summarize(specs: Parameters<typeof report>[0], requireTests?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'flowvid-required-'));
  const file = join(dir, 'results.json');
  writeFileSync(file, report(specs));
  const ctx = { ...defaultContext(), log: () => {} };
  return cmdPlaywrightSummary(ctx, { reportFile: file, requireTests, out: join(dir, 'summary.json') });
}

const PASSING = [{ title: 'audit: public homepage', status: 'passed' as const }];

describe('a skipped release-blocking flow blocks the release', () => {
  it('CRITICAL when a required flow was skipped', () => {
    const { findings, exitCode } = summarize(
      [...PASSING, { title: 'audit: public/shared project page', status: 'skipped' }],
      ['public/shared project page'],
    );
    const f = findings.find((x) => x.id === 'playwright.required-skipped');
    expect(f, 'a skipped required flow raised no finding').toBeDefined();
    expect(f?.severity).toBe('CRITICAL');
    // The exit code is what the workflow step actually reacts to. A finding written into a file
    // that the process then exits 0 on is a finding nobody acts upon.
    expect(exitCode, 'the command exited 0 despite a CRITICAL finding').toBe(1);
  });

  it('CRITICAL when a required flow is absent from the report entirely', () => {
    // Not the same failure: a renamed or deleted spec produces no entry at all, and matching
    // only against `skippedTitles` would score that as fine.
    const { findings, exitCode } = summarize(PASSING, ['export request entry']);
    expect(findings.find((x) => x.id === 'playwright.required-missing')?.severity).toBe('CRITICAL');
    expect(exitCode).toBe(1);
  });

  it('passes when the required flow actually ran', () => {
    const { findings, exitCode } = summarize(
      [...PASSING, { title: 'audit: public/shared project page', status: 'passed' }],
      ['public/shared project page'],
    );
    expect(findings).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it('does not double-report a required flow that FAILED', () => {
    // It is already CRITICAL as a failure. Reporting it twice inflates the finding count and
    // makes the report read as two independent problems.
    const { findings } = summarize(
      [{ title: 'audit: public/shared project page', status: 'failed' }],
      ['public/shared project page'],
    );
    expect(findings.map((f) => f.id)).toEqual(['playwright.failures']);
  });

  it('unskipped, unrequired flows are still allowed to skip', () => {
    // Not every skip is a defect — a browser-specific spec legitimately skips. Only the flows
    // the caller NAMED are release-blocking, so this must stay quiet.
    const { findings, exitCode } = summarize([...PASSING, { title: 'some optional check', status: 'skipped' }]);
    expect(findings).toEqual([]);
    expect(exitCode).toBe(0);
  });
});

describe('the summary records which specs ran, not only how many', () => {
  it('separates passed from skipped by title', () => {
    const s = summarizePlaywrightReport(
      report([
        { title: 'ran', status: 'passed' },
        { title: 'did not run', status: 'skipped' },
      ]),
    );
    expect(s.passedTitles).toEqual(['ran']);
    expect(s.skippedTitles).toEqual(['did not run']);
    expect(s.skipped).toBe(1);
  });
});
