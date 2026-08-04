/**
 * THE REVEAL INVARIANT.
 *
 *   A live iframe may have effective visible opacity only when the current presentation
 *   acknowledgement matches the current intent on ALL FIVE identity axes.
 *
 * This file is the acceptance evidence for that sentence. It drives the real document machine, the
 * real envelope validator and the real activation machines together, because the invariant is a
 * property of their COMPOSITION: each part in isolation looks fine, and every historical wrong-frame
 * incident in this codebase happened in the seam between two of them.
 *
 * The centrepiece is `A → B → A`. It constructs two activations of the SAME section, with the SAME
 * variant key, the SAME configuration hash, on the SAME document and the SAME package revision,
 * differing ONLY in activationId — and proves the first one's acknowledgement is refused for the
 * second. That is the case a token protocol cannot decide: a token is unique only within one
 * parent's lifetime, and every other axis agrees, so a token-shaped comparison returns "match" and
 * the player reveals the frame the user already saw.
 */
import { describe, it, expect } from 'vitest';
import {
  activationReducer,
  identityMatches,
  identityRefusal,
  initialActivationState,
  mayReveal,
  type ActivationMachineState,
  type RevealRefusal,
} from 'shared/src/sim/activationMachine';
import {
  acceptsCommands,
  documentReducer,
  initialDocumentState,
  type DocumentMachineState,
} from 'shared/src/sim/documentMachine';
import {
  DEFAULT_PRESENTATION_CONFIG,
  computeConfigHash,
  derivePackageRevision,
  newActivationId,
  newDocumentId,
  newPlayerSessionId,
  type PresentationIdentity,
  type SimPresentationConfig,
} from 'shared/src/sim/simIdentity';
import {
  DOMAIN_EVENT,
  NO_CAPABILITIES,
  PARENT_INBOUND_TYPES,
  SECTION_PRESENTED,
  makeEnvelope,
  validateEnvelope,
  type AnySimEnvelope,
  type ValidateContext,
} from 'shared/src/sim/runtimeProtocol';

// ── the world these tests run in ──────────────────────────────────────────────────────────────

const SESSION = newPlayerSessionId();
const PACKAGE = derivePackageRevision('11111111-2222-3333-4444-555555555555', 'bridge_hash_v1');

/** Section A's configuration. */
const CONFIG_A: SimPresentationConfig = {
  ...DEFAULT_PRESENTATION_CONFIG,
  simpleUi: true,
  hideSelectors: ['#hud', '.controls button'],
  quality: 'balanced',
};

/**
 * The SAME configuration, rebuilt independently with the selectors in a different order. Using a
 * second object rather than reusing `CONFIG_A` means the hash equality below is DERIVED — if
 * canonicalisation ever stopped treating `hideSelectors` as a set, the A → B → A test would stop
 * testing the activation axis and start testing a copied string, and this construction is what
 * prevents that from going unnoticed.
 */
const CONFIG_A_AGAIN: SimPresentationConfig = {
  ...DEFAULT_PRESENTATION_CONFIG,
  quality: 'balanced',
  hideSelectors: ['.controls button', '#hud'],
  simpleUi: true,
};

const CONFIG_B: SimPresentationConfig = { ...DEFAULT_PRESENTATION_CONFIG, quality: 'low' };

const identity = (over: Partial<PresentationIdentity> & { documentId: string; activationId: string; variantKey: string; configHash: string }): PresentationIdentity => ({
  packageRevision: PACKAGE,
  ...over,
});

/** Bring a document up to DOCUMENT_READY. */
function readyDocument(documentId: string): DocumentMachineState {
  return [
    { type: 'QUEUE' as const },
    { type: 'MOUNT' as const, documentId },
    { type: 'READY' as const, capabilities: { ...NO_CAPABILITIES, activationScoped: true, onDemandRender: true } },
  ].reduce(documentReducer, initialDocumentState(documentId));
}

function transportCtx(doc: DocumentMachineState, lastSeq: number): ValidateContext {
  return {
    playerSessionId: SESSION,
    documentId: doc.documentId!,
    tombstonedDocumentIds: new Set(doc.tombstoned),
    lastSeq,
    allowedTypes: PARENT_INBOUND_TYPES,
  };
}

/** The SECTION_PRESENTED an activation's child would send. */
function presentedEnvelope(id: PresentationIdentity, seq: number, framesSubmitted = 1): AnySimEnvelope {
  return makeEnvelope(
    SECTION_PRESENTED,
    {
      playerSessionId: SESSION,
      packageRevision: id.packageRevision,
      documentId: id.documentId,
      activationId: id.activationId,
      variantKey: id.variantKey,
      configHash: id.configHash,
    },
    seq,
    { variantKey: id.variantKey, configHash: id.configHash, framesSubmitted, canvas: { width: 1280, height: 720 } },
  );
}

const envelopeIdentity = (env: AnySimEnvelope): PresentationIdentity => ({
  packageRevision: env.packageRevision,
  documentId: env.documentId,
  activationId: env.activationId!,
  variantKey: env.variantKey!,
  configHash: env.configHash!,
});

/**
 * What the parent actually does with an inbound acknowledgement: verify the envelope's identity
 * against the CURRENT intent first, and only then let it become a state-machine event. The reducer
 * itself trusts its caller (its `PRESENTED` case records `prev.identity`), so this gate is where a
 * stale acknowledgement dies — and `mayReveal` re-verifies afterwards regardless, which is what
 * makes the guarantee survive a caller that forgets.
 */
function deliverPresented(
  machine: ActivationMachineState,
  env: AnySimEnvelope,
  current: PresentationIdentity,
): { machine: ActivationMachineState; dropped: RevealRefusal | null } {
  const refusal = identityRefusal(envelopeIdentity(env), current);
  if (refusal) return { machine, dropped: refusal };
  // The ENVELOPE's identity goes into the machine, never the machine's own. That is what makes
  // `mayReveal` an independent second check rather than a comparison of an object with itself.
  return {
    machine: activationReducer(machine, { type: 'PRESENTED', ackIdentity: envelopeIdentity(env) }),
    dropped: null,
  };
}

/** Everything a token-shaped protocol could compare: the four axes that are NOT the activation. */
function tokenProtocolWouldMatch(a: PresentationIdentity, b: PresentationIdentity): boolean {
  return (
    a.packageRevision === b.packageRevision &&
    a.documentId === b.documentId &&
    a.variantKey === b.variantKey &&
    a.configHash === b.configHash
  );
}

// ── A → B → A, the case the token protocol cannot decide ──────────────────────────────────────

describe('A → B → A: two activations of the same section, differing only in activationId', () => {
  const doc = readyDocument(newDocumentId());
  const docId = doc.documentId!;

  const idA1 = identity({ documentId: docId, activationId: newActivationId(), variantKey: 'section-A', configHash: computeConfigHash(CONFIG_A) });
  const idB = identity({ documentId: docId, activationId: newActivationId(), variantKey: 'section-B', configHash: computeConfigHash(CONFIG_B) });
  const idA2 = identity({ documentId: docId, activationId: newActivationId(), variantKey: 'section-A', configHash: computeConfigHash(CONFIG_A_AGAIN) });

  it('is built from two activations that agree on every axis except the activation id', () => {
    expect(idA2.packageRevision).toBe(idA1.packageRevision);
    expect(idA2.documentId).toBe(idA1.documentId);
    expect(idA2.variantKey).toBe(idA1.variantKey);
    // Derived, not copied — the two configs were built independently with reordered selectors.
    expect(idA2.configHash).toBe(idA1.configHash);
    expect(idA2.activationId).not.toBe(idA1.activationId);
  });

  it('would be judged IDENTICAL by a token-shaped comparison', () => {
    // This is the whole argument for the activation axis. Everything a token protocol can see about
    // these two entries is the same, so it must either reveal the stale frame or reveal nothing.
    expect(tokenProtocolWouldMatch(idA1, idA2)).toBe(true);
  });

  it('refuses the first A activation\'s acknowledgement for the second with activation-mismatch', () => {
    expect(identityRefusal(idA1, idA2)).toBe('activation-mismatch');
    expect(identityMatches(idA1, idA2)).toBe(false);
    // And symmetrically — neither direction may borrow the other's proof.
    expect(identityRefusal(idA2, idA1)).toBe('activation-mismatch');
  });

  it('refuses the reveal when the surface still holds the first A activation\'s machine', () => {
    // The realistic shape in a resident pool: A1's machine is genuinely PRESENTED (its child really
    // did submit a frame), the compositor asks whether it may be shown, and by then the intent has
    // moved to A2. Nothing about A1's machine is corrupt — it is simply about a different entry.
    const a1 = [
      { type: 'PREPARE' as const }, { type: 'APPLIED' as const },
      { type: 'PRESENT' as const }, { type: 'PRESENTED' as const, ackIdentity: idA1 },
    ].reduce(activationReducer, initialActivationState(idA1));

    expect(a1.state).toBe('PRESENTED');
    expect(a1.presentedBy).toEqual(idA1);
    expect(mayReveal({ activation: a1, current: idA1, documentReady: true, contextLost: false }))
      .toEqual({ allowed: true });
    expect(mayReveal({ activation: a1, current: idA2, documentReady: true, contextLost: false }))
      .toEqual({ allowed: false, refusal: 'activation-mismatch' });
  });

  it('drops the first A activation\'s SECTION_PRESENTED at the gate during the second A activation', () => {
    // The envelope is perfectly well-formed and comes from the live document on the live session —
    // the transport has no grounds to reject it, which is exactly why the identity gate exists.
    const stale = presentedEnvelope(idA1, 7);
    const accepted = validateEnvelope(stale, transportCtx(doc, 6));
    expect(accepted.ok).toBe(true);

    const a2 = [{ type: 'PREPARE' as const }, { type: 'APPLIED' as const }, { type: 'PRESENT' as const }]
      .reduce(activationReducer, initialActivationState(idA2));
    expect(a2.state).toBe('RENDERING');

    const { machine, dropped } = deliverPresented(a2, stale, idA2);
    expect(dropped).toBe('activation-mismatch');
    expect(machine.state).toBe('RENDERING');
    expect(machine.presentedBy).toBeNull();
    expect(mayReveal({ activation: machine, current: idA2, documentReady: true, contextLost: false }))
      .toEqual({ allowed: false, refusal: 'not-presented' });
  });

  it('reveals A2 only once A2\'s OWN acknowledgement arrives', () => {
    const a2 = [{ type: 'PREPARE' as const }, { type: 'APPLIED' as const }, { type: 'PRESENT' as const }]
      .reduce(activationReducer, initialActivationState(idA2));
    const { machine, dropped } = deliverPresented(a2, presentedEnvelope(idA2, 8), idA2);
    expect(dropped).toBeNull();
    expect(machine.state).toBe('PRESENTED');
    expect(machine.presentedBy).toEqual(idA2);
    expect(mayReveal({ activation: machine, current: idA2, documentReady: true, contextLost: false }))
      .toEqual({ allowed: true });
  });

  it('runs the whole cycle without ever authorising the wrong frame', () => {
    const authorised: string[] = [];
    const record = (label: string, activation: ActivationMachineState, current: PresentationIdentity) => {
      if (mayReveal({ activation, current, documentReady: acceptsCommands(doc), contextLost: doc.contextLost }).allowed) {
        authorised.push(`${label}:${activation.presentedBy?.activationId}`);
      }
    };

    // Enter A.
    let a1 = initialActivationState(idA1);
    for (const type of ['PREPARE', 'APPLIED', 'PRESENT'] as const) a1 = activationReducer(a1, { type });
    record('A1-before-ack', a1, idA1);
    a1 = deliverPresented(a1, presentedEnvelope(idA1, 1), idA1).machine;
    record('A1', a1, idA1);
    a1 = activationReducer(a1, { type: 'ACTIVATE' });

    // Leave A for B. A1 is released; B runs its own activation.
    a1 = activationReducer(a1, { type: 'RELEASE' });
    let b = initialActivationState(idB);
    for (const type of ['PREPARE', 'APPLIED', 'PRESENT'] as const) b = activationReducer(b, { type });
    // A1's acknowledgement, delayed by a slow port, arrives while B is the intent. It differs from
    // B on both the activation and the variant axis; the activation axis is compared first.
    const lateA1 = deliverPresented(b, presentedEnvelope(idA1, 2), idB);
    expect(lateA1.dropped).toBe('activation-mismatch');
    expect(lateA1.machine.state).toBe('RENDERING');
    b = deliverPresented(b, presentedEnvelope(idB, 3), idB).machine;
    record('B', b, idB);
    b = activationReducer(b, { type: 'ACTIVATE' });
    b = activationReducer(b, { type: 'RELEASE' });

    // Return to A. Same section, same configuration, same document, same package — new activation.
    let a2 = initialActivationState(idA2);
    for (const type of ['PREPARE', 'APPLIED', 'PRESENT'] as const) a2 = activationReducer(a2, { type });
    const staleAgain = deliverPresented(a2, presentedEnvelope(idA1, 4), idA2);
    expect(staleAgain.dropped).toBe('activation-mismatch');
    record('A2-with-stale-ack-only', staleAgain.machine, idA2);
    a2 = deliverPresented(a2, presentedEnvelope(idA2, 5), idA2).machine;
    record('A2', a2, idA2);

    // Exactly three reveals were authorised, each by its own activation's acknowledgement.
    expect(authorised).toEqual([
      `A1:${idA1.activationId}`,
      `B:${idB.activationId}`,
      `A2:${idA2.activationId}`,
    ]);
  });
});

// ── same-section re-entry, without a B in between ─────────────────────────────────────────────

describe('same-section re-entry', () => {
  const doc = readyDocument(newDocumentId());
  const base = { documentId: doc.documentId!, variantKey: 'section-A', configHash: computeConfigHash(CONFIG_A) };
  const first = identity({ ...base, activationId: newActivationId() });
  const second = identity({ ...base, activationId: newActivationId() });

  it('mints a new activation for a seek back into the section the user is already in', () => {
    expect(second.activationId).not.toBe(first.activationId);
    expect(tokenProtocolWouldMatch(first, second)).toBe(true);
  });

  it('refuses the previous entry\'s acknowledgement for the new entry', () => {
    expect(identityRefusal(first, second)).toBe('activation-mismatch');
  });

  it('refuses a reveal authorised by the previous entry, even though the picture would be identical', () => {
    // "It looks the same anyway" is not the property being enforced. The previous entry's frame may
    // be arbitrarily old, may have run its automation to a different point, and may have been
    // resized — the invariant is about provenance, not resemblance.
    const stalePresented: ActivationMachineState = {
      state: 'PRESENTED', identity: second, presentedBy: first, error: null, rejected: [],
    };
    expect(mayReveal({ activation: stalePresented, current: second, documentReady: true, contextLost: false }))
      .toEqual({ allowed: false, refusal: 'activation-mismatch' });
  });
});

// ── A → B ─────────────────────────────────────────────────────────────────────────────────────

describe('A → B', () => {
  const doc = readyDocument(newDocumentId());
  const idA = identity({ documentId: doc.documentId!, activationId: newActivationId(), variantKey: 'section-A', configHash: computeConfigHash(CONFIG_A) });
  const idB = identity({ documentId: doc.documentId!, activationId: newActivationId(), variantKey: 'section-B', configHash: computeConfigHash(CONFIG_B) });

  it('refuses A\'s acknowledgement for B with variant-mismatch', () => {
    // The variant axis is checked after the activation axis, so this is only reported as a variant
    // mismatch because the two entries genuinely differ in section — which is the useful diagnosis.
    expect(identityRefusal({ ...idA, activationId: idB.activationId }, idB)).toBe('variant-mismatch');
  });

  it('reports activation-mismatch first when BOTH the activation and the section differ', () => {
    expect(identityRefusal(idA, idB)).toBe('activation-mismatch');
  });

  it('never shows B\'s frame for A\'s intent', () => {
    const b = [
      { type: 'PREPARE' as const }, { type: 'APPLIED' as const },
      { type: 'PRESENT' as const }, { type: 'PRESENTED' as const, ackIdentity: idB },
    ].reduce(activationReducer, initialActivationState(idB));
    expect(mayReveal({ activation: b, current: idA, documentReady: true, contextLost: false }).allowed).toBe(false);
  });
});

// ── every refusal reason, by name ─────────────────────────────────────────────────────────────

const DOC = readyDocument('doc_reasons');
const CURRENT: PresentationIdentity = identity({
  documentId: 'doc_reasons',
  activationId: 'act_current',
  variantKey: 'section-A',
  configHash: computeConfigHash(CONFIG_A),
});

const presentedWith = (ack: PresentationIdentity, state: ActivationMachineState['state'] = 'PRESENTED'): ActivationMachineState =>
  ({ state, identity: CURRENT, presentedBy: ack, error: null, rejected: [] });

interface RefusalCase {
  activation: ActivationMachineState;
  documentReady?: boolean;
  contextLost?: boolean;
  note: string;
}

/** Total over the union — a new refusal reason without a test is a compile error. */
const REFUSALS: Record<RevealRefusal, RefusalCase> = {
  'document-not-ready': {
    activation: presentedWith(CURRENT),
    documentReady: false,
    note: 'a suspended, disposing or unmounted document may not show anything, however good its ack',
  },
  'context-lost': {
    activation: presentedWith(CURRENT),
    contextLost: true,
    note: 'the acknowledged frame no longer exists',
  },
  'not-presented': {
    activation: { state: 'APPLIED', identity: CURRENT, presentedBy: null, error: null, rejected: [] },
    note: 'installed is not drawn — APPLIED is the state a shortcut would reveal from',
  },
  'no-acknowledgement': {
    activation: presentedWith(null as unknown as PresentationIdentity),
    note: 'defensive: a PRESENTED machine with no recorded proof is not reachable through the reducer',
  },
  'package-revision-mismatch': {
    activation: presentedWith({ ...CURRENT, packageRevision: 'rev_previous_publish' }),
    note: 'the package was republished; the ack describes files that are no longer served',
  },
  'document-mismatch': {
    activation: presentedWith({ ...CURRENT, documentId: 'doc_previous_epoch' }),
    note: 'the iframe navigated; the element survived and the document did not',
  },
  'activation-mismatch': {
    activation: presentedWith({ ...CURRENT, activationId: 'act_previous_entry' }),
    note: 'the A → B → A case — every other axis agrees',
  },
  'variant-mismatch': {
    activation: presentedWith({ ...CURRENT, variantKey: 'section-B' }),
    note: 'the child applied a different sub-simulation than it was asked for',
  },
  'config-mismatch': {
    activation: presentedWith({ ...CURRENT, configHash: computeConfigHash(CONFIG_B) }),
    note: 'the child echoed a configuration it was not prepared with',
  },
};

describe('mayReveal — every refusal reason is produced and named', () => {
  for (const [refusal, c] of Object.entries(REFUSALS) as [RevealRefusal, RefusalCase][]) {
    it(`refuses with '${refusal}' (${c.note})`, () => {
      const decision = mayReveal({
        activation: c.activation,
        current: CURRENT,
        documentReady: c.documentReady ?? true,
        contextLost: c.contextLost ?? false,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.allowed === false && decision.refusal).toBe(refusal);
    });
  }

  it('covers every reason in the RevealRefusal union', () => {
    expect(Object.keys(REFUSALS).length).toBe(9);
  });

  it('allows the reveal when — and only when — everything matches', () => {
    expect(mayReveal({ activation: presentedWith(CURRENT), current: CURRENT, documentReady: true, contextLost: false }))
      .toEqual({ allowed: true });
  });
});

describe('mayReveal — which activation states may show at all', () => {
  const SHOWABLE = new Set(['PRESENTED', 'VISIBLE', 'COVERED']);

  it('allows only PRESENTED, VISIBLE and COVERED', () => {
    for (const state of ['IDLE', 'PREPARING', 'APPLIED', 'RENDERING', 'PRESENTED', 'VISIBLE', 'COVERED', 'RELEASED', 'FAILED'] as const) {
      const activation = presentedWith(CURRENT, state);
      const decision = mayReveal({ activation, current: CURRENT, documentReady: true, contextLost: false });
      expect(decision.allowed, `state ${state}`).toBe(SHOWABLE.has(state));
      if (!decision.allowed) expect(decision.refusal, `state ${state}`).toBe('not-presented');
    }
  });

  it('refuses APPLIED specifically, with not-presented', () => {
    // Called out on its own because "it applied, so it must be drawn" is the shortcut that keeps
    // being proposed. APPLIED means the section body ran, not that a frame was submitted.
    const applied = presentedWith(CURRENT, 'APPLIED');
    expect(mayReveal({ activation: applied, current: CURRENT, documentReady: true, contextLost: false }))
      .toEqual({ allowed: false, refusal: 'not-presented' });
  });

  it('refuses RELEASED even though the released machine still remembers its proof', () => {
    const released = presentedWith(CURRENT, 'RELEASED');
    expect(released.presentedBy).toEqual(CURRENT);
    expect(mayReveal({ activation: released, current: CURRENT, documentReady: true, contextLost: false }))
      .toEqual({ allowed: false, refusal: 'not-presented' });
  });
});

// ── ordering ──────────────────────────────────────────────────────────────────────────────────

describe('refusal precedence is deterministic', () => {
  it('reports document-not-ready ahead of every other problem', () => {
    const decision = mayReveal({
      activation: presentedWith({ packageRevision: 'x', documentId: 'y', activationId: 'z', variantKey: 'w', configHash: 'v' }, 'IDLE'),
      current: CURRENT,
      documentReady: false,
      contextLost: true,
    });
    expect(decision).toEqual({ allowed: false, refusal: 'document-not-ready' });
  });

  it('reports context-lost ahead of the activation state and the identity', () => {
    const decision = mayReveal({
      activation: presentedWith({ ...CURRENT, activationId: 'other' }, 'IDLE'),
      current: CURRENT,
      documentReady: true,
      contextLost: true,
    });
    expect(decision).toEqual({ allowed: false, refusal: 'context-lost' });
  });

  it('reports not-presented ahead of an identity mismatch', () => {
    const decision = mayReveal({
      activation: presentedWith({ ...CURRENT, activationId: 'other' }, 'RENDERING'),
      current: CURRENT,
      documentReady: true,
      contextLost: false,
    });
    expect(decision).toEqual({ allowed: false, refusal: 'not-presented' });
  });

  it('reports no-acknowledgement ahead of an identity mismatch', () => {
    const decision = mayReveal({
      activation: { state: 'PRESENTED', identity: CURRENT, presentedBy: null, error: null, rejected: [] },
      current: { ...CURRENT, variantKey: 'section-Z' },
      documentReady: true,
      contextLost: false,
    });
    expect(decision).toEqual({ allowed: false, refusal: 'no-acknowledgement' });
  });

  it('compares the five identity axes in a fixed order', () => {
    const wrongEverything: PresentationIdentity = {
      packageRevision: 'rev_x', documentId: 'doc_x', activationId: 'act_x',
      variantKey: 'var_x', configHash: 'cfg_x',
    };
    expect(identityRefusal(wrongEverything, CURRENT)).toBe('package-revision-mismatch');
    expect(identityRefusal({ ...wrongEverything, packageRevision: CURRENT.packageRevision }, CURRENT))
      .toBe('document-mismatch');
    expect(identityRefusal({ ...wrongEverything, packageRevision: CURRENT.packageRevision, documentId: CURRENT.documentId }, CURRENT))
      .toBe('activation-mismatch');
    expect(identityRefusal({ ...CURRENT, variantKey: 'var_x', configHash: 'cfg_x' }, CURRENT))
      .toBe('variant-mismatch');
    expect(identityRefusal({ ...CURRENT, configHash: 'cfg_x' }, CURRENT)).toBe('config-mismatch');
    expect(identityRefusal(CURRENT, CURRENT)).toBeNull();
  });

  it('treats identity comparison as exact string equality on every axis', () => {
    for (const axis of ['packageRevision', 'documentId', 'activationId', 'variantKey', 'configHash'] as const) {
      const nearMiss = { ...CURRENT, [axis]: `${CURRENT[axis]} ` };
      expect(identityMatches(nearMiss, CURRENT), `${axis} with a trailing space`).toBe(false);
      const upper = { ...CURRENT, [axis]: CURRENT[axis].toUpperCase() };
      if (upper[axis] !== CURRENT[axis]) {
        expect(identityMatches(upper, CURRENT), `${axis} case-folded`).toBe(false);
      }
    }
  });
});

// ── wrong document, wrong package, wrong config ───────────────────────────────────────────────

describe('wrong document ID', () => {
  it('is caught by the transport as tombstoned AND by the identity gate as document-mismatch', () => {
    // Belt and braces on purpose: the transport can only reject epochs it KNOWS are dead, and it
    // learns that from the navigation event, which can arrive after the stale message does.
    const doc = readyDocument('doc_first');
    const navigated = documentReducer(doc, { type: 'NAVIGATE', documentId: 'doc_second' });
    const readyAgain = documentReducer(navigated, { type: 'READY', capabilities: NO_CAPABILITIES });

    const oldIdentity = identity({ documentId: 'doc_first', activationId: 'act_1', variantKey: 'section-A', configHash: 'cfg' });
    const newIdentity = identity({ documentId: 'doc_second', activationId: 'act_2', variantKey: 'section-A', configHash: 'cfg' });

    const stale = presentedEnvelope(oldIdentity, 3);
    const verdict = validateEnvelope(stale, transportCtx(readyAgain, 2));
    expect(verdict.ok === false && verdict.reason).toBe('tombstoned-document');

    expect(identityRefusal({ ...oldIdentity, activationId: newIdentity.activationId }, newIdentity))
      .toBe('document-mismatch');
  });

  it('refuses a reveal proved by a message from the previous document epoch', () => {
    const current = identity({ documentId: 'doc_second', activationId: 'act_2', variantKey: 'section-A', configHash: 'cfg' });
    const activation: ActivationMachineState = {
      state: 'PRESENTED', identity: current,
      presentedBy: { ...current, documentId: 'doc_first' },
      error: null, rejected: [],
    };
    expect(mayReveal({ activation, current, documentReady: true, contextLost: false }))
      .toEqual({ allowed: false, refusal: 'document-mismatch' });
  });
});

describe('wrong package revision', () => {
  it('distinguishes two revisions of the same simulation', () => {
    const before = derivePackageRevision('sim-1', 'bridge_a');
    const after = derivePackageRevision('sim-1', 'bridge_b');
    expect(before).not.toBe(after);
  });

  it('refuses an acknowledgement minted against the pre-republish bytes', () => {
    const current = identity({ documentId: 'doc_1', activationId: 'act_1', variantKey: 'section-A', configHash: 'cfg' });
    const ack = { ...current, packageRevision: derivePackageRevision('sim-1', 'bridge_a') };
    expect(current.packageRevision).not.toBe(ack.packageRevision);
    expect(identityRefusal(ack, current)).toBe('package-revision-mismatch');
  });
});

describe('wrong config hash', () => {
  it('refuses a child that echoes a configuration it was not prepared with', () => {
    // SectionAppliedPayload/SectionPresentedPayload carry the hash the child RECOMPUTED from what it
    // actually installed. A mis-wired child that ignores `simpleUi` reports a different hash and is
    // caught here rather than showing a full-chrome simulation under a Minimal-UI section.
    const asked = computeConfigHash(CONFIG_A);
    const installed = computeConfigHash({ ...CONFIG_A, simpleUi: false });
    expect(installed).not.toBe(asked);

    const current = identity({ documentId: 'doc_1', activationId: 'act_1', variantKey: 'section-A', configHash: asked });
    expect(identityRefusal({ ...current, configHash: installed }, current)).toBe('config-mismatch');
  });

  it('accepts a hash recomputed from an equivalent configuration', () => {
    const current = identity({ documentId: 'doc_1', activationId: 'act_1', variantKey: 'section-A', configHash: computeConfigHash(CONFIG_A) });
    const child = { ...current, configHash: computeConfigHash(CONFIG_A_AGAIN) };
    expect(identityRefusal(child, current)).toBeNull();
  });
});

// ── delayed domain event ──────────────────────────────────────────────────────────────────────

describe('delayed domain event', () => {
  const doc = readyDocument('doc_domain');
  const idA1 = identity({ documentId: 'doc_domain', activationId: 'act_first', variantKey: 'section-A', configHash: 'cfg' });
  const idA2 = identity({ documentId: 'doc_domain', activationId: 'act_second', variantKey: 'section-A', configHash: 'cfg' });

  const domainEvent = (id: PresentationIdentity, seq: number) => makeEnvelope(
    DOMAIN_EVENT,
    {
      playerSessionId: SESSION, packageRevision: id.packageRevision, documentId: id.documentId,
      activationId: id.activationId, variantKey: id.variantKey, configHash: id.configHash,
    },
    seq,
    { event: 'userInteraction', detail: { control: 'murmuration' } },
  );

  it('passes transport validation — it is a real message from a live document', () => {
    expect(validateEnvelope(domainEvent(idA1, 4), transportCtx(doc, 3)).ok).toBe(true);
  });

  it('is attributed to the activation that emitted it, not the one that is current', () => {
    // A domain event is the message most likely to arrive late: it is emitted spontaneously by the
    // package, often from a user gesture that landed just as the section changed. Without the
    // activation axis it would be recorded against whichever entry happens to be current, silently
    // corrupting interaction telemetry and any behaviour keyed off it.
    const late = domainEvent(idA1, 5);
    expect(identityRefusal(envelopeIdentity(late), idA2)).toBe('activation-mismatch');
    expect(identityRefusal(envelopeIdentity(late), idA1)).toBeNull();
  });

  it('cannot authorise a reveal no matter how late it is', () => {
    const a2 = [{ type: 'PREPARE' as const }, { type: 'APPLIED' as const }, { type: 'PRESENT' as const }]
      .reduce(activationReducer, initialActivationState(idA2));
    // There is no DOMAIN_EVENT edge in the activation machine at all; the only way a domain event
    // could move the machine is if a surface translated it into one, and it has nothing to translate
    // it into.
    expect(mayReveal({ activation: a2, current: idA2, documentReady: true, contextLost: false }))
      .toEqual({ allowed: false, refusal: 'not-presented' });
  });
});

// ── context loss and document readiness, end to end ───────────────────────────────────────────

describe('context loss and document state gate the reveal together', () => {
  const docId = 'doc_gate';
  const id = identity({ documentId: docId, activationId: 'act_1', variantKey: 'section-A', configHash: 'cfg' });

  const presentedActivation = (): ActivationMachineState => [
    { type: 'PREPARE' as const }, { type: 'APPLIED' as const },
    { type: 'PRESENT' as const }, { type: 'PRESENTED' as const, ackIdentity: id },
  ].reduce(activationReducer, initialActivationState(id));

  it('refuses while the document is suspended, and allows again after it resumes', () => {
    let doc = readyDocument(docId);
    const activation = presentedActivation();
    const ask = () => mayReveal({ activation, current: id, documentReady: acceptsCommands(doc), contextLost: doc.contextLost });

    expect(ask()).toEqual({ allowed: true });

    doc = documentReducer(doc, { type: 'SUSPEND' });
    expect(ask()).toEqual({ allowed: true });   // requested, not confirmed — still live

    doc = documentReducer(doc, { type: 'SUSPENDED' });
    expect(ask()).toEqual({ allowed: false, refusal: 'document-not-ready' });

    doc = documentReducer(doc, { type: 'RESUMED' });
    expect(ask()).toEqual({ allowed: true });
  });

  it('refuses on context loss, and requires a NEW acknowledgement afterwards', () => {
    let doc = documentReducer(readyDocument(docId), { type: 'CONTEXT_LOST' });
    let activation = presentedActivation();

    expect(mayReveal({ activation, current: id, documentReady: acceptsCommands(doc), contextLost: doc.contextLost }))
      .toEqual({ allowed: false, refusal: 'context-lost' });

    // Restoring the document is not enough: the frame that was acknowledged is gone with it.
    doc = documentReducer(doc, { type: 'CONTEXT_RESTORED' });
    activation = activationReducer(activation, { type: 'CONTEXT_LOST' });
    expect(activation.state).toBe('RENDERING');
    expect(mayReveal({ activation, current: id, documentReady: acceptsCommands(doc), contextLost: doc.contextLost }))
      .toEqual({ allowed: false, refusal: 'not-presented' });

    activation = activationReducer(activation, { type: 'PRESENTED', ackIdentity: activation.identity });
    expect(mayReveal({ activation, current: id, documentReady: acceptsCommands(doc), contextLost: doc.contextLost }))
      .toEqual({ allowed: true });
  });

  it('refuses once the document is disposed, however healthy the activation looks', () => {
    const doc = [{ type: 'DISPOSE' as const }, { type: 'DISPOSED' as const }].reduce(documentReducer, readyDocument(docId));
    expect(doc.state).toBe('EVICTED');
    const activation = presentedActivation();
    expect(mayReveal({ activation, current: id, documentReady: acceptsCommands(doc), contextLost: doc.contextLost }))
      .toEqual({ allowed: false, refusal: 'document-not-ready' });
  });
});

// ── transport closure ─────────────────────────────────────────────────────────────────────────

describe('transport closure', () => {
  it('leaves the activation unrevealable — a closed port produces no acknowledgement', () => {
    // Closure is not an event the machines model; it is the ABSENCE of the acknowledgement they
    // require. The invariant handles it by construction: nothing arrives, nothing is proved,
    // nothing is shown, and the failure policy bounds the wait.
    const id = identity({ documentId: 'doc_closed', activationId: 'act_1', variantKey: 'section-A', configHash: 'cfg' });
    const activation = [{ type: 'PREPARE' as const }, { type: 'APPLIED' as const }, { type: 'PRESENT' as const }]
      .reduce(activationReducer, initialActivationState(id));
    expect(mayReveal({ activation, current: id, documentReady: true, contextLost: false }))
      .toEqual({ allowed: false, refusal: 'not-presented' });
  });

  it('rejects a message that arrives after the document was torn down', () => {
    const doc = [{ type: 'DISPOSE' as const }, { type: 'DISPOSED' as const }].reduce(documentReducer, readyDocument('doc_closed'));
    const id = identity({ documentId: 'doc_closed', activationId: 'act_1', variantKey: 'section-A', configHash: 'cfg' });
    const verdict = validateEnvelope(presentedEnvelope(id, 9), transportCtx(doc, 8));
    expect(verdict.ok === false && verdict.reason).toBe('tombstoned-document');
  });
});

// ── out-of-order and duplicate acknowledgements, at the invariant level ───────────────────────

describe('out-of-order and duplicate acknowledgements', () => {
  const doc = readyDocument('doc_seq');
  const id = identity({ documentId: 'doc_seq', activationId: 'act_1', variantKey: 'section-A', configHash: 'cfg' });

  it('rejects a replayed acknowledgement at the transport before it can reach the machine', () => {
    const env = presentedEnvelope(id, 5);
    expect(validateEnvelope(env, transportCtx(doc, 4)).ok).toBe(true);
    const replay = validateEnvelope(env, transportCtx(doc, 5));
    expect(replay.ok === false && replay.reason).toBe('duplicate-seq');
  });

  it('rejects a reordered acknowledgement', () => {
    const out = validateEnvelope(presentedEnvelope(id, 2), transportCtx(doc, 6));
    expect(out.ok === false && out.reason).toBe('out-of-order-seq');
  });

  it('does not change the reveal decision when a duplicate is let through anyway', () => {
    // Defence in depth: even if a duplicate reached the machine, the second one is refused by the
    // transition table and the recorded proof is unchanged, so the decision is identical.
    let activation = [
      { type: 'PREPARE' as const }, { type: 'APPLIED' as const },
      { type: 'PRESENT' as const }, { type: 'PRESENTED' as const, ackIdentity: id },
    ].reduce(activationReducer, initialActivationState(id));
    const before = mayReveal({ activation, current: id, documentReady: true, contextLost: false });
    activation = activationReducer(activation, { type: 'PRESENTED', ackIdentity: activation.identity });
    const after = mayReveal({ activation, current: id, documentReady: true, contextLost: false });
    expect(after).toEqual(before);
    expect(after).toEqual({ allowed: true });
  });
});
