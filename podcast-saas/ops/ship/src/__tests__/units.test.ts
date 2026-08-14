import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runIdFromLink } from '../conductor.js';
import { Gh, isTerminalGhFailure } from '../gh.js';
import { Journal, readJournal } from '../journal.js';
import { nextActions, renderReport } from '../report.js';
import type { ExecResult } from '../run.js';
import { initStages, loadRun, markStage, newRunId, runPaths, saveRun, stage } from '../state.js';
import { SHIP_RUN_SCHEMA, type ShipRun } from '../types.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ship-test-'));
}

function fakeRun(over: Partial<ShipRun> = {}): ShipRun {
  return {
    schema: SHIP_RUN_SCHEMA,
    runId: 'ship-20260814T120000Z',
    dir: '/tmp/x',
    startedAt: '2026-08-14T12:00:00.000Z',
    verdict: 'RUNNING',
    inputs: {
      bump: 'patch',
      deploy: true,
      backfillPolicy: 'report-only',
      approveHigh: false,
      audit: true,
      autoApprove: false,
      mergeMethod: 'merge',
      baseBranch: 'main',
    },
    git: { branch: 'feat/x', headSha: 'a'.repeat(40) },
    stages: initStages(),
    ...over,
  };
}

describe('journal', () => {
  it('numbers events monotonically and keeps counting across a resume', () => {
    const dir = tmp();
    const file = join(dir, 'ship.ndjson');
    const j1 = new Journal(file, () => {});
    j1.emit({ stage: 'run', event: 'run.start', msg: 'one' });
    j1.emit({ stage: 'ci', event: 'stage.start', msg: 'two' });

    // A second conductor process attaching to the same run must not restart the
    // sequence, or event order stops being total.
    const j2 = new Journal(file, () => {});
    j2.emit({ stage: 'ci', event: 'stage.ok', msg: 'three' });

    const events = readJournal(file);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.line.split('] ')[1])).toEqual(['one', 'two', 'three']);
  });

  it('marks progress as non-notifying and everything else as notifying', () => {
    const file = join(tmp(), 'ship.ndjson');
    const j = new Journal(file, () => {});
    j.emit({ stage: 'ci', event: 'progress', msg: 'still building' });
    j.emit({ stage: 'ci', event: 'stage.fail', level: 'error', msg: 'red' });
    j.emit({ stage: 'ci', event: 'progress', msg: 'a job failed', notify: true });

    const [progress, failure, loudProgress] = readJournal(file);
    expect(progress.notify).toBe(false);
    expect(failure.notify).toBe(true);
    expect(loudProgress.notify).toBe(true);
  });

  it('renders a line the watcher can print verbatim', () => {
    const file = join(tmp(), 'ship.ndjson');
    new Journal(file, () => {}).emit({ stage: 'deploy', event: 'stage.ok', msg: 'v0.1.9 deployed' });
    expect(readJournal(file)[0].line).toMatch(/^\d{2}:\d{2}:\d{2} · \[deploy] v0\.1\.9 deployed$/);
  });

  it('survives a corrupt line rather than losing the whole journal', () => {
    const file = join(tmp(), 'ship.ndjson');
    const j = new Journal(file, () => {});
    j.emit({ stage: 'run', event: 'run.start', msg: 'ok' });
    writeFileSync(file, `${readFileSync(file, 'utf8')}{not json\n`, 'utf8');
    expect(readJournal(file)).toHaveLength(1);
  });
});

describe('run state', () => {
  it('round-trips through disk', () => {
    const root = tmp();
    const paths = runPaths(root, 'ship-20260814T120000Z');
    const run = fakeRun({ dir: paths.dir });
    saveRun(paths, run);
    expect(loadRun(paths)).toEqual(run);
  });

  it('rejects a state file written by a different schema version', () => {
    const root = tmp();
    const paths = runPaths(root, 'ship-1');
    saveRun(paths, fakeRun());
    writeFileSync(paths.stateFile, JSON.stringify({ schema: 'flowvid.ship-run/v0' }), 'utf8');
    expect(loadRun(paths)).toBeNull();
  });

  it('stamps start and end times exactly once per stage', () => {
    const run = fakeRun();
    markStage(run, 'ci', 'running');
    const started = stage(run, 'ci').startedAt;
    markStage(run, 'ci', 'running');
    expect(stage(run, 'ci').startedAt).toBe(started);
    markStage(run, 'ci', 'passed', 'green');
    expect(stage(run, 'ci').endedAt).toBeDefined();
    expect(stage(run, 'ci').note).toBe('green');
  });

  it('produces sortable run ids', () => {
    expect(newRunId(new Date('2026-08-14T16:45:00.123Z'))).toBe('ship-20260814T164500Z');
    expect(newRunId(new Date('2026-01-02T03:04:05Z')) < newRunId(new Date('2026-01-02T03:04:06Z'))).toBe(true);
  });
});

describe('gh failure classification', () => {
  it('treats auth, permission and not-found as settled answers', () => {
    expect(isTerminalGhFailure('HTTP 404: Not Found')).toBe(true);
    expect(isTerminalGhFailure('gh: Resource not accessible by integration')).toBe(true);
    expect(isTerminalGhFailure('You must be authenticated')).toBe(true);
  });

  it('treats network noise as retryable', () => {
    expect(isTerminalGhFailure('dial tcp: lookup api.github.com: no such host')).toBe(true); // "no such" — settled DNS answer
    expect(isTerminalGhFailure('connection reset by peer')).toBe(false);
    expect(isTerminalGhFailure('HTTP 502: Bad Gateway')).toBe(false);
    expect(isTerminalGhFailure('context deadline exceeded')).toBe(false);
  });
});

describe('gh pr checks', () => {
  const rows = JSON.stringify([{ name: 'CI / build', state: 'IN_PROGRESS', bucket: 'pending', link: 'https://github.com/o/r/actions/runs/99/job/1' }]);

  function ghWith(res: Partial<ExecResult>): Gh {
    return new Gh({
      repo: 'o/r',
      cwd: '/tmp',
      runner: async () => ({ code: 0, stdout: '', stderr: '', ...res }),
    });
  }

  it('reads the JSON even though gh exits non-zero while checks are pending', async () => {
    // gh exits 8 for "pending" and 1 for "failing". Both are answers, not errors —
    // reading the exit code as a failure would abort every run still in progress.
    expect(await ghWith({ code: 8, stdout: rows }).prChecks(1)).toHaveLength(1);
    expect(await ghWith({ code: 1, stdout: rows }).prChecks(1)).toHaveLength(1);
  });

  it('returns an empty list when no checks exist yet', async () => {
    expect(await ghWith({ code: 1, stdout: '', stderr: 'no checks reported on the branch' }).prChecks(1)).toEqual([]);
  });

  it('throws rather than inventing an answer when gh genuinely breaks', async () => {
    await expect(ghWith({ code: 1, stdout: '', stderr: 'connection refused' }).prChecks(1)).rejects.toThrow(/connection refused/);
  });
});

describe('runIdFromLink', () => {
  it('extracts the run id from a check link', () => {
    expect(runIdFromLink('https://github.com/0feklevy/cebu/actions/runs/31805830592/job/123')).toBe(31805830592);
  });
  it('returns null for anything else', () => {
    expect(runIdFromLink('https://github.com/o/r/pull/3')).toBeNull();
    expect(runIdFromLink('')).toBeNull();
  });
});

describe('report', () => {
  it('leads with the verdict and never calls a blocked shipment shipped', () => {
    const run = fakeRun({
      verdict: 'BLOCKED',
      endedAt: '2026-08-14T12:10:00.000Z',
      failure: { stage: 'ci', kind: 'ci-red', summary: 'CI failed on PR #27: Release verification gate', evidence: ['ci/failed.log'] },
    });
    const md = renderReport(run, 'o/r');
    expect(md).toContain('Blocked at `ci`');
    expect(md).toContain('ci/failed.log');
    expect(md).not.toContain('Shipped');
  });

  it('separates a blocked gate from a broken pipeline in its wording', () => {
    const blocked = renderReport(fakeRun({ verdict: 'BLOCKED', failure: { stage: 'deploy', kind: 'gate-blocked', summary: 's', evidence: [] } }), 'o/r');
    const failed = renderReport(fakeRun({ verdict: 'FAILED', failure: { stage: 'audit', kind: 'audit-error', summary: 's', evidence: [] } }), 'o/r');
    expect(blocked).toContain('a gate said no');
    expect(failed).toContain('could not produce a trustworthy answer');
  });

  it('says so explicitly when a failure produced no evidence', () => {
    const md = renderReport(fakeRun({ verdict: 'FAILED', failure: { stage: 'release', kind: 'conductor', summary: 's', evidence: [] } }), 'o/r');
    expect(md).toContain('No evidence files were collected');
  });

  it('gives every failure kind a concrete next action', () => {
    const kinds = [
      'ci-red', 'merge-conflict', 'release-verify', 'build-images', 'gate-blocked',
      'deploy-failed', 'audit-findings', 'audit-error', 'approval-denied', 'conductor',
    ] as const;
    for (const kind of kinds) {
      const actions = nextActions(fakeRun({ failure: { stage: 'ci', kind, summary: 's', evidence: [] } }), 'o/r');
      expect(actions.length, kind).toBeGreaterThan(0);
    }
  });

  it('never recommends re-running until green or approving findings away', () => {
    const all = (['gate-blocked', 'audit-findings', 'audit-error'] as const).flatMap((kind) =>
      nextActions(fakeRun({ failure: { stage: 'deploy', kind, summary: 's', evidence: [] } }), 'o/r'),
    );
    expect(all.join(' ')).not.toMatch(/just re-run|try again until|--approve-high` to get past/i);
  });
});
