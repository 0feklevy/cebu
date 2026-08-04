/**
 * The iframe DOCUMENT lifecycle, as a pure reducer.
 *
 * WHY A REDUCER AND NOT BOOLEANS
 * Every surface that has hosted a simulation in this codebase kept its own `ready`, `painted`,
 * `loading`, `suspended` flags, and every audit found a state those flags could reach that no one
 * had considered — suspended-and-ready, disposed-but-polling, ready-on-a-document-that-navigated.
 * A transition table makes the illegal states unreachable and, just as importantly, makes them
 * ENUMERABLE: the tests below walk every (state, event) pair, so a transition nobody thought about
 * is a listed omission rather than a silent fall-through.
 *
 * THE ONE RULE THAT MATTERS
 * `DOCUMENT_READY` means the runtime can receive commands. It does NOT authorise reveal, and this
 * machine has no state that does — reveal lives entirely in the activation machine, gated by the
 * identity invariant. Conflating the two is the defect that produced every wrong-frame incident
 * this protocol exists to close, so the separation is structural rather than a convention.
 */

import type { DocumentId } from './simIdentity.js';
import type { SimRuntimeCapabilities, SimResourceCounts } from './runtimeProtocol.js';

export type DocumentState =
  | 'UNMOUNTED'
  | 'QUEUED'
  | 'MOUNTING'
  | 'DOCUMENT_READY'
  | 'SUSPENDED'
  | 'DISPOSING'
  | 'EVICTED'
  | 'FAILED';

export type DocumentEventType =
  | 'QUEUE'            // scheduled for mounting (pool admission)
  | 'MOUNT'            // iframe element created, src assigned, bootstrap offered
  | 'READY'            // child accepted bootstrap and reported DOCUMENT_READY
  | 'SUSPEND'          // parent asked the document to go quiescent
  | 'SUSPENDED'        // child confirmed quiescence with counts
  | 'RESUME'           // parent asked it to come back
  | 'RESUMED'          // child confirmed
  | 'NAVIGATE'         // the iframe loaded a NEW document — the old epoch is dead
  | 'CONTEXT_LOST'
  | 'CONTEXT_RESTORED'
  | 'DISPOSE'          // parent asked the child to release everything
  | 'DISPOSED'         // child confirmed
  | 'EVICT'            // element removed from the DOM
  | 'FAIL';

export interface DocumentEvent {
  type: DocumentEventType;
  /** For NAVIGATE: the id of the new epoch. */
  documentId?: DocumentId;
  capabilities?: SimRuntimeCapabilities;
  counts?: SimResourceCounts;
  reason?: string;
}

export interface DocumentMachineState {
  state: DocumentState;
  documentId: DocumentId | null;
  /** Epochs this transport must now reject messages from. */
  tombstoned: readonly DocumentId[];
  capabilities: SimRuntimeCapabilities | null;
  /** True between CONTEXT_LOST and CONTEXT_RESTORED. Presentation is invalid while set. */
  contextLost: boolean;
  lastCounts: SimResourceCounts | null;
  error: string | null;
  /**
   * Transitions the machine REFUSED, newest last. Kept (bounded) rather than dropped so that a
   * surface driving the machine wrongly is visible in telemetry instead of appearing to work.
   */
  rejected: readonly { from: DocumentState; event: DocumentEventType }[];
}

export const MAX_REJECTED_RECORDED = 32;

export function initialDocumentState(documentId: DocumentId | null = null): DocumentMachineState {
  return {
    state: 'UNMOUNTED',
    documentId,
    tombstoned: [],
    capabilities: null,
    contextLost: false,
    lastCounts: null,
    error: null,
    rejected: [],
  };
}

/**
 * The legal transition table. A `FAIL` from any non-terminal state is handled separately (the
 * spec says "any active state may transition to FAILED"), as is NAVIGATE, which can arrive at any
 * time because the browser — not the parent — decides when a document is replaced.
 */
const TRANSITIONS: Readonly<Record<DocumentState, Partial<Record<DocumentEventType, DocumentState>>>> = {
  UNMOUNTED: { QUEUE: 'QUEUED', MOUNT: 'MOUNTING' },
  QUEUED: { MOUNT: 'MOUNTING', EVICT: 'EVICTED' },
  MOUNTING: { READY: 'DOCUMENT_READY', DISPOSE: 'DISPOSING', EVICT: 'EVICTED' },
  DOCUMENT_READY: {
    SUSPEND: 'DOCUMENT_READY',      // request sent; state moves on the child's confirmation
    SUSPENDED: 'SUSPENDED',
    CONTEXT_LOST: 'DOCUMENT_READY', // stays usable; `contextLost` records the invalidation
    CONTEXT_RESTORED: 'DOCUMENT_READY',
    DISPOSE: 'DISPOSING',
    EVICT: 'EVICTED',
  },
  SUSPENDED: {
    RESUME: 'SUSPENDED',            // request sent; confirmation moves it
    RESUMED: 'DOCUMENT_READY',
    CONTEXT_LOST: 'SUSPENDED',
    CONTEXT_RESTORED: 'SUSPENDED',
    DISPOSE: 'DISPOSING',
    EVICT: 'EVICTED',
  },
  DISPOSING: { DISPOSED: 'EVICTED', EVICT: 'EVICTED' },
  // Terminal. A late message about an evicted document is rejected, never acted on.
  EVICTED: {},
  // Terminal for this epoch: recovery is a NEW document, which is a NAVIGATE or a fresh MOUNT.
  FAILED: { EVICT: 'EVICTED', DISPOSE: 'DISPOSING' },
};

const NON_TERMINAL: ReadonlySet<DocumentState> = new Set<DocumentState>([
  'QUEUED', 'MOUNTING', 'DOCUMENT_READY', 'SUSPENDED', 'DISPOSING',
]);

const tombstone = (prev: DocumentMachineState, id: DocumentId | null): readonly DocumentId[] =>
  id && !prev.tombstoned.includes(id) ? [...prev.tombstoned, id] : prev.tombstoned;

const withRejection = (prev: DocumentMachineState, event: DocumentEventType): DocumentMachineState => ({
  ...prev,
  rejected: [...prev.rejected, { from: prev.state, event }].slice(-MAX_REJECTED_RECORDED),
});

export function documentReducer(prev: DocumentMachineState, event: DocumentEvent): DocumentMachineState {
  // NAVIGATE is not a normal transition: the browser replaced the document under us. The OLD id is
  // tombstoned immediately so any message still in flight from it is dead on arrival, and the
  // machine returns to MOUNTING because the new document has handshaken nothing.
  if (event.type === 'NAVIGATE') {
    if (prev.state === 'EVICTED') return withRejection(prev, event.type);
    return {
      ...initialDocumentState(event.documentId ?? null),
      state: 'MOUNTING',
      tombstoned: tombstone(prev, prev.documentId),
      rejected: prev.rejected,
    };
  }

  if (event.type === 'FAIL') {
    if (!NON_TERMINAL.has(prev.state)) return withRejection(prev, event.type);
    return { ...prev, state: 'FAILED', error: event.reason ?? 'document failed' };
  }

  const next = TRANSITIONS[prev.state][event.type];
  if (!next) return withRejection(prev, event.type);

  let out: DocumentMachineState = { ...prev, state: next };

  switch (event.type) {
    case 'MOUNT':
      out = { ...out, documentId: event.documentId ?? prev.documentId, capabilities: null, contextLost: false, error: null };
      break;
    case 'READY':
      out = { ...out, capabilities: event.capabilities ?? null };
      break;
    case 'SUSPENDED':
      out = { ...out, lastCounts: event.counts ?? prev.lastCounts };
      break;
    case 'CONTEXT_LOST':
      out = { ...out, contextLost: true };
      break;
    case 'CONTEXT_RESTORED':
      out = { ...out, contextLost: false };
      break;
    case 'DISPOSED':
      out = { ...out, lastCounts: event.counts ?? prev.lastCounts, tombstoned: tombstone(prev, prev.documentId) };
      break;
    case 'EVICT':
      out = { ...out, tombstoned: tombstone(prev, prev.documentId) };
      break;
    default:
      break;
  }

  return out;
}

/** Can the parent send activation commands right now? */
export function acceptsCommands(s: DocumentMachineState): boolean {
  return s.state === 'DOCUMENT_READY';
}

/**
 * Deliberately exported so the reveal path can consult it and so a test can assert that NO document
 * state grants presentation on its own. It always returns false — presentation is the activation
 * machine's decision, gated by identity. Keeping it as a function (rather than not existing) makes
 * the intent checkable: a future edit that tries to make a document state authorise reveal has to
 * change a function with this comment on it.
 */
export function documentAuthorizesReveal(_s: DocumentMachineState): false {
  return false;
}
