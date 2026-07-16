/**
 * Database URL audit — consumes the machine-readable report of
 * backend-api/src/scripts/backfill-localhost-urls.ts (report/dry-run mode, run ON
 * the VM against known URL columns + JSON fields; DATABASE_URL never leaves the VM)
 * and turns it into findings + an apply/block decision under the backfill policy.
 *
 * The audit itself never changes data. Apply mode is a separate, explicitly
 * approved step and is refused outright under report-only policy.
 */
import { finding, type Finding } from './severity.js';

export interface UrlBackfillTarget {
  target: string; // table.column
  affected: number;
}

export interface UrlBackfillPlan {
  wouldRewrite: number;
  wouldKey: number;
  wouldNull: number;
  missingAssets: number;
}

export interface UrlBackfillReport {
  schema: 'flowvid.url-backfill-report/v1';
  runId: string;
  mode: 'report' | 'apply';
  generatedAt?: string;
  targets: UrlBackfillTarget[];
  totalAffected: number;
  plan?: UrlBackfillPlan;
  applied?: { rewritten: number; keyed: number; nulled: number };
  backupTable?: string;
  maxAffectedRows?: number;
}

export type BackfillPolicy = 'report-only' | 'allow-safe' | 'require-approval';

export interface DbUrlAuditResult {
  findings: Finding[];
  /** What the policy permits for the APPLY step. */
  decision: 'no-action-needed' | 'apply-allowed' | 'requires-approval' | 'report-only';
  report: UrlBackfillReport;
}

export function parseBackfillReport(json: string): UrlBackfillReport {
  const r = JSON.parse(json) as UrlBackfillReport;
  if (r.schema !== 'flowvid.url-backfill-report/v1') {
    throw new Error(`Unknown url-backfill report schema: ${String((r as { schema?: unknown }).schema)}`);
  }
  return r;
}

export function auditDatabaseUrls(
  report: UrlBackfillReport,
  policy: BackfillPolicy,
  maxAffectedRows: number,
): DbUrlAuditResult {
  const findings: Finding[] = [];
  const affectedTargets = report.targets.filter((t) => t.affected > 0);

  if (report.totalAffected === 0) {
    return { findings, decision: 'no-action-needed', report };
  }

  // Poisoned URLs exist in production data — a regression of the v0.1.1 incident.
  findings.push(
    finding('db-urls.non-public-rows', 'HIGH', 'backfill', `${report.totalAffected} row(s) hold non-public (localhost/private/docker) URLs in known URL columns.`, {
      detail: affectedTargets.map((t) => `${t.target}: ${t.affected}`).join(', '),
      remediation: 'Investigate what wrote them (BACKEND_API_URL/worker env), then repair via the approved backfill.',
    }),
  );

  const plan = report.plan;
  let unsafe = false;

  if (!plan) {
    unsafe = true;
    findings.push(
      finding('db-urls.no-plan', 'HIGH', 'backfill', 'Backfill report carries no dry-run plan — rewritten/nulled classification unavailable, apply cannot be assessed.'),
    );
  } else {
    if (plan.wouldNull > 0) {
      unsafe = true;
      findings.push(
        finding('db-urls.would-null', 'HIGH', 'backfill', `Data repair would NULL ${plan.wouldNull} row(s) (asset lost on dead local disk).`, {
          remediation: 'Requires explicit approval; affected assets must be regenerated or re-uploaded afterwards.',
        }),
      );
    }
    if (plan.missingAssets > 0) {
      unsafe = true;
      findings.push(
        finding('db-urls.missing-assets', 'HIGH', 'backfill', `${plan.missingAssets} referenced object(s) do not exist in cloud storage.`),
      );
    }
  }

  if (report.totalAffected > maxAffectedRows) {
    unsafe = true;
    findings.push(
      finding('db-urls.threshold-exceeded', 'HIGH', 'backfill', `Affected rows (${report.totalAffected}) exceed the policy ceiling (${maxAffectedRows}).`, {
        remediation: 'Raise the threshold consciously or repair in reviewed batches.',
      }),
    );
  }

  if (!report.backupTable) {
    unsafe = true;
    findings.push(
      finding('db-urls.no-backup-provenance', 'HIGH', 'backfill', 'No backup table recorded — rollback provenance unavailable; apply is blocked.'),
    );
  }

  let decision: DbUrlAuditResult['decision'];
  if (policy === 'report-only') decision = 'report-only';
  else if (policy === 'require-approval') decision = 'requires-approval';
  else decision = unsafe ? 'requires-approval' : 'apply-allowed';

  return { findings, decision, report };
}
