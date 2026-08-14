/**
 * Typed, retrying wrapper over the `gh` CLI.
 *
 * Everything the conductor knows about GitHub comes through here. Two rules hold
 * throughout:
 *
 *   1. A transport failure is never reported as a negative answer. `gh` exiting
 *      non-zero because the network blipped must not be read as "the check failed"
 *      or "no run exists" — those mistakes turn a flaky Wi-Fi moment into a false
 *      verdict about production. Reads retry; a read that still fails throws.
 *   2. Nothing here writes to production. The only mutating calls are: create PR,
 *      merge PR, dispatch a workflow, and approve a pending deployment — each one
 *      invoked from exactly one stage.
 */
import { runCommand, sleep, type Runner } from './run.js';

export class GhError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GhError';
  }
}

export interface GhOptions {
  repo: string;
  cwd: string;
  runner?: Runner;
  /** Retries for read-only calls. Mutating calls always run exactly once. */
  retries?: number;
}

export interface WorkflowRunSummary {
  databaseId: number;
  createdAt: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  url: string;
  event: string;
  workflowName?: string;
}

export interface JobSummary {
  name: string;
  status: string;
  conclusion: string | null;
  url?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PrSummary {
  number: number;
  url: string;
  headRefOid: string;
  state: string;
  mergeable?: string;
  mergeStateStatus?: string;
  isDraft?: boolean;
}

export interface PendingDeployment {
  environmentName: string;
  environmentId: number;
  currentUserCanApprove: boolean;
  waitTimerStartedAt: string | null;
}

/** A `gh pr checks` row. `bucket` is gh's normalisation: pass|fail|pending|skipping|cancel. */
export interface CheckRow {
  name: string;
  state: string;
  bucket: string;
  link: string;
  workflow?: string;
}

export class Gh {
  private readonly runner: Runner;
  private readonly retries: number;

  constructor(private readonly opts: GhOptions) {
    this.runner = opts.runner ?? runCommand;
    this.retries = opts.retries ?? 3;
  }

  /** Raw invocation. `mutating` calls bypass the retry loop — they are not idempotent. */
  private async exec(args: string[], opts: { mutating?: boolean; timeoutMs?: number } = {}): Promise<string> {
    const attempts = opts.mutating ? 1 : this.retries;
    let last: { code: number; stderr: string } = { code: -1, stderr: '' };
    for (let i = 0; i < attempts; i++) {
      const res = await this.runner('gh', args, { cwd: this.opts.cwd, timeoutMs: opts.timeoutMs ?? 120_000 });
      if (res.code === 0) return res.stdout;
      last = { code: res.code, stderr: res.stderr.trim() };
      // Auth/permission/not-found are settled answers — retrying only wastes time.
      if (isTerminalGhFailure(last.stderr)) break;
      if (i < attempts - 1) await sleep(2_000 * (i + 1));
    }
    throw new GhError(`gh ${args.join(' ')} failed (exit ${last.code}): ${last.stderr || '<no stderr>'}`, last.code, last.stderr);
  }

  private async json<T>(args: string[], opts: { mutating?: boolean; timeoutMs?: number } = {}): Promise<T> {
    const out = await this.exec(args, opts);
    try {
      return JSON.parse(out) as T;
    } catch {
      throw new GhError(`gh ${args.join(' ')} returned unparseable JSON: ${out.slice(0, 400)}`, 0, '');
    }
  }

  // ── identity & permissions ────────────────────────────────────────────────────

  async authLogin(): Promise<string> {
    const me = await this.json<{ login: string }>(['api', 'user', '--jq', '{login:.login}']);
    return me.login;
  }

  async repoInfo(): Promise<{ defaultBranch: string; visibility: string; allowMergeCommit: boolean; allowSquashMerge: boolean }> {
    return this.json(['api', `repos/${this.opts.repo}`, '--jq', '{defaultBranch:.default_branch,visibility:.visibility,allowMergeCommit:.allow_merge_commit,allowSquashMerge:.allow_squash_merge}']);
  }

  // ── pull requests ─────────────────────────────────────────────────────────────

  /** The open PR whose head is `branch`, or null. Never invents one. */
  async findPr(branch: string): Promise<PrSummary | null> {
    const rows = await this.json<PrSummary[]>([
      'pr', 'list', '--repo', this.opts.repo, '--head', branch, '--state', 'open',
      '--json', 'number,url,headRefOid,state,isDraft', '--limit', '5',
    ]);
    return rows[0] ?? null;
  }

  async viewPr(number: number): Promise<PrSummary & { mergedAt: string | null; mergeCommit: { oid: string } | null }> {
    return this.json([
      'pr', 'view', String(number), '--repo', this.opts.repo,
      '--json', 'number,url,headRefOid,state,mergeable,mergeStateStatus,isDraft,mergedAt,mergeCommit',
    ]);
  }

  async createPr(args: { branch: string; base: string; title: string; body: string; draft?: boolean }): Promise<string> {
    const argv = [
      'pr', 'create', '--repo', this.opts.repo,
      '--head', args.branch, '--base', args.base,
      '--title', args.title, '--body', args.body,
    ];
    if (args.draft) argv.push('--draft');
    return (await this.exec(argv, { mutating: true })).trim();
  }

  async prChecks(number: number): Promise<CheckRow[]> {
    // `gh pr checks` exits 8 while checks are pending and 1 when any check failed.
    // Both are *answers*, not transport failures, so the JSON on stdout is what
    // matters — reading the exit code as an error here would abort every run that
    // dares to still be running.
    const res = await this.runner(
      'gh',
      ['pr', 'checks', String(number), '--repo', this.opts.repo, '--json', 'name,state,bucket,link,workflow'],
      { cwd: this.opts.cwd, timeoutMs: 60_000 },
    );
    const out = res.stdout.trim();
    if (!out) {
      if (res.code === 0) return [];
      // No checks have been *created* yet — gh says so on stderr and prints nothing.
      if (/no checks reported|no commit statuses/i.test(res.stderr)) return [];
      throw new GhError(`gh pr checks failed (exit ${res.code}): ${res.stderr.trim()}`, res.code, res.stderr);
    }
    try {
      return JSON.parse(out) as CheckRow[];
    } catch {
      throw new GhError(`gh pr checks returned unparseable JSON: ${out.slice(0, 400)}`, res.code, res.stderr);
    }
  }

  /** Take a draft PR out of draft. A draft cannot be merged, so this runs before merging. */
  async readyPr(number: number): Promise<void> {
    await this.exec(['pr', 'ready', String(number), '--repo', this.opts.repo], { mutating: true });
  }

  /** The current tip of a branch on the remote — used to detect main drifting mid-shipment. */
  async branchSha(branch: string): Promise<string> {
    const res = await this.json<{ sha: string }>([
      'api', `repos/${this.opts.repo}/commits/${branch}`, '--jq', '{sha:.sha}',
    ]);
    return res.sha;
  }

  async mergePr(number: number, method: 'merge' | 'squash', deleteBranch: boolean): Promise<void> {
    const argv = ['pr', 'merge', String(number), '--repo', this.opts.repo, `--${method}`];
    if (deleteBranch) argv.push('--delete-branch');
    await this.exec(argv, { mutating: true, timeoutMs: 180_000 });
  }

  // ── workflow runs ─────────────────────────────────────────────────────────────

  async listRuns(args: { workflow?: string; branch?: string; event?: string; limit?: number }): Promise<WorkflowRunSummary[]> {
    const argv = ['run', 'list', '--repo', this.opts.repo, '--limit', String(args.limit ?? 20),
      '--json', 'databaseId,createdAt,headSha,status,conclusion,url,event,workflowName'];
    if (args.workflow) argv.push('--workflow', args.workflow);
    if (args.branch) argv.push('--branch', args.branch);
    if (args.event) argv.push('--event', args.event);
    return this.json<WorkflowRunSummary[]>(argv);
  }

  async viewRun(runId: number): Promise<WorkflowRunSummary & { jobs: JobSummary[] }> {
    return this.json([
      'run', 'view', String(runId), '--repo', this.opts.repo,
      '--json', 'databaseId,createdAt,headSha,status,conclusion,url,event,workflowName,jobs',
    ]);
  }

  async dispatchWorkflow(workflowFile: string, ref: string, inputs: Record<string, string>): Promise<void> {
    const argv = ['workflow', 'run', workflowFile, '--repo', this.opts.repo, '--ref', ref];
    for (const [k, v] of Object.entries(inputs)) argv.push('-f', `${k}=${v}`);
    await this.exec(argv, { mutating: true });
  }

  /** Failed-step logs for a run. Returns '' when GitHub has not retained any. */
  async failedLog(runId: number): Promise<string> {
    const res = await this.runner('gh', ['run', 'view', String(runId), '--repo', this.opts.repo, '--log-failed'], {
      cwd: this.opts.cwd,
      timeoutMs: 300_000,
    });
    return res.stdout;
  }

  async downloadArtifact(runId: number, name: string, dest: string): Promise<boolean> {
    const res = await this.runner('gh', ['run', 'download', String(runId), '--repo', this.opts.repo, '-n', name, '-D', dest], {
      cwd: this.opts.cwd,
      timeoutMs: 300_000,
    });
    return res.code === 0;
  }

  async listArtifactNames(runId: number): Promise<string[]> {
    try {
      const res = await this.json<{ artifacts: { name: string }[] }>([
        'api', `repos/${this.opts.repo}/actions/runs/${runId}/artifacts`, '--paginate',
      ]);
      return res.artifacts.map((a) => a.name);
    } catch {
      return [];
    }
  }

  async rerunFailed(runId: number): Promise<void> {
    await this.exec(['run', 'rerun', String(runId), '--repo', this.opts.repo, '--failed'], { mutating: true });
  }

  // ── environment approvals ─────────────────────────────────────────────────────

  async pendingDeployments(runId: number): Promise<PendingDeployment[]> {
    const rows = await this.json<{ environment: { id: number; name: string }; current_user_can_approve: boolean; wait_timer_started_at: string | null }[]>([
      'api', `repos/${this.opts.repo}/actions/runs/${runId}/pending_deployments`,
    ]);
    return rows.map((r) => ({
      environmentName: r.environment.name,
      environmentId: r.environment.id,
      currentUserCanApprove: r.current_user_can_approve,
      waitTimerStartedAt: r.wait_timer_started_at,
    }));
  }

  async reviewDeployment(runId: number, environmentIds: number[], state: 'approved' | 'rejected', comment: string): Promise<void> {
    const argv = ['api', '--method', 'POST', `repos/${this.opts.repo}/actions/runs/${runId}/pending_deployments`];
    for (const id of environmentIds) argv.push('-F', `environment_ids[]=${id}`);
    argv.push('-f', `state=${state}`, '-f', `comment=${comment}`);
    await this.exec(argv, { mutating: true });
  }
}

/**
 * `gh` failures that will never succeed on retry. Anything not matched here is
 * treated as transient — the conservative direction, since a needless retry costs
 * seconds while a misread permission error costs a wrong verdict.
 */
export function isTerminalGhFailure(stderr: string): boolean {
  return /HTTP 40[134]|not found|no such|must be authenticated|gh auth login|resource not accessible|permission|Bad credentials|unknown flag|no pull requests found/i.test(
    stderr,
  );
}
