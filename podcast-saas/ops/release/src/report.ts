/**
 * Release report assembly — one JSON document (machine-readable) and one Markdown
 * rendering (human-readable) per release attempt. Everything passes through
 * redaction before it is persisted.
 */
import { redactText, redactValue } from './redact.js';
import { sortFindings, type Finding, type GateDecision } from './severity.js';
import type { ReleaseState } from './state-machine.js';

export interface StageTiming {
  stage: string;
  status: 'success' | 'failure' | 'skipped';
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

export interface EndpointStatus {
  name: string;
  url: string;
  httpStatus: number | null;
  ok: boolean;
}

export interface TestSummary {
  suite: string;
  total: number;
  passed: number;
  failed: number;
  skipped?: number;
}

export interface ImageRecord {
  service: string;
  repository: string;
  tag: string;
  digest: string;
}

/** What kind of run produced this report. */
export type ReportKind = 'release' | 'audit' | 'rollback';

/**
 * Verdict states for runs that do NOT walk the release state machine.
 * A read-only audit must never pretend a deployment occurred: it ends in an
 * explicit AUDIT_PASSED / AUDIT_FAILED, not a deployment state and not UNKNOWN.
 */
export type AuditState = 'AUDIT_PASSED' | 'AUDIT_FAILED';

export interface ReleaseReport {
  schema: 'flowvid.release-report/v1';
  kind?: ReportKind;
  runId: string;
  workflow?: { runId?: string; runUrl?: string; actor?: string; workflow?: string };
  requested?: { bump?: string; deploy?: boolean; backfillPolicy?: string };
  version?: string;
  previousVersion?: string;
  gitSha?: string;
  startedAt?: string;
  endedAt?: string;
  state: ReleaseState | AuditState | 'UNKNOWN';
  stages: StageTiming[];
  source?: Record<string, unknown>;
  tests?: TestSummary[];
  lint?: { errors: number; warnings: number };
  images?: ImageRecord[];
  migrationPlan?: Record<string, unknown>;
  backfill?: Record<string, unknown>;
  deployment?: {
    status?: string;
    serviceHealth?: Record<string, string>;
    endpoints?: EndpointStatus[];
  };
  playwright?: {
    total?: number;
    passed?: number;
    failed?: number;
    skipped?: number;
    failures?: string[];
  };
  csp?: Record<string, unknown>;
  assets?: Record<string, unknown>;
  databaseUrlAudit?: Record<string, unknown>;
  findings: Finding[];
  gate?: GateDecision;
  rollback?: { attempted: boolean; target?: string; success?: boolean };
  failing?: { command?: string; test?: string };
  logs?: string[];
  remediation?: string[];
}

/** Assemble + redact the final report object. */
export function buildReport(input: Omit<ReleaseReport, 'schema'>): ReleaseReport {
  const report: ReleaseReport = {
    schema: 'flowvid.release-report/v1',
    ...input,
    findings: sortFindings(input.findings ?? []),
  };
  return redactValue(report);
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function table(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(mdEscape).join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
}

const SEVERITY_ICON: Record<string, string> = {
  CRITICAL: '🟥',
  HIGH: '🟧',
  WARNING: '🟨',
  INFO: 'ℹ️',
};

const KIND_TITLE: Record<ReportKind, string> = {
  release: 'Release report',
  audit: 'Production audit report',
  rollback: 'Rollback report',
};

export function renderMarkdown(report: ReleaseReport): string {
  const lines: string[] = [];
  const r = report;

  lines.push(`# ${KIND_TITLE[r.kind ?? 'release']} — ${r.version ?? r.runId}`);
  lines.push('');
  const meta: string[][] = [
    ['Run ID', r.runId],
    ['Final state', r.state],
    ['Requested bump', r.requested?.bump ?? '—'],
    ['Deploy requested', r.requested?.deploy === undefined ? '—' : String(r.requested.deploy)],
    ['Backfill policy', r.requested?.backfillPolicy ?? '—'],
    ['Version', r.version ?? '—'],
    ['Previous release', r.previousVersion ?? '—'],
    ['Git SHA', r.gitSha ?? '—'],
    ['Actor', r.workflow?.actor ?? '—'],
    ['Workflow run', r.workflow?.runUrl ?? '—'],
    ['Started', r.startedAt ?? '—'],
    ['Ended', r.endedAt ?? '—'],
  ];
  lines.push(table(['Field', 'Value'], meta));
  lines.push('');

  if (r.stages.length > 0) {
    lines.push('## Stages');
    lines.push(
      table(
        ['Stage', 'Status', 'Duration'],
        r.stages.map((s) => [
          s.stage,
          s.status,
          s.durationMs !== undefined ? `${(s.durationMs / 1000).toFixed(1)}s` : '—',
        ]),
      ),
    );
    lines.push('');
  }

  const gate = r.gate;
  lines.push('## Verdict');
  if (gate) {
    lines.push(
      `- Blocked: **${gate.blocked ? 'YES' : 'no'}**` +
        (gate.shouldRollback ? ' — **rollback required**' : ''),
    );
    lines.push(
      `- Findings: ${gate.counts.CRITICAL} critical / ${gate.counts.HIGH} high / ${gate.counts.WARNING} warning`,
    );
    for (const reason of gate.reasons) lines.push(`- ${reason}`);
  } else {
    lines.push('- No gate decision recorded.');
  }
  lines.push('');

  if (r.findings.length > 0) {
    lines.push('## Findings (most severe first)');
    lines.push(
      table(
        ['', 'Severity', 'Area', 'Finding', 'Remediation'],
        r.findings.map((f) => [
          SEVERITY_ICON[f.severity] ?? '',
          f.severity,
          f.area,
          `${f.message}${f.detail ? ` — ${f.detail}` : ''}`,
          f.remediation ?? '—',
        ]),
      ),
    );
    lines.push('');
  } else {
    lines.push('## Findings');
    lines.push('None. ✅');
    lines.push('');
  }

  if (r.tests && r.tests.length > 0) {
    lines.push('## Tests');
    lines.push(
      table(
        ['Suite', 'Total', 'Passed', 'Failed', 'Skipped'],
        r.tests.map((t) => [t.suite, String(t.total), String(t.passed), String(t.failed), String(t.skipped ?? 0)]),
      ),
    );
    if (r.lint) lines.push(`\nLint: ${r.lint.errors} error(s), ${r.lint.warnings} warning(s).`);
    lines.push('');
  }

  if (r.images && r.images.length > 0) {
    lines.push('## Images (immutable digests)');
    lines.push(
      table(
        ['Service', 'Repository', 'Tag', 'Digest'],
        r.images.map((i) => [i.service, i.repository, i.tag, i.digest]),
      ),
    );
    lines.push('');
  }

  if (r.migrationPlan) {
    lines.push('## Migration plan');
    lines.push('```json');
    lines.push(JSON.stringify(r.migrationPlan, null, 2));
    lines.push('```');
    lines.push('');
  }

  if (r.databaseUrlAudit) {
    lines.push('## Database URL audit');
    lines.push('```json');
    lines.push(JSON.stringify(r.databaseUrlAudit, null, 2));
    lines.push('```');
    lines.push('');
  }

  if (r.backfill) {
    lines.push('## Data backfill');
    lines.push('```json');
    lines.push(JSON.stringify(r.backfill, null, 2));
    lines.push('```');
    lines.push('');
  }

  if (r.deployment) {
    lines.push('## Deployment');
    if (r.deployment.status) lines.push(`Status: **${r.deployment.status}**`);
    if (r.deployment.serviceHealth) {
      lines.push('');
      lines.push(
        table(
          ['Service', 'Health'],
          Object.entries(r.deployment.serviceHealth).map(([k, v]) => [k, v]),
        ),
      );
    }
    if (r.deployment.endpoints && r.deployment.endpoints.length > 0) {
      lines.push('');
      lines.push(
        table(
          ['Endpoint', 'URL', 'HTTP', 'OK'],
          r.deployment.endpoints.map((e) => [e.name, e.url, e.httpStatus === null ? 'n/a' : String(e.httpStatus), e.ok ? '✅' : '❌']),
        ),
      );
    }
    lines.push('');
  }

  if (r.playwright) {
    lines.push('## Browser verification (Playwright)');
    lines.push(
      `- ${r.playwright.passed ?? 0} passed / ${r.playwright.failed ?? 0} failed / ${r.playwright.skipped ?? 0} skipped`,
    );
    for (const f of r.playwright.failures ?? []) lines.push(`- ❌ ${f}`);
    lines.push('');
  }

  if (r.rollback?.attempted) {
    lines.push('## Rollback');
    lines.push(`- Target: ${r.rollback.target ?? 'unknown'}`);
    lines.push(`- Result: ${r.rollback.success ? 'restored and healthy ✅' : 'FAILED ❌ — manual intervention required'}`);
    lines.push('');
  }

  if (r.failing?.command || r.failing?.test) {
    lines.push('## First failure');
    if (r.failing.command) lines.push(`- Command: \`${r.failing.command}\``);
    if (r.failing.test) lines.push(`- Test: \`${r.failing.test}\``);
    lines.push('');
  }

  if (r.remediation && r.remediation.length > 0) {
    lines.push('## Recommended remediation');
    for (const step of r.remediation) lines.push(`1. ${step}`);
    lines.push('');
  }

  if (r.logs && r.logs.length > 0) {
    lines.push('## Log locations (sanitized)');
    for (const l of r.logs) lines.push(`- ${l}`);
    lines.push('');
  }

  return redactText(lines.join('\n'));
}
