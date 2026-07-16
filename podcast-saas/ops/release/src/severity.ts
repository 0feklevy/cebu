/**
 * Severity model + release policy.
 *
 * CRITICAL — blocks the release; after deployment it also triggers rollback.
 * HIGH     — blocks unless explicitly approved by policy (approveHigh).
 * WARNING  — reported; blocks only when the policy opts in (blockOnWarning).
 * INFO     — informational, never blocks.
 */

export type Severity = 'CRITICAL' | 'HIGH' | 'WARNING' | 'INFO';

export interface Finding {
  /** Stable machine id, e.g. csp.frame-src.missing-firebase-auth-origin. */
  id: string;
  severity: Severity;
  /** Subsystem: csp | assets | migrations | backfill | secrets | images | deploy | health | browser | source. */
  area: string;
  message: string;
  detail?: string;
  remediation?: string;
}

export type Phase = 'pre-deploy' | 'post-deploy';

export interface GatePolicy {
  /** Explicit human approval recorded for HIGH findings (e.g. backfill_policy input). */
  approveHigh?: boolean;
  /** Escalate warnings to blockers (off by default). */
  blockOnWarning?: boolean;
}

export interface GateDecision {
  blocked: boolean;
  /** Only meaningful post-deploy: a CRITICAL finding demands rollback. */
  shouldRollback: boolean;
  counts: Record<Severity, number>;
  reasons: string[];
}

export function finding(
  id: string,
  severity: Severity,
  area: string,
  message: string,
  extra?: Partial<Pick<Finding, 'detail' | 'remediation'>>,
): Finding {
  return { id, severity, area, message, ...extra };
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, WARNING: 0, INFO: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/** Order findings most-severe first (stable within a severity). */
export function sortFindings(findings: Finding[]): Finding[] {
  const rank: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, WARNING: 2, INFO: 3 };
  return [...findings].sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function evaluateGate(findings: Finding[], phase: Phase, policy: GatePolicy = {}): GateDecision {
  const counts = countBySeverity(findings);
  const reasons: string[] = [];

  if (counts.CRITICAL > 0) {
    reasons.push(`${counts.CRITICAL} CRITICAL finding(s) — release policy always blocks on CRITICAL.`);
  }
  if (counts.HIGH > 0 && !policy.approveHigh) {
    reasons.push(`${counts.HIGH} HIGH finding(s) without explicit approval.`);
  }
  if (counts.WARNING > 0 && policy.blockOnWarning) {
    reasons.push(`${counts.WARNING} WARNING finding(s) and blockOnWarning is enabled.`);
  }

  return {
    blocked: reasons.length > 0,
    shouldRollback: phase === 'post-deploy' && counts.CRITICAL > 0,
    counts,
    reasons,
  };
}
