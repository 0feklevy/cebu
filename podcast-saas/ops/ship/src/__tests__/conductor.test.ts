/**
 * Conductor behaviour, driven by fakes.
 *
 * These are the tests that matter most: this code merges pull requests and approves
 * production deployments, so the properties asserted here are safety properties, not
 * conveniences. In particular — a red CI must never reach the merge stage, an
 * unverifiable audit must never resolve to green, and a resume must never repeat a
 * side effect that already happened.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Conductor, newShipRun } from '../conductor.js';
import { SHIP_CONFIG, type ShipConfig } from '../config.js';
import type { CheckRow, Gh, JobSummary, PendingDeployment, PrSummary, WorkflowRunSummary } from '../gh.js';
import type { Git } from '../git.js';
import { Journal } from '../journal.js';
import { initStages, loadRun, runPaths, type RunPaths } from '../state.js';
import type { ShipInputs, ShipRun } from '../types.js';

const MERGE_SHA = 'm'.repeat(40);
const HEAD_SHA = 'h'.repeat(40);
const RELEASE_RUN = 900001;
const AUDIT_RUN = 900002;
const CI_RUN = 900003;

const FAST: ShipConfig = {
  ...SHIP_CONFIG,
  repo: 'o/r',
  poll: { ...SHIP_CONFIG.poll, intervalMs: 1, approvalIntervalMs: 1, dispatchAppearMs: 200, ciTimeoutMs: 5_000, releaseTimeoutMs: 5_000, auditTimeoutMs: 5_000, approvalTimeoutMs: 2_000 },
};

interface FakeOptions {
  checks?: CheckRow[];
  releaseJobs?: JobSummary[];
  releaseConclusion?: string;
  auditVerdict?: { verdict: string; reasons?: string[] } | null;
  auditConclusion?: string;
  gateJson?: unknown;
  stateJson?: unknown;
  mainCiConclusion?: string;
}

class FakeGh {
  approved = false;
  rejected = false;
  prCreated = 0;
  merges = 0;
  dispatches: string[] = [];
  reviews: { state: string }[] = [];
  private pr: PrSummary | null = null;
  private merged = false;

  constructor(private readonly o: FakeOptions = {}) {}

  async authLogin() { return 'tester'; }
  async repoInfo() { return { defaultBranch: 'main', visibility: 'public', allowMergeCommit: true, allowSquashMerge: true }; }

  async findPr(): Promise<PrSummary | null> { return this.pr; }
  async createPr(): Promise<string> {
    this.prCreated++;
    this.pr = { number: 27, url: 'https://github.com/o/r/pull/27', headRefOid: HEAD_SHA, state: 'OPEN', isDraft: false };
    return this.pr.url;
  }
  async readyPr(): Promise<void> {}
  async viewPr() {
    return {
      ...(this.pr as PrSummary),
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      mergedAt: this.merged ? '2026-08-14T12:00:00Z' : null,
      mergeCommit: this.merged ? { oid: MERGE_SHA } : null,
    };
  }
  async mergePr(): Promise<void> {
    this.merges++;
    this.merged = true;
  }
  async prChecks(): Promise<CheckRow[]> {
    return this.o.checks ?? [{ name: 'Release verification gate', state: 'SUCCESS', bucket: 'pass', link: `https://github.com/o/r/actions/runs/${CI_RUN}/job/1` }];
  }

  async branchSha(): Promise<string> { return MERGE_SHA; }

  async listRuns(args: { workflow?: string; event?: string }): Promise<WorkflowRunSummary[]> {
    const now = new Date().toISOString();
    if (args.workflow === FAST.workflows.ci) {
      return [{ databaseId: CI_RUN, createdAt: now, headSha: MERGE_SHA, status: 'completed', conclusion: this.o.mainCiConclusion ?? 'success', url: `https://github.com/o/r/actions/runs/${CI_RUN}`, event: 'push' }];
    }
    if (args.workflow === FAST.workflows.release) {
      return [{ databaseId: RELEASE_RUN, createdAt: now, headSha: MERGE_SHA, status: 'in_progress', conclusion: null, url: `https://github.com/o/r/actions/runs/${RELEASE_RUN}`, event: 'workflow_dispatch' }];
    }
    return [{ databaseId: AUDIT_RUN, createdAt: now, headSha: MERGE_SHA, status: 'completed', conclusion: 'success', url: `https://github.com/o/r/actions/runs/${AUDIT_RUN}`, event: 'workflow_dispatch' }];
  }

  async viewRun(runId: number): Promise<WorkflowRunSummary & { jobs: JobSummary[] }> {
    const base = { databaseId: runId, createdAt: '2026-08-14T12:00:00Z', headSha: MERGE_SHA, url: `https://github.com/o/r/actions/runs/${runId}`, event: 'workflow_dispatch' };
    if (runId === AUDIT_RUN) {
      return { ...base, status: 'completed', conclusion: this.o.auditConclusion ?? 'success', jobs: [{ name: 'Audit production (read-only)', status: 'completed', conclusion: this.o.auditConclusion ?? 'success' }] };
    }
    // The release run parks on the environment gate until it is approved.
    if (!this.approved) {
      return { ...base, status: 'waiting', conclusion: null, jobs: [{ name: 'Manifest, tag & draft release', status: 'completed', conclusion: 'success' }] };
    }
    return {
      ...base,
      status: 'completed',
      conclusion: this.o.releaseConclusion ?? 'success',
      jobs: this.o.releaseJobs ?? [
        { name: 'Deploy to production (digest-pinned)', status: 'completed', conclusion: 'success' },
        { name: 'Publish GitHub release', status: 'completed', conclusion: 'success' },
      ],
    };
  }

  async dispatchWorkflow(file: string): Promise<void> { this.dispatches.push(file); }
  async failedLog(): Promise<string> { return 'FAIL step output\n'; }
  async listArtifactNames(runId: number): Promise<string[]> {
    return runId === AUDIT_RUN ? [`production-audit-${AUDIT_RUN}`] : ['release-report', 'release-artifacts'];
  }
  async downloadArtifact(runId: number, _name: string, dest: string): Promise<boolean> {
    mkdirSync(dest, { recursive: true });
    if (runId === AUDIT_RUN) {
      if (this.o.auditVerdict === null) return true; // downloaded, but no verdict inside
      writeFileSync(join(dest, 'audit-verdict.json'), JSON.stringify(this.o.auditVerdict ?? { verdict: 'PASS' }), 'utf8');
      return true;
    }
    writeFileSync(join(dest, 'release-report.json'), JSON.stringify({ version: 'v0.2.0', previousVersion: 'v0.1.9' }), 'utf8');
    writeFileSync(join(dest, 'plan.json'), JSON.stringify({ nextTag: 'v0.2.0' }), 'utf8');
    if (this.o.gateJson) writeFileSync(join(dest, 'gate.json'), JSON.stringify(this.o.gateJson), 'utf8');
    if (this.o.stateJson) writeFileSync(join(dest, 'state.json'), JSON.stringify(this.o.stateJson), 'utf8');
    return true;
  }

  async pendingDeployments(): Promise<PendingDeployment[]> {
    if (this.approved || this.rejected) return [];
    return [{ environmentName: 'production', environmentId: 42, currentUserCanApprove: true, waitTimerStartedAt: null }];
  }
  async reviewDeployment(_runId: number, _ids: number[], state: 'approved' | 'rejected'): Promise<void> {
    this.reviews.push({ state });
    if (state === 'approved') this.approved = true;
    else this.rejected = true;
  }
}

class FakeGit {
  pushes = 0;
  constructor(private readonly dirty = false) {}
  async currentBranch() { return 'feat/x'; }
  async headSha() { return HEAD_SHA; }
  async isDirty() { return this.dirty; }
  async untrackedCount() { return 0; }
  async fetch() {}
  async unpushedCount() { return 0; }
  async push() { this.pushes++; }
  async subject() { return 'feat: a thing'; }
  async commitsSince() { return ['feat: a thing']; }
  async changedFiles() { return ['podcast-saas/backend-api/src/x.ts']; }
  async remoteExists() { return true; }
}

function inputs(over: Partial<ShipInputs> = {}): ShipInputs {
  return {
    bump: 'patch',
    deploy: true,
    backfillPolicy: 'report-only',
    approveHigh: false,
    audit: true,
    autoApprove: true,
    mergeMethod: 'merge',
    baseBranch: 'main',
    ...over,
  };
}

let root: string;
let paths: RunPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ship-cond-'));
  paths = runPaths(root, 'ship-20260814T120000Z');
});

async function ship(gh: FakeGh, over: Partial<ShipInputs> = {}, git = new FakeGit()): Promise<ShipRun> {
  const run = newShipRun({ runId: 'ship-20260814T120000Z', dir: paths.dir, inputs: inputs(over), branch: 'feat/x', headSha: HEAD_SHA, stages: initStages() });
  return new Conductor({
    gh: gh as unknown as Gh,
    git: git as unknown as Git,
    journal: new Journal(paths.journalFile, () => {}),
    paths,
    config: FAST,
    run,
  }).ship();
}

describe('happy path', () => {
  it('takes a branch from PR to audited release', async () => {
    const gh = new FakeGh();
    const run = await ship(gh);

    expect(run.verdict).toBe('SHIPPED');
    expect(run.pr?.number).toBe(27);
    expect(run.pr?.merged).toBe(true);
    expect(run.release?.version).toBe('v0.2.0');
    expect(run.audit?.verdict).toBe('PASS');
    expect(gh.dispatches).toEqual([FAST.workflows.release, FAST.workflows.audit]);
    expect(run.stages.filter((s) => s.status === 'failed' || s.status === 'blocked')).toHaveLength(0);
  });

  it('writes SHIP-REPORT.md and a readable ship.json', async () => {
    await ship(new FakeGh());
    expect(existsSync(paths.reportFile)).toBe(true);
    expect(loadRun(paths)?.verdict).toBe('SHIPPED');
  });
});

describe('a red gate stops the shipment', () => {
  it('never merges when CI fails, and collects the failed log', async () => {
    const gh = new FakeGh({
      checks: [{ name: 'Release verification gate', state: 'FAILURE', bucket: 'fail', link: `https://github.com/o/r/actions/runs/${CI_RUN}/job/1` }],
    });
    const run = await ship(gh);

    expect(run.verdict).toBe('BLOCKED');
    expect(run.failure?.kind).toBe('ci-red');
    expect(gh.merges).toBe(0); // the safety property
    expect(gh.dispatches).toHaveLength(0);
    expect(run.failure?.evidence).toContain('ci/failed.log');
  });

  it('treats a cancelled check as red, not as pending forever', async () => {
    const gh = new FakeGh({
      checks: [{ name: 'Release verification gate', state: 'CANCELLED', bucket: 'cancel', link: `https://github.com/o/r/actions/runs/${CI_RUN}/job/1` }],
    });
    expect((await ship(gh)).failure?.kind).toBe('ci-red');
    expect(gh.merges).toBe(0);
  });

  it('reports a blocked post-deploy gate as BLOCKED with the rollback stated', async () => {
    const gh = new FakeGh({
      releaseConclusion: 'failure',
      releaseJobs: [{ name: 'Deploy to production (digest-pinned)', status: 'completed', conclusion: 'failure' }],
      gateJson: { blocked: true, shouldRollback: true, phase: 'post-deploy', counts: { critical: 1, high: 0, warning: 2 } },
      stateJson: { state: 'ROLLED_BACK' },
    });
    const run = await ship(gh);
    expect(run.verdict).toBe('BLOCKED');
    expect(run.failure?.kind).toBe('gate-blocked');
    expect(run.failure?.summary).toMatch(/rolled back/i);
    expect(gh.dispatches).not.toContain(FAST.workflows.audit); // nothing new to audit
  });
});

describe('the audit verdict is never smoothed over', () => {
  it('classifies BLOCKED_BY_FINDINGS as a blocked shipment (production violates policy)', async () => {
    const run = await ship(new FakeGh({ auditVerdict: { verdict: 'BLOCKED_BY_FINDINGS', reasons: ['csp frame-src missing'] } }));
    expect(run.verdict).toBe('BLOCKED');
    expect(run.failure?.kind).toBe('audit-findings');
  });

  it('classifies BLOCKED_BY_AUDIT_ERROR as FAILED — unknown must never resolve to green', async () => {
    const run = await ship(new FakeGh({ auditVerdict: { verdict: 'BLOCKED_BY_AUDIT_ERROR' } }));
    expect(run.verdict).toBe('FAILED');
    expect(run.failure?.kind).toBe('audit-error');
    expect(run.failure?.summary).toMatch(/UNKNOWN/);
  });

  it('refuses to call a missing verdict artifact a pass', async () => {
    const run = await ship(new FakeGh({ auditVerdict: null }));
    expect(run.verdict).toBe('FAILED');
    expect(run.failure?.kind).toBe('audit-error');
  });
});

describe('the approval gate', () => {
  it('auto-approves only when explicitly asked', async () => {
    const gh = new FakeGh();
    await ship(gh, { autoApprove: true });
    expect(gh.reviews).toEqual([{ state: 'approved' }]);
  });

  it('rejects the deployment and aborts when DENY arrives while it waits', async () => {
    const gh = new FakeGh();
    // The decision must land *during* the wait — that is the only kind of decision
    // that can be about this deployment.
    const decide = setTimeout(() => {
      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(paths.denyFile, 'no\n', 'utf8');
    }, 50);
    const run = await ship(gh, { autoApprove: false });
    clearTimeout(decide);

    expect(run.verdict).toBe('ABORTED');
    expect(gh.reviews).toEqual([{ state: 'rejected' }]);
    expect(gh.dispatches).not.toContain(FAST.workflows.audit);
  });

  it('approves when APPROVE arrives while it waits', async () => {
    const gh = new FakeGh();
    const decide = setTimeout(() => {
      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(paths.approveFile, 'go\n', 'utf8');
    }, 50);
    const run = await ship(gh, { autoApprove: false });
    clearTimeout(decide);

    expect(run.verdict).toBe('SHIPPED');
    expect(gh.reviews).toEqual([{ state: 'approved' }]);
  });

  it('ignores handshake files left behind by an earlier shipment', async () => {
    // Both files exist before the gate is reached, so neither can be a decision about
    // THIS deployment. Honouring the APPROVE would deploy to production by accident.
    const gh = new FakeGh();
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.approveFile, 'stale\n', 'utf8');
    writeFileSync(paths.denyFile, 'stale\n', 'utf8');
    const run = await ship(gh, { autoApprove: false });

    expect(run.verdict).toBe('FAILED');
    expect(run.failure?.summary).toMatch(/no approval decision/i);
    expect(gh.reviews).toHaveLength(0);
  });
});

describe('preflight refuses unsafe starting conditions', () => {
  it('will not ship a dirty working tree', async () => {
    const gh = new FakeGh();
    const run = await ship(gh, {}, new FakeGit(true));
    expect(run.verdict).toBe('FAILED');
    expect(run.failure?.summary).toMatch(/uncommitted changes/);
    expect(gh.prCreated).toBe(0);
  });
});

describe('resume', () => {
  it('does not re-create the PR, re-merge, or dispatch a second release', async () => {
    const gh = new FakeGh();
    const first = await ship(gh);
    expect(first.verdict).toBe('SHIPPED');

    const again = await new Conductor({
      gh: gh as unknown as Gh,
      git: new FakeGit() as unknown as Git,
      journal: new Journal(paths.journalFile, () => {}),
      paths,
      config: FAST,
      run: loadRun(paths)!,
    }).ship();

    expect(again.verdict).toBe('SHIPPED');
    expect(gh.prCreated).toBe(1);
    expect(gh.merges).toBe(1);
    expect(gh.dispatches).toHaveLength(2); // still just the one release + one audit
  });

  it('retries a failed stage and can turn a blocked shipment green', async () => {
    const red = new FakeGh({ checks: [{ name: 'CI', state: 'FAILURE', bucket: 'fail', link: `https://github.com/o/r/actions/runs/${CI_RUN}/job/1` }] });
    const blocked = await ship(red);
    expect(blocked.verdict).toBe('BLOCKED');

    // The developer pushed a fix; CI is green now. The same run directory continues.
    const green = new FakeGh();
    await green.createPr(); // the PR already exists from the first attempt
    const resumed = await new Conductor({
      gh: green as unknown as Gh,
      git: new FakeGit() as unknown as Git,
      journal: new Journal(paths.journalFile, () => {}),
      paths,
      config: FAST,
      run: loadRun(paths)!,
    }).ship();

    expect(resumed.verdict).toBe('SHIPPED');
    expect(resumed.failure).toBeUndefined();
  });
});
