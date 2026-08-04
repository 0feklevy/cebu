/**
 * The iframe DOCUMENT lifecycle reducer.
 *
 * The transition table is duplicated here as an INDEPENDENT expectation. That duplication is the
 * point: if the test read the production table it would prove only that the reducer agrees with
 * itself. Written out separately, the exhaustive (state × event) walk below is a specification —
 * every pair either transitions to a named state or is refused and recorded, and there is no third
 * outcome.
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
} from 'shared/src/sim/documentMachine';
import { NO_CAPABILITIES, ZERO_RESOURCE_COUNTS, validateEnvelope, PARENT_INBOUND_TYPES, DOCUMENT_READY as DOCUMENT_READY_MSG, SIM_PROTOCOL_NAMESPACE, SIM_PROTOCOL_VERSION } from 'shared/src/sim/runtimeProtocol';

// ── enumerations, kept exhaustive by the type system ──────────────────────────────────────────

const ALL_STATES = Object.keys({
  UNMOUNTED: 1, QUEUED: 1, MOUNTING: 1, DOCUMENT_READY: 1,
  SUSPENDED: 1, DISPOSING: 1, EVICTED: 1, FAILED: 1,
} satisfies Record<DocumentState, 1>) as DocumentState[];

const ALL_EVENTS = Object.keys({
  QUEUE: 1, MOUNT: 1, READY: 1, SUSPEND: 1, SUSPENDED: 1, RESUME: 1, RESUMED: 1,
  NAVIGATE: 1, CONTEXT_LOST: 1, CONTEXT_RESTORED: 1, DISPOSE: 1, DISPOSED: 1, EVICT: 1, FAIL: 1,
} satisfies Record<DocumentEventType, 1>) as DocumentEventType[];

/**
 * The specification, restated. `NAVIGATE` and `FAIL` are deliberately absent: they are not ordinary
 * edges (the browser, not the parent, decides when a document is replaced) and are asserted
 * separately below.
 */
const EXPECTED: Record<DocumentState, Partial<Record<DocumentEventType, DocumentState>>> = {
  UNMOUNTED: { QUEUE: 'QUEUED', MOUNT: 'MOUNTING' },
  QUEUED: { MOUNT: 'MOUNTING', EVICT: 'EVICTED' },
  MOUNTING: { READY: 'DOCUMENT_READY', DISPOSE: 'DISPOSING', EVICT: 'EVICTED' },
  DOCUMENT_READY: {
    SUSPEND: 'DOCUMENT_READY',
    SUSPENDED: 'SUSPENDED',
    CONTEXT_LOST: 'DOCUMENT_READY',
    CONTEXT_RESTORED: 'DOCUMENT_READY',
    DISPOSE: 'DISPOSING',
    EVICT: 'EVICTED',
  },
  SUSPENDED: {
    RESUME: 'SUSPENDED',
    RESUMED: 'DOCUMENT_READY',
    CONTEXT_LOST: 'SUSPENDED',
    CONTEXT_RESTORED: 'SUSPENDED',
    DISPOSE: 'DISPOSING',
    EVICT: 'EVICTED',
  },
  DISPOSING: { DISPOSED: 'EVICTED', EVICT: 'EVICTED' },
  EVICTED: {},
  FAILED: { EVICT: 'EVICTED', DISPOSE: 'DISPOSING' },
};

/** States from which a FAIL is honoured. UNMOUNTED is NOT one: nothing has been attempted yet. */
const FAILABLE: ReadonlySet<DocumentState> = new Set<DocumentState>([
  'QUEUED', 'MOUNTING', 'DOCUMENT_READY', 'SUSPENDED', 'DISPOSING',
]);

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

const DOC1 = 'doc_epoch_1';
const DOC2 = 'doc_epoch_2';

const run = (s: DocumentMachineState, ...events: DocumentEvent[]): DocumentMachineState =>
  events.reduce(documentReducer, s);

/** Drive a real machine into `target` using only legal events. */
function reach(target: DocumentState): DocumentMachineState {
  const start = initialDocumentState(DOC1);
  switch (target) {
    case 'UNMOUNTED': return start;
    case 'QUEUED': return run(start, { type: 'QUEUE' });
    case 'MOUNTING': return run(start, { type: 'QUEUE' }, { type: 'MOUNT', documentId: DOC1 });
    case 'DOCUMENT_READY':
      return run(reach('MOUNTING'), { type: 'READY', capabilities: NO_CAPABILITIES });
    case 'SUSPENDED':
      return run(reach('DOCUMENT_READY'), { type: 'SUSPEND' }, { type: 'SUSPENDED', counts: ZERO_RESOURCE_COUNTS });
    case 'DISPOSING':
      return run(reach('DOCUMENT_READY'), { type: 'DISPOSE' });
    case 'EVICTED':
      return run(reach('DISPOSING'), { type: 'DISPOSED', counts: ZERO_RESOURCE_COUNTS });
    case 'FAILED':
      return run(reach('MOUNTING'), { type: 'FAIL', reason: 'boom' });
  }
}

/** Deep-freeze so any in-place mutation by the reducer throws instead of passing unnoticed. */
function frozen(s: DocumentMachineState): DocumentMachineState {
  Object.freeze(s.tombstoned);
  Object.freeze(s.rejected);
  return Object.freeze(s);
}

// ── document creation ─────────────────────────────────────────────────────────────────────────

describe('document creation', () => {
  it('starts UNMOUNTED with nothing known about the document', () => {
    const s = initialDocumentState();
    expect(s.state).toBe('UNMOUNTED');
    expect(s.documentId).toBeNull();
    expect(s.capabilities).toBeNull();
    expect(s.contextLost).toBe(false);
    expect(s.lastCounts).toBeNull();
    expect(s.error).toBeNull();
    expect(s.tombstoned).toEqual([]);
    expect(s.rejected).toEqual([]);
  });

  it('carries a pre-assigned document id', () => {
    expect(initialDocumentState(DOC1).documentId).toBe(DOC1);
  });

  it('QUEUE → MOUNT → READY is the creation path, and only READY yields capabilities', () => {
    const queued = documentReducer(initialDocumentState(), { type: 'QUEUE' });
    expect(queued.state).toBe('QUEUED');

    const mounting = documentReducer(queued, { type: 'MOUNT', documentId: DOC1 });
    expect(mounting.state).toBe('MOUNTING');
    expect(mounting.documentId).toBe(DOC1);
    expect(mounting.capabilities).toBeNull();

    const caps = { ...NO_CAPABILITIES, activationScoped: true, onDemandRender: true };
    const ready = documentReducer(mounting, { type: 'READY', capabilities: caps });
    expect(ready.state).toBe('DOCUMENT_READY');
    expect(ready.capabilities).toEqual(caps);
  });

  it('mounts directly from UNMOUNTED without a QUEUE (the eager path)', () => {
    const s = documentReducer(initialDocumentState(), { type: 'MOUNT', documentId: DOC1 });
    expect(s.state).toBe('MOUNTING');
    expect(s.documentId).toBe(DOC1);
  });

  it('keeps the existing document id when MOUNT carries none', () => {
    const s = documentReducer(initialDocumentState(DOC1), { type: 'MOUNT' });
    expect(s.documentId).toBe(DOC1);
  });

  it('refuses to re-MOUNT a FAILED document — recovery is a new epoch, not a revival', () => {
    const lost = run(reach('DOCUMENT_READY'), { type: 'CONTEXT_LOST' });
    expect(lost.contextLost).toBe(true);

    const failed = documentReducer(lost, { type: 'FAIL', reason: 'gpu' });
    expect(failed.state).toBe('FAILED');
    // Re-mounting in place would keep the failed epoch's id, so a message still in flight from it
    // would pass the document check against the "recovered" document.
    expect(documentReducer(failed, { type: 'MOUNT', documentId: DOC2 }).state).toBe('FAILED');

    const fresh = documentReducer(failed, { type: 'NAVIGATE', documentId: DOC2 });
    expect(fresh.state).toBe('MOUNTING');
    expect(fresh.documentId).toBe(DOC2);
    expect(fresh.tombstoned).toEqual([DOC1]);
    expect(fresh.contextLost).toBe(false);
    expect(fresh.capabilities).toBeNull();
    expect(fresh.error).toBeNull();
  });

  it('accepts commands ONLY in DOCUMENT_READY', () => {
    for (const state of ALL_STATES) {
      expect(acceptsCommands(reach(state)), `acceptsCommands in ${state}`).toBe(state === 'DOCUMENT_READY');
    }
  });
});

// ── the exhaustive walk ───────────────────────────────────────────────────────────────────────

describe('documentReducer — every (state, event) pair', () => {
  it('either takes the specified edge or refuses and records it — never a third outcome', () => {
    const problems: string[] = [];
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        if (event === 'NAVIGATE' || event === 'FAIL') continue;
        const before = frozen(reach(state));
        const after = documentReducer(before, { type: event, documentId: DOC2, counts: ZERO_RESOURCE_COUNTS, capabilities: NO_CAPABILITIES });
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

  it('honours FAIL from every active state and refuses it everywhere else', () => {
    for (const state of ALL_STATES) {
      const before = frozen(reach(state));
      const after = documentReducer(before, { type: 'FAIL', reason: 'because' });
      if (FAILABLE.has(state)) {
        expect(after.state, `FAIL from ${state}`).toBe('FAILED');
        expect(after.error).toBe('because');
      } else {
        expect(after.state, `FAIL from ${state}`).toBe(state);
        expect(after.rejected.length).toBe(before.rejected.length + 1);
      }
    }
  });

  it('supplies a default reason when FAIL carries none', () => {
    expect(documentReducer(reach('MOUNTING'), { type: 'FAIL' }).error).toBe('document failed');
  });

  it('never mutates the state it was given', () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        const before = frozen(reach(state));
        expect(() => documentReducer(before, { type: event, documentId: DOC2 })).not.toThrow();
      }
    }
  });

  it('bounds the rejection log', () => {
    let s = reach('EVICTED');
    for (let i = 0; i < MAX_REJECTED_RECORDED + 20; i++) s = documentReducer(s, { type: 'READY' });
    expect(s.rejected.length).toBe(MAX_REJECTED_RECORDED);
    expect(s.rejected.every((r) => r.from === 'EVICTED' && r.event === 'READY')).toBe(true);
  });
});

// ── navigation and document-id replacement ────────────────────────────────────────────────────

describe('document navigation', () => {
  it('replaces the epoch, tombstones the old one, and returns to MOUNTING', () => {
    const ready = run(reach('DOCUMENT_READY'), { type: 'CONTEXT_LOST' });
    const navigated = documentReducer(ready, { type: 'NAVIGATE', documentId: DOC2 });

    expect(navigated.state).toBe('MOUNTING');
    expect(navigated.documentId).toBe(DOC2);
    expect(navigated.tombstoned).toEqual([DOC1]);
    // The new document has handshaken nothing, so nothing the old one reported may carry over.
    expect(navigated.capabilities).toBeNull();
    expect(navigated.contextLost).toBe(false);
    expect(navigated.error).toBeNull();
  });

  it('preserves the rejection log across a navigation', () => {
    // The log is telemetry about the SURFACE driving the machine, not about the document, so a
    // navigation must not erase evidence of misuse.
    const withRejects = run(reach('MOUNTING'), { type: 'RESUMED' }, { type: 'SUSPENDED' });
    expect(withRejects.rejected.length).toBe(2);
    const navigated = documentReducer(withRejects, { type: 'NAVIGATE', documentId: DOC2 });
    expect(navigated.rejected.length).toBe(2);
  });

  it('is accepted from every state except EVICTED', () => {
    for (const state of ALL_STATES) {
      const before = frozen(reach(state));
      const after = documentReducer(before, { type: 'NAVIGATE', documentId: DOC2 });
      if (state === 'EVICTED') {
        expect(after.state, 'NAVIGATE from EVICTED').toBe('EVICTED');
        expect(after.rejected.length).toBe(before.rejected.length + 1);
      } else {
        expect(after.state, `NAVIGATE from ${state}`).toBe('MOUNTING');
        expect(after.documentId).toBe(DOC2);
      }
    }
  });

  it('accumulates every dead epoch and never records one twice', () => {
    // Ids are minted unique in production, so the repeat below is not a real path — it pins the
    // dedupe itself, which is what keeps the tombstone list bounded across a long session.
    const s = run(
      reach('DOCUMENT_READY'),
      { type: 'NAVIGATE', documentId: DOC2 },
      { type: 'NAVIGATE', documentId: DOC1 },
      { type: 'NAVIGATE', documentId: 'doc_epoch_3' },
    );
    expect(s.tombstoned).toEqual([DOC1, DOC2]);
    expect(s.documentId).toBe('doc_epoch_3');
  });
});

describe('document ID replacement — the transport must reject the previous epoch', () => {
  const envelopeFrom = (documentId: string) => ({
    namespace: SIM_PROTOCOL_NAMESPACE,
    protocolVersion: SIM_PROTOCOL_VERSION,
    type: DOCUMENT_READY_MSG,
    playerSessionId: 'ps_1',
    packageRevision: 'rev_1',
    documentId,
    seq: 1,
    payload: { capabilities: NO_CAPABILITIES, variants: [] },
  });

  it('rejects a message from the pre-navigation document as tombstoned, and accepts the new one', () => {
    // This is the concrete defect the `documentId` axis closes: the iframe ELEMENT survives
    // navigation, so a `contentWindow` comparison still matches and the old document's message is
    // accepted as if it described the new one.
    const navigated = documentReducer(reach('DOCUMENT_READY'), { type: 'NAVIGATE', documentId: DOC2 });
    const c = {
      playerSessionId: 'ps_1',
      documentId: navigated.documentId!,
      tombstonedDocumentIds: new Set(navigated.tombstoned),
      lastSeq: 0,
      allowedTypes: PARENT_INBOUND_TYPES,
    };

    const stale = validateEnvelope(envelopeFrom(DOC1), c);
    expect(stale.ok).toBe(false);
    expect(stale.ok === false && stale.reason).toBe('tombstoned-document');

    expect(validateEnvelope(envelopeFrom(DOC2), c).ok).toBe(true);
  });

  it('rejects a message from a disposed document as tombstoned', () => {
    const evicted = reach('EVICTED');
    expect(evicted.tombstoned).toEqual([DOC1]);
    const c = {
      playerSessionId: 'ps_1',
      documentId: DOC1,
      tombstonedDocumentIds: new Set(evicted.tombstoned),
      lastSeq: 0,
      allowedTypes: PARENT_INBOUND_TYPES,
    };
    const late = validateEnvelope(envelopeFrom(DOC1), c);
    expect(late.ok === false && late.reason).toBe('tombstoned-document');
  });
});

// ── suspend / resume ──────────────────────────────────────────────────────────────────────────

describe('suspend and resume', () => {
  it('keeps accepting commands while a suspend is merely REQUESTED', () => {
    // The request is not the fact. Until the child confirms quiescence the document is still live,
    // and a parent that stopped talking to it could never deliver the resume.
    const requested = documentReducer(reach('DOCUMENT_READY'), { type: 'SUSPEND' });
    expect(requested.state).toBe('DOCUMENT_READY');
    expect(acceptsCommands(requested)).toBe(true);
  });

  it('moves to SUSPENDED only on the child\'s confirmation, and records the proof', () => {
    const counts = { ...ZERO_RESOURCE_COUNTS, listeners: 3, glTextures: 12 };
    const suspended = run(reach('DOCUMENT_READY'), { type: 'SUSPEND' }, { type: 'SUSPENDED', counts });
    expect(suspended.state).toBe('SUSPENDED');
    expect(suspended.lastCounts).toEqual(counts);
    expect(acceptsCommands(suspended)).toBe(false);
  });

  it('round-trips back to DOCUMENT_READY on RESUMED, and keeps the last counts', () => {
    const suspended = reach('SUSPENDED');
    const requested = documentReducer(suspended, { type: 'RESUME' });
    expect(requested.state).toBe('SUSPENDED');
    const resumed = documentReducer(requested, { type: 'RESUMED' });
    expect(resumed.state).toBe('DOCUMENT_READY');
    expect(resumed.lastCounts).toEqual(ZERO_RESOURCE_COUNTS);
  });

  it('refuses a duplicate suspension confirmation', () => {
    const suspended = reach('SUSPENDED');
    const again = documentReducer(suspended, { type: 'SUSPENDED', counts: ZERO_RESOURCE_COUNTS });
    expect(again.state).toBe('SUSPENDED');
    expect(again.rejected[again.rejected.length - 1]).toEqual({ from: 'SUSPENDED', event: 'SUSPENDED' });
  });

  it('refuses a resume confirmation that was never requested', () => {
    const ready = reach('DOCUMENT_READY');
    const bogus = documentReducer(ready, { type: 'RESUMED' });
    expect(bogus.state).toBe('DOCUMENT_READY');
    expect(bogus.rejected[bogus.rejected.length - 1]).toEqual({ from: 'DOCUMENT_READY', event: 'RESUMED' });
  });

  it('refuses a suspension confirmation that arrives after a dispose was started', () => {
    const disposing = reach('DISPOSING');
    const late = documentReducer(disposing, { type: 'SUSPENDED', counts: ZERO_RESOURCE_COUNTS });
    expect(late.state).toBe('DISPOSING');
    expect(late.lastCounts).toBeNull();
  });
});

// ── context loss ──────────────────────────────────────────────────────────────────────────────

describe('context loss', () => {
  it('marks the document invalid without taking it out of DOCUMENT_READY', () => {
    // The runtime can still be talked to — it is the SUBMITTED FRAME that is gone. Presentation
    // validity is the activation machine's business; this flag is what it consults.
    const lost = documentReducer(reach('DOCUMENT_READY'), { type: 'CONTEXT_LOST' });
    expect(lost.state).toBe('DOCUMENT_READY');
    expect(lost.contextLost).toBe(true);
    expect(acceptsCommands(lost)).toBe(true);
  });

  it('clears the flag on restore', () => {
    const restored = run(reach('DOCUMENT_READY'), { type: 'CONTEXT_LOST' }, { type: 'CONTEXT_RESTORED' });
    expect(restored.contextLost).toBe(false);
  });

  it('is idempotent — a repeated loss does not accumulate state', () => {
    const twice = run(reach('DOCUMENT_READY'), { type: 'CONTEXT_LOST' }, { type: 'CONTEXT_LOST' });
    expect(twice.contextLost).toBe(true);
    expect(twice.rejected).toEqual([]);
  });

  it('is tracked while suspended too', () => {
    const lost = documentReducer(reach('SUSPENDED'), { type: 'CONTEXT_LOST' });
    expect(lost.state).toBe('SUSPENDED');
    expect(lost.contextLost).toBe(true);
  });

  it('is refused — and leaves the flag clear — before the handshake', () => {
    const early = documentReducer(reach('MOUNTING'), { type: 'CONTEXT_LOST' });
    expect(early.contextLost).toBe(false);
    expect(early.rejected[0]).toEqual({ from: 'MOUNTING', event: 'CONTEXT_LOST' });
  });
});

// ── release / dispose ─────────────────────────────────────────────────────────────────────────

describe('release and dispose', () => {
  it('disposes through DISPOSING and tombstones the epoch on confirmation', () => {
    const counts = { ...ZERO_RESOURCE_COUNTS, workers: 1 };
    const disposing = documentReducer(reach('DOCUMENT_READY'), { type: 'DISPOSE' });
    expect(disposing.state).toBe('DISPOSING');
    expect(disposing.tombstoned).toEqual([]);

    const evicted = documentReducer(disposing, { type: 'DISPOSED', counts });
    expect(evicted.state).toBe('EVICTED');
    expect(evicted.tombstoned).toEqual([DOC1]);
    expect(evicted.lastCounts).toEqual(counts);
  });

  it('tombstones on a hard EVICT even when the child never confirmed', () => {
    const evicted = documentReducer(reach('DISPOSING'), { type: 'EVICT' });
    expect(evicted.state).toBe('EVICTED');
    expect(evicted.tombstoned).toEqual([DOC1]);
  });

  it('can dispose a failed document, but cannot revive it', () => {
    const failed = reach('FAILED');
    expect(documentReducer(failed, { type: 'DISPOSE' }).state).toBe('DISPOSING');
    expect(documentReducer(failed, { type: 'READY', capabilities: NO_CAPABILITIES }).state).toBe('FAILED');
  });

  it('is terminal once EVICTED — no event resurrects it', () => {
    const evicted = reach('EVICTED');
    for (const event of ALL_EVENTS) {
      const after = documentReducer(evicted, { type: event, documentId: DOC2 });
      expect(after.state, `${event} from EVICTED`).toBe('EVICTED');
    }
  });
});

// ── the separation that matters ───────────────────────────────────────────────────────────────

describe('the document machine never authorises a reveal', () => {
  it('returns false from documentAuthorizesReveal in EVERY state', () => {
    // DOCUMENT_READY means "the runtime can receive commands". Treating it as "safe to show" is the
    // exact conflation that produced every wrong-frame incident this protocol exists to close, so
    // there must be no document state — not even the healthy one — that grants presentation.
    for (const state of ALL_STATES) {
      expect(documentAuthorizesReveal(reach(state)), `documentAuthorizesReveal in ${state}`).toBe(false);
    }
  });

  it('returns false even for a fully-capable, context-healthy, ready document', () => {
    const caps = {
      activationScoped: true, managedLifecycle: true, onDemandRender: true, contextEvents: true,
      suspendable: true, audioControl: true, qualityControl: true,
    };
    const ready = documentReducer(reach('MOUNTING'), { type: 'READY', capabilities: caps });
    expect(ready.capabilities).toEqual(caps);
    expect(acceptsCommands(ready)).toBe(true);
    expect(documentAuthorizesReveal(ready)).toBe(false);
  });
});
