/**
 * The SECTION ACTIVATION reducer and the reveal invariant — shared-side.
 *
 * RELATIONSHIP TO client-web/__tests__/simActivationMachine.test.ts and simRevealInvariant.test.ts
 * Those two files are the behavioural suite: A -> B -> A cycles, same-section re-entry, delayed
 * domain events, transport closure. This file does not restate any of that. It adds the two
 * structural guarantees they are shaped in a way that cannot give:
 *
 *   • A TOTAL transition table. client-web's is `Partial<Record<ActivationEventType, …>>`, where an
 *     omitted key means "expected to be refused" — so an event added to the union, or a key lost to
 *     a typo, inherits that expectation silently. All 9 x 10 = 90 pairs are written out below.
 *   • A CASCADED refusal table for `mayReveal`. client-web produces each of the nine refusals from
 *     an input where that is the only thing wrong, which proves reachability but not precedence:
 *     with nothing else broken, the check that fires is the only one that could. Here each case
 *     carries its own defect PLUS every defect checked after it, so the whole order is asserted.
 *     That order is load-bearing — `document-not-ready` must outrank an identity mismatch, because
 *     a suspended document's acknowledgement can be perfectly well-formed and still describe a
 *     frame that is no longer on screen.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_REJECTED_RECORDED,
  activationReducer,
  identityMatches,
  identityRefusal,
  initialActivationState,
  mayReveal,
  shouldRevealLive,
  toPresentationIdentity,
  SIM_MIN_LIVE_DWELL_MS,
  type ActivationEvent,
  type ActivationEventType,
  type ActivationMachineState,
  type ActivationState,
  type RevealInputs,
  type RevealRefusal,
} from '../activationMachine.js';
import type { PresentationIdentity } from '../simIdentity.js';

const IDENTITY: PresentationIdentity = {
  packageRevision: 'a3f9c1d0e7b45268',
  documentId: 'doc_epoch_1',
  activationId: 'act_1',
  variantKey: 'sec-1',
  configHash: '0123456789abcdef',
};

type Outcome = ActivationState | 'REFUSED';

/**
 * The specification, restated in full.
 *
 * The shape that matters: ACTIVATE is the ONLY edge into VISIBLE and PRESENTED is its only source;
 * PRESENTED is entered only from RENDERING and only by an acknowledgement; there is no timeout edge
 * anywhere and no edge a document-scope event can take. Each of those was, at some point in this
 * codebase's history, the thing that authorised a reveal, and each authorised a wrong one.
 */
const EXPECTED: Record<ActivationState, Record<ActivationEventType, Outcome>> = {
  IDLE: {
    PREPARE: 'PREPARING', APPLIED: 'REFUSED', PRESENT: 'REFUSED', PRESENTED: 'REFUSED',
    ACTIVATE: 'REFUSED', COVER: 'REFUSED', UNCOVER: 'REFUSED', CONTEXT_LOST: 'REFUSED',
    RELEASE: 'RELEASED', FAIL: 'FAILED',
  },
  PREPARING: {
    PREPARE: 'REFUSED', APPLIED: 'APPLIED', PRESENT: 'REFUSED', PRESENTED: 'REFUSED',
    ACTIVATE: 'REFUSED', COVER: 'REFUSED', UNCOVER: 'REFUSED', CONTEXT_LOST: 'REFUSED',
    RELEASE: 'RELEASED', FAIL: 'FAILED',
  },
  APPLIED: {
    // No edge from APPLIED to PRESENTED: an applied section has installed its state but has not
    // submitted a render, and showing it is exactly the unverified reveal.
    PREPARE: 'REFUSED', APPLIED: 'REFUSED', PRESENT: 'RENDERING', PRESENTED: 'REFUSED',
    ACTIVATE: 'REFUSED', COVER: 'REFUSED', UNCOVER: 'REFUSED', CONTEXT_LOST: 'REFUSED',
    RELEASE: 'RELEASED', FAIL: 'FAILED',
  },
  RENDERING: {
    PREPARE: 'REFUSED', APPLIED: 'REFUSED', PRESENT: 'REFUSED', PRESENTED: 'PRESENTED',
    ACTIVATE: 'REFUSED', COVER: 'REFUSED', UNCOVER: 'REFUSED', CONTEXT_LOST: 'REFUSED',
    RELEASE: 'RELEASED', FAIL: 'FAILED',
  },
  PRESENTED: {
    PREPARE: 'REFUSED', APPLIED: 'REFUSED', PRESENT: 'REFUSED',
    // A duplicate acknowledgement is refused rather than re-recorded.
    PRESENTED: 'REFUSED',
    ACTIVATE: 'VISIBLE', COVER: 'COVERED', UNCOVER: 'REFUSED',
    // The submitted frame is gone: back to RENDERING, and the proof is dropped.
    CONTEXT_LOST: 'RENDERING',
    RELEASE: 'RELEASED', FAIL: 'FAILED',
  },
  VISIBLE: {
    PREPARE: 'REFUSED', APPLIED: 'REFUSED', PRESENT: 'REFUSED', PRESENTED: 'REFUSED',
    ACTIVATE: 'REFUSED', COVER: 'COVERED', UNCOVER: 'REFUSED', CONTEXT_LOST: 'RENDERING',
    RELEASE: 'RELEASED', FAIL: 'FAILED',
  },
  COVERED: {
    PREPARE: 'REFUSED', APPLIED: 'REFUSED', PRESENT: 'REFUSED', PRESENTED: 'REFUSED',
    ACTIVATE: 'REFUSED', COVER: 'REFUSED', UNCOVER: 'VISIBLE', CONTEXT_LOST: 'RENDERING',
    RELEASE: 'RELEASED', FAIL: 'FAILED',
  },
  RELEASED: {
    PREPARE: 'REFUSED', APPLIED: 'REFUSED', PRESENT: 'REFUSED', PRESENTED: 'REFUSED',
    ACTIVATE: 'REFUSED', COVER: 'REFUSED', UNCOVER: 'REFUSED', CONTEXT_LOST: 'REFUSED',
    RELEASE: 'REFUSED', FAIL: 'REFUSED',
  },
  FAILED: {
    PREPARE: 'REFUSED', APPLIED: 'REFUSED', PRESENT: 'REFUSED', PRESENTED: 'REFUSED',
    ACTIVATE: 'REFUSED', COVER: 'REFUSED', UNCOVER: 'REFUSED', CONTEXT_LOST: 'REFUSED',
    RELEASE: 'RELEASED', FAIL: 'REFUSED',
  },
};

const ALL_STATES = Object.keys(EXPECTED) as ActivationState[];
const ALL_EVENTS = Object.keys(EXPECTED.IDLE) as ActivationEventType[];

const run = (s: ActivationMachineState, ...events: ActivationEvent[]): ActivationMachineState =>
  events.reduce(activationReducer, s);

const ACK: ActivationEvent = { type: 'PRESENTED', ackIdentity: IDENTITY };

function reach(target: ActivationState): ActivationMachineState {
  const start = initialActivationState(IDENTITY);
  switch (target) {
    case 'IDLE': return start;
    case 'PREPARING': return run(start, { type: 'PREPARE' });
    case 'APPLIED': return run(reach('PREPARING'), { type: 'APPLIED' });
    case 'RENDERING': return run(reach('APPLIED'), { type: 'PRESENT' });
    case 'PRESENTED': return run(reach('RENDERING'), ACK);
    case 'VISIBLE': return run(reach('PRESENTED'), { type: 'ACTIVATE' });
    case 'COVERED': return run(reach('VISIBLE'), { type: 'COVER' });
    case 'RELEASED': return run(reach('VISIBLE'), { type: 'RELEASE' });
    case 'FAILED': return run(reach('RENDERING'), { type: 'FAIL', reason: 'boom' });
  }
}

function frozen(s: ActivationMachineState): ActivationMachineState {
  Object.freeze(s.rejected);
  return Object.freeze(s);
}

/** PRESENTED always carries an acknowledgement here; the omitted case is asserted separately. */
const eventFor = (type: ActivationEventType): ActivationEvent =>
  type === 'PRESENTED' ? ACK : type === 'FAIL' ? { type, reason: 'boom' } : { type };

describe('every (state x event) pair, with no pair left to a default', () => {
  it('reaches all nine states with legal events, so the walk below is not testing stubs', () => {
    for (const state of ALL_STATES) expect(reach(state).state).toBe(state);
    expect(ALL_STATES).toHaveLength(9);
    expect(ALL_EVENTS).toHaveLength(10);
  });

  for (const state of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      const outcome = EXPECTED[state][event];
      it(`${state} + ${event} -> ${outcome}`, () => {
        const prev = frozen(reach(state));
        const next = activationReducer(prev, eventFor(event));

        if (outcome === 'REFUSED') {
          expect(next.state).toBe(prev.state);
          expect(next.rejected.length).toBe(prev.rejected.length + 1);
          expect(next.rejected[next.rejected.length - 1]).toEqual({ from: state, event });
        } else {
          expect(next.state).toBe(outcome);
          expect(next.rejected.length).toBe(prev.rejected.length);
        }
      });
    }
  }

  it('never mutates the state it was given', () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        const prev = frozen(reach(state));
        const snapshot = JSON.stringify(prev);
        activationReducer(prev, eventFor(event));
        expect(JSON.stringify(prev)).toBe(snapshot);
      }
    }
  });

  it('bounds the rejection log', () => {
    let s = initialActivationState(IDENTITY);
    for (let i = 0; i < MAX_REJECTED_RECORDED + 20; i++) s = activationReducer(s, { type: 'ACTIVATE' });
    expect(s.rejected).toHaveLength(MAX_REJECTED_RECORDED);
  });

  it('never rewrites the activation identity it was created with', () => {
    for (const state of ALL_STATES) expect(reach(state).identity).toEqual(IDENTITY);
  });
});

describe('PRESENTED requires an acknowledgement identity, from every state', () => {
  it('is refused everywhere when ackIdentity is omitted — including from RENDERING', () => {
    // Defaulting it to the machine's own identity made `mayReveal` compare an object with itself at
    // its only production call site, so every axis of the five-axis invariant was unreachable: the
    // check was unit-testable in isolation and enforced nothing in the player. Refusing is the fix.
    for (const state of ALL_STATES) {
      const prev = reach(state);
      const next = activationReducer(prev, { type: 'PRESENTED' });
      expect(next.state).toBe(prev.state);
      expect(next.presentedBy).toBe(prev.presentedBy);
      expect(next.rejected.length).toBe(prev.rejected.length + 1);
    }
  });

  it('records what the ACKNOWLEDGEMENT claimed, not what the machine already believes', () => {
    // The recorded value must be the ack's, so `mayReveal` can re-verify independently rather than
    // trusting that the caller checked. A wrong ack that reaches RENDERING is recorded verbatim and
    // then refused at the gate — which is the only reason the gate can catch it at all.
    const wrong: PresentationIdentity = { ...IDENTITY, documentId: 'doc_epoch_0' };
    const s = run(reach('RENDERING'), { type: 'PRESENTED', ackIdentity: wrong });
    expect(s.state).toBe('PRESENTED');
    expect(s.presentedBy).toEqual(wrong);
    expect(s.presentedBy).not.toEqual(s.identity);
  });

  it('drops the proof on context loss, so a new render is required before showing again', () => {
    for (const state of ['PRESENTED', 'VISIBLE', 'COVERED'] as ActivationState[]) {
      const s = reach(state);
      expect(s.presentedBy).toEqual(IDENTITY);
      const after = activationReducer(s, { type: 'CONTEXT_LOST' });
      expect(after.state).toBe('RENDERING');
      expect(after.presentedBy).toBeNull();
    }
  });

  it('drops the proof on FAIL too', () => {
    const s = activationReducer(reach('VISIBLE'), { type: 'FAIL', reason: 'gpu reset' });
    expect(s.state).toBe('FAILED');
    expect(s.presentedBy).toBeNull();
    expect(s.error).toBe('gpu reset');
  });
});

// ── the reveal gate ───────────────────────────────────────────────────────────────────────────

interface RefusalCase {
  apply(inputs: MutableRevealInputs): void;
  why: string;
}

interface MutableRevealInputs {
  activation: ActivationMachineState;
  current: PresentationIdentity;
  documentReady: boolean;
  contextLost: boolean;
}

/** The order `mayReveal` decides in, restated independently of the source. */
const REFUSAL_ORDER: readonly RevealRefusal[] = [
  'document-not-ready',
  'context-lost',
  'not-presented',
  'no-acknowledgement',
  'package-revision-mismatch',
  'document-mismatch',
  'activation-mismatch',
  'variant-mismatch',
  'config-mismatch',
];

const REFUSALS: Record<RevealRefusal, RefusalCase> = {
  'document-not-ready': {
    apply: (i) => { i.documentReady = false; },
    why: 'a suspended or disposing document may not show, however good the acknowledgement is',
  },
  'context-lost': {
    apply: (i) => { i.contextLost = true; },
    why: 'the submitted frame is gone; the identity that vouched for it is now describing nothing',
  },
  'not-presented': {
    apply: (i) => { i.activation = { ...i.activation, state: 'APPLIED' }; },
    why: 'installed state is not a submitted render',
  },
  'no-acknowledgement': {
    // Unreachable through the reducer (PRESENTED refuses without an ack), so it is constructed. A
    // gate that trusted the state alone would let this through, which is why the check exists.
    apply: (i) => { i.activation = { ...i.activation, presentedBy: null }; },
    why: 'a presented-looking state with nothing vouching for it',
  },
  'package-revision-mismatch': {
    apply: (i) => { i.current = { ...i.current, packageRevision: 'ffffffffffffffff' }; },
    why: 'the package was republished under the activation',
  },
  'document-mismatch': {
    apply: (i) => { i.current = { ...i.current, documentId: 'doc_epoch_9' }; },
    why: 'the acknowledgement came from a document epoch that has been replaced',
  },
  'activation-mismatch': {
    apply: (i) => { i.current = { ...i.current, activationId: 'act_9' }; },
    why: 'the axis that makes A -> B -> A safe: same section, same picture, different entry',
  },
  'variant-mismatch': {
    apply: (i) => { i.current = { ...i.current, variantKey: 'sec-9' }; },
    why: 'the wrong sub-simulation inside the right package',
  },
  'config-mismatch': {
    apply: (i) => { i.current = { ...i.current, configHash: 'ffffffffffffffff' }; },
    why: 'the right section rendered with a configuration it was not prepared with',
  },
};

function goodInputs(): MutableRevealInputs {
  return { activation: reach('PRESENTED'), current: { ...IDENTITY }, documentReady: true, contextLost: false };
}

/** This refusal's defect plus every defect checked after it. */
function cascadeFor(refusal: RevealRefusal): RevealInputs {
  const start = REFUSAL_ORDER.indexOf(refusal);
  if (start < 0) throw new Error(`${refusal} is missing from REFUSAL_ORDER`);
  const inputs = goodInputs();
  // Reverse, so `no-acknowledgement` (which nulls the proof the identity defects live on) is
  // applied AFTER them and therefore wins for its own case, and not at all for theirs.
  for (let i = REFUSAL_ORDER.length - 1; i >= start; i--) REFUSALS[REFUSAL_ORDER[i]].apply(inputs);
  return inputs;
}

describe('mayReveal — the refusal order is total, not merely reachable', () => {
  it('allows the reveal when everything matches, so every cascade starts from an allowed input', () => {
    expect(mayReveal(goodInputs())).toEqual({ allowed: true });
  });

  for (const refusal of REFUSAL_ORDER) {
    it(`refuses with '${refusal}' even with every later defect also present (${REFUSALS[refusal].why})`, () => {
      const decision = mayReveal(cascadeFor(refusal));
      expect(decision.allowed).toBe(false);
      expect(decision.allowed === false && decision.refusal).toBe(refusal);
    });
  }

  it('covers every reason in the RevealRefusal union exactly once', () => {
    expect(REFUSAL_ORDER.length).toBe(9);
    expect(new Set(REFUSAL_ORDER).size).toBe(9);
    expect([...REFUSAL_ORDER].sort()).toEqual(Object.keys(REFUSALS).sort());
  });

  it('allows only PRESENTED, VISIBLE and COVERED — every other state is not-presented', () => {
    const allowed: ActivationState[] = [];
    for (const state of ALL_STATES) {
      const decision = mayReveal({ ...goodInputs(), activation: reach(state) });
      if (decision.allowed) allowed.push(state);
      else if (!['PRESENTED', 'VISIBLE', 'COVERED'].includes(state)) {
        // RELEASED still remembers its proof for telemetry, so the state check — not the
        // acknowledgement check — has to be what refuses it.
        expect(decision.refusal).toBe('not-presented');
      }
    }
    expect(allowed.sort()).toEqual(['COVERED', 'PRESENTED', 'VISIBLE']);
  });
});

describe('identityRefusal compares all five axes by exact string equality', () => {
  const AXES: Record<keyof PresentationIdentity, RevealRefusal> = {
    packageRevision: 'package-revision-mismatch',
    documentId: 'document-mismatch',
    activationId: 'activation-mismatch',
    variantKey: 'variant-mismatch',
    configHash: 'config-mismatch',
  };

  for (const [axis, refusal] of Object.entries(AXES) as [keyof PresentationIdentity, RevealRefusal][]) {
    it(`reports '${refusal}' when ${axis} differs`, () => {
      expect(identityRefusal({ ...IDENTITY, [axis]: 'other' }, IDENTITY)).toBe(refusal);
      expect(identityMatches({ ...IDENTITY, [axis]: 'other' }, IDENTITY)).toBe(false);
    });

    it(`is not fooled by a ${axis} that differs only in case or whitespace`, () => {
      // Every axis is an opaque token compared verbatim. A normalising comparison would make two
      // genuinely different epochs look interchangeable.
      const value = IDENTITY[axis];
      expect(identityMatches({ ...IDENTITY, [axis]: value.toUpperCase() }, IDENTITY)).toBe(false);
      expect(identityMatches({ ...IDENTITY, [axis]: `${value} ` }, IDENTITY)).toBe(false);
    });
  }

  it('returns null only when all five agree', () => {
    expect(identityRefusal({ ...IDENTITY }, IDENTITY)).toBeNull();
    expect(identityMatches({ ...IDENTITY }, IDENTITY)).toBe(true);
    expect(Object.keys(AXES).sort()).toEqual(Object.keys(IDENTITY).sort());
  });

  it('reports the axes in a fixed order when more than one differs', () => {
    const allWrong: PresentationIdentity = {
      packageRevision: 'x', documentId: 'x', activationId: 'x', variantKey: 'x', configHash: 'x',
    };
    expect(identityRefusal(allWrong, IDENTITY)).toBe('package-revision-mismatch');
    expect(identityRefusal({ ...allWrong, packageRevision: IDENTITY.packageRevision }, IDENTITY))
      .toBe('document-mismatch');
    expect(identityRefusal(
      { ...allWrong, packageRevision: IDENTITY.packageRevision, documentId: IDENTITY.documentId },
      IDENTITY,
    )).toBe('activation-mismatch');
  });
});

describe('toPresentationIdentity and shouldRevealLive', () => {
  it('copies exactly the five compared axes and nothing else', () => {
    const identity = toPresentationIdentity({ ...IDENTITY });
    expect(identity).toEqual(IDENTITY);
    expect(Object.keys(identity).sort()).toEqual(Object.keys(IDENTITY).sort());
  });

  it('drops any extra field rather than carrying it onto the wire', () => {
    // playerSessionId is deliberately NOT part of the compared identity: a client instance never
    // sees another session's transport, so including it would imply the comparison enforces session
    // scoping when in fact the transport does.
    const identity = toPresentationIdentity({ ...IDENTITY, playerSessionId: 'ps_1' } as never);
    expect(Object.keys(identity)).not.toContain('playerSessionId');
  });

  it('allows a live reveal at exactly the threshold and refuses below it', () => {
    expect(shouldRevealLive(SIM_MIN_LIVE_DWELL_MS, SIM_MIN_LIVE_DWELL_MS)).toBe(true);
    expect(shouldRevealLive(SIM_MIN_LIVE_DWELL_MS - 1, SIM_MIN_LIVE_DWELL_MS)).toBe(false);
    expect(shouldRevealLive(-1, 0)).toBe(false);
    expect(shouldRevealLive(0, 0)).toBe(true);
    expect(SIM_MIN_LIVE_DWELL_MS).toBeGreaterThan(0);
  });
});
