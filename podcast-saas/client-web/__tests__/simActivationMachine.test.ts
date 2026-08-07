/**
 * The SECTION ACTIVATION lifecycle reducer.
 *
 * The structural claims this file exists to pin are negative ones: there is NO edge into PRESENTED
 * except a real acknowledgement, NO edge into VISIBLE except from PRESENTED (or back from COVERED),
 * and no timeout, paint heuristic or document event can reach either. Each of those was, at some
 * point in this codebase, the thing that authorised a reveal — and each in turn was shown to
 * authorise a wrong one. They are asserted here by scanning the whole (state × event) space rather
 * than by checking the handful of pairs someone thought of.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_REJECTED_RECORDED,
  SIM_MIN_LIVE_DWELL_MS,
  activationReducer,
  initialActivationState,
  shouldRevealLive,
  toPresentationIdentity,
  type ActivationEvent,
  type ActivationEventType,
  type ActivationMachineState,
  type ActivationState,
} from 'shared/src/sim/activationMachine';
import type { PresentationIdentity } from 'shared/src/sim/simIdentity';

// ── enumerations, kept exhaustive by the type system ──────────────────────────────────────────

const ALL_STATES = Object.keys({
  IDLE: 1, PREPARING: 1, APPLIED: 1, RENDERING: 1, PRESENTED: 1,
  VISIBLE: 1, COVERED: 1, RELEASED: 1, FAILED: 1,
} satisfies Record<ActivationState, 1>) as ActivationState[];

const ALL_EVENTS = Object.keys({
  PREPARE: 1, APPLIED: 1, PRESENT: 1, PRESENTED: 1, ACTIVATE: 1,
  COVER: 1, UNCOVER: 1, CONTEXT_LOST: 1, RELEASE: 1, FAIL: 1,
} satisfies Record<ActivationEventType, 1>) as ActivationEventType[];

/** The specification, restated independently of the production table. FAIL is asserted separately. */
const EXPECTED: Record<ActivationState, Partial<Record<ActivationEventType, ActivationState>>> = {
  IDLE: { PREPARE: 'PREPARING', RELEASE: 'RELEASED' },
  PREPARING: { APPLIED: 'APPLIED', RELEASE: 'RELEASED' },
  APPLIED: { PRESENT: 'RENDERING', RELEASE: 'RELEASED' },
  RENDERING: { PRESENTED: 'PRESENTED', RELEASE: 'RELEASED' },
  PRESENTED: { ACTIVATE: 'VISIBLE', COVER: 'COVERED', RELEASE: 'RELEASED', CONTEXT_LOST: 'RENDERING' },
  VISIBLE: { COVER: 'COVERED', RELEASE: 'RELEASED', CONTEXT_LOST: 'RENDERING' },
  COVERED: { UNCOVER: 'VISIBLE', RELEASE: 'RELEASED', CONTEXT_LOST: 'RENDERING' },
  RELEASED: {},
  FAILED: { RELEASE: 'RELEASED' },
};

const FAILABLE: ReadonlySet<ActivationState> = new Set<ActivationState>([
  'IDLE', 'PREPARING', 'APPLIED', 'RENDERING', 'PRESENTED', 'VISIBLE', 'COVERED',
]);

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────

const IDENTITY: PresentationIdentity = {
  packageRevision: 'rev_boids_v1',
  documentId: 'doc_epoch_1',
  activationId: 'act_1',
  variantKey: 'section-a',
  configHash: 'cfg_aaaa',
};

const run = (s: ActivationMachineState, ...events: ActivationEvent[]): ActivationMachineState =>
  events.reduce(activationReducer, s);

function reach(target: ActivationState, identity: PresentationIdentity = IDENTITY): ActivationMachineState {
  const start = initialActivationState(identity);
  switch (target) {
    case 'IDLE': return start;
    case 'PREPARING': return run(start, { type: 'PREPARE' });
    case 'APPLIED': return run(start, { type: 'PREPARE' }, { type: 'APPLIED' });
    case 'RENDERING': return run(reach('APPLIED', identity), { type: 'PRESENT' });
    case 'PRESENTED': return run(reach('RENDERING', identity), { type: 'PRESENTED', ackIdentity: identity });
    case 'VISIBLE': return run(reach('PRESENTED', identity), { type: 'ACTIVATE' });
    case 'COVERED': return run(reach('PRESENTED', identity), { type: 'COVER' });
    case 'RELEASED': return run(reach('PRESENTED', identity), { type: 'RELEASE' });
    case 'FAILED': return run(reach('RENDERING', identity), { type: 'FAIL', reason: 'boom' });
  }
}

function frozen(s: ActivationMachineState): ActivationMachineState {
  Object.freeze(s.rejected);
  Object.freeze(s.identity);
  return Object.freeze(s);
}

// ── first activation ──────────────────────────────────────────────────────────────────────────

describe('first activation', () => {
  it('walks IDLE → PREPARING → APPLIED → RENDERING → PRESENTED → VISIBLE', () => {
    let s = initialActivationState(IDENTITY);
    expect(s.state).toBe('IDLE');
    expect(s.presentedBy).toBeNull();

    s = activationReducer(s, { type: 'PREPARE' });
    expect(s.state).toBe('PREPARING');

    s = activationReducer(s, { type: 'APPLIED' });
    expect(s.state).toBe('APPLIED');
    // APPLIED means the section was INSTALLED, not that anything was drawn. Nothing may be shown.
    expect(s.presentedBy).toBeNull();

    s = activationReducer(s, { type: 'PRESENT' });
    expect(s.state).toBe('RENDERING');
    expect(s.presentedBy).toBeNull();

    s = activationReducer(s, { type: 'PRESENTED', ackIdentity: s.identity });
    expect(s.state).toBe('PRESENTED');
    expect(s.presentedBy).toEqual(IDENTITY);

    s = activationReducer(s, { type: 'ACTIVATE' });
    expect(s.state).toBe('VISIBLE');
    expect(s.presentedBy).toEqual(IDENTITY);
  });

  it('records the acknowledging identity, not a boolean', () => {
    // `mayReveal` re-verifies against this rather than trusting that the transport checked. A flag
    // would make that impossible: it can say "something was acknowledged", never "what".
    const presented = reach('PRESENTED');
    expect(presented.presentedBy).toEqual(IDENTITY);
    expect(presented.presentedBy).not.toBe(null);
  });

  it('never rewrites the activation identity it was created with', () => {
    for (const state of ALL_STATES) {
      expect(reach(state).identity, `identity in ${state}`).toEqual(IDENTITY);
    }
  });

  it('clears any prior error when a presentation lands', () => {
    const s = run(reach('RENDERING'), { type: 'PRESENTED', ackIdentity: IDENTITY });
    expect(s.error).toBeNull();
  });
});

// ── the exhaustive walk ───────────────────────────────────────────────────────────────────────

describe('activationReducer — every (state, event) pair', () => {
  it('either takes the specified edge or refuses and records it — never a third outcome', () => {
    const problems: string[] = [];
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        if (event === 'FAIL') continue;
        const before = frozen(reach(state));
        // PRESENTED carries the acknowledgement's identity. A bare PRESENTED is REFUSED by design —
        // recording the machine's own identity instead was the defect that made the reveal
        // invariant compare an object with itself — so the walk must supply one to exercise the
        // legal edge. Every other event is identity-free.
        const after = activationReducer(
          before,
          event === 'PRESENTED' ? { type: event, ackIdentity: before.identity } : { type: event },
        );
        const expected = EXPECTED[state][event];
        if (expected) {
          if (after.state !== expected) problems.push(`${state} + ${event} → ${after.state}, expected ${expected}`);
        } else {
          if (after.state !== state) problems.push(`${state} + ${event} → ${after.state}, expected refusal`);
          if (after.rejected.length !== before.rejected.length + 1) {
            problems.push(`${state} + ${event} was refused without being recorded`);
          }
          const last = after.rejected[after.rejected.length - 1];
          if (!last || last.from !== state || last.event !== event) {
            problems.push(`${state} + ${event} recorded the wrong rejection`);
          }
        }
        if (!ALL_STATES.includes(after.state)) problems.push(`${state} + ${event} → non-state ${after.state}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('REFUSES a PRESENTED that carries no acknowledgement identity, from every state', () => {
    // Defaulting to the machine's own identity here is exactly what made `mayReveal` a tautology at
    // its only production call site. Refusing is what forces a caller to say what the ack claimed.
    for (const state of ALL_STATES) {
      const before = reach(state);
      const after = activationReducer(before, { type: 'PRESENTED' });
      expect(after.state, `${state} + PRESENTED(no identity) must not advance`).toBe(before.state);
      expect(after.presentedBy).toBe(before.presentedBy);
      expect(after.rejected.length).toBe(Math.min(before.rejected.length + 1, MAX_REJECTED_RECORDED));
    }
  });

  it('honours FAIL from every live state and refuses it from the terminal ones', () => {
    for (const state of ALL_STATES) {
      const before = frozen(reach(state));
      const after = activationReducer(before, { type: 'FAIL', reason: 'gpu died' });
      if (FAILABLE.has(state)) {
        expect(after.state, `FAIL from ${state}`).toBe('FAILED');
        expect(after.error).toBe('gpu died');
        // A failed activation has no valid presentation, whatever it had submitted before.
        expect(after.presentedBy, `presentedBy after FAIL from ${state}`).toBeNull();
      } else {
        expect(after.state, `FAIL from ${state}`).toBe(state);
        expect(after.rejected.length).toBe(before.rejected.length + 1);
      }
    }
  });

  it('supplies a default reason when FAIL carries none', () => {
    expect(activationReducer(reach('RENDERING'), { type: 'FAIL' }).error).toBe('activation failed');
  });

  it('never mutates the state it was given', () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        const before = frozen(reach(state));
        expect(() => activationReducer(before, { type: event })).not.toThrow();
      }
    }
  });

  it('bounds the rejection log', () => {
    let s = reach('RELEASED');
    for (let i = 0; i < MAX_REJECTED_RECORDED + 15; i++) s = activationReducer(s, { type: 'PRESENTED', ackIdentity: s.identity });
    expect(s.rejected.length).toBe(MAX_REJECTED_RECORDED);
  });
});

// ── the negative structural claims ────────────────────────────────────────────────────────────

describe('PRESENTED is reachable only by acknowledgement', () => {
  it('is refused from every state except RENDERING', () => {
    for (const state of ALL_STATES) {
      if (state === 'RENDERING') continue;
      const before = reach(state);
      const after = activationReducer(before, { type: 'PRESENTED', ackIdentity: before.identity });
      expect(after.state, `PRESENTED from ${state}`).toBe(state);
    }
  });

  it('is ENTERED by no other event, from any state', () => {
    // Entry, not occupancy: a refused event leaves an already-PRESENTED machine where it was, which
    // is not an edge. The scan is the assertion — a future edit that adds a timeout event with an
    // edge into PRESENTED (the classic "it has probably painted by now" fix) fails here.
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        if (event === 'PRESENTED') continue;
        const before = reach(state);
        const after = activationReducer(before, { type: event });
        const entered = before.state !== 'PRESENTED' && after.state === 'PRESENTED';
        expect(entered, `${state} + ${event} must not enter PRESENTED`).toBe(false);
      }
    }
  });

  it('cannot be reached from APPLIED without a render', () => {
    // APPLIED → PRESENTED directly is the shortcut that shows an installed-but-undrawn section.
    const applied = reach('APPLIED');
    expect(activationReducer(applied, { type: 'PRESENTED', ackIdentity: applied.identity }).state).toBe('APPLIED');
    expect(activationReducer(applied, { type: 'ACTIVATE' }).state).toBe('APPLIED');
  });
});

describe('VISIBLE is reachable only from PRESENTED (or back from COVERED)', () => {
  const entersVisible = (state: ActivationState, event: ActivationEventType): boolean => {
    const before = reach(state);
    const after = activationReducer(before, { type: event });
    return before.state !== 'VISIBLE' && after.state === 'VISIBLE';
  };

  it('accepts ACTIVATE only from PRESENTED', () => {
    for (const state of ALL_STATES) {
      expect(entersVisible(state, 'ACTIVATE'), `ACTIVATE from ${state}`).toBe(state === 'PRESENTED');
    }
  });

  it('accepts UNCOVER only from COVERED', () => {
    for (const state of ALL_STATES) {
      expect(entersVisible(state, 'UNCOVER'), `UNCOVER from ${state}`).toBe(state === 'COVERED');
    }
  });

  it('is ENTERED by no event other than ACTIVATE and UNCOVER', () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        if (event === 'ACTIVATE' || event === 'UNCOVER') continue;
        expect(entersVisible(state, event), `${state} + ${event} must not enter VISIBLE`).toBe(false);
      }
    }
  });
});

// ── duplicate acknowledgement ─────────────────────────────────────────────────────────────────

describe('duplicate acknowledgement', () => {
  it('refuses a second SECTION_PRESENTED and leaves the presentation proof untouched', () => {
    const first = reach('PRESENTED');
    const second = activationReducer(first, { type: 'PRESENTED', ackIdentity: first.identity });
    expect(second.state).toBe('PRESENTED');
    expect(second.presentedBy).toEqual(IDENTITY);
    expect(second.rejected[second.rejected.length - 1]).toEqual({ from: 'PRESENTED', event: 'PRESENTED' });
  });

  it('refuses a late SECTION_PRESENTED that arrives after the section is already VISIBLE', () => {
    const visible = reach('VISIBLE');
    const late = activationReducer(visible, { type: 'PRESENTED', ackIdentity: visible.identity });
    expect(late.state).toBe('VISIBLE');
    expect(late.rejected[late.rejected.length - 1]).toEqual({ from: 'VISIBLE', event: 'PRESENTED' });
  });

  it('refuses a duplicate APPLIED', () => {
    const applied = reach('APPLIED');
    const again = activationReducer(applied, { type: 'APPLIED' });
    expect(again.state).toBe('APPLIED');
    expect(again.rejected.length).toBe(applied.rejected.length + 1);
  });

  it('refuses a duplicate ACTIVATE', () => {
    const visible = reach('VISIBLE');
    expect(activationReducer(visible, { type: 'ACTIVATE' }).state).toBe('VISIBLE');
  });
});

// ── context loss ──────────────────────────────────────────────────────────────────────────────

describe('context loss invalidates the presentation', () => {
  for (const state of ['PRESENTED', 'VISIBLE', 'COVERED'] as const) {
    it(`drops ${state} back to RENDERING and forgets the acknowledgement`, () => {
      const before = reach(state);
      expect(before.presentedBy).toEqual(IDENTITY);
      const after = activationReducer(before, { type: 'CONTEXT_LOST' });
      expect(after.state).toBe('RENDERING');
      // The submitted frame is gone. A new render must be submitted and acknowledged before the
      // section may be shown again — the old proof describes pixels that no longer exist.
      expect(after.presentedBy).toBeNull();
    });
  }

  it('can be re-presented after a restore, and re-records the proof', () => {
    const recovered = run(reach('VISIBLE'), { type: 'CONTEXT_LOST' }, { type: 'PRESENTED', ackIdentity: IDENTITY });
    expect(recovered.state).toBe('PRESENTED');
    expect(recovered.presentedBy).toEqual(IDENTITY);
  });

  it('is refused before anything has been presented', () => {
    for (const state of ['IDLE', 'PREPARING', 'APPLIED', 'RENDERING'] as const) {
      const after = activationReducer(reach(state), { type: 'CONTEXT_LOST' });
      expect(after.state, `CONTEXT_LOST from ${state}`).toBe(state);
    }
  });
});

// ── release ───────────────────────────────────────────────────────────────────────────────────

describe('release', () => {
  it('is accepted from every non-released state', () => {
    for (const state of ALL_STATES) {
      const after = activationReducer(reach(state), { type: 'RELEASE' });
      expect(after.state, `RELEASE from ${state}`).toBe('RELEASED');
    }
  });

  it('is terminal — no event revives a released activation', () => {
    const released = reach('RELEASED');
    for (const event of ALL_EVENTS) {
      expect(activationReducer(released, { type: event }).state, `${event} from RELEASED`).toBe('RELEASED');
    }
  });

  it('keeps the presentation proof visible for telemetry but the state unrevealable', () => {
    // RELEASED is not in mayReveal's allow-list, so retaining `presentedBy` cannot authorise
    // anything; it is kept so a post-mortem can say what the activation had achieved.
    const released = reach('RELEASED');
    expect(released.presentedBy).toEqual(IDENTITY);
    expect(released.state).toBe('RELEASED');
  });
});

// ── cover / uncover ───────────────────────────────────────────────────────────────────────────

describe('cover and uncover', () => {
  it('covers a presented-but-not-yet-activated section (the exit transition case)', () => {
    const covered = activationReducer(reach('PRESENTED'), { type: 'COVER' });
    expect(covered.state).toBe('COVERED');
    expect(covered.presentedBy).toEqual(IDENTITY);
  });

  it('round-trips COVER → UNCOVER without losing the proof', () => {
    const s = run(reach('VISIBLE'), { type: 'COVER' }, { type: 'UNCOVER' });
    expect(s.state).toBe('VISIBLE');
    expect(s.presentedBy).toEqual(IDENTITY);
  });
});

// ── live-dwell product rule ───────────────────────────────────────────────────────────────────

describe('shouldRevealLive', () => {
  it('allows a reveal at exactly the threshold and refuses one below it', () => {
    expect(shouldRevealLive(1_200, 1_200)).toBe(true);
    expect(shouldRevealLive(1_199, 1_200)).toBe(false);
    expect(shouldRevealLive(0, 1_200)).toBe(false);
  });

  it('refuses a negative remaining time (the section is already over)', () => {
    expect(shouldRevealLive(-50, SIM_MIN_LIVE_DWELL_MS)).toBe(false);
  });

  it('allows anything when the minimum is zero', () => {
    expect(shouldRevealLive(0, 0)).toBe(true);
  });

  it('has a positive default dwell', () => {
    expect(SIM_MIN_LIVE_DWELL_MS).toBeGreaterThan(0);
  });
});

// ── identity plumbing ─────────────────────────────────────────────────────────────────────────

describe('toPresentationIdentity', () => {
  it('copies exactly the five compared axes and nothing else', () => {
    const identity = toPresentationIdentity({
      packageRevision: 'rev', documentId: 'doc', activationId: 'act',
      variantKey: 'var', configHash: 'cfg',
    });
    expect(identity).toEqual({
      packageRevision: 'rev', documentId: 'doc', activationId: 'act',
      variantKey: 'var', configHash: 'cfg',
    });
    expect(Object.keys(identity).sort()).toEqual(
      ['activationId', 'configHash', 'documentId', 'packageRevision', 'variantKey'],
    );
  });
});
