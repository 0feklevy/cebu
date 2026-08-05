/**
 * The backend's reading of a canary run (Priority 5.4).
 *
 * `shared/src/sim/canaryContract` owns the CLASSIFICATION rule — one pure function, stated once, so
 * the browser driver and the server never disagree about what a run meant. This module owns
 * everything the server needs on top of it: assembling a report out of the pieces a run produces,
 * merging the runs of several engines into one verdict, explaining the verdict to a human, and the
 * single guard that decides whether a package may be published with the modern guarantees.
 *
 * WHY THE GUARD RE-DERIVES INSTEAD OF READING THE FIELD
 * `CanaryReport.classification` is a stored field. It arrives from a driver process, over a
 * serialisation boundary, and may have been written by an older build, hand-edited, or produced by
 * a run that was interrupted after stamping it. Trusting it would make "may this be published as
 * modern" answerable by writing five characters into a JSON file. `mayPublishAsModern` therefore
 * recomputes the classification from the report's own evidence and requires the two to AGREE — a
 * report whose stamp disagrees with its contents is refused rather than reconciled, because there
 * is no way to tell which of the two is the lie.
 *
 * WHY THE GUARD ALSO REQUIRES COMPLETENESS
 * `classifyCanaryReport` can only judge the steps a run reported. A report that reports NO steps
 * has nothing failing in it, and — with a full capability claim and no leaks — would classify as
 * `managed-presentable` while having demonstrated nothing at all. That is the same "incomplete
 * proof read as success" failure the contract's header rejects, arriving through omission instead
 * of through abortion. So publication additionally requires every case to have reported every step
 * in `CANARY_STEPS`. Classification stays exactly as the contract defines it; only the PUBLISH
 * decision is strengthened, and `isCanaryReportComplete` states the extra requirement separately so
 * a caller can see which of the two refused.
 */

import {
  CANARY_STEPS,
  DEMOTING_STEPS,
  FATAL_STEPS,
  classifyCanaryReport,
  explainClassification,
  isSignificantError,
  type CanaryCase,
  type CanaryCaseResult,
  type CanaryReport,
  type CanaryStep,
} from 'shared/sim/canaryContract';
import type { SimPackageClass } from 'shared/sim/simFailurePolicy';

/** One entry of `CanaryReport['assets']`, named so callers can build the list without an index type. */
export type CanaryAssetResult = CanaryReport['assets'][number];

/** Everything about a run that is not per-case evidence. */
export interface CanaryReportMeta {
  packageRevision: string;
  simulationId: string;
  storagePrefix: string;
  startedAt: string;
  finishedAt: string;
  /** Browser engine and version the run executed in. Recorded, never asserted on. */
  engine: string;
}

// ─── Assembly ─────────────────────────────────────────────────────────────────────────────────

/**
 * Build a report and stamp its classification in ONE place.
 *
 * Callers never construct a `CanaryReport` literal: doing so means choosing a `classification`
 * by hand, and a classification chosen by hand is not a classification.
 */
export function assembleCanaryReport(
  meta: CanaryReportMeta,
  cases: readonly CanaryCaseResult[],
  assets: readonly CanaryAssetResult[],
  aborted: { reason: string } | null = null,
): CanaryReport {
  const draft: Omit<CanaryReport, 'classification'> = {
    packageRevision: meta.packageRevision,
    simulationId: meta.simulationId,
    storagePrefix: meta.storagePrefix,
    cases,
    assets,
    aborted,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    engine: meta.engine,
  };
  return { ...draft, classification: classifyCanaryReport(draft) };
}

function withoutClassification(report: CanaryReport): Omit<CanaryReport, 'classification'> {
  return {
    packageRevision: report.packageRevision,
    simulationId: report.simulationId,
    storagePrefix: report.storagePrefix,
    cases: report.cases,
    assets: report.assets,
    aborted: report.aborted,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    engine: report.engine,
  };
}

/** The classification the report's own evidence supports, ignoring the stamped field entirely. */
export function recomputeClassification(report: CanaryReport): SimPackageClass {
  return classifyCanaryReport(withoutClassification(report));
}

/** True when the stamped classification is the one the evidence supports. */
export function classificationIsHonest(report: CanaryReport): boolean {
  return report.classification === recomputeClassification(report);
}

// ─── Inspection ───────────────────────────────────────────────────────────────────────────────

/**
 * The label a human reads a failure by. Includes the Minimal-UI state because two cases of one
 * variant at one aspect/quality differ ONLY by configuration, and a demotion attributed to
 * "variantX @ wide/high" that could mean either of them is not attributable at all.
 */
export function caseLabel(c: CanaryCase): string {
  const ui = c.config.simpleUi ? 'minimal-ui' : 'full-ui';
  return `${c.variantKey} @ ${c.aspectProfile}/${c.qualityProfile} [${ui}]`;
}

/** Steps the case reported as failed. */
export function failedStepsOf(c: CanaryCaseResult): readonly CanaryStep[] {
  return c.steps.filter((s) => s.status === 'fail').map((s) => s.step);
}

/**
 * Steps the case never reported at all.
 *
 * A step reported as `skipped` counts as missing too: `skipped` says the run did not get to it,
 * which is exactly as much proof as never mentioning it.
 */
export function missingStepsOf(c: CanaryCaseResult): readonly CanaryStep[] {
  const decided = new Set<CanaryStep>(
    c.steps.filter((s) => s.status !== 'skipped').map((s) => s.step),
  );
  return CANARY_STEPS.filter((s) => !decided.has(s));
}

/** Every case reported a decision for every step in the contract. */
export function isCanaryReportComplete(report: CanaryReport): boolean {
  if (report.cases.length === 0) return false;
  return report.cases.every((c) => missingStepsOf(c).length === 0);
}

export interface CanarySummary {
  cases: number;
  /** Step decisions actually recorded across all cases. */
  stepsRecorded: number;
  passed: number;
  failed: number;
  skipped: number;
  notApplicable: number;
  /** `label: step` for each failure, split by what the failure costs. */
  fatalFailures: readonly string[];
  demotingFailures: readonly string[];
  otherFailures: readonly string[];
  /** `label: step` for each step no case decided. */
  missing: readonly string[];
  significantErrors: number;
  ignoredErrors: number;
  /** Labels of cases that leaked after dispose. */
  leakedCases: readonly string[];
  badAssets: readonly string[];
  /** Cases that completed an activation-scoped handshake. */
  handshookCases: number;
}

export function summarizeCanary(report: CanaryReport): CanarySummary {
  const fatalFailures: string[] = [];
  const demotingFailures: string[] = [];
  const otherFailures: string[] = [];
  const missing: string[] = [];
  const leakedCases: string[] = [];
  let stepsRecorded = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let notApplicable = 0;
  let significantErrors = 0;
  let ignoredErrors = 0;
  let handshookCases = 0;

  for (const c of report.cases) {
    const label = caseLabel(c.case);
    for (const s of c.steps) {
      stepsRecorded++;
      if (s.status === 'pass') passed++;
      else if (s.status === 'skipped') skipped++;
      else if (s.status === 'not-applicable') notApplicable++;
      else {
        failed++;
        const entry = `${label}: ${s.step}${s.detail ? ` — ${s.detail}` : ''}`;
        if (FATAL_STEPS.has(s.step)) fatalFailures.push(entry);
        else if (DEMOTING_STEPS.has(s.step)) demotingFailures.push(entry);
        else otherFailures.push(entry);
      }
    }
    for (const step of missingStepsOf(c)) missing.push(`${label}: ${step}`);
    for (const e of c.errors) {
      if (isSignificantError(e)) significantErrors++;
      else ignoredErrors++;
    }
    if (c.leaked.length > 0) leakedCases.push(`${label}: ${c.leaked.join(', ')}`);
    if (c.capabilities?.activationScoped) handshookCases++;
  }

  const badAssets = report.assets
    .filter((a) => !a.ok)
    .map((a) => `${a.path} → HTTP ${a.status}${a.contentType ? ` (${a.contentType})` : ''}`);

  return {
    cases: report.cases.length,
    stepsRecorded,
    passed,
    failed,
    skipped,
    notApplicable,
    fatalFailures,
    demotingFailures,
    otherFailures,
    missing,
    significantErrors,
    ignoredErrors,
    leakedCases,
    badAssets,
    handshookCases,
  };
}

// ─── The decision ─────────────────────────────────────────────────────────────────────────────

export interface CanaryDecision {
  /** What the evidence supports. Always recomputed — never the stamped field. */
  classification: SimPackageClass;
  /** The stamped field, kept so a disagreement is visible rather than silently corrected. */
  stampedClassification: SimPackageClass;
  /** Stamp and evidence agree. */
  honest: boolean;
  /** Every case decided every step. */
  complete: boolean;
  mayPublishAsModern: boolean;
  /** One line: the verdict and the single most important reason for it. */
  headline: string;
  /** Every demotion, named by case and step. */
  reasons: readonly string[];
  summary: CanarySummary;
}

/**
 * The publication guard.
 *
 * Returns false for EVERY classification except `managed-presentable`, and false even for that one
 * when the stamp disagrees with the evidence or the run left steps undecided. There is deliberately
 * no override parameter: a package that cannot demonstrate the guarantees does not get them by
 * being asked twice.
 */
export function mayPublishAsModern(report: CanaryReport): boolean {
  if (report.classification !== 'managed-presentable') return false;
  if (recomputeClassification(report) !== 'managed-presentable') return false;
  return isCanaryReportComplete(report);
}

export function judgeCanaryReport(report: CanaryReport): CanaryDecision {
  const classification = recomputeClassification(report);
  const honest = report.classification === classification;
  const complete = isCanaryReportComplete(report);
  const summary = summarizeCanary(report);
  const publishable = mayPublishAsModern(report);

  // `explainClassification` reads the STAMPED report, which is what a human will be looking at;
  // the extra lines below cover the two failure modes it cannot express (a dishonest stamp and an
  // incomplete run), because neither is visible in the per-step evidence it walks.
  const reasons = [...explainClassification(report)];
  if (!honest) {
    reasons.unshift(
      `Report is stamped '${report.classification}' but its evidence supports '${classification}'. ` +
      'Refusing to publish on a stamp the evidence does not support.',
    );
  }
  if (!complete && !report.aborted) {
    const undecided = summary.missing.length > 0 ? summary.missing.join('; ') : 'no cases were run';
    reasons.push(`Run is incomplete — undecided: ${undecided}`);
  }

  return {
    classification,
    stampedClassification: report.classification,
    honest,
    complete,
    mayPublishAsModern: publishable,
    headline: headlineFor(report, classification, publishable, summary),
    reasons,
    summary,
  };
}

function headlineFor(
  report: CanaryReport,
  classification: SimPackageClass,
  publishable: boolean,
  summary: CanarySummary,
): string {
  const where = `${report.simulationId}@${report.packageRevision} (${report.engine})`;
  if (report.aborted) return `${where}: FAILED — run aborted: ${report.aborted.reason}`;
  if (publishable) {
    return `${where}: managed-presentable — ${summary.cases} case(s), ${summary.passed} step(s) passed, no leaks.`;
  }
  const first =
    summary.fatalFailures[0] ??
    summary.badAssets[0] ??
    summary.demotingFailures[0] ??
    summary.otherFailures[0] ??
    summary.leakedCases[0] ??
    summary.missing[0] ??
    (summary.significantErrors > 0 ? `${summary.significantErrors} significant error(s)` : 'capability report incomplete');
  return `${where}: ${classification} — not publishable as modern. First cause: ${first}`;
}

/** The whole decision as text, for a log line, a CI annotation or an operator's terminal. */
export function describeCanaryDecision(decision: CanaryDecision): string {
  const lines = [decision.headline, ...decision.reasons.map((r) => `  • ${r}`)];
  const s = decision.summary;
  lines.push(
    `  summary: ${s.cases} case(s); steps ${s.passed} pass / ${s.failed} fail / ` +
    `${s.notApplicable} n-a / ${s.skipped} skipped; errors ${s.significantErrors} significant ` +
    `(${s.ignoredErrors} ignored); ${s.handshookCases}/${s.cases} handshook`,
  );
  return lines.join('\n');
}

// ─── Merging runs ─────────────────────────────────────────────────────────────────────────────

/**
 * Combine the runs of several engines (or several shards) into ONE verdict.
 *
 * The merge is deliberately pessimistic on every axis, because the player has no way to be
 * selective: it picks a variant at runtime and it runs in whichever browser the user brought. A
 * guarantee that holds in Chromium and not in WebKit is not a guarantee.
 *
 * Reports describing DIFFERENT packages are not merged into a verdict about either — the result is
 * aborted, which forces `failed`. Silently merging them would produce a confident verdict about a
 * package that was never run as a whole.
 */
export function mergeCanaryReports(reports: readonly CanaryReport[]): CanaryReport {
  if (reports.length === 0) {
    throw new TypeError('mergeCanaryReports: nothing to merge — an empty run is not a verdict');
  }
  const first = reports[0];

  const revisions = [...new Set(reports.map((r) => r.packageRevision))];
  const simulations = [...new Set(reports.map((r) => r.simulationId))];
  const prefixes = [...new Set(reports.map((r) => r.storagePrefix))];

  let aborted: { reason: string } | null = reports.find((r) => r.aborted)?.aborted ?? null;
  if (!aborted && revisions.length > 1) {
    aborted = { reason: `reports describe different package revisions: ${revisions.join(', ')}` };
  }
  if (!aborted && simulations.length > 1) {
    aborted = { reason: `reports describe different simulations: ${simulations.join(', ')}` };
  }

  // Worst status wins per asset path: an asset that 404s in one engine is a broken asset.
  const assets = new Map<string, CanaryAssetResult>();
  for (const r of reports) {
    for (const a of r.assets) {
      const seen = assets.get(a.path);
      if (!seen || (seen.ok && !a.ok)) assets.set(a.path, a);
    }
  }

  const times = reports.map((r) => r.startedAt).filter((t) => t.length > 0).sort();
  const ends = reports.map((r) => r.finishedAt).filter((t) => t.length > 0).sort();

  return assembleCanaryReport(
    {
      packageRevision: revisions.join('+'),
      simulationId: simulations.join('+'),
      storagePrefix: prefixes.length === 1 ? prefixes[0] : prefixes.join('+'),
      startedAt: times[0] ?? first.startedAt,
      finishedAt: ends[ends.length - 1] ?? first.finishedAt,
      engine: [...new Set(reports.map((r) => r.engine))].join('+'),
    },
    reports.flatMap((r) => r.cases),
    [...assets.values()],
    aborted,
  );
}
