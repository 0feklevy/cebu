/**
 * The conductor — one shipment, start to finish.
 *
 * It drives the existing GitHub workflows from outside and never replaces them. Every
 * decision that matters (does this build pass, is this migration safe, should this roll
 * back) stays inside the deterministic release engine; the conductor only sequences the
 * dispatches, watches the results, and writes down what happened.
 *
 * Two invariants shape the code below:
 *
 *   • **Silence is never success.** Every wait has a ceiling, and hitting one is a
 *     FAILED verdict, not a pass. A stage that cannot observe its own outcome says so.
 *   • **Resumable.** Each stage first asks GitHub what already exists — an open PR, a
 *     merged branch, a release run for this commit — so re-running `ship` after a
 *     laptop sleeps continues rather than duplicating side effects.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectRunEvidence, errText, readArtifact } from './collect.js';
import {
  RELEASE_JOB_DEPLOY,
  RELEASE_JOB_PUBLISH,
  releaseJobFailureKind,
  type ShipConfig,
} from './config.js';
import type { Gh, JobSummary } from './gh.js';
import type { Git } from './git.js';
import type { Journal } from './journal.js';
import { writeReport } from './report.js';
import { sleep } from './run.js';
import { markStage, saveRun, stage, type RunPaths } from './state.js';
import { SHIP_RUN_SCHEMA, type FailureKind, type ShipFailure, type ShipRun, type ShipStageName } from './types.js';

/** Thrown to unwind a shipment. Carries everything the report needs. */
export class StageFailure extends Error {
  constructor(
    readonly stage: ShipStageName,
    readonly kind: FailureKind,
    readonly summary: string,
    readonly extra: Partial<ShipFailure> = {},
  ) {
    super(summary);
    this.name = 'StageFailure';
  }
}

/** A human declined at the approval gate. Not a failure — an intentional stop. */
export class Aborted extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'Aborted';
  }
}

export interface ConductorDeps {
  gh: Gh;
  git: Git;
  journal: Journal;
  paths: RunPaths;
  config: ShipConfig;
  run: ShipRun;
  signal?: AbortSignal;
}

export class Conductor {
  constructor(private readonly d: ConductorDeps) {}

  private get run(): ShipRun {
    return this.d.run;
  }

  private save(): void {
    saveRun(this.d.paths, this.run);
  }

  private begin(name: ShipStageName, msg: string): void {
    markStage(this.run, name, 'running');
    this.save();
    this.d.journal.emit({ stage: name, event: 'stage.start', msg });
  }

  private ok(name: ShipStageName, msg: string): void {
    markStage(this.run, name, 'passed', msg);
    this.save();
    this.d.journal.emit({ stage: name, event: 'stage.ok', msg });
  }

  private skip(name: ShipStageName, msg: string): void {
    markStage(this.run, name, 'skipped', msg);
    this.save();
    this.d.journal.emit({ stage: name, event: 'stage.skip', msg });
  }

  private progress(name: ShipStageName, msg: string, data?: Record<string, unknown>): void {
    this.d.journal.emit({ stage: name, event: 'progress', msg, data });
  }

  /**
   * Resume guard. A stage that already reached a terminal *good* status is never
   * re-entered — that is what makes `ship resume` safe to run repeatedly against a
   * pipeline whose side effects (opening a PR, merging, dispatching a release) are
   * not idempotent. Failed and blocked stages are retried, which is the whole point
   * of resuming.
   */
  private done(name: ShipStageName): boolean {
    const s = stage(this.run, name).status;
    if (s !== 'passed' && s !== 'skipped') return false;
    this.d.journal.emit({ stage: name, event: 'progress', msg: `already ${s} — not re-running`, notify: false });
    return true;
  }

  private warn(name: ShipStageName, msg: string): void {
    this.d.journal.emit({ stage: name, event: 'progress', level: 'warn', msg, notify: true });
  }

  // ── the pipeline ──────────────────────────────────────────────────────────────

  async ship(): Promise<ShipRun> {
    this.d.journal.emit({
      stage: 'run',
      event: 'run.start',
      msg: `shipping ${this.run.git.branch} → ${this.run.inputs.baseBranch} (bump=${this.run.inputs.bump}, deploy=${this.run.inputs.deploy}, audit=${this.run.inputs.audit})`,
      data: { runId: this.run.runId, dir: this.d.paths.dir },
    });
    // A resume starts from a clean slate for the verdict: the previous failure is
    // history, and leaving it in place would let a successful retry still report red.
    this.run.verdict = 'RUNNING';
    delete this.run.failure;
    delete this.run.endedAt;
    for (const s of this.run.stages) {
      if (s.status === 'failed' || s.status === 'blocked' || s.status === 'running') {
        s.status = 'pending';
        delete s.startedAt;
        delete s.endedAt;
        delete s.note;
      }
    }
    this.save();
    try {
      await this.stagePreflight();
      await this.stagePr();
      await this.stageCi();
      await this.stageMerge();
      await this.stageMainCi();
      await this.stageRelease();
      await this.stageApproval();
      await this.stageDeploy();
      await this.stageAudit();
      this.run.verdict = 'SHIPPED';
    } catch (err) {
      if (err instanceof Aborted) {
        this.run.verdict = 'ABORTED';
        this.run.failure = {
          stage: 'approval',
          kind: 'approval-denied',
          summary: err.reason,
          evidence: [],
        };
      } else if (err instanceof StageFailure) {
        // A gate saying no is BLOCKED (fix the code); anything else is FAILED
        // (fix the pipeline, and draw no conclusion about the product).
        this.run.verdict = BLOCKING_KINDS.has(err.kind) ? 'BLOCKED' : 'FAILED';
        this.run.failure = {
          stage: err.stage,
          kind: err.kind,
          summary: err.summary,
          evidence: err.extra.evidence ?? [],
          workflowUrl: err.extra.workflowUrl,
          failedJobs: err.extra.failedJobs,
        };
        markStage(this.run, err.stage, this.run.verdict === 'BLOCKED' ? 'blocked' : 'failed', err.summary);
        this.d.journal.emit({
          stage: err.stage,
          event: 'stage.fail',
          level: 'error',
          msg: err.summary,
          data: { kind: err.kind, evidence: this.run.failure.evidence, workflowUrl: err.extra.workflowUrl },
        });
      } else if (isAbort(err)) {
        // Ctrl-C. Nothing on GitHub is affected — the runs keep going without us — so
        // this must not be reported as a failed release. If we were parked on the
        // approval gate, that is still exactly where the shipment stands.
        const atApproval = stage(this.run, 'approval').status === 'running';
        this.run.verdict = atApproval ? 'AWAITING_APPROVAL' : 'FAILED';
        const msg = atApproval
          ? 'interrupted while waiting for approval — the release run is still parked on the production gate; `pnpm ship resume` re-attaches'
          : 'interrupted by the operator — the GitHub runs are unaffected; `pnpm ship resume` re-attaches';
        if (!atApproval) {
          this.run.failure = { stage: currentStage(this.run) ?? 'preflight', kind: 'conductor', summary: msg, evidence: [] };
        }
        this.d.journal.emit({ stage: 'run', event: 'progress', level: 'warn', msg, notify: true });
      } else {
        this.run.verdict = 'FAILED';
        this.run.failure = {
          stage: currentStage(this.run) ?? 'preflight',
          kind: 'conductor',
          summary: `the conductor itself failed: ${errText(err)}`,
          evidence: [],
        };
        this.d.journal.emit({ stage: 'run', event: 'stage.fail', level: 'error', msg: this.run.failure.summary });
      }
    }
    this.run.endedAt = new Date().toISOString();

    // The report is written unconditionally, including after a conductor crash — a
    // shipment with no explanation is worse than a failed one.
    markStage(this.run, 'report', 'running');
    try {
      writeReport(this.d.paths.reportFile, this.run, this.d.config.repo);
      markStage(this.run, 'report', 'passed', 'SHIP-REPORT.md written');
    } catch (err) {
      markStage(this.run, 'report', 'failed', `could not write SHIP-REPORT.md: ${errText(err)}`);
    }
    this.save();

    const level = this.run.verdict === 'SHIPPED' ? 'info' : this.run.verdict === 'AWAITING_APPROVAL' ? 'action' : 'error';
    this.d.journal.emit({
      stage: 'run',
      event: 'run.end',
      level,
      msg: `${this.run.verdict}${this.run.failure ? ` — ${this.run.failure.summary}` : ''}`,
      data: {
        verdict: this.run.verdict,
        version: this.run.release?.version,
        report: this.d.paths.reportFile,
        failure: this.run.failure,
      },
    });
    return this.run;
  }

  // ── 1. preflight ──────────────────────────────────────────────────────────────

  private async stagePreflight(): Promise<void> {
    // Deliberately NOT guarded by done(): preflight is pure observation, and a resume
    // must re-verify that the tree is still clean and the branch still pushed.
    this.begin('preflight', 'checking the working tree, the remote, and gh access');
    const { git, gh, config } = this.d;

    const branch = await git.currentBranch();
    if (config.protectedBranches.includes(branch)) {
      throw new StageFailure('preflight', 'conductor', `refusing to ship from ${branch} — start a feature branch first`);
    }
    if (branch === 'HEAD') {
      throw new StageFailure('preflight', 'conductor', 'detached HEAD — check out a branch before shipping');
    }

    if (await git.isDirty()) {
      throw new StageFailure(
        'preflight',
        'conductor',
        'the working tree has uncommitted changes to tracked files — commit or stash them, then run ship again',
      );
    }
    const untracked = await git.untrackedCount();
    if (untracked > 0) {
      this.warn('preflight', `${untracked} untracked file(s) will NOT be part of this release`);
    }

    const login = await gh.authLogin();
    const repo = await gh.repoInfo();
    if (repo.defaultBranch !== this.run.inputs.baseBranch) {
      this.warn('preflight', `base is ${this.run.inputs.baseBranch} but the repository default is ${repo.defaultBranch}`);
    }
    if (this.run.inputs.mergeMethod === 'merge' && !repo.allowMergeCommit) {
      throw new StageFailure('preflight', 'conductor', 'merge commits are disabled on this repository — re-run with --squash');
    }

    await git.fetch();
    const head = await git.headSha();
    const unpushed = await git.unpushedCount(branch);
    if (unpushed !== 0) {
      const label = unpushed < 0 ? 'branch does not exist on origin' : `${unpushed} unpushed commit(s)`;
      this.progress('preflight', `pushing ${branch} (${label})`);
      await git.push(branch, unpushed < 0);
    }

    this.run.git.branch = branch;
    this.run.git.headSha = head;
    this.ok('preflight', `${branch} @ ${head.slice(0, 8)} pushed; gh authenticated as ${login}`);
  }

  // ── 2. pull request ───────────────────────────────────────────────────────────

  private async stagePr(): Promise<void> {
    if (this.done('pr')) return;
    this.begin('pr', 'creating or adopting the pull request');
    const { gh, git } = this.d;
    const branch = this.run.git.branch;

    let pr = await gh.findPr(branch);
    if (pr) {
      this.progress('pr', `adopted existing PR #${pr.number}`);
    } else {
      const commits = await git.commitsSince(`origin/${this.run.inputs.baseBranch}`);
      if (commits.length === 0) {
        throw new StageFailure(
          'pr',
          'conductor',
          `${branch} has no commits that ${this.run.inputs.baseBranch} does not already have — nothing to ship`,
        );
      }
      const title = commits.length === 1 ? commits[0] : await git.subject();
      const body = prBody(commits, await git.changedFiles(`origin/${this.run.inputs.baseBranch}`));
      const url = await gh.createPr({ branch, base: this.run.inputs.baseBranch, title, body });
      this.progress('pr', `created ${url}`);
      pr = await gh.findPr(branch);
      if (!pr) throw new StageFailure('pr', 'conductor', `created ${url} but it did not appear in the PR list`);
    }

    if (pr.isDraft) {
      this.progress('pr', `PR #${pr.number} is a draft — marking it ready for review`);
      await gh.readyPr(pr.number);
    }

    if (pr.headRefOid !== this.run.git.headSha) {
      throw new StageFailure(
        'pr',
        'conductor',
        `PR #${pr.number} points at ${pr.headRefOid.slice(0, 8)} but the local branch is at ${this.run.git.headSha.slice(0, 8)} — someone else pushed to ${branch}`,
      );
    }

    this.run.pr = { number: pr.number, url: pr.url, headSha: pr.headRefOid, merged: false };
    this.ok('pr', `PR #${pr.number} ready — ${pr.url}`);
  }

  // ── 3. CI on the pull request ─────────────────────────────────────────────────

  private async stageCi(): Promise<void> {
    if (this.done('ci')) return;
    const pr = this.requirePr();
    this.begin('ci', `waiting for CI on PR #${pr.number}`);
    const { gh, config } = this.d;

    const deadline = Date.now() + config.poll.ciTimeoutMs;
    // GitHub needs a moment to create check runs after a push. An empty list is only
    // an answer after this grace period; before it, it means "not yet".
    const appearBy = Date.now() + config.poll.dispatchAppearMs;
    const seen = new Map<string, string>();

    for (;;) {
      if (Date.now() > deadline) {
        throw new StageFailure('ci', 'conductor', `CI on PR #${pr.number} did not finish within ${minutes(config.poll.ciTimeoutMs)} — the conductor stopped watching; the run itself may still be going`);
      }
      const checks = await gh.prChecks(pr.number);

      if (checks.length === 0) {
        if (Date.now() > appearBy) {
          throw new StageFailure('ci', 'conductor', `no CI checks were created for PR #${pr.number} within ${minutes(config.poll.dispatchAppearMs)} — the workflow may be disabled or filtered out`);
        }
        await sleep(config.poll.intervalMs, this.d.signal);
        continue;
      }

      if (!this.run.ci) {
        const runId = runIdFromLink(checks[0].link);
        if (runId) this.run.ci = { runId, url: `https://github.com/${config.repo}/actions/runs/${runId}` };
        this.save();
      }

      for (const c of checks) {
        if (seen.get(c.name) !== c.bucket) {
          seen.set(c.name, c.bucket);
          this.progress('ci', `${c.name}: ${c.bucket}`);
        }
      }

      const pending = checks.filter((c) => c.bucket === 'pending');
      if (pending.length === 0) {
        const bad = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
        if (bad.length > 0) await this.failFromCi(bad);
        this.run.ci = { ...(this.run.ci ?? { runId: 0, url: '' }), conclusion: 'success' };
        this.ok('ci', `all ${checks.length} checks green on PR #${pr.number}`);
        return;
      }
      await sleep(config.poll.intervalMs, this.d.signal);
    }
  }

  private async failFromCi(bad: { name: string; bucket: string; link: string }[]): Promise<never> {
    const runId = runIdFromLink(bad[0].link) ?? this.run.ci?.runId ?? 0;
    let evidence: string[] = [];
    let failedJobs: { name: string; conclusion: string }[] = bad.map((c) => ({ name: c.name, conclusion: c.bucket }));
    if (runId) {
      const got = await collectRunEvidence({
        gh: this.d.gh,
        runId,
        runDir: this.d.paths.dir,
        destDir: this.d.paths.ciDir,
        artifactNames: [],
      });
      evidence = got.evidence;
      if (got.failedJobs.length > 0) failedJobs = got.failedJobs;
      for (const n of got.notes) this.warn('ci', n);
    }
    throw new StageFailure('ci', 'ci-red', `CI failed on PR #${this.run.pr?.number}: ${bad.map((c) => c.name).join(', ')}`, {
      evidence,
      failedJobs,
      workflowUrl: runId ? `https://github.com/${this.d.config.repo}/actions/runs/${runId}` : undefined,
    });
  }

  // ── 4. merge ──────────────────────────────────────────────────────────────────

  private async stageMerge(): Promise<void> {
    if (this.done('merge')) return;
    const pr = this.requirePr();
    this.begin('merge', `merging PR #${pr.number} into ${this.run.inputs.baseBranch}`);
    const { gh, config } = this.d;

    const view = await gh.viewPr(pr.number);
    if (view.mergedAt) {
      this.run.pr = { ...pr, merged: true, mergeSha: view.mergeCommit?.oid };
      this.ok('merge', `PR #${pr.number} was already merged as ${short(view.mergeCommit?.oid)}`);
      return;
    }
    if (view.mergeable === 'CONFLICTING') {
      throw new StageFailure('merge', 'merge-conflict', `PR #${pr.number} conflicts with ${this.run.inputs.baseBranch} — rebase it, then run ship again`);
    }

    await gh.mergePr(pr.number, this.run.inputs.mergeMethod, true);

    // GitHub reports the merge asynchronously; poll until the merge commit exists so
    // the release is dispatched against a ref that provably contains this work.
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      const after = await gh.viewPr(pr.number);
      if (after.mergedAt && after.mergeCommit?.oid) {
        this.run.pr = { ...pr, merged: true, mergeSha: after.mergeCommit.oid };
        this.save();
        this.ok('merge', `PR #${pr.number} merged as ${short(after.mergeCommit.oid)}`);
        return;
      }
      if (Date.now() > deadline) {
        throw new StageFailure('merge', 'conductor', `PR #${pr.number} did not report a merge commit within 5 minutes`);
      }
      await sleep(config.poll.approvalIntervalMs, this.d.signal);
    }
  }

  // ── 5. CI on main (normally short-circuited by the tree guard) ────────────────

  private async stageMainCi(): Promise<void> {
    if (this.done('main-ci')) return;
    const mergeSha = this.run.pr?.mergeSha;
    if (!mergeSha) {
      this.skip('main-ci', 'no merge commit recorded');
      return;
    }
    this.begin('main-ci', `waiting for CI on ${this.run.inputs.baseBranch} @ ${short(mergeSha)}`);
    const { gh, config } = this.d;
    const base = this.run.inputs.baseBranch;

    const appearBy = Date.now() + config.poll.dispatchAppearMs;
    const deadline = Date.now() + config.poll.ciTimeoutMs;
    for (;;) {
      const runs = await gh.listRuns({ workflow: config.workflows.ci, branch: base, event: 'push', limit: 15 });
      const mine = runs.find((r) => r.headSha === mergeSha);
      if (!mine) {
        if (Date.now() > appearBy) {
          // No push-triggered run appeared. That is not a pass — but it is also not a
          // reason to abandon a merged change, because the release runs its own full
          // verification gate. Record it honestly and move on.
          this.skip('main-ci', `no push CI run appeared for ${short(mergeSha)} within ${minutes(config.poll.dispatchAppearMs)} — the release's own verification gate still applies`);
          return;
        }
        await sleep(config.poll.intervalMs, this.d.signal);
        continue;
      }
      this.run.mainCi = { runId: mine.databaseId, url: mine.url, status: mine.status, conclusion: mine.conclusion ?? undefined };
      this.save();

      if (mine.status === 'completed') {
        if (mine.conclusion === 'success') {
          this.ok('main-ci', `CI green on ${base} @ ${short(mergeSha)}`);
          return;
        }
        if (mine.conclusion === 'skipped') {
          this.ok('main-ci', `CI short-circuited on ${base} — the merged tree is identical to the tree that already passed on PR #${this.run.pr?.number}`);
          return;
        }
        const got = await collectRunEvidence({
          gh,
          runId: mine.databaseId,
          runDir: this.d.paths.dir,
          destDir: join(this.d.paths.ciDir, 'main'),
          artifactNames: [],
        });
        for (const n of got.notes) this.warn('main-ci', n);
        throw new StageFailure('main-ci', 'ci-red', `CI failed on ${base} after the merge (${mine.conclusion})`, {
          evidence: got.evidence,
          failedJobs: got.failedJobs,
          workflowUrl: mine.url,
        });
      }
      if (Date.now() > deadline) {
        throw new StageFailure('main-ci', 'conductor', `CI on ${base} did not finish within ${minutes(config.poll.ciTimeoutMs)}`);
      }
      await sleep(config.poll.intervalMs, this.d.signal);
    }
  }

  // ── 6. release: dispatch and watch up to the approval gate ────────────────────

  private async stageRelease(): Promise<void> {
    if (this.done('release')) return;
    const { gh, config } = this.d;

    // A resume that already dispatched must adopt that run, never dispatch a second
    // one — two concurrent releases would race for the same version tag.
    if (this.run.release?.runId) {
      this.begin('release', `re-attaching to release run ${this.run.release.runId}`);
      const outcome = await this.watchRun('release', this.run.release.runId, config.poll.releaseTimeoutMs, true);
      if (outcome.kind === 'completed') {
        await this.finishReleaseRun(outcome.jobs, outcome.conclusion);
        return;
      }
      this.ok('release', 'build, tag and draft release complete — production approval is pending');
      return;
    }

    this.begin('release', `dispatching Release FlowVid (bump=${this.run.inputs.bump})`);

    const base = this.run.inputs.baseBranch;
    const tip = await gh.branchSha(base);
    const mergeSha = this.run.pr?.mergeSha;
    if (mergeSha && tip !== mergeSha) {
      // The release workflow always builds the tip of the base branch. Say so out loud
      // rather than letting the report imply this shipment released only its commits.
      this.warn('release', `${base} has moved to ${short(tip)} since the merge (${short(mergeSha)}) — the release will contain those commits too`);
    }

    const since = new Date(Date.now() - 20_000).toISOString();
    await gh.dispatchWorkflow(config.workflows.release, base, {
      bump: this.run.inputs.bump,
      deploy: String(this.run.inputs.deploy),
      backfill_policy: this.run.inputs.backfillPolicy,
      approve_high: String(this.run.inputs.approveHigh),
    });

    const runRef = await this.awaitDispatchedRun(config.workflows.release, since, 'release');
    this.run.release = { runId: runRef.databaseId, url: runRef.url };
    this.save();
    this.progress('release', `release run ${runRef.databaseId} — ${runRef.url}`);

    const outcome = await this.watchRun('release', runRef.databaseId, config.poll.releaseTimeoutMs, true);

    if (outcome.kind === 'completed') {
      // Finished without ever pausing for approval: either deploy=false (fine) or it
      // failed on the way (not fine).
      await this.finishReleaseRun(outcome.jobs, outcome.conclusion);
      return;
    }
    this.ok('release', `build, tag and draft release complete — production approval is pending`);
  }

  // ── 7. approval ───────────────────────────────────────────────────────────────

  private async stageApproval(): Promise<void> {
    if (this.done('approval')) return;
    if (!this.run.inputs.deploy) {
      this.skip('approval', 'deploy=false — nothing to approve');
      return;
    }
    if (stage(this.run, 'release').status !== 'passed' || !this.run.release) {
      this.skip('approval', 'the release run did not reach the approval gate');
      return;
    }
    const { gh, config, paths } = this.d;
    const runId = this.run.release.runId;
    this.begin('approval', 'production deployment is waiting for approval');

    const pending = await gh.pendingDeployments(runId);
    const prod = pending.filter((p) => p.environmentName === config.productionEnvironment);
    if (prod.length === 0) {
      this.skip('approval', 'no pending production deployment — it was already approved');
      return;
    }
    if (!prod[0].currentUserCanApprove) {
      throw new StageFailure('approval', 'conductor', `the authenticated gh account is not a required reviewer for the "${config.productionEnvironment}" environment`);
    }

    const version = await this.readPlannedVersion(runId);
    if (version) {
      this.run.release.version = version;
      this.save();
    }

    if (this.run.inputs.autoApprove) {
      await gh.reviewDeployment(runId, prod.map((p) => p.environmentId), 'approved', `auto-approved by ship ${this.run.runId}`);
      this.ok('approval', `production approved automatically (--auto-approve)`);
      return;
    }

    // Stale handshake files from a previous shipment must never approve this one.
    rmSync(paths.approveFile, { force: true });
    rmSync(paths.denyFile, { force: true });

    this.run.verdict = 'AWAITING_APPROVAL';
    this.save();
    this.d.journal.emit({
      stage: 'approval',
      event: 'need.approval',
      level: 'action',
      msg: `production deploy of ${version ?? 'the next version'} is waiting for your approval — run \`ship approve\` (or \`ship deny\`)`,
      data: {
        runId,
        version,
        workflowUrl: this.run.release.url,
        approveFile: paths.approveFile,
        denyFile: paths.denyFile,
      },
    });

    const deadline = Date.now() + config.poll.approvalTimeoutMs;
    let lastRemoteCheck = 0;
    for (;;) {
      if (existsSync(paths.denyFile)) {
        await gh.reviewDeployment(runId, prod.map((p) => p.environmentId), 'rejected', `denied via ship ${this.run.runId}`);
        throw new Aborted('production deployment was denied — the release run is rejected and nothing was deployed');
      }
      if (existsSync(paths.approveFile)) {
        await gh.reviewDeployment(runId, prod.map((p) => p.environmentId), 'approved', `approved via ship ${this.run.runId}`);
        this.run.verdict = 'RUNNING';
        this.ok('approval', 'production approved');
        return;
      }
      // The approval may also arrive through the GitHub UI. Poll for that, but far
      // less often than the local file — it is a network call, not a stat().
      if (Date.now() - lastRemoteCheck > config.poll.intervalMs) {
        lastRemoteCheck = Date.now();
        const still = await gh.pendingDeployments(runId);
        if (still.filter((p) => p.environmentName === config.productionEnvironment).length === 0) {
          this.run.verdict = 'RUNNING';
          this.ok('approval', 'production approved on GitHub');
          return;
        }
      }
      if (Date.now() > deadline) {
        throw new StageFailure('approval', 'conductor', `no approval decision within ${minutes(config.poll.approvalTimeoutMs)} — the release run is still waiting on GitHub`, {
          workflowUrl: this.run.release?.url,
        });
      }
      await sleep(config.poll.approvalIntervalMs, this.d.signal);
    }
  }

  // ── 8. deploy + publish ───────────────────────────────────────────────────────

  private async stageDeploy(): Promise<void> {
    if (this.done('deploy')) return;
    if (!this.run.release || stage(this.run, 'release').status !== 'passed') {
      this.skip('deploy', 'the release run never reached the deploy phase');
      return;
    }
    if (!this.run.inputs.deploy) {
      this.skip('deploy', 'deploy=false');
      return;
    }
    this.begin('deploy', 'deploying to production and verifying');
    const outcome = await this.watchRun('deploy', this.run.release.runId, this.d.config.poll.releaseTimeoutMs, false);
    if (outcome.kind !== 'completed') {
      throw new StageFailure('deploy', 'conductor', 'the conductor stopped watching the release run before it completed', {
        workflowUrl: this.run.release.url,
      });
    }
    await this.finishReleaseRun(outcome.jobs, outcome.conclusion);
  }

  /**
   * Turn a finished release run into a verdict.
   *
   * The release engine has already decided everything — gate.json says whether it
   * blocked and whether it rolled back, state.json says exactly where it stopped. This
   * reads those, and only falls back to the run's own conclusion when the artifacts
   * are missing (which is itself reported, never smoothed over).
   */
  private async finishReleaseRun(jobs: JobSummary[], conclusion: string): Promise<void> {
    const { gh, config, paths } = this.d;
    const rel = this.run.release;
    if (!rel) throw new StageFailure('deploy', 'conductor', 'no release run recorded');

    const collected = await collectRunEvidence({
      gh,
      runId: rel.runId,
      runDir: paths.dir,
      destDir: paths.releaseDir,
      artifactNames: config.artifacts.release,
      jobs,
    });
    for (const n of collected.notes) this.warn('deploy', n);

    const report = readArtifact<ReleaseReport>(paths.releaseDir, 'release-report.json');
    if (report?.version) {
      rel.version = report.version;
      rel.previousVersion = report.previousVersion;
    }
    const gate = readArtifact<GateReport>(paths.releaseDir, 'gate.json');
    const state = readArtifact<StateReport>(paths.releaseDir, 'state.json');
    rel.conclusion = conclusion;
    this.save();

    const failedJobs = collected.failedJobs;
    const deployJob = jobs.find((j) => j.name === RELEASE_JOB_DEPLOY);
    const publishJob = jobs.find((j) => j.name === RELEASE_JOB_PUBLISH);

    if (conclusion === 'success' && publishJob?.conclusion === 'success') {
      const at = stage(this.run, 'deploy').status === 'running' ? 'deploy' : 'release';
      const label = `${rel.version ?? 'release'} deployed and published${state?.state ? ` (state ${state.state})` : ''}`;
      if (at === 'deploy') this.ok('deploy', label);
      else this.ok('release', label);
      return;
    }

    if (conclusion === 'success' && !this.run.inputs.deploy) {
      this.ok('release', `${rel.version ?? 'release'} built, tagged and drafted (deploy=false)`);
      this.skip('deploy', 'deploy=false');
      return;
    }

    // Decide *why* it failed, most specific source first.
    const failingStage: ShipStageName = stage(this.run, 'deploy').status === 'running' ? 'deploy' : 'release';
    let kind: FailureKind = 'conductor';
    let summary: string;

    if (gate?.blocked) {
      kind = 'gate-blocked';
      const counts = `${gate.counts?.critical ?? 0}C/${gate.counts?.high ?? 0}H/${gate.counts?.warning ?? 0}W`;
      summary = gate.shouldRollback
        ? `post-deploy gate found CRITICAL findings (${counts}) — production was rolled back automatically`
        : `the ${gate.phase ?? 'release'} gate blocked (${counts}): ${(gate.reasons ?? []).slice(0, 3).join('; ') || 'see gate.json'}`;
    } else if (deployJob?.conclusion === 'failure') {
      kind = 'deploy-failed';
      summary =
        state?.state === 'ROLLED_BACK'
          ? 'the deployment failed and production was rolled back to the previous version'
          : 'the deployment failed — check whether production was left on the previous version (state.json)';
    } else if (failedJobs.length > 0) {
      kind = releaseJobFailureKind(failedJobs[0].name);
      summary = `release job "${failedJobs[0].name}" failed (${failedJobs[0].conclusion})`;
    } else {
      summary = `the release run finished as ${conclusion} without a failed job the conductor could name`;
    }

    throw new StageFailure(failingStage, kind, summary, {
      evidence: collected.evidence,
      failedJobs,
      workflowUrl: rel.url,
    });
  }

  // ── 9. production audit ───────────────────────────────────────────────────────

  private async stageAudit(): Promise<void> {
    if (this.done('audit')) return;
    const { gh, config, paths } = this.d;
    if (!this.run.inputs.audit) {
      this.skip('audit', 'audit disabled (--no-audit)');
      return;
    }
    if (!this.run.inputs.deploy || stage(this.run, 'deploy').status !== 'passed') {
      this.skip('audit', 'nothing was deployed, so there is nothing new to audit');
      return;
    }
    this.begin('audit', 'auditing production (read-only)');

    const since = new Date(Date.now() - 20_000).toISOString();
    await gh.dispatchWorkflow(config.workflows.audit, this.run.inputs.baseBranch, {});
    const runRef = await this.awaitDispatchedRun(config.workflows.audit, since, 'audit');
    this.run.audit = { runId: runRef.databaseId, url: runRef.url };
    this.save();
    this.progress('audit', `audit run ${runRef.databaseId} — ${runRef.url}`);

    const outcome = await this.watchRun('audit', runRef.databaseId, config.poll.auditTimeoutMs, false);
    if (outcome.kind !== 'completed') {
      throw new StageFailure('audit', 'conductor', 'the conductor stopped watching the audit run before it completed', {
        workflowUrl: runRef.url,
      });
    }

    const collected = await collectRunEvidence({
      gh,
      runId: runRef.databaseId,
      runDir: paths.dir,
      destDir: paths.auditDir,
      artifactNames: [`production-audit-${runRef.databaseId}`, ...config.artifacts.audit],
      jobs: outcome.jobs,
    });
    for (const n of collected.notes) this.warn('audit', n);

    const verdict = readArtifact<{ verdict?: string; reasons?: string[] }>(paths.auditDir, 'audit-verdict.json');
    this.run.audit.conclusion = outcome.conclusion;
    this.run.audit.verdict = verdict?.verdict;
    this.save();

    if (verdict?.verdict === 'PASS') {
      this.ok('audit', 'production audit PASS');
      return;
    }
    if (outcome.conclusion === 'success' && !verdict) {
      // The workflow succeeded but its verdict artifact is missing. Unknown is never green.
      throw new StageFailure('audit', 'audit-error', 'the audit run succeeded but published no audit-verdict.json — production state is unverified', {
        evidence: collected.evidence,
        workflowUrl: runRef.url,
      });
    }
    const kind: FailureKind = verdict?.verdict === 'BLOCKED_BY_FINDINGS' ? 'audit-findings' : 'audit-error';
    const summary =
      kind === 'audit-findings'
        ? `production audit BLOCKED_BY_FINDINGS — production violates policy: ${(verdict?.reasons ?? []).slice(0, 3).join('; ') || 'see audit-report.md'}`
        : `production audit BLOCKED_BY_AUDIT_ERROR — a collector could not produce a trustworthy answer, so production state is UNKNOWN (this is an auditor problem, not necessarily a production one)`;
    throw new StageFailure('audit', kind, summary, {
      evidence: collected.evidence,
      failedJobs: collected.failedJobs,
      workflowUrl: runRef.url,
    });
  }

  // ── shared machinery ──────────────────────────────────────────────────────────

  /**
   * Find the run a dispatch just created.
   *
   * `gh workflow run` returns nothing useful, so the run is matched by workflow file
   * and creation time. The `since` window is deliberately narrow and the newest match
   * wins, so a run from an earlier shipment can never be adopted as this one's.
   */
  private async awaitDispatchedRun(workflow: string, since: string, stageName: ShipStageName): Promise<{ databaseId: number; url: string }> {
    const { gh, config } = this.d;
    const deadline = Date.now() + config.poll.dispatchAppearMs;
    for (;;) {
      const runs = await gh.listRuns({ workflow, event: 'workflow_dispatch', limit: 20 });
      const fresh = runs.filter((r) => r.createdAt >= since).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      if (fresh.length > 0) return { databaseId: fresh[0].databaseId, url: fresh[0].url };
      if (Date.now() > deadline) {
        throw new StageFailure(stageName, 'conductor', `dispatched ${workflow} but no run appeared within ${minutes(config.poll.dispatchAppearMs)} — check that the gh token may dispatch workflows`);
      }
      await sleep(5_000, this.d.signal);
    }
  }

  /**
   * Watch a run, emitting one event per job status change.
   *
   * `stopAtApproval` returns as soon as the run parks on an environment gate, so the
   * conductor can hand the decision to a human without burning the release timeout.
   */
  private async watchRun(
    stageName: ShipStageName,
    runId: number,
    timeoutMs: number,
    stopAtApproval: boolean,
  ): Promise<{ kind: 'completed'; conclusion: string; jobs: JobSummary[] } | { kind: 'awaiting-approval'; jobs: JobSummary[] }> {
    const { gh, config } = this.d;
    const deadline = Date.now() + timeoutMs;
    const seen = new Map<string, string>();

    for (;;) {
      const view = await gh.viewRun(runId);
      for (const j of view.jobs) {
        const key = `${j.status}:${j.conclusion ?? ''}`;
        if (seen.get(j.name) !== key) {
          seen.set(j.name, key);
          const done = j.status === 'completed';
          const bad = done && j.conclusion !== 'success' && j.conclusion !== 'skipped';
          this.d.journal.emit({
            stage: stageName,
            event: 'progress',
            level: bad ? 'warn' : 'info',
            msg: `${j.name}: ${done ? j.conclusion : j.status}`,
            notify: bad,
          });
        }
      }

      if (view.status === 'completed') {
        return { kind: 'completed', conclusion: view.conclusion ?? 'unknown', jobs: view.jobs };
      }
      if (stopAtApproval) {
        const pending = await gh.pendingDeployments(runId).catch(() => []);
        if (view.status === 'waiting' || pending.length > 0) {
          return { kind: 'awaiting-approval', jobs: view.jobs };
        }
      }
      if (Date.now() > deadline) {
        throw new StageFailure(stageName, 'conductor', `run ${runId} did not finish within ${minutes(timeoutMs)} — the conductor stopped watching; the run itself may still be going`, {
          workflowUrl: view.url,
        });
      }
      await sleep(config.poll.intervalMs, this.d.signal);
    }
  }

  /** The version the release plan chose, so the approval prompt can name it. */
  private async readPlannedVersion(runId: number): Promise<string | undefined> {
    // paths.planDir, NOT a subdirectory of releaseDir: this snapshot predates the deployment
    // and readArtifact() would otherwise find its stale gate.json/state.json when the run ends.
    const dir = this.d.paths.planDir;
    const ok = await this.d.gh.downloadArtifact(runId, 'release-artifacts', dir);
    if (!ok) return undefined;
    const plan = readArtifact<{ nextTag?: string }>(dir, 'plan.json');
    const state = readArtifact<{ version?: string }>(dir, 'state.json');
    return plan?.nextTag ?? state?.version;
  }

  private requirePr(): NonNullable<ShipRun['pr']> {
    if (!this.run.pr) throw new StageFailure('pr', 'conductor', 'no pull request recorded');
    return this.run.pr;
  }
}

/** Failures that mean "a gate said no" rather than "the pipeline broke". */
const BLOCKING_KINDS = new Set<FailureKind>(['ci-red', 'gate-blocked', 'audit-findings', 'merge-conflict', 'release-verify', 'build-images']);

interface GateReport {
  blocked?: boolean;
  shouldRollback?: boolean;
  phase?: string;
  counts?: { critical?: number; high?: number; warning?: number };
  reasons?: string[];
}
interface StateReport {
  state?: string;
}
interface ReleaseReport {
  version?: string;
  previousVersion?: string;
}

export function newShipRun(args: {
  runId: string;
  dir: string;
  inputs: ShipRun['inputs'];
  branch: string;
  headSha: string;
  stages: ShipRun['stages'];
}): ShipRun {
  return {
    schema: SHIP_RUN_SCHEMA,
    runId: args.runId,
    dir: args.dir,
    startedAt: new Date().toISOString(),
    verdict: 'RUNNING',
    inputs: args.inputs,
    git: { branch: args.branch, headSha: args.headSha },
    stages: args.stages,
  };
}

export function currentStage(run: ShipRun): ShipStageName | null {
  return run.stages.find((s) => s.status === 'running')?.name ?? null;
}

/** The abort a cancelled `sleep` throws when the operator presses Ctrl-C. */
function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.message === 'aborted' || err.name === 'AbortError');
}

export function runIdFromLink(link: string): number | null {
  const m = /\/actions\/runs\/(\d+)/.exec(link ?? '');
  return m ? Number.parseInt(m[1], 10) : null;
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} minutes`;
}

function short(sha?: string): string {
  return sha ? sha.slice(0, 8) : '(unknown)';
}

function prBody(commits: string[], files: string[]): string {
  const lines = ['## What changed', ''];
  for (const c of commits) lines.push(`- ${c}`);
  lines.push('', `## Files (${files.length})`, '');
  for (const f of files.slice(0, 40)) lines.push(`- \`${f}\``);
  if (files.length > 40) lines.push(`- …and ${files.length - 40} more`);
  lines.push('', '---', '', 'Opened by `pnpm ship`. CI must be green before this merges.');
  return lines.join('\n');
}

/** Write the approval handshake file. Exported so `ship approve` and tests share it. */
export function writeDecision(file: string, note: string): void {
  writeFileSync(file, `${note}\n${new Date().toISOString()}\n`, 'utf8');
}
