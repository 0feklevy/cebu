/**
 * Failure policy and package classification — shared-side.
 *
 * RELATIONSHIP TO client-web/__tests__/simFailurePolicy.test.ts
 * That file spot-checks `classifyFromCapabilities` (all-true, one-missing, no-handshake) and asserts
 * properties of `recoveryActionsFor` (never empty, poster first, retry before skip). Both functions
 * have small enough input spaces to be tested EXHAUSTIVELY, so that is what happens here: all 128
 * capability reports and all 16 failure contexts, each against a written-out expectation. A property
 * assertion can hold for every input while the function is still wrong about a specific one; an
 * exhaustive table cannot.
 */
import { describe, it, expect } from 'vitest';
import {
  PACKAGE_CLASS_ORDER,
  SIM_BREAKER_THRESHOLD,
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
} from '../simFailurePolicy.js';
import { NO_CAPABILITIES, type SimRuntimeCapabilities } from '../runtimeProtocol.js';

/** Every capability, as a list, so the 2^7 enumeration below cannot silently miss one. */
const CAPABILITY_KEYS = Object.keys({
  activationScoped: 1, managedLifecycle: 1, onDemandRender: 1, contextEvents: 1,
  suspendable: 1, audioControl: 1, qualityControl: 1,
} satisfies Record<keyof SimRuntimeCapabilities, 1>) as (keyof SimRuntimeCapabilities)[];

describe('classifyFromCapabilities — all 128 capability reports', () => {
  it('has exactly seven capabilities to enumerate', () => {
    expect(CAPABILITY_KEYS).toHaveLength(7);
    expect(Object.keys(NO_CAPABILITIES).sort()).toEqual([...CAPABILITY_KEYS].sort());
  });

  it('classifies every one of the 128 combinations the way the rule says', () => {
    /**
     * The rule, restated: no report at all, or a report without `activationScoped`, is legacy-opaque
     * — it has not spoken v3, so nothing about it is a promise. With `activationScoped` and every
     * other capability, it is managed-presentable. With `activationScoped` and anything missing, it
     * is managed-partial: "presentable" is a promise about the reveal path, and a package that
     * cannot render on demand is not able to make it.
     */
    const wrong: string[] = [];
    for (let bits = 0; bits < 128; bits++) {
      const caps = {} as SimRuntimeCapabilities;
      CAPABILITY_KEYS.forEach((key, i) => { caps[key] = (bits & (1 << i)) !== 0; });

      const expected: SimPackageClass = !caps.activationScoped
        ? 'legacy-opaque'
        : CAPABILITY_KEYS.every((k) => caps[k])
          ? 'managed-presentable'
          : 'managed-partial';

      const actual = classifyFromCapabilities(caps);
      if (actual !== expected) wrong.push(`${bits.toString(2).padStart(7, '0')}: ${actual} != ${expected}`);
    }
    expect(wrong).toEqual([]);
  });

  it('classifies a document that never handshook as legacy-opaque, not as a partial promise', () => {
    // The difference matters downstream: `managed-partial` says "it spoke v3 and fell short",
    // `legacy-opaque` says "it never spoke". Only the first is a contradiction worth reporting when
    // the canary said otherwise.
    expect(classifyFromCapabilities(null)).toBe('legacy-opaque');
    expect(classifyFromCapabilities(NO_CAPABILITIES)).toBe('legacy-opaque');
  });

  it('reaches exactly three of the five classes — the other two come from elsewhere', () => {
    const reached = new Set<SimPackageClass>();
    for (let bits = 0; bits < 128; bits++) {
      const caps = {} as SimRuntimeCapabilities;
      CAPABILITY_KEYS.forEach((key, i) => { caps[key] = (bits & (1 << i)) !== 0; });
      reached.add(classifyFromCapabilities(caps));
    }
    // `legacy-cooperative` is learned from observed v2 behaviour, `failed` only from a canary run.
    // A capability report can never produce either, and must never be able to.
    expect([...reached].sort()).toEqual(['legacy-opaque', 'managed-partial', 'managed-presentable']);
  });
});

describe('classifyLegacy — all four observations', () => {
  const TABLE: [boolean, boolean, SimPackageClass][] = [
    [false, false, 'legacy-opaque'],
    [false, true, 'legacy-opaque'],
    [true, false, 'legacy-opaque'],
    [true, true, 'legacy-cooperative'],
  ];

  for (const [ackCapable, canEmitPaint, expected] of TABLE) {
    it(`ackCapable=${ackCapable}, canEmitPaint=${canEmitPaint} -> ${expected}`, () => {
      expect(classifyLegacy({ ackCapable, canEmitPaint })).toBe(expected);
    });
  }

  it('requires BOTH — an acknowledgement without a paint is not cooperation the player can use', () => {
    expect(classifyLegacy({ ackCapable: true, canEmitPaint: false })).toBe('legacy-opaque');
  });
});

describe('what each class is allowed to do', () => {
  it('grants the aggressive path to managed-presentable and nothing else', () => {
    const granted = PACKAGE_CLASS_ORDER.filter(allowsAggressivePreparation);
    expect(granted).toEqual(['managed-presentable']);
  });

  it('presents everything except a proven-broken package', () => {
    const presentable = PACKAGE_CLASS_ORDER.filter(isPresentable);
    expect(presentable).toEqual(['managed-presentable', 'managed-partial', 'legacy-cooperative', 'legacy-opaque']);
  });

  it('orders the five classes from most to least trusted, with no gaps or repeats', () => {
    expect(PACKAGE_CLASS_ORDER).toHaveLength(5);
    expect(new Set(PACKAGE_CLASS_ORDER).size).toBe(5);
    // Aggressive preparation implies presentable, never the reverse — the order is a real ranking.
    const aggressiveIndex = PACKAGE_CLASS_ORDER.findIndex(allowsAggressivePreparation);
    const failedIndex = PACKAGE_CLASS_ORDER.indexOf('failed');
    expect(aggressiveIndex).toBe(0);
    expect(failedIndex).toBe(PACKAGE_CLASS_ORDER.length - 1);
  });
});

describe('recoveryActionsFor — all 16 contexts, written out', () => {
  /**
   * Ordered by what best serves the user, not by severity: `poster-only` first whenever a poster
   * exists, because it is the only option that shows the RIGHT picture immediately and costs
   * nothing; `retry` next, because it is the only one that can still deliver the interactive
   * section. Every row is an explicit expectation rather than a restated algorithm — a restatement
   * can share the implementation's bug.
   */
  const TABLE: [FailureContext, boolean, SimRecoveryAction[]][] = [
    [{ hasPoster: false, hasVideo: false, canSkip: false }, false, ['retry']],
    // No poster, no video, cannot skip, breaker open: nothing applies, so `skip` is offered anyway
    // rather than leaving the user on a dead end they cannot leave.
    [{ hasPoster: false, hasVideo: false, canSkip: false }, true, ['skip']],
    [{ hasPoster: false, hasVideo: false, canSkip: true }, false, ['retry', 'skip']],
    [{ hasPoster: false, hasVideo: false, canSkip: true }, true, ['skip']],
    [{ hasPoster: false, hasVideo: true, canSkip: false }, false, ['retry', 'back-to-video']],
    [{ hasPoster: false, hasVideo: true, canSkip: false }, true, ['back-to-video']],
    [{ hasPoster: false, hasVideo: true, canSkip: true }, false, ['retry', 'skip', 'back-to-video']],
    [{ hasPoster: false, hasVideo: true, canSkip: true }, true, ['skip', 'back-to-video']],
    [{ hasPoster: true, hasVideo: false, canSkip: false }, false, ['poster-only', 'retry']],
    [{ hasPoster: true, hasVideo: false, canSkip: false }, true, ['poster-only']],
    [{ hasPoster: true, hasVideo: false, canSkip: true }, false, ['poster-only', 'retry', 'skip']],
    [{ hasPoster: true, hasVideo: false, canSkip: true }, true, ['poster-only', 'skip']],
    [{ hasPoster: true, hasVideo: true, canSkip: false }, false, ['poster-only', 'retry', 'back-to-video']],
    [{ hasPoster: true, hasVideo: true, canSkip: false }, true, ['poster-only', 'back-to-video']],
    [{ hasPoster: true, hasVideo: true, canSkip: true }, false, ['poster-only', 'retry', 'skip', 'back-to-video']],
    [{ hasPoster: true, hasVideo: true, canSkip: true }, true, ['poster-only', 'skip', 'back-to-video']],
  ];

  it('covers all 16 combinations exactly once', () => {
    const seen = new Set(TABLE.map(([ctx, open]) => `${ctx.hasPoster}${ctx.hasVideo}${ctx.canSkip}${open}`));
    expect(seen.size).toBe(16);
  });

  for (const [ctx, breakerOpen, expected] of TABLE) {
    const label = `poster=${ctx.hasPoster} video=${ctx.hasVideo} skip=${ctx.canSkip} breaker=${breakerOpen ? 'open' : 'closed'}`;
    it(`${label} -> [${expected.join(', ')}]`, () => {
      expect(recoveryActionsFor(ctx, breakerOpen)).toEqual(expected);
    });
  }

  it('never offers an action that would show an unverified frame', () => {
    // There is deliberately no `force-reveal` and no `show-anyway`. A modern package promised to
    // send SECTION_PRESENTED; when it does not, the honest response is a visible failure.
    const offered = new Set(TABLE.flatMap(([, , expected]) => expected));
    expect([...offered].sort()).toEqual(['back-to-video', 'poster-only', 'retry', 'skip']);
  });

  it('withdraws retry exactly when the breaker is open, in every context', () => {
    for (const [ctx, breakerOpen, expected] of TABLE) {
      expect(expected.includes('retry')).toBe(!breakerOpen);
      expect(recoveryActionsFor(ctx, breakerOpen).includes('retry')).toBe(!breakerOpen);
    }
  });
});

describe('circuit breaker', () => {
  it('starts closed with no history', () => {
    expect(initialBreaker()).toEqual({ failures: 0, open: false, reasons: [] });
  });

  it('opens at exactly the threshold, never before', () => {
    let b = initialBreaker();
    for (let i = 1; i < SIM_BREAKER_THRESHOLD; i++) {
      b = recordFailure(b, 'present-timeout');
      expect(b.failures).toBe(i);
      expect(b.open).toBe(false);
    }
    b = recordFailure(b, 'present-timeout');
    expect(b.failures).toBe(SIM_BREAKER_THRESHOLD);
    expect(b.open).toBe(true);
  });

  it('stays open, and keeps counting, on further failures', () => {
    let b = initialBreaker();
    for (let i = 0; i < SIM_BREAKER_THRESHOLD + 5; i++) b = recordFailure(b, 'section-error');
    expect(b.open).toBe(true);
    expect(b.failures).toBe(SIM_BREAKER_THRESHOLD + 5);
  });

  it('bounds the recorded reasons while keeping the most recent ones', () => {
    let b = initialBreaker();
    const kinds: SimFailureKind[] = ['prepare-timeout', 'present-timeout', 'section-error', 'document-error'];
    for (let i = 0; i < 20; i++) b = recordFailure(b, kinds[i % kinds.length]);
    expect(b.reasons).toHaveLength(SIM_BREAKER_THRESHOLD * 2);
    expect(b.reasons[b.reasons.length - 1]).toBe(kinds[19 % kinds.length]);
  });

  it('resets completely on a success — no half-open state, no decay window', () => {
    // Half-open states and decay windows make the breaker's behaviour depend on wall-clock timing,
    // which is exactly what made the previous generation of reveal bugs irreproducible.
    let b = initialBreaker();
    for (let i = 0; i < SIM_BREAKER_THRESHOLD + 2; i++) b = recordFailure(b, 'handshake-failed');
    expect(recordSuccess(b)).toEqual(initialBreaker());
  });

  it('is pure — recording a failure does not mutate the previous state', () => {
    const before = initialBreaker();
    const snapshot = JSON.stringify(before);
    recordFailure(before, 'transport-closed');
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('makeFailure', () => {
  const ctx: FailureContext = { hasPoster: true, hasVideo: true, canSkip: true };

  /** Total over the union: a new failure kind without a case here is a COMPILE error. */
  const ALL_KINDS = Object.keys({
    'prepare-timeout': 1, 'present-timeout': 1, 'section-error': 1, 'document-error': 1,
    'context-lost-unrecovered': 1, 'transport-closed': 1, 'handshake-failed': 1,
  } satisfies Record<SimFailureKind, 1>) as SimFailureKind[];

  it('resolves every failure kind to a bounded, non-empty action set — never a permanent spinner', () => {
    for (const kind of ALL_KINDS) {
      const failure = makeFailure(kind, 'x', 1, ctx, initialBreaker());
      expect(failure.kind).toBe(kind);
      expect(failure.actions.length).toBeGreaterThan(0);
    }
    expect(ALL_KINDS).toHaveLength(7);
  });

  it('reflects an open breaker in BOTH the flag and the actions', () => {
    // Two representations of one fact; a UI reading only one of them must not be able to disagree
    // with a UI reading the other.
    let breaker = initialBreaker();
    for (let i = 0; i < SIM_BREAKER_THRESHOLD; i++) breaker = recordFailure(breaker, 'present-timeout');
    const failure = makeFailure('present-timeout', 'timed out', 3, ctx, breaker);
    expect(failure.breakerOpen).toBe(true);
    expect(failure.actions).not.toContain('retry');
    expect(failure.attempt).toBe(3);
  });

  it('offers retry while the breaker is closed', () => {
    const failure = makeFailure('present-timeout', 'timed out', 1, ctx, initialBreaker());
    expect(failure.breakerOpen).toBe(false);
    expect(failure.actions).toContain('retry');
  });
});

// ── prepareTimeoutMsFor — the per-package prepare bound (sim-review 2026-09-04, P1) ───────────

import { prepareTimeoutMsFor, SIM_PREPARE_TIMEOUT_MS as PREP_FLOOR, SIM_PREPARE_TIMEOUT_MAX_MS } from '../simFailurePolicy.js';

describe('prepareTimeoutMsFor', () => {
  it('an unmeasured package keeps the historical 5s bound exactly', () => {
    expect(prepareTimeoutMsFor()).toBe(PREP_FLOOR);
    expect(prepareTimeoutMsFor({})).toBe(PREP_FLOOR);
    expect(prepareTimeoutMsFor({ prepareBudgetMs: null, weightTotalBytes: null })).toBe(PREP_FLOOR);
  });

  it('a measured budget above the floor extends the bound with headroom', () => {
    // The regression this exists for: a 30MB GLB package measures ~6s prepare on a cold miss at
    // 40Mbps — the flat 5s bound failed it deterministically and the breaker then killed
    // auto-preparation for the whole session on a healthy connection.
    expect(prepareTimeoutMsFor({ prepareBudgetMs: 6_000 })).toBe(9_000);
    expect(prepareTimeoutMsFor({ prepareBudgetMs: 1_000 })).toBe(PREP_FLOOR); // light stays at the floor
  });

  it('package weight extends the bound ~1s per 2MB beyond the first 5MB', () => {
    expect(prepareTimeoutMsFor({ weightTotalBytes: 4_000_000 })).toBe(PREP_FLOOR);
    expect(prepareTimeoutMsFor({ weightTotalBytes: 35_000_000 })).toBe(PREP_FLOOR + 15_000 > SIM_PREPARE_TIMEOUT_MAX_MS ? SIM_PREPARE_TIMEOUT_MAX_MS : PREP_FLOOR + 15_000);
  });

  it('the ceiling holds against absurd or hostile published numbers', () => {
    expect(prepareTimeoutMsFor({ prepareBudgetMs: 10 * 60_000 })).toBe(SIM_PREPARE_TIMEOUT_MAX_MS);
    expect(prepareTimeoutMsFor({ weightTotalBytes: Number.MAX_SAFE_INTEGER })).toBe(SIM_PREPARE_TIMEOUT_MAX_MS);
    expect(prepareTimeoutMsFor({ prepareBudgetMs: NaN, weightTotalBytes: -5 })).toBe(PREP_FLOOR);
  });
});
