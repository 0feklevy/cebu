/**
 * The audit result model.
 *
 * The production audit previously collapsed two unrelated things into one red X:
 * findings ABOUT production, and failures OF the audit itself. Run 31199562890 is the
 * worked example — Playwright died during test collection (`Cannot find module
 * 'shared/sim/canaryContract'`), so no browser evidence existed at all, yet the final
 * verdict read `BLOCKED — 1C/0H/0W` / `AUDIT_FAILED`, indistinguishable from a healthy
 * audit that found one real defect. An operator cannot act on that: "the site is broken"
 * and "the auditor is broken" require opposite responses.
 *
 * So every collector now reports exactly one status, and the two failure kinds stay
 * separate all the way to the final verdict.
 */
import type { Finding, GateDecision } from './severity.js';

/**
 * PASS            the check ran to completion and found nothing.
 * FINDING         the check ran to completion and production violated policy.
 * ERROR           the check could not produce a trustworthy answer (crash, timeout,
 *                 unreadable output). Says nothing about production's health.
 * NOT_CONFIGURED  the check was not attempted because its inputs are absent. This is a
 *                 COVERAGE statement: the surface was not tested.
 */
export type CollectorStatus = 'PASS' | 'FINDING' | 'ERROR' | 'NOT_CONFIGURED';

export const COLLECTOR_STATUSES: readonly CollectorStatus[] = ['PASS', 'FINDING', 'ERROR', 'NOT_CONFIGURED'];

/** One collector's execution record. Written even (especially) when it fails. */
export interface CollectorRecord {
  name: string;
  /** The command as invoked, with secrets already redacted by the caller. */
  command: string;
  startedAt: string;
  endedAt: string;
  /** null when the collector was never spawned (NOT_CONFIGURED). */
  exitCode: number | null;
  status: CollectorStatus;
  /** Short machine-ish explanation: why this status, in operator language. */
  reason: string;
  /** Artifact this collector was supposed to produce, if any. */
  artifact?: string;
}

export const COLLECTOR_LOG_SCHEMA = 'flowvid.collector-log/v1';

export interface CollectorLog {
  schema: typeof COLLECTOR_LOG_SCHEMA;
  runId?: string;
  gitSha?: string;
  createdAt: string;
  collectors: CollectorRecord[];
}

/**
 * A production surface and whether this run actually exercised it.
 *
 * This exists because a green audit that silently skipped the admin console is more
 * dangerous than a red one: it asserts health for something it never looked at.
 */
export interface CoverageEntry {
  surface: string;
  status: 'TESTED' | 'NOT_CONFIGURED' | 'ERROR';
  /** Which inputs the surface needs, for the report's remediation line. */
  requires?: readonly string[];
  reason?: string;
}

/** Final, explicit audit states. Never collapse these into a generic AUDIT_FAILED. */
export type AuditVerdict = 'PASS' | 'BLOCKED_BY_FINDINGS' | 'BLOCKED_BY_AUDIT_ERROR';

export interface VerdictInput {
  collectors: readonly CollectorRecord[];
  /** The severity gate's decision over the findings that were actually collected. */
  gate?: Pick<GateDecision, 'blocked'> | undefined;
  findings?: readonly Finding[];
}

export interface VerdictOutcome {
  verdict: AuditVerdict;
  /** Human-ordered reasons, most decisive first. */
  reasons: string[];
  erroredCollectors: string[];
  notConfigured: string[];
}

/**
 * Derive the final verdict.
 *
 * ERROR outranks FINDING deliberately. If any collector failed, the audit's picture of
 * production is incomplete, so even a clean gate cannot be reported as PASS — the honest
 * statement is "the audit could not be trusted", and the operator's first job is to fix
 * the auditor. A findings-based block is reported only when every collector actually ran.
 *
 * NOT_CONFIGURED never blocks by itself: it is a coverage fact, surfaced in the report so
 * that a PASS is always read alongside what was skipped. Callers that consider a surface
 * mandatory must record it as ERROR instead (see `requiredInputStatus`).
 */
export function deriveVerdict(input: VerdictInput): VerdictOutcome {
  const errored = input.collectors.filter((c) => c.status === 'ERROR');
  const notConfigured = input.collectors.filter((c) => c.status === 'NOT_CONFIGURED');
  const reasons: string[] = [];

  if (errored.length > 0) {
    for (const c of errored) reasons.push(`${c.name}: ${c.reason}`);
    return {
      verdict: 'BLOCKED_BY_AUDIT_ERROR',
      reasons,
      erroredCollectors: errored.map((c) => c.name),
      notConfigured: notConfigured.map((c) => c.name),
    };
  }

  const blocked = input.gate?.blocked === true;
  if (blocked) {
    for (const c of input.collectors.filter((c) => c.status === 'FINDING')) reasons.push(`${c.name}: ${c.reason}`);
    if (reasons.length === 0) reasons.push('the severity gate blocked on collected findings');
    return { verdict: 'BLOCKED_BY_FINDINGS', reasons, erroredCollectors: [], notConfigured: notConfigured.map((c) => c.name) };
  }

  for (const c of notConfigured) reasons.push(`${c.name}: ${c.reason} (surface not tested)`);
  return { verdict: 'PASS', reasons, erroredCollectors: [], notConfigured: notConfigured.map((c) => c.name) };
}

/**
 * Classify a required-vs-optional input.
 *
 * A missing REQUIRED input is an audit ERROR — the run promised to test that surface and
 * could not. A missing OPTIONAL input is NOT_CONFIGURED — honest reduced coverage.
 */
export function requiredInputStatus(present: boolean, required: boolean): CollectorStatus {
  if (present) return 'PASS';
  return required ? 'ERROR' : 'NOT_CONFIGURED';
}

/**
 * Map a collector's exit code onto a status.
 *
 * The distinction the old `|| true` erased: the release CLI uses exit 1 to mean "I ran
 * and found something that blocks" and reserves other non-zero codes / thrown errors for
 * "I could not run". Anything the caller could not classify is ERROR, never PASS —
 * an unknown outcome is not evidence of health.
 */
export function statusFromExit(exitCode: number | null, opts: { producedArtifact: boolean }): CollectorStatus {
  if (exitCode === 0) return 'PASS';
  if (exitCode === 1 && opts.producedArtifact) return 'FINDING';
  return 'ERROR';
}
