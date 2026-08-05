/**
 * Tests for the canary verdict.
 *
 * The point of these is adversarial rather than illustrative: every one of them describes a way a
 * package could be granted the modern guarantees WITHOUT having demonstrated them, and asserts it
 * is refused. The classification rule itself lives in shared/src/sim/canaryContract; what is
 * pinned here is the server's use of it — assembly, the honesty and completeness guards, the
 * pessimistic merge, and the explanation a human acts on.
 */
import { describe, expect, it } from 'vitest';
import {
  CANARY_STEPS,
  DEMOTING_STEPS,
  FATAL_STEPS,
  type CanaryCase,
  type CanaryCaseResult,
  type CanaryError,
  type CanaryReport,
  type CanaryStep,
  type CanaryStepResult,
} from 'shared/sim/canaryContract';
import type { SimRuntimeCapabilities, SimResourceCounts } from 'shared/sim/runtimeProtocol';
import { ZERO_RESOURCE_COUNTS } from 'shared/sim/runtimeProtocol';
import { DEFAULT_PRESENTATION_CONFIG } from 'shared/sim/simIdentity';
import {
  assembleCanaryReport,
  caseLabel,
  classificationIsHonest,
  describeCanaryDecision,
  failedStepsOf,
  isCanaryReportComplete,
  judgeCanaryReport,
  mayPublishAsModern,
  mergeCanaryReports,
  missingStepsOf,
  recomputeClassification,
  summarizeCanary,
  type CanaryAssetResult,
  type CanaryReportMeta,
} from '../canaryJudge.js';

// ── builders ────────────────────────────────────────────────────────────────────────────

const FULL_CAPS: SimRuntimeCapabilities = {
  activationScoped: true,
  managedLifecycle: true,
  onDemandRender: true,
  contextEvents: true,
  suspendable: true,
  audioControl: true,
  qualityControl: true,
};

const META: CanaryReportMeta = {
  packageRevision: 'rev0001',
  simulationId: 'sim-1',
  storagePrefix: 'simulations/p1/sim-1',
  startedAt: '2026-08-03T10:00:00.000Z',
  finishedAt: '2026-08-03T10:01:00.000Z',
  engine: 'chromium/1.2.3',
};

function makeCase(variantKey = 'A', simpleUi = false): CanaryCase {
  return {
    variantKey,
    config: { ...DEFAULT_PRESENTATION_CONFIG, simpleUi, hideSelectors: simpleUi ? ['.controls'] : [] },
    aspectProfile: 'wide',
    qualityProfile: 'high',
  };
}

const allPassing = (): CanaryStepResult[] =>
  CANARY_STEPS.map((step) => ({ step, status: 'pass' as const, ms: 5 }));

interface CaseOverrides {
  variantKey?: string;
  simpleUi?: boolean;
  steps?: CanaryStepResult[];
  capabilities?: SimRuntimeCapabilities | null;
  errors?: CanaryError[];
  leaked?: string[];
  countsAfterDispose?: SimResourceCounts | null;
}

function okCase(o: CaseOverrides = {}): CanaryCaseResult {
  return {
    case: makeCase(o.variantKey ?? 'A', o.simpleUi ?? false),
    steps: o.steps ?? allPassing(),
    capabilities: o.capabilities === undefined ? FULL_CAPS : o.capabilities,
    errors: o.errors ?? [],
    countsAfterDispose: o.countsAfterDispose === undefined ? ZERO_RESOURCE_COUNTS : o.countsAfterDispose,
    leaked: o.leaked ?? [],
    posterIdentity: 'rev0001__A__cfg0__wide__high',
  };
}

/** Same as `okCase` but with one step forced to a status. */
function caseWithStep(step: CanaryStep, status: CanaryStepResult['status'], o: CaseOverrides = {}): CanaryCaseResult {
  const steps = allPassing().map((s) => (s.step === step ? { ...s, status, detail: `forced ${status}` } : s));
  return okCase({ ...o, steps });
}

const OK_ASSETS: CanaryAssetResult[] = [
  { path: '/sim-public/x/index.html', ok: true, status: 200, contentType: 'text/html; charset=utf-8' },
  { path: '/sim-public/x/bridge.js', ok: true, status: 200, contentType: 'application/javascript' },
];

const report = (
  cases: CanaryCaseResult[],
  assets: CanaryAssetResult[] = OK_ASSETS,
  aborted: { reason: string } | null = null,
): CanaryReport => assembleCanaryReport(META, cases, assets, aborted);

// ── assembly ────────────────────────────────────────────────────────────────────────────

describe('assembleCanaryReport', () => {
  it('stamps the classification the evidence supports and carries the meta through', () => {
    const r = report([okCase()]);
    expect(r.classification).toBe('managed-presentable');
    expect(r.packageRevision).toBe('rev0001');
    expect(r.simulationId).toBe('sim-1');
    expect(r.storagePrefix).toBe('simulations/p1/sim-1');
    expect(r.engine).toBe('chromium/1.2.3');
    expect(classificationIsHonest(r)).toBe(true);
  });

  it('a clean run of several cases is publishable as modern', () => {
    const r = report([okCase({ variantKey: 'A' }), okCase({ variantKey: 'B', simpleUi: true })]);
    expect(r.classification).toBe('managed-presentable');
    expect(mayPublishAsModern(r)).toBe(true);
  });
});

// ── aborted ─────────────────────────────────────────────────────────────────────────────

describe('an aborted run is never a downgrade', () => {
  it('classifies as failed even when every case passed everything', () => {
    const r = report([okCase()], OK_ASSETS, { reason: 'browser crashed' });
    expect(r.classification).toBe('failed');
    expect(mayPublishAsModern(r)).toBe(false);
  });

  it('the decision names the abort reason and does not claim incompleteness instead', () => {
    const d = judgeCanaryReport(report([okCase()], OK_ASSETS, { reason: 'asset server unreachable' }));
    expect(d.classification).toBe('failed');
    expect(d.headline).toContain('asset server unreachable');
    expect(d.reasons.join('\n')).toContain('Proof is incomplete');
    expect(d.reasons.join('\n')).not.toContain('Run is incomplete —');
  });

  it('a run with no cases at all is failed, not vacuously presentable', () => {
    const r = report([]);
    expect(r.classification).toBe('failed');
    expect(isCanaryReportComplete(r)).toBe(false);
    expect(mayPublishAsModern(r)).toBe(false);
  });
});

// ── fatal steps ─────────────────────────────────────────────────────────────────────────

describe('fatal steps', () => {
  for (const step of FATAL_STEPS) {
    it(`a failed '${step}' fails the whole package`, () => {
      const r = report([okCase({ variantKey: 'A' }), caseWithStep(step, 'fail', { variantKey: 'B' })]);
      expect(r.classification).toBe('failed');
      expect(mayPublishAsModern(r)).toBe(false);
    });
  }

  it('names the failing case and marks it FATAL in the explanation', () => {
    const d = judgeCanaryReport(report([caseWithStep('present', 'fail', { variantKey: 'B' })]));
    expect(d.reasons.join('\n')).toContain('FATAL');
    expect(d.reasons.join('\n')).toContain('B @ wide/high');
    expect(d.summary.fatalFailures).toHaveLength(1);
    expect(d.summary.fatalFailures[0]).toContain('present');
  });
});

// ── demoting steps ──────────────────────────────────────────────────────────────────────

describe('demoting steps', () => {
  for (const step of DEMOTING_STEPS) {
    it(`a failed '${step}' demotes to managed-partial rather than failing`, () => {
      const r = report([caseWithStep(step, 'fail')]);
      expect(r.classification).toBe('managed-partial');
      expect(mayPublishAsModern(r)).toBe(false);
    });
  }

  it('a demotion in ONE case demotes the whole package', () => {
    const r = report([okCase({ variantKey: 'A' }), caseWithStep('suspend-resume', 'fail', { variantKey: 'B' })]);
    expect(r.classification).toBe('managed-partial');
    expect(summarizeCanary(r).demotingFailures[0]).toContain('B @ wide/high');
  });

  it('a step that is neither fatal nor demoting still blocks publication', () => {
    // 'ab-cycles' is in neither set: it cannot make the package unshowable, but a package that
    // could not prove A → B → A has not proven the reveal invariant either.
    expect(FATAL_STEPS.has('ab-cycles')).toBe(false);
    expect(DEMOTING_STEPS.has('ab-cycles')).toBe(false);
    const r = report([caseWithStep('ab-cycles', 'fail')]);
    expect(r.classification).toBe('managed-partial');
    expect(mayPublishAsModern(r)).toBe(false);
    expect(summarizeCanary(r).otherFailures).toHaveLength(1);
  });

  it("'not-applicable' is a decision, not a failure", () => {
    const r = report([caseWithStep('context-loss', 'not-applicable')]);
    expect(r.classification).toBe('managed-presentable');
    expect(mayPublishAsModern(r)).toBe(true);
    expect(summarizeCanary(r).notApplicable).toBe(1);
  });
});

// ── leaks ───────────────────────────────────────────────────────────────────────────────

describe('leaks', () => {
  it('a non-empty leak list demotes even when every step passed', () => {
    const r = report([okCase({ leaked: ['rafCallbacks=2'] })]);
    expect(r.classification).toBe('managed-partial');
    expect(mayPublishAsModern(r)).toBe(false);
  });

  it('the leak is named in the explanation and the summary', () => {
    const d = judgeCanaryReport(report([okCase({ leaked: ['glTextures=7', 'listeners=3'] })]));
    expect(d.reasons.join('\n')).toContain('glTextures=7');
    expect(d.summary.leakedCases[0]).toContain('listeners=3');
  });
});

// ── handshake / legacy classes ──────────────────────────────────────────────────────────

describe('legacy classification', () => {
  it('no handshake but applied + presented is legacy-cooperative', () => {
    const r = report([okCase({ capabilities: null })]);
    expect(r.classification).toBe('legacy-cooperative');
    expect(mayPublishAsModern(r)).toBe(false);
  });

  it('a capability report that is not activation-scoped is legacy, not managed', () => {
    const caps: SimRuntimeCapabilities = { ...FULL_CAPS, activationScoped: false };
    expect(report([okCase({ capabilities: caps })]).classification).toBe('legacy-cooperative');
  });

  it('no handshake and no presentation is legacy-opaque', () => {
    const r = report([caseWithStep('section-presented', 'fail', { capabilities: null })]);
    expect(r.classification).toBe('legacy-opaque');
    expect(mayPublishAsModern(r)).toBe(false);
  });

  it('no handshake and a failed apply is legacy-opaque only when nothing fatal failed', () => {
    // 'section-applied' IS fatal, so a package that could not apply is `failed`, never a legacy
    // class — being unable to install a section is not a compatibility level, it is broken.
    const r = report([caseWithStep('section-applied', 'fail', { capabilities: null })]);
    expect(r.classification).toBe('failed');
  });

  it('a MIXED run where only one case handshook is judged legacy for the whole package', () => {
    const r = report([okCase({ variantKey: 'A' }), okCase({ variantKey: 'B', capabilities: null })]);
    expect(r.classification).toBe('legacy-cooperative');
  });

  it('summarizes how many cases handshook', () => {
    const s = summarizeCanary(report([okCase({ variantKey: 'A' }), okCase({ variantKey: 'B', capabilities: null })]));
    expect(s.handshookCases).toBe(1);
    expect(s.cases).toBe(2);
  });
});

// ── capabilities ────────────────────────────────────────────────────────────────────────

describe('capability completeness', () => {
  const flags: (keyof SimRuntimeCapabilities)[] = [
    'managedLifecycle', 'onDemandRender', 'contextEvents', 'suspendable', 'audioControl', 'qualityControl',
  ];
  for (const flag of flags) {
    it(`missing '${flag}' demotes to managed-partial`, () => {
      const r = report([okCase({ capabilities: { ...FULL_CAPS, [flag]: false } })]);
      expect(r.classification).toBe('managed-partial');
      expect(mayPublishAsModern(r)).toBe(false);
    });
  }
});

// ── errors ──────────────────────────────────────────────────────────────────────────────

describe('significant vs ignorable errors', () => {
  it('a favicon 404 is noise and does not change the verdict', () => {
    const errors: CanaryError[] = [
      { source: 'network', message: 'Failed to load resource: the server responded with 404 (/favicon.ico)', url: '/favicon.ico' },
    ];
    const r = report([okCase({ errors })]);
    expect(r.classification).toBe('managed-presentable');
    expect(mayPublishAsModern(r)).toBe(true);
    expect(summarizeCanary(r).ignoredErrors).toBe(1);
    expect(summarizeCanary(r).significantErrors).toBe(0);
  });

  it('a ResizeObserver loop warning is noise', () => {
    const r = report([okCase({ errors: [{ source: 'console', message: 'ResizeObserver loop completed with undelivered notifications' }] })]);
    expect(r.classification).toBe('managed-presentable');
  });

  it('a real page error fails the package outright', () => {
    const r = report([okCase({ errors: [{ source: 'pageerror', message: 'TypeError: scene.render is not a function' }] })]);
    expect(r.classification).toBe('failed');
    expect(mayPublishAsModern(r)).toBe(false);
    expect(summarizeCanary(r).significantErrors).toBe(1);
  });

  it('a protocol rejection is a significant error', () => {
    const r = report([okCase({ errors: [{ source: 'protocol', message: 'out-of-order-seq: 3' }] })]);
    expect(r.classification).toBe('failed');
    expect(judgeCanaryReport(r).reasons.join('\n')).toContain('out-of-order-seq');
  });

  it('mixes: the ignorable ones never mask the significant one', () => {
    const errors: CanaryError[] = [
      { source: 'network', message: 'favicon.ico 404' },
      { source: 'pageerror', message: 'ReferenceError: THREE is not defined' },
    ];
    const s = summarizeCanary(report([okCase({ errors })]));
    expect(s.ignoredErrors).toBe(1);
    expect(s.significantErrors).toBe(1);
    expect(report([okCase({ errors })]).classification).toBe('failed');
  });
});

// ── assets ──────────────────────────────────────────────────────────────────────────────

describe('manifest assets', () => {
  it('one asset that did not serve fails the package', () => {
    const assets: CanaryAssetResult[] = [
      ...OK_ASSETS,
      { path: '/sim-public/x/textures/noise.png', ok: false, status: 404, contentType: null },
    ];
    const r = report([okCase()], assets);
    expect(r.classification).toBe('failed');
    expect(summarizeCanary(r).badAssets[0]).toContain('404');
  });

  it('the bad asset is named in the explanation', () => {
    const assets: CanaryAssetResult[] = [
      { path: '/sim-public/x/index.html', ok: false, status: 200, contentType: 'text/plain' },
    ];
    expect(judgeCanaryReport(report([okCase()], assets)).reasons.join('\n')).toContain('text/plain');
  });
});

// ── completeness + honesty guards ───────────────────────────────────────────────────────

describe('the publication guard', () => {
  it('refuses a report that reported no steps at all, even though it classifies presentable', () => {
    const empty = okCase({ steps: [] });
    const r = report([empty]);
    // The contract's rule has nothing failing to find, so it says presentable...
    expect(r.classification).toBe('managed-presentable');
    // ...and publication still refuses, because nothing was demonstrated.
    expect(isCanaryReportComplete(r)).toBe(false);
    expect(mayPublishAsModern(r)).toBe(false);
    expect(missingStepsOf(empty)).toEqual([...CANARY_STEPS]);
  });

  it('treats a skipped step as undecided', () => {
    const c = caseWithStep('dispose-counters', 'skipped');
    const r = report([c]);
    expect(missingStepsOf(c)).toEqual(['dispose-counters']);
    expect(isCanaryReportComplete(r)).toBe(false);
    expect(mayPublishAsModern(r)).toBe(false);
    expect(summarizeCanary(r).missing).toEqual(['A @ wide/high [full-ui]: dispose-counters']);
  });

  it('refuses a report whose stamp claims more than its evidence supports', () => {
    const honest = report([okCase({ leaked: ['ports=1'] })]);
    expect(honest.classification).toBe('managed-partial');
    const forged: CanaryReport = { ...honest, classification: 'managed-presentable' };
    expect(recomputeClassification(forged)).toBe('managed-partial');
    expect(classificationIsHonest(forged)).toBe(false);
    expect(mayPublishAsModern(forged)).toBe(false);
    expect(judgeCanaryReport(forged).reasons[0]).toContain('Refusing to publish on a stamp');
  });

  it('refuses a report whose stamp claims LESS than its evidence supports, rather than upgrading it', () => {
    const clean = report([okCase()]);
    const understated: CanaryReport = { ...clean, classification: 'managed-partial' };
    expect(mayPublishAsModern(understated)).toBe(false);
    const d = judgeCanaryReport(understated);
    expect(d.classification).toBe('managed-presentable');
    expect(d.honest).toBe(false);
  });

  it('reports the incompleteness in the decision text', () => {
    const d = judgeCanaryReport(report([caseWithStep('poster-captured', 'skipped')]));
    expect(d.complete).toBe(false);
    expect(d.reasons.join('\n')).toContain('Run is incomplete');
    expect(d.reasons.join('\n')).toContain('poster-captured');
  });
});

// ── inspection helpers ──────────────────────────────────────────────────────────────────

describe('inspection helpers', () => {
  it('caseLabel distinguishes two configurations of one variant', () => {
    expect(caseLabel(makeCase('A', false))).toBe('A @ wide/high [full-ui]');
    expect(caseLabel(makeCase('A', true))).toBe('A @ wide/high [minimal-ui]');
  });

  it('failedStepsOf lists exactly the failures', () => {
    const c = caseWithStep('audio-state', 'fail');
    expect(failedStepsOf(c)).toEqual(['audio-state']);
    expect(failedStepsOf(okCase())).toEqual([]);
  });

  it('summarizeCanary counts every recorded decision', () => {
    const s = summarizeCanary(report([okCase(), caseWithStep('context-loss', 'not-applicable')]));
    expect(s.stepsRecorded).toBe(CANARY_STEPS.length * 2);
    expect(s.passed).toBe(CANARY_STEPS.length * 2 - 1);
    expect(s.notApplicable).toBe(1);
    expect(s.failed).toBe(0);
  });

  it('describeCanaryDecision renders the headline, the reasons and the counts', () => {
    const text = describeCanaryDecision(judgeCanaryReport(report([caseWithStep('suspend-resume', 'fail')])));
    expect(text).toContain('managed-partial');
    expect(text).toContain('suspend-resume');
    expect(text).toContain('summary:');
    expect(text.split('\n').length).toBeGreaterThan(2);
  });

  it('the clean headline states the case count and the absence of leaks', () => {
    const d = judgeCanaryReport(report([okCase({ variantKey: 'A' }), okCase({ variantKey: 'B' })]));
    expect(d.headline).toContain('managed-presentable');
    expect(d.headline).toContain('2 case(s)');
    expect(d.headline).toContain('no leaks');
  });
});

// ── merging ─────────────────────────────────────────────────────────────────────────────

describe('mergeCanaryReports', () => {
  const chromium = assembleCanaryReport({ ...META, engine: 'chromium/1' }, [okCase({ variantKey: 'A' })], OK_ASSETS);
  const webkit = assembleCanaryReport({ ...META, engine: 'webkit/2' }, [okCase({ variantKey: 'A' })], OK_ASSETS);

  it('two clean runs merge to one publishable verdict across both engines', () => {
    const m = mergeCanaryReports([chromium, webkit]);
    expect(m.classification).toBe('managed-presentable');
    expect(mayPublishAsModern(m)).toBe(true);
    expect(m.engine).toBe('chromium/1+webkit/2');
    expect(m.cases).toHaveLength(2);
  });

  it('a guarantee that holds in one engine and not another is not a guarantee', () => {
    const broken = assembleCanaryReport(
      { ...META, engine: 'webkit/2' },
      [caseWithStep('suspend-resume', 'fail', { variantKey: 'A' })],
      OK_ASSETS,
    );
    const m = mergeCanaryReports([chromium, broken]);
    expect(m.classification).toBe('managed-partial');
    expect(mayPublishAsModern(m)).toBe(false);
  });

  it('one aborted run aborts the merge', () => {
    const dead = assembleCanaryReport({ ...META, engine: 'firefox/3' }, [], OK_ASSETS, { reason: 'timeout' });
    const m = mergeCanaryReports([chromium, dead]);
    expect(m.aborted?.reason).toBe('timeout');
    expect(m.classification).toBe('failed');
  });

  it('an asset that failed in ANY engine is a failed asset', () => {
    const bad = assembleCanaryReport({ ...META, engine: 'firefox/3' }, [okCase()], [
      OK_ASSETS[0],
      { path: '/sim-public/x/bridge.js', ok: false, status: 404, contentType: null },
    ]);
    const m = mergeCanaryReports([chromium, bad]);
    expect(m.assets.find((a) => a.path.endsWith('bridge.js'))?.ok).toBe(false);
    expect(m.classification).toBe('failed');
  });

  it('reports describing different revisions produce a verdict about neither', () => {
    const other = assembleCanaryReport({ ...META, packageRevision: 'rev0002' }, [okCase()], OK_ASSETS);
    const m = mergeCanaryReports([chromium, other]);
    expect(m.classification).toBe('failed');
    expect(m.aborted?.reason).toContain('different package revisions');
    expect(mayPublishAsModern(m)).toBe(false);
  });

  it('reports describing different simulations produce a verdict about neither', () => {
    const other = assembleCanaryReport({ ...META, simulationId: 'sim-2' }, [okCase()], OK_ASSETS);
    const m = mergeCanaryReports([chromium, other]);
    expect(m.classification).toBe('failed');
    expect(m.aborted?.reason).toContain('different simulations');
  });

  it('spans the widest time window of the merged runs', () => {
    const late = assembleCanaryReport(
      { ...META, engine: 'firefox/3', startedAt: '2026-08-03T11:00:00.000Z', finishedAt: '2026-08-03T11:05:00.000Z' },
      [okCase()], OK_ASSETS,
    );
    const m = mergeCanaryReports([late, chromium]);
    expect(m.startedAt).toBe('2026-08-03T10:00:00.000Z');
    expect(m.finishedAt).toBe('2026-08-03T11:05:00.000Z');
  });

  it('merging nothing throws rather than inventing a verdict', () => {
    expect(() => mergeCanaryReports([])).toThrow(/not a verdict/);
  });

  it('a single report merges to an equivalent verdict', () => {
    const m = mergeCanaryReports([chromium]);
    expect(m.classification).toBe(chromium.classification);
    expect(m.cases).toHaveLength(1);
    expect(m.storagePrefix).toBe(META.storagePrefix);
  });
});
