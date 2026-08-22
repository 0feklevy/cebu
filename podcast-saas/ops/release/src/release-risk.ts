/**
 * IS THIS RELEASE ROUTINE, OR DOES IT NEED A HUMAN?
 *
 * The owner's account of the manual approval this replaces: "in practice I only click 'Approve
 * and deploy' without performing an additional review, so it is not providing meaningful
 * protection." A gate that is always answered the same way is not a gate — it is a delay that
 * teaches everyone the answer is always yes. The value of a human is spent on the releases where
 * a human could actually change the outcome, and squandered on the ninety-nine that they wave
 * through, which is also what makes the hundredth get waved through.
 *
 * So approval becomes rare and meaningful instead of routine and reflexive. This module decides
 * which releases are which, and it decides it from evidence the pipeline ALREADY produces —
 * the migration audit's findings, the backfill policy, and the `approve_high` input. Nothing here
 * is a new severity system, a second opinion, or a parallel set of rules; a release is risky
 * exactly when the existing audits say something a human is being asked to accept.
 *
 * DEFAULT TO REQUIRING A HUMAN. Every unknown, unreadable, or unparseable input is risk, not
 * absence of risk. A verdict computed from evidence that could not be read is the automation
 * equivalent of clicking Approve without looking.
 */
import type { Finding } from './severity.js';
import type { BackfillPolicy } from './database-url-audit.js';

export const RELEASE_RISK_SCHEMA = 'flowvid.release-risk/v1';

export interface ReleaseRiskInput {
  /** Findings from every pre-deploy audit — migrations, secrets, CSP, images. */
  findings: readonly Finding[];
  /** The run's `backfill_policy` input. Anything that can write data is risky. */
  backfillPolicy: BackfillPolicy;
  /** The run's `approve_high` input: the operator pre-accepting HIGH findings. */
  approveHigh: boolean;
  /** Paths changed since the last release, for the security-sensitive-surface check. */
  changedPaths: readonly string[];
}

export interface ReleaseRiskVerdict {
  schema: typeof RELEASE_RISK_SCHEMA;
  /** true ⇒ a human must approve before this deploys. */
  requiresHuman: boolean;
  /** Every reason, in the order evaluated. Empty exactly when requiresHuman is false. */
  reasons: string[];
}

/**
 * Paths where a mistake is not caught by any browser test, because the damage is silent:
 * a permission that stopped being checked, a token that stopped expiring, a secret that
 * started being logged. These are the changes worth a person's attention.
 */
const SENSITIVE_PATH_PATTERNS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /(^|\/)(auth|authorization|authorize)[^/]*\.(ts|tsx)$/i, why: 'authentication/authorization logic' },
  { re: /(^|\/)middleware\/.*auth/i, why: 'auth middleware' },
  { re: /mediaAccess|mintMediaToken|mediaToken/i, why: 'media token minting or access control' },
  { re: /(^|\/)firebase[^/]*\.(ts|tsx)$/i, why: 'Firebase identity wiring' },
  { re: /\.env\.example$/, why: 'the environment-variable contract' },
  { re: /(^|\/)(secrets?|encryption|crypto)[^/]*\.(ts|tsx)$/i, why: 'secret handling or encryption' },
  { re: /(^|\/)deploy\/(docker-compose[^/]*\.yml|nginx|systemd)/i, why: 'production deployment configuration' },
  { re: /(^|\/)publicOrigins\.ts$/, why: 'public origin configuration (CSP and URL minting)' },
  { re: /(^|\/)stripe|billing|webhook/i, why: 'billing or webhook handling' },
];

/** Migration findings a human is meant to accept rather than a machine. */
const RISKY_MIGRATION_IDS = new Set([
  'migrations.destructive',
  'migrations.compat-risk',
  'migrations.runner-incompatible',
  'migrations.history-rewrite',
]);

export function assessReleaseRisk(input: ReleaseRiskInput): ReleaseRiskVerdict {
  const reasons: string[] = [];

  // 1. Destructive or backward-incompatible schema change. The migration audit already
  //    classifies these; this only decides who is asked to accept them.
  for (const f of input.findings) {
    if (RISKY_MIGRATION_IDS.has(f.id)) reasons.push(`${f.id}: ${f.message}`);
  }

  // 2. Anything that can WRITE production data. `report-only` observes; the other two modes
  //    change rows, and an automated pipeline must not decide on its own to do that.
  if (input.backfillPolicy !== 'report-only') {
    reasons.push(`backfill_policy=${input.backfillPolicy} — this run may modify production data.`);
  }

  // 3. `approve_high` IS a human acceptance. Its presence means findings exist that the gate
  //    would otherwise block on, so the person accepting them has to be a person.
  if (input.approveHigh) {
    reasons.push('approve_high was requested — HIGH findings are being accepted for this run.');
  }
  const highs = input.findings.filter((f) => f.severity === 'HIGH');
  if (highs.length > 0 && !RISKY_MIGRATION_IDS.has(highs[0].id)) {
    reasons.push(`${highs.length} HIGH finding(s) require acceptance: ${highs.map((f) => f.id).join(', ')}`);
  }

  // 4. Security-sensitive surface. A green test suite is weak evidence here: the failure mode
  //    of a broken authorization check is that everything keeps working, for everyone.
  const sensitive = new Map<string, string[]>();
  for (const path of input.changedPaths) {
    for (const { re, why } of SENSITIVE_PATH_PATTERNS) {
      if (re.test(path)) {
        const list = sensitive.get(why) ?? [];
        list.push(path);
        sensitive.set(why, list);
        break;
      }
    }
  }
  for (const [why, paths] of sensitive) {
    reasons.push(`touches ${why}: ${paths.slice(0, 5).join(', ')}${paths.length > 5 ? `, +${paths.length - 5} more` : ''}`);
  }

  return { schema: RELEASE_RISK_SCHEMA, requiresHuman: reasons.length > 0, reasons };
}
