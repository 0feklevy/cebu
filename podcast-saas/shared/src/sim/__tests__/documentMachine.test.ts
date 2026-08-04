/**
 * The iframe DOCUMENT lifecycle reducer — shared-side.
 *
 * RELATIONSHIP TO client-web/__tests__/simDocumentMachine.test.ts
 * That file restates the transition table independently and walks every (state x event) pair, which
 * is the right shape. It restates it as `Record<DocumentState, Partial<Record<DocumentEventType,
 * …>>>`, and that `Partial` is the gap this file closes: under it, an omitted key means "expected to
 * be refused", so a DocumentEventType added to the union — or a key lost to a typo — silently
 * acquires the expectation "refused" and no test fails. It also excludes NAVIGATE and FAIL from the
 * walk and asserts them separately, so those two are never checked against the other twelve.
 *
 * The table below is TOTAL: `Record<DocumentState, Record<DocumentEventType, …>>` with no `Partial`
 * and no omissions, including NAVIGATE and FAIL. Every one of the 8 x 14 = 112 pairs has to be
 * written down, so a new state or a new event cannot compile until someone has decided what it
 * does from everywhere.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_REJECTED_RECORDED,
  acceptsCommands,
  documentAuthorizesReveal,
  documentReducer,
  initialDocumentState,
  type DocumentEvent,
  type DocumentEventType,
  type DocumentMachineState,
  type DocumentState,
} from '../documentMachine.js';
import { NO_CAPABILITIES, ZERO_RESOURCE_COUNTS } from '../runtimeProtocol.js';

const DOC1 = 'doc_epoch_1';
const DOC2 = 'doc_epoch_2';

/** What a pair does: a destination state, or a refusal that is recorded and changes nothing else. */
type Outcome = DocumentState | 'REFUSED';

/**
 * The specification, restated in full. NAVIGATE is `MOUNTING` from everywhere but EVICTED because
 * the BROWSER, not the parent, decides when a document is replaced — it can therefore arrive in any
 * live state, and the new document has handshaken nothing. FAIL is honoured only from the states
 * where something is actually in flight.
 */
const EXPECTED: Record<DocumentState, Record<DocumentEventType, Outcome>> = {
  UNMOUNTED: {
    QUEUE: 'QUEUED', MOUNT: 'MOUNTING', READY: 'REFUSED', SUSPEND: 'REFUSED', SUSPENDED: 'REFUSED',
    RESUME: 'REFUSED', RESUMED: 'REFUSED', NAVIGATE: 'MOUNTING', CONTEXT_LOST: 'REFUSED',
    CONTEXT_RESTORED: 'REFUSED', DISPOSE: 'REFUSED', DISPOSED: 'REFUSED', EVICT: 'REFUSED',
    // Nothing has been attempted yet, so there is nothing to have failed.
    FAIL: 'REFUSED',
  },
  QUEUED: {
    QUEUE: 'REFUSED', MOUNT: 'MOUNTING', READY: 'REFUSED', SUSPEND: 'REFUSED', SUSPENDED: 'REFUSED',
    RESUME: 'REFUSED', RESUMED: 'REFUSED', NAVIGATE: 'MOUNTING', CONTEXT_LOST: 'REFUSED',
    CONTEXT_RESTORED: 'REFUSED', DISPOSE: 'REFUSED', DISPOSED: 'REFUSED', EVICT: 'EVICTED',
    FAIL: 'FAILED',
  },
  MOUNTING: {
    QUEUE: 'REFUSED', MOUNT: 'REFUSED', READY: 'DOCUMENT_READY', SUSPEND: 'REFUSED',
    SUSPENDED: 'REFUSED', RESUME: 'REFUSED', RESUMED: 'REFUSED', NAVIGATE: 'MOUNTING',
    CONTEXT_LOST: 'REFUSED', CONTEXT_RESTORED: 'REFUSED', DISPOSE: 'DISPOSING', DISPOSED: 'REFUSED',
    EVICT: 'EVICTED', FAIL: 'FAILED',
  },
  DOCUMENT_READY: {
    QUEUE: 'REFUSED', MOUNT: 'REFUSED', READY: 'REFUSED',
    // A suspend REQUEST does not move the state; only the child's confirmation does.
    SUSPEND: 'DOCUMENT_READY', SUSPENDED: 'SUSPENDED',
    RESUME: 'REFUSED', RESUMED: 'REFUSED', NAVIGATE: 'MOUNTING',
    // Context loss records an invalidation without taking the document out of service.
    CONTEXT_LOST: 'DOCUMENT_READY', CONTEXT_RESTORED: 'DOCUMENT_READY',
    DISPOSE: 'DISPOSING', DISPOSED: 'REFUSED', EVICT: 'EVICTED', FAIL: 'FAILED',
  },
  SUSPENDED: {
    QUEUE: 'REFUSED', MOUNT: 'REFUSED', READY: 'REFUSED', SUSPEND: 'REFUSED', SUSPENDED: 'REFUSED',
    RESUME: 'SUSPENDED', RESUMED: 'DOCUMENT_READY', NAVIGATE: 'MOUNTING',
    CONTEXT_LOST: 'SUSPENDED', CONTEXT_RESTORED: 'SUSPENDED',
    DISPOSE: 'DISPOSING', DISPOSED: 'REFUSED', EVICT: 'EVICTED', FAIL: 'FAILED',
  },
  DISPOSING: {
    QUEUE: 'REFUSED', MOUNT: 'REFUSED', READY: 'REFUSED', SUSPEND: 'REFUSED', SUSPENDED: 'REFUSED',
    RESUME: 'REFUSED', RESUMED: 'REFUSED', NAVIGATE: 'MOUNTING', CONTEXT_LOST: 'REFUSED',
    CONTEXT_RESTORED: 'REFUSED', DISPOSE: 'REFUSED', DISPOSED: 'EVICTED', EVICT: 'EVICTED',
    FAIL: 'FAILED',
  },
  // Terminal. A late message about an evicted document is rejected, never acted on — including a
  // NAVIGATE, because a document that has left the DOM cannot navigate.
  EVICTED: {
    QUEUE: 'REFUSED', MOUNT: 'REFUSED', READY: 'REFUSED', SUSPEND: 'REFUSED', SUSPENDED: 'REFUSED',
    RESUME: 'REFUSED', RESUMED: 'REFUSED', NAVIGATE: 'REFUSED', CONTEXT_LOST: 'REFUSED',
    CONTEXT_RESTORED: 'REFUSED', DISPOSE: 'REFUSED', DISPOSED: 'REFUSED', EVICT: 'REFUSED',
    FAIL: 'REFUSED',
  },
  FAILED: {
    // Recovery from FAILED is a NEW epoch, never a revival: MOUNT and READY stay refused.
    QUEUE: 'REFUSED', MOUNT: 'REFUSED', READY: 'REFUSED', SUSPEND: 'REFUSED', SUSPENDED: 'REFUSED',
    RESUME: 'REFUSED', RESUMED: 'REFUSED', NAVIGATE: 'MOUNTING', CONTEXT_LOST: 'REFUSED',
    CONTEXT_RESTORED: 'REFUSED', DISPOSE: 'DISPOSING', DISPOSED: 'REFUSED', EVICT: 'EVICTED',
    FAIL: 'REFUSED',
  },
};

const ALL_STATES = Object.keys(EXPECTED) as DocumentState[];
const ALL_EVENTS = Object.keys(EXPECTED.UNMOUNTED) as DocumentEventType[];

const run = (s: DocumentMachineState, ...events: DocumentEvent[]): DocumentMachineState =>
  events.reduce(documentReducer, s);

/** Drive a real machine into `target` using only legal events. */
function reach(target: DocumentState): DocumentMachineState {
  const start = initialDocumentState(DOC1);
  switch (target) {
    case 'UNMOUNTED': return start;
    case 'QUEUED': return run(start, { type: 'QUEUE' });
    case 'MOUNTING': return run(start, { type: 'QUEUE' }, { type: 'MOUNT', documentId: DOC1 });
    case 'DOCUMENT_READY': return run(reach('MOUNTING'), { type: 'READY', capabilities: NO_CAPABILITIES });
    case 'SUSPENDED':
      return run(reach('DOCUMENT_READY'), { type: 'SUSPEND' }, { type: 'SUSPENDED', counts: ZERO_RESOURCE_COUNTS });
    case 'DISPOSING': return run(reach('DOCUMENT_READY'), { type: 'DISPOSE' });
    case 'EVICTED': return run(reach('DISPOSING'), { type: 'DISPOSED', counts: ZERO_RESOURCE_COUNTS });
    case 'FAILED': return run(reach('MOUNTING'), { type: 'FAIL', reason: 'boom' });
  }
}

/** Deep-freeze so an in-place mutation throws here instead of corrupting a caller's state. */
function frozen(s: DocumentMachineState): DocumentMachineState {
  Object.freeze(s.tombstoned);
  Object.freeze(s.rejected);
  return Object.freeze(s);
}

/** Events that need a payload to be meaningful get one, so no pair is tested in a degenerate form. */
function eventFor(type: DocumentEventType): DocumentEvent {
  switch (type) {
    case 'MOUNT': return { type, documentId: DOC1 };
    case 'NAVIGATE': return { type, documentId: DOC2 };
    case 'READY': return { type, capabilities: NO_CAPABILITIES };
    case 'SUSPENDED':
    case 'DISPOSED': return { type, counts: ZERO_RESOURCE_COUNTS };
    case 'FAIL': return { type, reason: 'boom' };
    default: return { type };
  }
}

describe('every (state x event) pair, with no pair left to a default', () => {
  it('reaches all eight states with legal events, so the walk below is not testing stubs', () => {
    for (const state of ALL_STATES) expect(reach(state).state).toBe(state);
    expect(ALL_STATES).toHaveLength(8);
    expect(ALL_EVENTS).toHaveLength(14);
  });

  for (const state of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      const outcome = EXPECTED[state][event];
      it(`${state} + ${event} -> ${outcome}`, () => {
        const prev = frozen(reach(state));
        const next = documentReducer(prev, eventFor(event));

        if (outcome === 'REFUSED') {
          // A refusal is not just "no state change": DOCUMENT_READY + SUSPEND also leaves the state
          // alone. The rejection log is the only thing that tells the two apart.
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
    // The freeze above would throw on a write in strict mode; this also checks nothing was swapped.
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        const prev = frozen(reach(state));
        const snapshot = JSON.stringify(prev);
        documentReducer(prev, eventFor(event));
        expect(JSON.stringify(prev)).toBe(snapshot);
      }
    }
  });
});

describe('tombstoning — which transitions kill an epoch', () => {
  /** A dead epoch must be in `tombstoned` so the transport can reject its in-flight messages. */
  const TOMBSTONES: Record<DocumentEventType, boolean> = {
    QUEUE: false, MOUNT: false, READY: false, SUSPEND: false, SUSPENDED: false,
    RESUME: false, RESUMED: false,
    // The browser replaced the document; anything still in flight from the old one is dead.
    NAVIGATE: true,
    CONTEXT_LOST: false, CONTEXT_RESTORED: false, DISPOSE: false,
    DISPOSED: true, EVICT: true, FAIL: false,
  };

  for (const [event, tombstones] of Object.entries(TOMBSTONES) as [DocumentEventType, boolean][]) {
    it(`${event} ${tombstones ? 'tombstones' : 'does not tombstone'} the current epoch`, () => {
      // Driven from DOCUMENT_READY for the events that are legal there; the others are refused and
      // must not tombstone either, which is the point of asserting all fourteen.
      const prev = reach('DOCUMENT_READY');
      const next = documentReducer(prev, eventFor(event));
      expect(next.tombstoned.includes(DOC1)).toBe(tombstones && EXPECTED.DOCUMENT_READY[event] !== 'REFUSED');
    });
  }

  it('accumulates every dead epoch and never records one twice', () => {
    let s = reach('DOCUMENT_READY');
    s = documentReducer(s, { type: 'NAVIGATE', documentId: DOC2 });
    expect(s.tombstoned).toEqual([DOC1]);
    s = documentReducer(s, { type: 'READY', capabilities: NO_CAPABILITIES });
    s = documentReducer(s, { type: 'EVICT' });
    expect(s.tombstoned).toEqual([DOC1, DOC2]);
    // A second EVICT is refused, so nothing is appended a second time.
    s = documentReducer(s, { type: 'EVICT' });
    expect(s.tombstoned).toEqual([DOC1, DOC2]);
  });

  it('carries the rejection log across a navigation but drops everything the old epoch knew', () => {
    let s = reach('DOCUMENT_READY');
    s = documentReducer(s, { type: 'CONTEXT_LOST' });
    s = documentReducer(s, { type: 'QUEUE' });
    expect(s.rejected).toHaveLength(1);
    expect(s.contextLost).toBe(true);
    s = documentReducer(s, { type: 'NAVIGATE', documentId: DOC2 });
    expect(s.rejected).toHaveLength(1);
    expect(s.documentId).toBe(DOC2);
    // The new document handshook nothing, so capabilities and the loss flag must not survive.
    expect(s.capabilities).toBeNull();
    expect(s.contextLost).toBe(false);
  });
});

describe('the rejection log is bounded', () => {
  it(`keeps the newest ${MAX_REJECTED_RECORDED} refusals and drops older ones`, () => {
    let s = initialDocumentState(DOC1);
    for (let i = 0; i < MAX_REJECTED_RECORDED + 20; i++) s = documentReducer(s, { type: 'READY' });
    expect(s.rejected).toHaveLength(MAX_REJECTED_RECORDED);
    expect(s.rejected.every((r) => r.event === 'READY' && r.from === 'UNMOUNTED')).toBe(true);
  });
});

describe('the document machine never authorises a reveal', () => {
  it('returns false from documentAuthorizesReveal in every state, including a perfectly healthy one', () => {
    // Presentation is the activation machine's decision, gated by the five-axis identity check.
    // Conflating "the runtime accepts commands" with "this activation may be shown" is the single
    // defect that produced every wrong-frame incident this protocol exists to close, so no document
    // state may grant it — not even DOCUMENT_READY with full capabilities and no context loss.
    for (const state of ALL_STATES) {
      expect(documentAuthorizesReveal(reach(state))).toBe(false);
    }
    const healthy = run(reach('MOUNTING'), {
      type: 'READY',
      capabilities: { ...NO_CAPABILITIES, activationScoped: true, onDemandRender: true },
    });
    expect(healthy.state).toBe('DOCUMENT_READY');
    expect(healthy.contextLost).toBe(false);
    expect(documentAuthorizesReveal(healthy)).toBe(false);
  });

  it('accepts commands in DOCUMENT_READY and nowhere else', () => {
    const accepting = ALL_STATES.filter((s) => acceptsCommands(reach(s)));
    expect(accepting).toEqual(['DOCUMENT_READY']);
  });
});
