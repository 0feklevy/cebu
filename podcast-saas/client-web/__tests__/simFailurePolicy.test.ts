/**
 * Failure policy: classification, bounded recovery, the circuit breaker — and the canary verdict
 * that must speak the same vocabulary.
 *
 * The rule being defended is that a MODERN package which fails to present is a visible, bounded
 * failure and never a force-reveal, while a LEGACY package is described honestly as legacy rather
 * than as modern-with-an-asterisk. Both halves are testable as pure functions, which is the point of
 * having them as policy rather than as timeouts scattered through the surfaces.
 */
import { describe, it, expect } from 'vitest';
import {
  PACKAGE_CLASS_ORDER,
  SIM_BREAKER_THRESHOLD,
  SIM_CONTEXT_RESTORE_TIMEOUT_MS,
  SIM_DISPOSE_TIMEOUT_MS,
  SIM_HANDSHAKE_TIMEOUT_MS,
  SIM_PREPARE_TIMEOUT_MS,
  SIM_PRESENT_TIMEOUT_MS,
  SIM_SUSPEND_TIMEOUT_MS,
  allowsAggressivePreparation,
  classifyFromCapabilities,
  classifyLegacy,
  initialBreaker,
  isPresentable,
  makeFailure,
  recordFailure,
  recordSuccess,
  recoveryActionsFor,
  type FailureContext,
  type SimFailureKind,
  type SimPackageClass,
  type SimRecoveryAction,
} from 'shared/src/sim/simFailurePolicy';
import {
  NO_CAPABILITIES,
  SIM_BOOTSTRAP_TIMEOUT_MS,
  ZERO_RESOURCE_COUNTS,
  type SimRuntimeCapabilities,
} from 'shared/src/sim/runtimeProtocol';
import {
  CANARY_STEPS,
  DEMOTING_STEPS,
  FATAL_STEPS,
  classifyCanaryReport,
  explainClassification,
  isSignificantError,
  type CanaryCaseResult,
  type CanaryReport,
  type CanaryStep,
} from 'shared/src/sim/canaryContract';
import { DEFAULT_PRESENTATION_CONFIG } from 'shared/src/sim/simIdentity';

// ── capability classification ─────────────────────────────────────────────────────────────────

const FULL_CAPS: SimRuntimeCapabilities = {
  activationScoped: true, managedLifecycle: true, onDemandRender: true, contextEvents: true,
  suspendable: true, audioControl: true, qualityControl: true,
};

const CAPABILITY_KEYS = Object.keys(FULL_CAPS) as (keyof SimRuntimeCapabilities)[];

describe('classifyFromCapabilities', () => {
  it('classifies a package that reports everything as managed-presentable', () => {
    expect(classifyFromCapabilities(FULL_CAPS)).toBe('managed-presentable');
  });

  it('classifies a document that never handshook as legacy-opaque', () => {
    expect(classifyFromCapabilities(null)).toBe('legacy-opaque');
    expect(classifyFromCapabilities(NO_CAPABILITIES)).toBe('legacy-opaque');
  });

  it('demotes to managed-partial when ANY single guarantee is missing', () => {
    // "Presentable" is a promise about the reveal path. A package missing on-demand render cannot
    // make it, and one missing suspend cannot be left resident — so every axis is load-bearing and
    // none of them may be quietly rounded up.
    for (const key of CAPABILITY_KEYS) {
      if (key === 'activationScoped') continue;
      const caps = { ...FULL_CAPS, [key]: false };
      expect(classifyFromCapabilities(caps), `missing ${key}`).toBe('managed-partial');
    }
  });

  it('treats a package that lost activationScoped as legacy, not partial', () => {
    // Without activation scoping there is no identity on its messages at all, so nothing it says
    // can be checked. That is a different kind of thing from a modern package missing one feature.
    expect(classifyFromCapabilities({ ...FULL_CAPS, activationScoped: false })).toBe('legacy-opaque');
  });
});

describe('classifyLegacy', () => {
  const table: [boolean, boolean, SimPackageClass][] = [
    [true, true, 'legacy-cooperative'],
    [true, false, 'legacy-opaque'],
    [false, true, 'legacy-opaque'],
    [false, false, 'legacy-opaque'],
  ];
  for (const [ackCapable, canEmitPaint, expected] of table) {
    it(`ackCapable=${ackCapable}, canEmitPaint=${canEmitPaint} → ${expected}`, () => {
      expect(classifyLegacy({ ackCapable, canEmitPaint })).toBe(expected);
    });
  }
});

describe('what each class is allowed to do', () => {
  it('grants the aggressive path to managed-presentable and nothing else', () => {
    for (const cls of PACKAGE_CLASS_ORDER) {
      expect(allowsAggressivePreparation(cls), cls).toBe(cls === 'managed-presentable');
    }
  });

  it('presents everything except a proven-broken package', () => {
    for (const cls of PACKAGE_CLASS_ORDER) {
      expect(isPresentable(cls), cls).toBe(cls !== 'failed');
    }
  });

  it('orders the classes from most to least trusted, with no gaps or repeats', () => {
    const complete = Object.keys({
      'managed-presentable': 1, 'managed-partial': 1, 'legacy-cooperative': 1,
      'legacy-opaque': 1, failed: 1,
    } satisfies Record<SimPackageClass, 1>);
    expect([...PACKAGE_CLASS_ORDER].sort()).toEqual(complete.sort());
    expect(new Set(PACKAGE_CLASS_ORDER).size).toBe(PACKAGE_CLASS_ORDER.length);
    expect(PACKAGE_CLASS_ORDER[0]).toBe('managed-presentable');
    expect(PACKAGE_CLASS_ORDER[PACKAGE_CLASS_ORDER.length - 1]).toBe('failed');
  });
});

// ── recovery actions ──────────────────────────────────────────────────────────────────────────

const ALL_ACTIONS = Object.keys({
  retry: 1, skip: 1, 'back-to-video': 1, 'poster-only': 1,
} satisfies Record<SimRecoveryAction, 1>) as SimRecoveryAction[];

const CONTEXTS: FailureContext[] = [false, true].flatMap((hasPoster) =>
  [false, true].flatMap((hasVideo) =>
    [false, true].map((canSkip) => ({ hasPoster, hasVideo, canSkip })),
  ),
);

describe('recoveryActionsFor', () => {
  it('offers no action that shows an unverified frame', () => {
    // The vocabulary itself is the guarantee: there is no 'reveal-anyway'. A modern package that
    // will not present is shown as a failure, because showing a frame nothing vouched for is the
    // defect the protocol exists to eliminate — and it is worse when it is deliberate.
    expect(ALL_ACTIONS.sort()).toEqual(['back-to-video', 'poster-only', 'retry', 'skip']);
  });

  it('never returns an empty list, whatever the context', () => {
    for (const ctx of CONTEXTS) {
      for (const breakerOpen of [false, true]) {
        const actions = recoveryActionsFor(ctx, breakerOpen);
        expect(actions.length, JSON.stringify({ ctx, breakerOpen })).toBeGreaterThan(0);
      }
    }
  });

  it('returns only known actions, never a duplicate', () => {
    for (const ctx of CONTEXTS) {
      for (const breakerOpen of [false, true]) {
        const actions = recoveryActionsFor(ctx, breakerOpen);
        expect(new Set(actions).size).toBe(actions.length);
        for (const a of actions) expect(ALL_ACTIONS).toContain(a);
      }
    }
  });

  it('puts poster-only first whenever a poster exists', () => {
    // It is the only option that shows the user the right picture immediately, and it costs nothing.
    for (const ctx of CONTEXTS.filter((c) => c.hasPoster)) {
      for (const breakerOpen of [false, true]) {
        expect(recoveryActionsFor(ctx, breakerOpen)[0]).toBe('poster-only');
      }
    }
  });

  it('puts retry ahead of skip and back-to-video — it is the only one that can still deliver the section', () => {
    const actions = recoveryActionsFor({ hasPoster: true, hasVideo: true, canSkip: true }, false);
    expect(actions).toEqual(['poster-only', 'retry', 'skip', 'back-to-video']);
  });

  it('withdraws retry once the breaker is open', () => {
    const actions = recoveryActionsFor({ hasPoster: true, hasVideo: true, canSkip: true }, true);
    expect(actions).not.toContain('retry');
    expect(actions).toEqual(['poster-only', 'skip', 'back-to-video']);
  });

  it('falls back to skip when the user would otherwise be stuck', () => {
    const dead: FailureContext = { hasPoster: false, hasVideo: false, canSkip: false };
    expect(recoveryActionsFor(dead, true)).toEqual(['skip']);
  });

  it('offers only retry when nothing else is available but the breaker is closed', () => {
    expect(recoveryActionsFor({ hasPoster: false, hasVideo: false, canSkip: false }, false)).toEqual(['retry']);
  });
});

// ── retry and the circuit breaker ─────────────────────────────────────────────────────────────

describe('circuit breaker', () => {
  it('starts closed with no history', () => {
    expect(initialBreaker()).toEqual({ failures: 0, open: false, reasons: [] });
  });

  it('opens at exactly the threshold, not before', () => {
    let b = initialBreaker();
    for (let i = 1; i < SIM_BREAKER_THRESHOLD; i++) {
      b = recordFailure(b, 'present-timeout');
      expect(b.open, `after ${i} failures`).toBe(false);
      expect(b.failures).toBe(i);
    }
    b = recordFailure(b, 'present-timeout');
    expect(b.failures).toBe(SIM_BREAKER_THRESHOLD);
    expect(b.open).toBe(true);
  });

  it('stays open on further failures', () => {
    let b = initialBreaker();
    for (let i = 0; i < SIM_BREAKER_THRESHOLD + 5; i++) b = recordFailure(b, 'prepare-timeout');
    expect(b.open).toBe(true);
    expect(b.failures).toBe(SIM_BREAKER_THRESHOLD + 5);
  });

  it('records the reasons, bounded', () => {
    let b = initialBreaker();
    const kinds: SimFailureKind[] = ['prepare-timeout', 'present-timeout', 'section-error', 'document-error', 'transport-closed', 'handshake-failed', 'context-lost-unrecovered'];
    for (let i = 0; i < 20; i++) b = recordFailure(b, kinds[i % kinds.length]);
    expect(b.reasons.length).toBe(SIM_BREAKER_THRESHOLD * 2);
    expect(b.reasons[b.reasons.length - 1]).toBe(kinds[19 % kinds.length]);
  });

  it('resets completely on a success — no half-open state, no decay window', () => {
    // Both were considered and rejected: they make the breaker's behaviour depend on wall-clock
    // timing, which is exactly what made the previous generation of reveal bugs irreproducible.
    let b = initialBreaker();
    for (let i = 0; i < SIM_BREAKER_THRESHOLD; i++) b = recordFailure(b, 'present-timeout');
    expect(b.open).toBe(true);
    expect(recordSuccess(b)).toEqual({ failures: 0, open: false, reasons: [] });
  });

  it('is pure — recording a failure does not mutate the previous state', () => {
    const before = initialBreaker();
    const frozen = Object.freeze({ ...before, reasons: Object.freeze([...before.reasons]) });
    expect(() => recordFailure(frozen, 'section-error')).not.toThrow();
    expect(frozen.failures).toBe(0);
  });

  it('stops offering automatic retries once open, per package per session', () => {
    let b = initialBreaker();
    const ctx: FailureContext = { hasPoster: true, hasVideo: true, canSkip: true };
    expect(recoveryActionsFor(ctx, b.open)).toContain('retry');
    for (let i = 0; i < SIM_BREAKER_THRESHOLD; i++) b = recordFailure(b, 'present-timeout');
    expect(recoveryActionsFor(ctx, b.open)).not.toContain('retry');
  });
});

describe('makeFailure', () => {
  it('composes the kind, attempt, actions and breaker state into one reportable object', () => {
    let breaker = initialBreaker();
    breaker = recordFailure(breaker, 'present-timeout');
    const failure = makeFailure('present-timeout', 'no SECTION_PRESENTED in 5s', 1, { hasPoster: true, hasVideo: true, canSkip: false }, breaker);
    expect(failure).toEqual({
      kind: 'present-timeout',
      message: 'no SECTION_PRESENTED in 5s',
      attempt: 1,
      actions: ['poster-only', 'retry', 'back-to-video'],
      breakerOpen: false,
    });
  });

  it('reflects an open breaker in both the flag and the actions', () => {
    let breaker = initialBreaker();
    for (let i = 0; i < SIM_BREAKER_THRESHOLD; i++) breaker = recordFailure(breaker, 'handshake-failed');
    const failure = makeFailure('handshake-failed', 'child never accepted the port', 3, { hasPoster: false, hasVideo: true, canSkip: true }, breaker);
    expect(failure.breakerOpen).toBe(true);
    expect(failure.actions).toEqual(['skip', 'back-to-video']);
  });

  it('covers every failure kind with a bounded, non-empty action set', () => {
    const kinds = Object.keys({
      'prepare-timeout': 1, 'present-timeout': 1, 'section-error': 1, 'document-error': 1,
      'context-lost-unrecovered': 1, 'transport-closed': 1, 'handshake-failed': 1,
    } satisfies Record<SimFailureKind, 1>) as SimFailureKind[];
    for (const kind of kinds) {
      const failure = makeFailure(kind, kind, 1, { hasPoster: false, hasVideo: false, canSkip: false }, initialBreaker());
      expect(failure.actions.length, kind).toBeGreaterThan(0);
    }
  });
});

describe('transport closure is a bounded failure like any other', () => {
  it('offers the poster and a retry when the port dies mid-activation', () => {
    const failure = makeFailure('transport-closed', 'MessagePort closed', 1, { hasPoster: true, hasVideo: true, canSkip: true }, initialBreaker());
    expect(failure.actions[0]).toBe('poster-only');
    expect(failure.actions).toContain('retry');
  });

  it('never leaves the user on a permanent spinner — every kind resolves to an action', () => {
    for (const ctx of CONTEXTS) {
      const failure = makeFailure('transport-closed', 'closed', 1, ctx, initialBreaker());
      expect(failure.actions.length).toBeGreaterThan(0);
    }
  });
});

// ── timeouts ──────────────────────────────────────────────────────────────────────────────────

describe('timeout bounds', () => {
  it('are all positive, finite and integral', () => {
    const bounds = {
      SIM_HANDSHAKE_TIMEOUT_MS, SIM_PREPARE_TIMEOUT_MS, SIM_PRESENT_TIMEOUT_MS,
      SIM_SUSPEND_TIMEOUT_MS, SIM_DISPOSE_TIMEOUT_MS, SIM_CONTEXT_RESTORE_TIMEOUT_MS,
    };
    for (const [name, ms] of Object.entries(bounds)) {
      expect(Number.isInteger(ms), name).toBe(true);
      expect(ms, name).toBeGreaterThan(0);
    }
  });

  it('bounds the handshake identically on both sides of the bootstrap', () => {
    // They bound the SAME wait: the parent concluding "legacy" and the failure policy declaring
    // 'handshake-failed'. If they drifted apart, one of the two would fire on a package the other
    // still considered live.
    expect(SIM_HANDSHAKE_TIMEOUT_MS).toBe(SIM_BOOTSTRAP_TIMEOUT_MS);
  });

  it('allows a lost context longer than a single present, since recovery is a browser event', () => {
    expect(SIM_CONTEXT_RESTORE_TIMEOUT_MS).toBeGreaterThan(SIM_PRESENT_TIMEOUT_MS);
  });
});

// ── legacy downgrade, via the canary ──────────────────────────────────────────────────────────

const CASE = {
  variantKey: 'section-A',
  config: DEFAULT_PRESENTATION_CONFIG,
  aspectProfile: 'wide' as const,
  qualityProfile: 'high' as const,
};

function caseResult(over: Partial<CanaryCaseResult> = {}): CanaryCaseResult {
  return {
    case: CASE,
    steps: CANARY_STEPS.map((step) => ({ step, status: 'pass' as const })),
    capabilities: FULL_CAPS,
    errors: [],
    countsAfterDispose: ZERO_RESOURCE_COUNTS,
    leaked: [],
    posterIdentity: 'rev__section-A__cfg__wide__high',
    ...over,
  };
}

function withFailedStep(step: CanaryStep, over: Partial<CanaryCaseResult> = {}): CanaryCaseResult {
  const base = caseResult(over);
  return { ...base, steps: base.steps.map((s) => (s.step === step ? { ...s, status: 'fail', detail: 'nope' } : s)) };
}

type Report = Omit<CanaryReport, 'classification'>;

function report(over: Partial<Report> = {}): Report {
  return {
    packageRevision: 'rev_1',
    simulationId: 'sim_1',
    storagePrefix: 'simulations/p/s',
    cases: [caseResult()],
    assets: [{ path: 'index.html', ok: true, status: 200, contentType: 'text/html' }],
    aborted: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    engine: 'chromium/test',
    ...over,
  };
}

describe('classifyCanaryReport', () => {
  it('grants managed-presentable only when every case passed every step with every capability', () => {
    expect(classifyCanaryReport(report())).toBe('managed-presentable');
  });

  it('agrees with the runtime classification for the same capability report', () => {
    // The canary verdict and the runtime classification use ONE vocabulary on purpose: a package the
    // canary called managed-presentable that behaves as legacy-opaque at runtime is a reportable
    // contradiction, not two unrelated opinions.
    expect(classifyCanaryReport(report())).toBe(classifyFromCapabilities(FULL_CAPS));
  });

  it('fails an aborted run even when every completed step passed', () => {
    // Incomplete proof is never success — and specifically never a legacy class, because
    // legacy-cooperative is a claim that cooperative behaviour was OBSERVED.
    const r = report({ aborted: { reason: 'browser crashed' } });
    expect(classifyCanaryReport(r)).toBe('failed');
  });

  it('fails a run with no cases at all', () => {
    expect(classifyCanaryReport(report({ cases: [] }))).toBe('failed');
  });

  it('fails a run where any manifest asset did not serve', () => {
    const r = report({ assets: [{ path: 'bundle.js', ok: false, status: 404, contentType: null }] });
    expect(classifyCanaryReport(r)).toBe('failed');
  });

  for (const step of FATAL_STEPS) {
    it(`fails when the fatal step '${step}' fails`, () => {
      expect(classifyCanaryReport(report({ cases: [withFailedStep(step)] }))).toBe('failed');
    });
  }

  for (const step of DEMOTING_STEPS) {
    it(`demotes to managed-partial when the step '${step}' fails`, () => {
      expect(classifyCanaryReport(report({ cases: [withFailedStep(step)] }))).toBe('managed-partial');
    });
  }

  it('keeps the fatal and demoting sets disjoint, and both inside the step list', () => {
    for (const step of FATAL_STEPS) {
      expect(DEMOTING_STEPS.has(step), `${step} cannot be both fatal and merely demoting`).toBe(false);
      expect(CANARY_STEPS).toContain(step);
    }
    for (const step of DEMOTING_STEPS) expect(CANARY_STEPS).toContain(step);
  });

  it('demotes when a package leaks after dispose', () => {
    const r = report({ cases: [caseResult({ leaked: ['WebGLRenderer', 'AudioContext'] })] });
    expect(classifyCanaryReport(r)).toBe('managed-partial');
  });

  it('demotes when the capability report is short of a full promise', () => {
    const r = report({ cases: [caseResult({ capabilities: { ...FULL_CAPS, suspendable: false } })] });
    expect(classifyCanaryReport(r)).toBe('managed-partial');
  });

  it('lets ONE bad variant demote the whole package', () => {
    // The player picks the variant at runtime and cannot be selective about a promise.
    const r = report({
      cases: [
        caseResult(),
        withFailedStep('context-loss', { case: { ...CASE, variantKey: 'section-B' } }),
      ],
    });
    expect(classifyCanaryReport(r)).toBe('managed-partial');
  });

  it('fails on a significant error even when every step passed', () => {
    const r = report({ cases: [caseResult({ errors: [{ source: 'pageerror', message: 'TypeError: x is undefined' }] })] });
    expect(classifyCanaryReport(r)).toBe('failed');
  });

  it('ignores known-noise errors', () => {
    const r = report({
      cases: [caseResult({ errors: [
        { source: 'network', message: 'Failed to load resource: net::ERR_ABORTED favicon.ico' },
        { source: 'console', message: 'ResizeObserver loop completed with undelivered notifications.' },
      ] })],
    });
    expect(classifyCanaryReport(r)).toBe('managed-presentable');
  });

  describe('legacy downgrade', () => {
    it('classifies a package with no activation-scoped handshake as legacy-cooperative when it still applied and presented', () => {
      const legacyCase = caseResult({
        capabilities: null,
        steps: CANARY_STEPS.map((step) => ({
          step,
          status: DEMOTING_STEPS.has(step) ? ('not-applicable' as const) : ('pass' as const),
        })),
      });
      expect(classifyCanaryReport(report({ cases: [legacyCase] }))).toBe('legacy-cooperative');
    });

    it('classifies it legacy-opaque when it could not even prove a presentation', () => {
      const opaque = withFailedStep('section-presented', { capabilities: null });
      expect(classifyCanaryReport(report({ cases: [opaque] }))).toBe('legacy-opaque');
    });

    it('treats a capability report that claims nothing as legacy, not partial', () => {
      const noCaps = caseResult({ capabilities: NO_CAPABILITIES });
      expect(classifyCanaryReport(report({ cases: [noCaps] }))).toBe('legacy-cooperative');
      expect(classifyFromCapabilities(NO_CAPABILITIES)).toBe('legacy-opaque');
    });

    it('never grants a legacy package the aggressive preparation path', () => {
      for (const cls of ['legacy-cooperative', 'legacy-opaque'] as const) {
        expect(allowsAggressivePreparation(cls)).toBe(false);
        expect(isPresentable(cls)).toBe(true);
      }
    });
  });
});

describe('isSignificantError', () => {
  it('filters the known noise', () => {
    expect(isSignificantError({ source: 'network', message: 'GET /favicon.ico 404' })).toBe(false);
    expect(isSignificantError({ source: 'console', message: 'ResizeObserver loop limit exceeded' })).toBe(false);
  });

  it('keeps anything that could be evidence', () => {
    expect(isSignificantError({ source: 'pageerror', message: 'ReferenceError: THREE is not defined' })).toBe(true);
    expect(isSignificantError({ source: 'protocol', message: 'SECTION_PRESENTED for an unknown activation' })).toBe(true);
    expect(isSignificantError({ source: 'network', message: 'GET /assets/model.glb 500' })).toBe(true);
  });
});

describe('explainClassification', () => {
  it('names the case and the step for every demotion', () => {
    const r: CanaryReport = {
      ...report({ cases: [withFailedStep('suspend-resume'), withFailedStep('load', { case: { ...CASE, variantKey: 'section-B' } })] }),
      classification: 'failed',
    };
    const lines = explainClassification(r);
    expect(lines.some((l) => l.includes('section-A') && l.includes('suspend-resume') && l.includes('demotes'))).toBe(true);
    expect(lines.some((l) => l.includes('section-B') && l.includes('load') && l.includes('FATAL'))).toBe(true);
  });

  it('explains an aborted run and stops there', () => {
    const r: CanaryReport = { ...report({ aborted: { reason: 'timed out after 120s' } }), classification: 'failed' };
    const lines = explainClassification(r);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('timed out after 120s');
  });

  it('reports leaks and bad assets', () => {
    const r: CanaryReport = {
      ...report({
        cases: [caseResult({ leaked: ['AudioContext'] })],
        assets: [{ path: 'a.js', ok: false, status: 403, contentType: 'text/plain' }],
      }),
      classification: 'failed',
    };
    const lines = explainClassification(r);
    expect(lines.some((l) => l.includes('leaked after dispose') && l.includes('AudioContext'))).toBe(true);
    expect(lines.some((l) => l.includes('a.js') && l.includes('403'))).toBe(true);
  });

  it('says so plainly when there is nothing to explain', () => {
    const r: CanaryReport = { ...report(), classification: 'managed-presentable' };
    expect(explainClassification(r)).toEqual(['Every case passed every step.']);
  });
});
