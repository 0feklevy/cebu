/**
 * Ship CLI — one command takes a branch from "committed locally" to "released and
 * audited in production".
 *
 *   pnpm ship run --bump patch
 *
 * The conductor drives the existing GitHub workflows and writes everything it learns
 * into a run directory under `.claude/ship/runs/`. It decides nothing about the code:
 * every pass/fail verdict still comes from CI, the release gate, and the production
 * audit. What it adds is sequencing, evidence collection, and an event stream that a
 * watcher (a human or Claude) can follow live.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Conductor, newShipRun, writeDecision } from './conductor.js';
import { SHIP_CONFIG } from './config.js';
import { Gh } from './gh.js';
import { Git } from './git.js';
import { Journal, readJournal } from './journal.js';
import { renderReport, nextActions } from './report.js';
import { runCommand } from './run.js';
import {
  getCurrent,
  initStages,
  listRunIds,
  loadRun,
  newRunId,
  runPaths,
  saveRun,
  setCurrent,
  type RunPaths,
} from './state.js';
import type { ShipInputs, ShipRun } from './types.js';

const USAGE = `Usage: ship <command> [flags]

  run          --bump patch|minor|major
               [--no-deploy] [--no-audit] [--auto-approve] [--squash]
               [--backfill report-only|allow-safe|require-approval] [--approve-high]
               [--base main]
               Take the current branch through PR → CI → merge → release → deploy → audit.

  resume       [--run <shipRunId>]          Continue the current (or named) shipment.
  approve      [--run <shipRunId>] [--note] Approve the pending production deployment.
  deny         [--run <shipRunId>] [--note] Decline it; the release run is rejected.
  status       [--run <shipRunId>] [--json] Where the shipment stands.
  report       [--run <shipRunId>]          Print SHIP-REPORT.md.
  watch-cmd    [--run <shipRunId>]          Print the command that streams this run's events.
  doctor                                    Check gh access and repository settings. Changes nothing.

Every command is read-only except run/resume (which open, merge and dispatch) and
approve/deny (which answer the environment gate).
`;

function parseArgs(argv: string[]): { flags: Map<string, string>; bools: Set<string>; rest: string[] } {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(a.slice(2), next);
      i++;
    } else {
      bools.add(a.slice(2));
    }
  }
  return { flags, bools, rest };
}

async function resolveRoot(): Promise<string> {
  return new Git(process.cwd()).repoRoot();
}

/** Resolve which shipment a command refers to: explicit id, `current`, or newest. */
function resolveRunId(root: string, explicit?: string): string {
  if (explicit) return explicit;
  const current = getCurrent(root);
  if (current && existsSync(runPaths(root, current).stateFile)) return current;
  const all = listRunIds(root);
  if (all.length === 0) throw new Error('no shipment found — run `pnpm ship run --bump patch` first');
  return all[0];
}

function loadOrThrow(paths: RunPaths): ShipRun {
  const run = loadRun(paths);
  if (!run) throw new Error(`no readable ship.json in ${paths.dir}`);
  return run;
}

function makeConductor(root: string, paths: RunPaths, run: ShipRun, signal?: AbortSignal): Conductor {
  return new Conductor({
    gh: new Gh({ repo: SHIP_CONFIG.repo, cwd: root }),
    git: new Git(root),
    journal: new Journal(paths.journalFile),
    paths,
    config: SHIP_CONFIG,
    run,
    signal,
  });
}

/** Exit code by verdict: 0 shipped, 1 blocked/failed, 2 aborted, 3 awaiting approval. */
function exitCodeFor(run: ShipRun): number {
  switch (run.verdict) {
    case 'SHIPPED':
      return 0;
    case 'ABORTED':
      return 2;
    case 'AWAITING_APPROVAL':
      return 3;
    default:
      return 1;
  }
}

async function cmdRun(flags: Map<string, string>, bools: Set<string>): Promise<number> {
  const root = await resolveRoot();
  const bump = flags.get('bump') ?? 'patch';
  if (!['patch', 'minor', 'major'].includes(bump)) throw new Error(`--bump must be patch, minor or major (got ${bump})`);
  const backfill = flags.get('backfill') ?? 'report-only';
  if (!['report-only', 'allow-safe', 'require-approval'].includes(backfill)) {
    throw new Error(`--backfill must be report-only, allow-safe or require-approval (got ${backfill})`);
  }

  const inputs: ShipInputs = {
    bump: bump as ShipInputs['bump'],
    deploy: !bools.has('no-deploy'),
    backfillPolicy: backfill as ShipInputs['backfillPolicy'],
    approveHigh: bools.has('approve-high'),
    audit: !bools.has('no-audit'),
    autoApprove: bools.has('auto-approve'),
    mergeMethod: bools.has('squash') ? 'squash' : 'merge',
    baseBranch: flags.get('base') ?? SHIP_CONFIG.baseBranch,
  };

  const git = new Git(root);
  const runId = newRunId();
  const paths = runPaths(root, runId);
  const run = newShipRun({
    runId,
    dir: paths.dir,
    inputs,
    branch: await git.currentBranch(),
    headSha: await git.headSha(),
    stages: initStages(),
  });
  saveRun(paths, run);
  setCurrent(root, runId);

  process.stdout.write(`ship ${runId}\n  dir     ${paths.dir}\n  events  ${paths.journalFile}\n\n`);

  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const finished = await makeConductor(root, paths, run, ac.signal).ship();
  process.stdout.write(`\n${'─'.repeat(60)}\n${renderReport(finished, SHIP_CONFIG.repo).split('\n').slice(0, 4).join('\n')}\n`);
  process.stdout.write(`\nFull report: ${paths.reportFile}\n`);
  for (const line of nextActions(finished, SHIP_CONFIG.repo)) process.stdout.write(`  → ${line}\n`);
  return exitCodeFor(finished);
}

async function cmdResume(flags: Map<string, string>): Promise<number> {
  const root = await resolveRoot();
  const runId = resolveRunId(root, flags.get('run'));
  const paths = runPaths(root, runId);
  const run = loadOrThrow(paths);
  setCurrent(root, runId);
  process.stdout.write(`resuming ${runId} (was ${run.verdict})\n`);

  const ac = new AbortController();
  process.once('SIGINT', () => ac.abort());
  const finished = await makeConductor(root, paths, run, ac.signal).ship();
  process.stdout.write(`\nFull report: ${paths.reportFile}\n`);
  return exitCodeFor(finished);
}

async function cmdDecision(flags: Map<string, string>, decision: 'approve' | 'deny'): Promise<number> {
  const root = await resolveRoot();
  const runId = resolveRunId(root, flags.get('run'));
  const paths = runPaths(root, runId);
  const run = loadOrThrow(paths);
  const note = flags.get('note') ?? `${decision}d by ${process.env.USER ?? 'operator'}`;

  // A decision written before the gate is reached is DISCARDED by the conductor, which
  // clears both handshake files when it arrives at the gate. That is deliberate: an
  // approval must be a decision about a specific version and a specific migration plan,
  // and neither exists yet. Say so plainly instead of accepting a decision that will
  // silently evaporate.
  if (run.verdict !== 'AWAITING_APPROVAL') {
    process.stderr.write(
      `${runId} is ${run.verdict}, not AWAITING_APPROVAL.\n` +
        `Nothing was written: the conductor discards decisions made before the gate is reached,\n` +
        `so this would not have applied. Wait for the "waiting for your approval" event, then run this again.\n`,
    );
    return 1;
  }
  writeDecision(decision === 'approve' ? paths.approveFile : paths.denyFile, note);
  if (decision === 'approve') rmSync(paths.denyFile, { force: true });
  else rmSync(paths.approveFile, { force: true });
  process.stdout.write(`${decision === 'approve' ? 'Approved' : 'Denied'} — the running conductor will act on it within a few seconds.\n`);
  return 0;
}

async function cmdStatus(flags: Map<string, string>, bools: Set<string>): Promise<number> {
  const root = await resolveRoot();
  const runId = resolveRunId(root, flags.get('run'));
  const paths = runPaths(root, runId);
  const run = loadOrThrow(paths);
  if (bools.has('json')) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    return exitCodeFor(run);
  }
  process.stdout.write(`${runId}  ${run.verdict}\n`);
  process.stdout.write(`branch ${run.git.branch} @ ${run.git.headSha.slice(0, 8)}\n`);
  if (run.pr) process.stdout.write(`PR     #${run.pr.number} ${run.pr.merged ? '(merged)' : '(open)'} ${run.pr.url}\n`);
  if (run.release) process.stdout.write(`release ${run.release.version ?? ''} ${run.release.url}\n`);
  if (run.audit?.verdict) process.stdout.write(`audit  ${run.audit.verdict}\n`);
  process.stdout.write('\n');
  for (const s of run.stages) {
    const mark = { pending: '·', running: '▶', passed: '✓', failed: '✗', skipped: '–', blocked: '⛔' }[s.status];
    process.stdout.write(`  ${mark} ${s.name.padEnd(10)} ${s.note ?? s.status}\n`);
  }
  if (run.failure) {
    process.stdout.write(`\n✗ ${run.failure.summary}\n`);
    for (const line of nextActions(run, SHIP_CONFIG.repo)) process.stdout.write(`  → ${line}\n`);
  }
  const events = readJournal(paths.journalFile);
  if (events.length) process.stdout.write(`\nlast event: ${events[events.length - 1].line}\n`);
  return exitCodeFor(run);
}

async function cmdReport(flags: Map<string, string>): Promise<number> {
  const root = await resolveRoot();
  const paths = runPaths(root, resolveRunId(root, flags.get('run')));
  if (existsSync(paths.reportFile)) {
    process.stdout.write(readFileSync(paths.reportFile, 'utf8'));
  } else {
    process.stdout.write(renderReport(loadOrThrow(paths), SHIP_CONFIG.repo));
  }
  return 0;
}

async function cmdWatchCmd(flags: Map<string, string>): Promise<number> {
  const root = await resolveRoot();
  const paths = runPaths(root, resolveRunId(root, flags.get('run')));
  // Printed rather than executed: this is the command a watcher (a terminal, or a
  // Claude Monitor) should run. It replays from the first event and exits on run.end.
  process.stdout.write(`node '${join(root, 'podcast-saas/ops/ship/watch.mjs')}' '${paths.journalFile}'\n`);
  return 0;
}

/**
 * Read-only environment check.
 *
 * Nothing here dispatches a workflow or writes to the repository — a doctor that can
 * break production is not a doctor.
 */
async function cmdDoctor(): Promise<number> {
  const root = await resolveRoot();
  const gh = new Gh({ repo: SHIP_CONFIG.repo, cwd: root });
  const git = new Git(root);
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const ghVersion = await runCommand('gh', ['--version']);
  add('gh installed', ghVersion.code === 0, ghVersion.code === 0 ? ghVersion.stdout.split('\n')[0] : 'gh not found on PATH');

  const watcher = join(root, 'podcast-saas/ops/ship/watch.mjs');
  add('event watcher present', existsSync(watcher), existsSync(watcher) ? watcher : 'watch.mjs is missing — live streaming will not work');

  try {
    add('gh authenticated', true, `as ${await gh.authLogin()}`);
  } catch (err) {
    add('gh authenticated', false, `${err instanceof Error ? err.message : String(err)} — run \`gh auth login\``);
  }

  try {
    const perms = await runCommand('gh', ['api', `repos/${SHIP_CONFIG.repo}`, '--jq', '.permissions.push'], { cwd: root });
    const canPush = perms.stdout.trim() === 'true';
    add('write access (needed to merge and dispatch)', canPush, canPush ? 'push: true' : 'the token cannot write to this repository');
  } catch {
    add('write access (needed to merge and dispatch)', false, 'could not read repository permissions');
  }

  try {
    const info = await gh.repoInfo();
    add('merge commits enabled', info.allowMergeCommit, info.allowMergeCommit ? 'allow_merge_commit: true' : 'disabled — ship must be run with --squash');
    add('default branch', info.defaultBranch === SHIP_CONFIG.baseBranch, `${info.defaultBranch} (ship targets ${SHIP_CONFIG.baseBranch})`);
  } catch (err) {
    add('repository readable', false, err instanceof Error ? err.message : String(err));
  }

  for (const [label, file] of Object.entries(SHIP_CONFIG.workflows)) {
    const res = await runCommand('gh', ['api', `repos/${SHIP_CONFIG.repo}/actions/workflows/${file}`, '--jq', '.state'], { cwd: root });
    const active = res.code === 0 && res.stdout.trim() === 'active';
    add(`workflow ${label} (${file})`, active, active ? 'active' : res.stdout.trim() || 'not found or disabled');
  }

  try {
    const me = await gh.authLogin();
    const res = await runCommand(
      'gh',
      ['api', `repos/${SHIP_CONFIG.repo}/environments/${SHIP_CONFIG.productionEnvironment}`, '--jq',
        '[.protection_rules[] | select(.type=="required_reviewers") | .reviewers[].reviewer.login] | join(",")'],
      { cwd: root },
    );
    const reviewers = res.stdout.trim();
    const canApprove = reviewers.split(',').includes(me);
    add(`can approve "${SHIP_CONFIG.productionEnvironment}"`, canApprove, reviewers ? `reviewers: ${reviewers}` : 'no required reviewers configured');
  } catch {
    add(`can approve "${SHIP_CONFIG.productionEnvironment}"`, false, 'could not read the environment');
  }

  const branch = await git.currentBranch();
  const onFeature = !SHIP_CONFIG.protectedBranches.includes(branch);
  add('on a feature branch', onFeature, onFeature ? branch : `${branch} — ship refuses to start from a protected branch`);
  const dirty = await git.isDirty();
  add('working tree clean', !dirty, dirty ? 'uncommitted changes to tracked files' : 'clean');

  for (const c of checks) process.stdout.write(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(42)} ${c.detail}\n`);
  const bad = checks.filter((c) => !c.ok);
  process.stdout.write(`\n${bad.length === 0 ? 'Ready to ship.' : `${bad.length} problem(s) to fix before shipping.`}\n`);
  return bad.length === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const [command, ...raw] = process.argv.slice(2);
  const { flags, bools } = parseArgs(raw);
  switch (command) {
    case 'run':
      return cmdRun(flags, bools);
    case 'resume':
      return cmdResume(flags);
    case 'approve':
      return cmdDecision(flags, 'approve');
    case 'deny':
      return cmdDecision(flags, 'deny');
    case 'status':
      return cmdStatus(flags, bools);
    case 'report':
      return cmdReport(flags);
    case 'watch-cmd':
      return cmdWatchCmd(flags);
    case 'doctor':
      return cmdDoctor();
    case 'help':
    case '--help':
    case undefined:
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
