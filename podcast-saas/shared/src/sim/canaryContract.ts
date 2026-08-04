/**
 * The publish-time canary contract (Priority 5.4) — what a package must DEMONSTRATE, in a real
 * browser, before it is allowed to claim the modern guarantees.
 *
 * WHY A CANARY AND NOT A STATIC CHECK
 * Every static gate this codebase has built (the bridge validator, the replace-compatibility
 * contract) answers "do the pieces look right". None of them can answer the only question the
 * reveal invariant depends on: does this package, when asked to present a specific section with a
 * specific configuration, actually submit a render and say so? That is not derivable from the
 * bytes. It has to be executed.
 *
 * THE DECISION THE CANARY MAKES
 * A package is classified, and the classification is what the player uses to decide whether it may
 * be prepared aggressively and revealed live. `managed-presentable` is a claim about EVERY variant
 * in EVERY required configuration — one variant that cannot prove a presentation demotes the whole
 * package, because the player picks the variant at runtime and cannot be selective about a promise.
 *
 * INCOMPLETE PROOF IS NEVER SUCCESS. A canary run that could not complete — the browser crashed,
 * the asset server was unreachable, the run timed out — produces `failed`, never a downgrade to a
 * legacy class. The difference matters: `legacy-cooperative` is a statement that the package was
 * observed behaving cooperatively, and an aborted run observed nothing.
 */

import type { SimPackageClass } from './simFailurePolicy.js';
import type { SimResourceCounts, SimRuntimeCapabilities } from './runtimeProtocol.js';
import type { SimAspectProfile, SimPresentationConfig, SimQualityProfile, VariantKey } from './simIdentity.js';

/** One (variant, configuration) pair the canary must exercise. */
export interface CanaryCase {
  variantKey: VariantKey;
  config: SimPresentationConfig;
  aspectProfile: SimAspectProfile;
  qualityProfile: SimQualityProfile;
}

/** Each numbered check from the Priority 5.4 list, as an assertable step. */
export type CanaryStep =
  | 'load'
  | 'handshake'
  | 'prepare'
  | 'section-applied'
  | 'present'
  | 'section-presented'
  | 'poster-captured'
  | 'no-errors'
  | 'controls-verified'
  | 'ab-cycles'
  | 'pause-automation'
  | 'suspend-resume'
  | 'audio-state'
  | 'dispose-counters'
  | 'manifest-assets'
  | 'context-loss';

export const CANARY_STEPS: readonly CanaryStep[] = [
  'load', 'handshake', 'prepare', 'section-applied', 'present', 'section-presented',
  'poster-captured', 'no-errors', 'controls-verified', 'ab-cycles', 'pause-automation',
  'suspend-resume', 'audio-state', 'dispose-counters', 'manifest-assets', 'context-loss',
];

/**
 * Steps whose failure DEMOTES rather than fails. A package that cannot survive a synthetic WebGL
 * context loss is not broken — the loss is synthetic and some environments cannot even simulate it
 * — but it has not proven the recovery guarantee, so it may not be `managed-presentable`.
 */
export const DEMOTING_STEPS: ReadonlySet<CanaryStep> = new Set<CanaryStep>([
  'suspend-resume', 'audio-state', 'dispose-counters', 'context-loss', 'pause-automation',
]);

/**
 * Steps whose failure means the package cannot be presented at all. If it will not load, will not
 * apply a section, or will not prove a render, there is nothing to show.
 */
export const FATAL_STEPS: ReadonlySet<CanaryStep> = new Set<CanaryStep>([
  'load', 'prepare', 'section-applied', 'present', 'manifest-assets',
]);

export type CanaryStepStatus = 'pass' | 'fail' | 'skipped' | 'not-applicable';

export interface CanaryStepResult {
  step: CanaryStep;
  status: CanaryStepStatus;
  detail?: string;
  /** Wall-clock milliseconds the step took. Reported, never asserted on. */
  ms?: number;
}

export interface CanaryCaseResult {
  case: CanaryCase;
  steps: readonly CanaryStepResult[];
  /** Capability report the document sent, if it handshook at all. */
  capabilities: SimRuntimeCapabilities | null;
  /** Console/page/network errors captured during the case. */
  errors: readonly CanaryError[];
  /** Resource counts after dispose. A non-empty leak list demotes. */
  countsAfterDispose: SimResourceCounts | null;
  leaked: readonly string[];
  /** Poster identity captured, if any. */
  posterIdentity: string | null;
}

export interface CanaryError {
  source: 'console' | 'pageerror' | 'network' | 'protocol' | 'runtime';
  message: string;
  /** Where it came from, when known. */
  url?: string;
}

export interface CanaryReport {
  packageRevision: string;
  simulationId: string;
  storagePrefix: string;
  classification: SimPackageClass;
  cases: readonly CanaryCaseResult[];
  /** Every manifest asset checked, with the content type actually served. */
  assets: readonly { path: string; ok: boolean; status: number; contentType: string | null }[];
  /** Set when the run itself could not complete. Forces `failed`. */
  aborted: { reason: string } | null;
  startedAt: string;
  finishedAt: string;
  /** Engine the canary ran in, for the record. */
  engine: string;
}

/** Errors that are noise rather than evidence — filtered before judging. */
const IGNORABLE_ERROR_RE =
  /favicon|ResizeObserver loop|Failed to load resource: net::ERR_ABORTED|net::ERR_FAILED.*favicon/i;

export function isSignificantError(err: CanaryError): boolean {
  return !IGNORABLE_ERROR_RE.test(err.message);
}

/**
 * The classification decision, as one pure function so it can be unit-tested without a browser and
 * so the rule is stated exactly once.
 *
 * ORDER OF REASONING
 *  1. An aborted run is `failed`. Incomplete proof is never success.
 *  2. Any fatal step failing, in any case, is `failed`.
 *  3. Any significant error, in any case, is `failed` — a package that throws while being brought
 *     up is not one to grant the aggressive path to.
 *  4. Without an activation-scoped handshake it is legacy; cooperative only if it nonetheless
 *     applied and presented something, opaque otherwise.
 *  5. With a handshake: `managed-presentable` only when EVERY case passed EVERY step, and the
 *     capability report claims everything. Otherwise `managed-partial`.
 */
export function classifyCanaryReport(report: Omit<CanaryReport, 'classification'>): SimPackageClass {
  if (report.aborted) return 'failed';
  if (report.cases.length === 0) return 'failed';
  if (report.assets.some((a) => !a.ok)) return 'failed';

  const failedStep = (c: CanaryCaseResult, step: CanaryStep): boolean =>
    c.steps.some((s) => s.step === step && s.status === 'fail');

  for (const c of report.cases) {
    for (const step of FATAL_STEPS) {
      if (failedStep(c, step)) return 'failed';
    }
    if (c.errors.some(isSignificantError)) return 'failed';
  }

  const handshook = report.cases.every((c) => c.capabilities !== null && c.capabilities.activationScoped);
  if (!handshook) {
    // No v3. Did it at least apply and present under the compatibility path?
    const cooperative = report.cases.every(
      (c) => !failedStep(c, 'section-applied') && !failedStep(c, 'section-presented'),
    );
    return cooperative ? 'legacy-cooperative' : 'legacy-opaque';
  }

  const everythingPassed = report.cases.every((c) =>
    c.steps.every((s) => s.status === 'pass' || s.status === 'not-applicable'),
  );
  const allCapable = report.cases.every((c) => {
    const caps = c.capabilities;
    if (!caps) return false;
    return (
      caps.activationScoped && caps.managedLifecycle && caps.onDemandRender &&
      caps.contextEvents && caps.suspendable && caps.audioControl && caps.qualityControl
    );
  });
  const noLeaks = report.cases.every((c) => c.leaked.length === 0);

  return everythingPassed && allCapable && noLeaks ? 'managed-presentable' : 'managed-partial';
}

/**
 * Human-readable explanation of a classification — every demotion names the case and the step that
 * caused it. A verdict that cannot be explained is a verdict nobody can act on.
 */
export function explainClassification(report: CanaryReport): string[] {
  const lines: string[] = [];
  if (report.aborted) {
    lines.push(`Run aborted: ${report.aborted.reason}. Proof is incomplete, so the package is 'failed'.`);
    return lines;
  }
  for (const c of report.cases) {
    const label = `${c.case.variantKey} @ ${c.case.aspectProfile}/${c.case.qualityProfile}`;
    for (const s of c.steps) {
      if (s.status === 'fail') {
        const severity = FATAL_STEPS.has(s.step) ? 'FATAL' : DEMOTING_STEPS.has(s.step) ? 'demotes' : 'fails';
        lines.push(`${label}: step '${s.step}' ${severity}${s.detail ? ` — ${s.detail}` : ''}`);
      }
    }
    for (const e of c.errors.filter(isSignificantError)) {
      lines.push(`${label}: ${e.source} error — ${e.message}`);
    }
    if (c.leaked.length) lines.push(`${label}: leaked after dispose — ${c.leaked.join(', ')}`);
  }
  const badAssets = report.assets.filter((a) => !a.ok);
  for (const a of badAssets) {
    lines.push(`asset ${a.path} → HTTP ${a.status}${a.contentType ? ` (${a.contentType})` : ''}`);
  }
  if (lines.length === 0) lines.push('Every case passed every step.');
  return lines;
}
