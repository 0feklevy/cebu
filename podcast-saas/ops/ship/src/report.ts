/**
 * SHIP-REPORT.md — the one file that explains a shipment.
 *
 * Written for two readers at once: a human scanning for "did it ship, and if not
 * why", and Claude deciding what to do next. So the verdict is first, the failure is
 * named in one sentence, the evidence paths are literal, and the recommended action
 * is a command rather than a suggestion.
 */
import { writeFileSync } from 'node:fs';
import type { FailureKind, ShipRun, ShipStage } from './types.js';

const STATUS_MARK: Record<ShipStage['status'], string> = {
  pending: '·',
  running: '▶',
  passed: '✓',
  failed: '✗',
  skipped: '–',
  blocked: '⛔',
};

export function renderReport(run: ShipRun, repo: string): string {
  const L: string[] = [];
  const dur = duration(run.startedAt, run.endedAt);

  L.push(`# Ship report — ${run.runId}`, '');
  L.push(`**${verdictLine(run)}**`, '');

  L.push('| | |', '| --- | --- |');
  L.push(`| Verdict | \`${run.verdict}\` |`);
  L.push(`| Branch | \`${run.git.branch}\` @ \`${run.git.headSha.slice(0, 8)}\` |`);
  if (run.pr) L.push(`| Pull request | [#${run.pr.number}](${run.pr.url})${run.pr.merged ? ` — merged as \`${run.pr.mergeSha?.slice(0, 8)}\`` : ' — not merged'} |`);
  if (run.release?.version) L.push(`| Version | \`${run.release.version}\`${run.release.previousVersion ? ` (was \`${run.release.previousVersion}\`)` : ''} |`);
  if (run.audit?.verdict) L.push(`| Production audit | \`${run.audit.verdict}\` |`);
  L.push(`| Started | ${run.startedAt} |`);
  L.push(`| Duration | ${dur} |`);
  L.push(`| Inputs | bump=\`${run.inputs.bump}\` deploy=\`${run.inputs.deploy}\` backfill=\`${run.inputs.backfillPolicy}\` approve_high=\`${run.inputs.approveHigh}\` |`);
  L.push('');

  L.push('## Stages', '');
  L.push('| | Stage | Outcome | Took |', '| --- | --- | --- | --- |');
  for (const s of run.stages) {
    L.push(`| ${STATUS_MARK[s.status]} | \`${s.name}\` | ${s.note ?? s.status} | ${duration(s.startedAt, s.endedAt)} |`);
  }
  L.push('');

  L.push('## Workflow runs', '');
  const runs: [string, { runId: number; url: string; conclusion?: string } | undefined][] = [
    ['CI (pull request)', run.ci],
    ['CI (main)', run.mainCi],
    ['Release FlowVid', run.release],
    ['Production audit', run.audit],
  ];
  const known = runs.filter(([, r]) => r && r.runId);
  if (known.length === 0) {
    L.push('_No workflow run was started._', '');
  } else {
    L.push('| Workflow | Run | Conclusion |', '| --- | --- | --- |');
    for (const [name, r] of known) L.push(`| ${name} | [${r!.runId}](${r!.url}) | ${r!.conclusion ?? '—'} |`);
    L.push('');
  }

  if (run.failure) {
    const f = run.failure;
    L.push('## What went wrong', '');
    L.push(`**Stage:** \`${f.stage}\` · **Kind:** \`${f.kind}\``, '');
    L.push(f.summary, '');
    if (f.workflowUrl) L.push(`Workflow run: ${f.workflowUrl}`, '');
    if (f.failedJobs?.length) {
      L.push('**Failed jobs**', '');
      for (const j of f.failedJobs) L.push(`- \`${j.name}\` → ${j.conclusion}${j.url ? ` — ${j.url}` : ''}`);
      L.push('');
    }
    if (f.evidence.length) {
      L.push('**Evidence** (paths relative to this directory)', '');
      for (const e of f.evidence) L.push(`- \`${e}\``);
      L.push('');
    } else {
      L.push('_No evidence files were collected — see the notes in `ship.ndjson` for why._', '');
    }
    L.push('## What to do next', '');
    for (const line of nextActions(run, repo)) L.push(`- ${line}`);
    L.push('');
  } else if (run.verdict === 'SHIPPED') {
    L.push('## Result', '');
    L.push(`\`${run.release?.version ?? 'the release'}\` is live and the production audit passed. Nothing to do.`, '');
  }

  L.push('---', '', `Machine-readable state: \`ship.json\` · Event stream: \`ship.ndjson\``);
  return `${L.join('\n')}\n`;
}

export function writeReport(file: string, run: ShipRun, repo: string): void {
  writeFileSync(file, renderReport(run, repo), 'utf8');
}

function verdictLine(run: ShipRun): string {
  switch (run.verdict) {
    case 'SHIPPED':
      return `Shipped ${run.release?.version ?? ''} — deployed, verified and audited.`.replace('  ', ' ');
    case 'BLOCKED':
      return `Blocked at \`${run.failure?.stage}\` — a gate said no. The code needs a fix; the pipeline behaved correctly.`;
    case 'FAILED':
      return `Failed at \`${run.failure?.stage}\` — the pipeline could not produce a trustworthy answer. Fix the pipeline before concluding anything about production.`;
    case 'ABORTED':
      return 'Aborted — production deployment was declined. Nothing was deployed.';
    case 'AWAITING_APPROVAL':
      return 'Waiting for production approval.';
    default:
      return 'In progress.';
  }
}

/**
 * Concrete next steps, keyed off the failure kind.
 *
 * Never suggests weakening a check or re-running until it goes green — the same rule
 * the release-audit skill follows. A red gate is information, not an obstacle.
 */
export function nextActions(run: ShipRun, repo: string): string[] {
  const f = run.failure;
  if (!f) return [];
  const resume = '`pnpm ship resume` picks this shipment back up once the cause is fixed.';
  const byKind: Record<FailureKind, string[]> = {
    'ci-red': [
      'Read `ci/failed.log` — it contains the failed steps only.',
      'Fix the code, commit, and push to the same branch; the PR and its CI re-run automatically.',
      resume,
    ],
    'merge-conflict': [
      `Rebase \`${run.git.branch}\` onto \`${run.inputs.baseBranch}\` and push.`,
      resume,
    ],
    'release-verify': [
      'The release re-runs the full verification gate; something passed on the PR but not on main — usually a merge that combined two independently-green changes.',
      'Read `release/failed.log`, fix on a new branch, and ship again.',
    ],
    'build-images': [
      'Read `release/failed.log` for the Docker build failure.',
      'Image builds do not touch production — nothing was deployed.',
    ],
    'gate-blocked': [
      'Read `release/gate.json` (and `release/release-report.md`) for the findings that blocked it.',
      'Severity policy lives in `podcast-saas/ops/release/src/severity.ts`: CRITICAL always blocks and rolls back post-deploy; HIGH blocks unless explicitly approved.',
      'Fix the finding. Do not re-run with `--approve-high` unless the finding is genuinely understood and accepted.',
    ],
    'deploy-failed': [
      'Read `release/state.json` — its final state says exactly where the deployment stopped and whether the rollback engaged.',
      `If production is on the wrong version, restore a known-good release: \`gh workflow run rollback.yml --repo ${repo} --ref main -f version=vX.Y.Z\`.`,
    ],
    'audit-findings': [
      'This is a production incident, not a pipeline failure — the deployment succeeded and production violates policy.',
      'Read `audit/audit-report.md` for the findings, most severe first.',
      `Roll back if user-facing: \`gh workflow run rollback.yml --repo ${repo} --ref main -f version=<previous tag>\`.`,
    ],
    'audit-error': [
      'The auditor could not produce a trustworthy answer, so production state is UNKNOWN — do not read this as either healthy or broken.',
      'Read `audit/collectors.json` to see which collector errored, and fix the auditor.',
      `Re-run the audit alone: \`gh workflow run production-audit.yml --repo ${repo} --ref main\`.`,
    ],
    'approval-denied': ['Nothing was deployed. Ship again when ready.'],
    conductor: [
      'This is a conductor/transport problem, not a verdict about the code.',
      'Check `gh auth status`, then `pnpm ship doctor`.',
      resume,
    ],
  };
  return byKind[f.kind] ?? [resume];
}

function duration(from?: string, to?: string): string {
  if (!from) return '—';
  const end = to ? Date.parse(to) : Date.now();
  const ms = end - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
