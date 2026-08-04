/**
 * The publish-time canary verdict — shared-side.
 *
 * RELATIONSHIP TO client-web/__tests__/simFailurePolicy.test.ts
 * That file's `classifyCanaryReport` block iterates FATAL_STEPS and DEMOTING_STEPS separately. The
 * gap that leaves is the steps in NEITHER set: `handshake`, `section-presented`, `poster-captured`,
 * `no-errors`, `controls-verified`, `ab-cycles`. Nothing there asserts what happens when one of
 * those fails, and "unclassified" is exactly where a step quietly stops mattering. The sweep below
 * runs over ALL of CANARY_STEPS, so every step has a stated severity and a new step added to the
 * list without a decision shows up immediately.
 *
 * `explainClassification` is also untested anywhere. A verdict nobody can explain is a verdict
 * nobody can act on, which makes the explanation part of the contract rather than logging.
 */
import { describe, it, expect } from 'vitest';
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
  type CanaryStepResult,
} from '../canaryContract.js';
import { NO_CAPABILITIES, ZERO_RESOURCE_COUNTS, type SimRuntimeCapabilities } from '../runtimeProtocol.js';
import { DEFAULT_PRESENTATION_CONFIG } from '../simIdentity.js';

const FULL_CAPABILITIES: SimRuntimeCapabilities = {
  activationScoped: true, managedLifecycle: true, onDemandRender: true, contextEvents: true,
  suspendable: true, audioControl: true, qualityControl: true,
};

const CASE: CanaryCase = {
  variantKey: 'sec-1',
  config: DEFAULT_PRESENTATION_CONFIG,
  aspectProfile: 'wide',
  qualityProfile: 'high',
};

const allPassing = (): CanaryStepResult[] => CANARY_STEPS.map((step) => ({ step, status: 'pass' as const }));

const caseResult = (over: Partial<CanaryCaseResult> = {}): CanaryCaseResult => ({
  case: CASE,
  steps: allPassing(),
  capabilities: FULL_CAPABILITIES,
  errors: [],
  countsAfterDispose: ZERO_RESOURCE_COUNTS,
  leaked: [],
  posterIdentity: 'a3f9c1d0e7b45268__sec-1__0123456789abcdef__wide__high',
  ...over,
});

const report = (over: Partial<Omit<CanaryReport, 'classification'>> = {}): Omit<CanaryReport, 'classification'> => ({
  packageRevision: 'a3f9c1d0e7b45268',
  simulationId: 'sim-1',
  storagePrefix: 'simulations/proj-1/sim-1',
  cases: [caseResult()],
  assets: [{ path: 'index.html', ok: true, status: 200, contentType: 'text/html' }],
  aborted: null,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:01:00.000Z',
  engine: 'chromium',
  ...over,
});

/** Replace one step's status inside an otherwise all-passing case. */
const withFailedStep = (step: CanaryStep): CanaryCaseResult =>
  caseResult({ steps: allPassing().map((s) => (s.step === step ? { ...s, status: 'fail', detail: 'no' } : s)) });

describe('the step severity partition covers every step', () => {
  it('lists sixteen steps, with no repeats', () => {
    expect(CANARY_STEPS).toHaveLength(16);
    expect(new Set(CANARY_STEPS).size).toBe(16);
  });

  it('keeps FATAL and DEMOTING disjoint, and both inside the step list', () => {
    const overlap = [...FATAL_STEPS].filter((s) => DEMOTING_STEPS.has(s));
    expect(overlap).toEqual([]);
    for (const step of [...FATAL_STEPS, ...DEMOTING_STEPS]) expect(CANARY_STEPS).toContain(step);
  });

  it('leaves six steps in neither set — the ones the sweep below exists for', () => {
    const neither = CANARY_STEPS.filter((s) => !FATAL_STEPS.has(s) && !DEMOTING_STEPS.has(s));
    expect(neither.sort()).toEqual(
      ['ab-cycles', 'controls-verified', 'handshake', 'no-errors', 'poster-captured', 'section-presented'].sort(),
    );
  });
});

describe('classifyCanaryReport — every step, failed one at a time', () => {
  it('grants managed-presentable only when everything passed', () => {
    expect(classifyCanaryReport(report())).toBe('managed-presentable');
  });

  for (const step of CANARY_STEPS) {
    const expected = FATAL_STEPS.has(step) ? 'failed' : 'managed-partial';
    it(`failing '${step}' yields ${expected}`, () => {
      expect(classifyCanaryReport(report({ cases: [withFailedStep(step)] }))).toBe(expected);
    });
  }

  it('treats a step marked not-applicable as no obstacle at all', () => {
    // Some environments genuinely cannot simulate a WebGL context loss. Not being able to RUN the
    // check is different from running it and failing.
    const steps = allPassing().map((s) => (s.step === 'context-loss' ? { ...s, status: 'not-applicable' as const } : s));
    expect(classifyCanaryReport(report({ cases: [caseResult({ steps })] }))).toBe('managed-presentable');
  });

  it('treats a SKIPPED step as a demotion — a step that did not run has proven nothing', () => {
    const steps = allPassing().map((s) => (s.step === 'suspend-resume' ? { ...s, status: 'skipped' as const } : s));
    expect(classifyCanaryReport(report({ cases: [caseResult({ steps })] }))).toBe('managed-partial');
  });
});

describe('classifyCanaryReport — incomplete proof is never success', () => {
  it('fails an aborted run even when every completed step passed', () => {
    // `legacy-cooperative` is a statement that the package was OBSERVED behaving cooperatively.
    // An aborted run observed nothing, so downgrading to a legacy class would be a claim about
    // evidence that was never collected.
    expect(classifyCanaryReport(report({ aborted: { reason: 'browser crashed' } }))).toBe('failed');
  });

  it('fails a run with no cases at all', () => {
    expect(classifyCanaryReport(report({ cases: [] }))).toBe('failed');
  });

  it('fails a run where any manifest asset did not serve', () => {
    const assets = [
      { path: 'index.html', ok: true, status: 200, contentType: 'text/html' },
      { path: 'bundle.js', ok: false, status: 404, contentType: null },
    ];
    expect(classifyCanaryReport(report({ assets }))).toBe('failed');
  });

  it('lets ONE bad variant demote the whole package', () => {
    // The player picks the variant at runtime and cannot be selective about a promise.
    const cases = [caseResult(), withFailedStep('suspend-resume')];
    expect(classifyCanaryReport(report({ cases }))).toBe('managed-partial');
  });

  it('lets ONE fatal variant fail the whole package', () => {
    expect(classifyCanaryReport(report({ cases: [caseResult(), withFailedStep('prepare')] }))).toBe('failed');
  });

  it('demotes when a package leaks after dispose', () => {
    expect(classifyCanaryReport(report({ cases: [caseResult({ leaked: ['AudioContext'] })] }))).toBe('managed-partial');
  });

  it('demotes when the capability report is short of a full promise', () => {
    const capabilities = { ...FULL_CAPABILITIES, onDemandRender: false };
    expect(classifyCanaryReport(report({ cases: [caseResult({ capabilities })] }))).toBe('managed-partial');
  });
});

describe('classifyCanaryReport — the legacy path', () => {
  it('classifies a package that never handshook but still applied and presented as legacy-cooperative', () => {
    const cases = [caseResult({ capabilities: null })];
    expect(classifyCanaryReport(report({ cases }))).toBe('legacy-cooperative');
  });

  it('classifies a package with capabilities but no activationScoped as legacy too', () => {
    const cases = [caseResult({ capabilities: NO_CAPABILITIES })];
    expect(classifyCanaryReport(report({ cases }))).toBe('legacy-cooperative');
  });

  it('drops to legacy-opaque when it could not even prove a presentation', () => {
    const steps = allPassing().map((s) => (s.step === 'section-presented' ? { ...s, status: 'fail' as const } : s));
    const cases = [caseResult({ capabilities: null, steps })];
    expect(classifyCanaryReport(report({ cases }))).toBe('legacy-opaque');
  });

  it('needs EVERY case to have handshaken before it is judged as modern', () => {
    // A mixed report — one variant that spoke v3 and one that did not — is legacy, because the
    // package as a whole has not made the promise.
    const cases = [caseResult(), caseResult({ capabilities: null })];
    expect(classifyCanaryReport(report({ cases }))).toBe('legacy-cooperative');
  });
});

describe('errors', () => {
  it('fails on a significant error even when every step passed', () => {
    const errors = [{ source: 'pageerror' as const, message: 'TypeError: x is not a function' }];
    expect(classifyCanaryReport(report({ cases: [caseResult({ errors })] }))).toBe('failed');
  });

  it('ignores known noise', () => {
    const noise = [
      'GET /favicon.ico 404',
      'ResizeObserver loop completed with undelivered notifications',
      'Failed to load resource: net::ERR_ABORTED',
    ];
    for (const message of noise) {
      expect(isSignificantError({ source: 'console', message })).toBe(false);
      expect(classifyCanaryReport(report({ cases: [caseResult({ errors: [{ source: 'console', message }] })] })))
        .toBe('managed-presentable');
    }
  });

  it('keeps a real error even when it merely resembles the noise patterns', () => {
    const real = [
      'WebGL: CONTEXT_LOST_WEBGL',
      'Uncaught (in promise) DOMException: play() failed',
      'net::ERR_CONNECTION_REFUSED loading bundle.js',
      'ResizeObserver is not defined',
    ];
    for (const message of real) expect(isSignificantError({ source: 'console', message })).toBe(true);
  });
});

describe('explainClassification — every demotion names the case and the step', () => {
  const full = (over: Partial<CanaryReport> = {}): CanaryReport => ({ ...report(), classification: 'managed-presentable', ...over });

  it('says so plainly when nothing went wrong', () => {
    expect(explainClassification(full())).toEqual(['Every case passed every step.']);
  });

  it('short-circuits on an aborted run and explains why the verdict is failed', () => {
    const lines = explainClassification(full({ aborted: { reason: 'timed out after 120s' }, classification: 'failed' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('timed out after 120s');
    expect(lines[0]).toContain('failed');
  });

  it('names the case, the step and its severity for a fatal failure', () => {
    const lines = explainClassification(full({ cases: [withFailedStep('prepare')], classification: 'failed' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('sec-1 @ wide/high');
    expect(lines[0]).toContain("'prepare'");
    expect(lines[0]).toContain('FATAL');
  });

  it('distinguishes a demoting step from a fatal one in the wording', () => {
    const lines = explainClassification(full({ cases: [withFailedStep('suspend-resume')], classification: 'managed-partial' }));
    expect(lines[0]).toContain('demotes');
    expect(lines[0]).not.toContain('FATAL');
  });

  it('reports a step in neither set as a plain failure rather than mislabelling it', () => {
    const lines = explainClassification(full({ cases: [withFailedStep('ab-cycles')], classification: 'managed-partial' }));
    expect(lines[0]).toContain("'ab-cycles' fails");
  });

  it('lists leaks, significant errors and bad assets, and omits the noise it filtered', () => {
    const cases = [caseResult({
      leaked: ['AudioContext', 'Worker'],
      errors: [
        { source: 'pageerror', message: 'TypeError: boom' },
        { source: 'console', message: 'GET /favicon.ico 404' },
      ],
    })];
    const assets = [
      { path: 'index.html', ok: true, status: 200, contentType: 'text/html' },
      { path: 'bundle.js', ok: false, status: 404, contentType: null },
    ];
    const lines = explainClassification(full({ cases, assets, classification: 'failed' }));
    const joined = lines.join('\n');
    expect(joined).toContain('AudioContext, Worker');
    expect(joined).toContain('TypeError: boom');
    expect(joined).toContain('bundle.js');
    expect(joined).toContain('404');
    expect(joined).not.toContain('favicon');
  });

  it('explains every case, not only the first', () => {
    const cases = [
      withFailedStep('suspend-resume'),
      caseResult({ case: { ...CASE, variantKey: 'sec-2', aspectProfile: 'portrait' }, leaked: ['Worker'] }),
    ];
    const joined = explainClassification(full({ cases, classification: 'managed-partial' })).join('\n');
    expect(joined).toContain('sec-1 @ wide/high');
    expect(joined).toContain('sec-2 @ portrait/high');
  });
});
