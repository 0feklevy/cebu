/**
 * Envelope validation for the activation-scoped simulation protocol (v3).
 *
 * WHY THIS SUITE LIVES IN client-web/__tests__ AND NOT IN shared/
 * The `shared` package has no test runner of its own — it is a types-and-pure-functions package
 * compiled by `tsc` and consumed by both `client-web` and `backend-api`. client-web's vitest project
 * already resolves the `shared/src/*` export map (see vitest.config.ts + the `shared` file: link in
 * package.json), so the protocol core's acceptance tests are hosted here. They import ONLY from
 * `shared/src/sim/*` and touch no browser API, so they are pure unit tests that happen to run in a
 * jsdom worker. The sibling files simDocumentMachine / simActivationMachine / simRevealInvariant /
 * simFailurePolicy / simIdentityHash / sha256 are the rest of the same suite.
 *
 * WHAT IS BEING DEFENDED
 * `validateEnvelope` is the boundary between "bytes that arrived on a port" and "an event the state
 * machines will act on". Every reason it can return is produced here by a purpose-built message and
 * asserted BY NAME — a test that merely asserts `ok === false` would pass even if the validator
 * rejected everything for the wrong reason, which is indistinguishable from the validator being the
 * bug.
 */
import { describe, it, expect } from 'vitest';
import {
  ACTIVATE_SECTION,
  ACTIVATION_SCOPED_TYPES,
  AUTOMATION_PAUSED,
  AUTOMATION_RESUMED,
  CHILD_INBOUND_TYPES,
  CONTEXT_LOST,
  CONTEXT_RESTORED,
  DISPOSE_DOCUMENT,
  DISPOSED,
  DOCUMENT_ERROR,
  DOCUMENT_READY,
  DOCUMENT_RESUMED,
  DOCUMENT_SUSPENDED,
  DOMAIN_EVENT,
  INIT_DOCUMENT,
  PARENT_INBOUND_TYPES,
  PAUSE_AUTOMATION,
  POLICY_APPLIED,
  POLICY_REFUSED,
  PREPARE_SECTION,
  PRESENT_SECTION,
  QUALITY_APPLIED,
  RELEASE_SECTION,
  RESUME_AUTOMATION,
  RESUME_DOCUMENT,
  SECTION_APPLIED,
  SECTION_ERROR,
  SECTION_PRESENTED,
  SECTION_RELEASED,
  SET_AUDIBLE,
  SET_AUTOMATION_POLICY,
  SET_QUALITY,
  SET_UI_POLICY,
  SIM_BOOTSTRAP_ACCEPT_KIND,
  SIM_BOOTSTRAP_KIND,
  SIM_BOOTSTRAP_TIMEOUT_MS,
  SIM_PROTOCOL_NAMESPACE,
  SIM_PROTOCOL_VERSION,
  SUSPEND_DOCUMENT,
  isBootstrapAccept,
  isBootstrapOffer,
  makeEnvelope,
  validateEnvelope,
  type EnvelopeRejectReason,
  type ValidateContext,
} from 'shared/src/sim/runtimeProtocol';

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────

const SESSION = 'ps_test_session';
const REVISION = 'rev_aaaaaaaaaaaa';
const DOC = 'doc_epoch_1';
const ACT = 'act_1';
const VARIANT = 'section-a';
const CONFIG = 'cfg0123456789ab';

function ctx(over: Partial<ValidateContext> = {}): ValidateContext {
  return {
    playerSessionId: SESSION,
    documentId: DOC,
    lastSeq: 0,
    allowedTypes: PARENT_INBOUND_TYPES,
    ...over,
  };
}

/** A well-formed, document-scope inbound envelope. Every rejection case is a mutation of this. */
function goodDocEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    namespace: SIM_PROTOCOL_NAMESPACE,
    protocolVersion: SIM_PROTOCOL_VERSION,
    type: DOCUMENT_READY,
    playerSessionId: SESSION,
    packageRevision: REVISION,
    documentId: DOC,
    seq: 1,
    payload: { capabilities: null, variants: [] },
    ...over,
  };
}

/** A well-formed, activation-scope inbound envelope. */
function goodActEnvelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...goodDocEnvelope(),
    type: SECTION_PRESENTED,
    activationId: ACT,
    variantKey: VARIANT,
    configHash: CONFIG,
    payload: { variantKey: VARIANT, configHash: CONFIG, framesSubmitted: 1 },
    ...over,
  };
}

const reasonOf = (raw: unknown, c: ValidateContext = ctx()): EnvelopeRejectReason | 'ACCEPTED' => {
  const r = validateEnvelope(raw, c);
  return r.ok ? 'ACCEPTED' : r.reason;
};

// ── acceptance ────────────────────────────────────────────────────────────────────────────────

describe('validateEnvelope — the messages it must accept', () => {
  it('accepts a well-formed document-scope envelope', () => {
    const r = validateEnvelope(goodDocEnvelope(), ctx());
    expect(r.ok).toBe(true);
  });

  it('accepts a well-formed activation-scope envelope', () => {
    const r = validateEnvelope(goodActEnvelope(), ctx());
    expect(r.ok).toBe(true);
  });

  it('does NOT require activation identity on document-scope messages', () => {
    // A DOCUMENT_READY has no activation — demanding one would make the handshake impossible.
    for (const type of [DOCUMENT_READY, DOCUMENT_SUSPENDED, DOCUMENT_RESUMED, QUALITY_APPLIED, DISPOSED, CONTEXT_LOST, CONTEXT_RESTORED, DOCUMENT_ERROR]) {
      expect(reasonOf(goodDocEnvelope({ type }))).toBe('ACCEPTED');
    }
  });

  it('accepts a strictly increasing sequence on one transport', () => {
    expect(reasonOf(goodDocEnvelope({ seq: 1 }), ctx({ lastSeq: 0 }))).toBe('ACCEPTED');
    expect(reasonOf(goodDocEnvelope({ seq: 2 }), ctx({ lastSeq: 1 }))).toBe('ACCEPTED');
    expect(reasonOf(goodDocEnvelope({ seq: 3 }), ctx({ lastSeq: 2 }))).toBe('ACCEPTED');
  });

  it('accepts a FORWARD gap in the sequence', () => {
    // Deliberate: a closing port can drop messages, and refusing the survivor would strand the
    // transport forever on a number that will never arrive. Only replays and reorderings are fatal.
    expect(reasonOf(goodDocEnvelope({ seq: 9 }), ctx({ lastSeq: 2 }))).toBe('ACCEPTED');
  });

  it('accepts a message whose documentId is tombstoned ONLY IF it is not in the tombstone set', () => {
    const tombstoned = new Set<string>(['doc_epoch_0']);
    expect(reasonOf(goodDocEnvelope(), ctx({ tombstonedDocumentIds: tombstoned }))).toBe('ACCEPTED');
  });
});

// ── every rejection reason, by name ───────────────────────────────────────────────────────────

interface RejectCase {
  raw: unknown;
  ctx?: Partial<ValidateContext>;
  /** Why this input produces this reason and not the neighbouring one. */
  note: string;
}

/**
 * Typed as a total Record over the union, so adding a new `EnvelopeRejectReason` without a case
 * here is a COMPILE error rather than an untested rejection path.
 */
const REJECTIONS: Record<EnvelopeRejectReason, RejectCase> = {
  'not-an-object': {
    raw: 'flowvid.sim',
    note: 'a string, a number, null and an array are all not-an-object',
  },
  'wrong-namespace': {
    raw: { ...goodDocEnvelope(), namespace: 'someone.else' },
    note: 'checked first so foreign traffic on the page never produces a field complaint',
  },
  'wrong-protocol-version': {
    raw: { ...goodDocEnvelope(), protocolVersion: SIM_PROTOCOL_VERSION + 1 },
    note: 'a partially-understood protocol must be refused, never guessed at',
  },
  'missing-type': {
    raw: { ...goodDocEnvelope(), type: '' },
    note: 'empty string is missing, not a type named ""',
  },
  'unknown-type': {
    raw: { ...goodDocEnvelope(), type: 'SIM_READY' },
    note: 'a type outside this direction\'s allow-list',
  },
  'missing-player-session': {
    raw: { ...goodDocEnvelope(), playerSessionId: '' },
    note: 'absent or empty session id',
  },
  'wrong-player-session': {
    raw: { ...goodDocEnvelope(), playerSessionId: 'ps_someone_else' },
    note: 'present but belonging to another player on the same page',
  },
  'missing-package-revision': {
    raw: { ...goodDocEnvelope(), packageRevision: '' },
    note: 'a message that cannot say which package bytes produced it',
  },
  'missing-document-id': {
    raw: { ...goodDocEnvelope(), documentId: '' },
    note: 'no epoch at all',
  },
  'unknown-document': {
    raw: { ...goodDocEnvelope(), documentId: 'doc_never_seen' },
    note: 'a live-looking epoch this transport is not bound to',
  },
  'tombstoned-document': {
    raw: { ...goodDocEnvelope(), documentId: 'doc_epoch_0' },
    ctx: { tombstonedDocumentIds: new Set<string>(['doc_epoch_0']) },
    note: 'a dead epoch is rejected for BEING dead, before any other complaint',
  },
  'missing-activation-id': {
    raw: (() => { const e = goodActEnvelope(); delete e.activationId; return e; })(),
    note: 'activation-scoped type without the axis that makes A→B→A safe',
  },
  'missing-variant-key': {
    raw: (() => { const e = goodActEnvelope(); delete e.variantKey; return e; })(),
    note: 'activation-scoped type that cannot say which sub-simulation it means',
  },
  'missing-config-hash': {
    raw: (() => { const e = goodActEnvelope(); delete e.configHash; return e; })(),
    note: 'activation-scoped type that cannot say which picture it produced',
  },
  'bad-seq': {
    raw: { ...goodDocEnvelope(), seq: 0 },
    note: 'sequence numbers start at 1; 0, negatives, fractions and non-numbers are all bad',
  },
  'duplicate-seq': {
    raw: { ...goodDocEnvelope(), seq: 4 },
    ctx: { lastSeq: 4 },
    note: 'exactly the last accepted number — a replay',
  },
  'out-of-order-seq': {
    raw: { ...goodDocEnvelope(), seq: 3 },
    ctx: { lastSeq: 7 },
    note: 'older than the last accepted number — a reordering',
  },
  'malformed-payload': {
    raw: { ...goodDocEnvelope(), payload: null },
    note: 'every payload is an object; null/array/scalar is malformed',
  },
};

describe('validateEnvelope — every rejection reason is produced and named', () => {
  for (const [reason, c] of Object.entries(REJECTIONS) as [EnvelopeRejectReason, RejectCase][]) {
    it(`rejects with reason '${reason}' (${c.note})`, () => {
      const result = validateEnvelope(c.raw, ctx(c.ctx));
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe(reason);
    });
  }

  it('covers every reason in the EnvelopeRejectReason union', () => {
    // Record<EnvelopeRejectReason, …> already enforces this at compile time; the runtime assertion
    // catches the other direction — a case table that grew a key the union no longer has.
    expect(Object.keys(REJECTIONS).length).toBe(18);
  });
});

describe('validateEnvelope — not-an-object covers every non-object shape', () => {
  for (const raw of [null, undefined, 'x', 42, true, Symbol('s'), [], [goodDocEnvelope()], () => {}]) {
    it(`rejects ${String(typeof raw === 'symbol' ? 'symbol' : JSON.stringify(raw) ?? typeof raw)} as not-an-object`, () => {
      expect(reasonOf(raw)).toBe('not-an-object');
    });
  }
});

describe('validateEnvelope — bad-seq covers every non-positive-integer', () => {
  for (const seq of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', null, undefined]) {
    it(`rejects seq=${String(seq)} as bad-seq`, () => {
      expect(reasonOf(goodDocEnvelope({ seq }))).toBe('bad-seq');
    });
  }
});

describe('validateEnvelope — malformed-payload covers every non-object payload', () => {
  for (const payload of [null, undefined, 'x', 0, false, [], [1, 2]]) {
    it(`rejects payload=${JSON.stringify(payload) ?? String(payload)} as malformed-payload`, () => {
      expect(reasonOf(goodDocEnvelope({ payload }))).toBe('malformed-payload');
    });
  }
});

// ── ordering: the reason must be the USEFUL one ───────────────────────────────────────────────

describe('validateEnvelope — rejection ordering is deliberate', () => {
  it('reports wrong-namespace before any missing field, even when nothing else is present', () => {
    expect(reasonOf({ namespace: 'other.lib' })).toBe('wrong-namespace');
  });

  it('reports wrong-protocol-version before an unknown type', () => {
    expect(reasonOf({ ...goodDocEnvelope(), protocolVersion: 99, type: 'NOT_A_TYPE' }))
      .toBe('wrong-protocol-version');
  });

  it('reports unknown-type before a wrong session', () => {
    expect(reasonOf({ ...goodDocEnvelope(), type: 'NOT_A_TYPE', playerSessionId: 'ps_other' }))
      .toBe('unknown-type');
  });

  it('reports tombstoned-document before out-of-order-seq', () => {
    // A message from a dead epoch must be rejected for being dead. Calling it "out of order" would
    // be true and useless: the operator would go looking for a transport bug that does not exist.
    const raw = { ...goodDocEnvelope(), documentId: 'doc_epoch_0', seq: 1 };
    const c = ctx({ lastSeq: 50, tombstonedDocumentIds: new Set<string>(['doc_epoch_0']) });
    expect(reasonOf(raw, c)).toBe('tombstoned-document');
  });

  it('reports tombstoned-document before unknown-document', () => {
    const raw = { ...goodDocEnvelope(), documentId: 'doc_epoch_0' };
    const c = ctx({ tombstonedDocumentIds: new Set<string>(['doc_epoch_0']) });
    expect(reasonOf(raw, c)).toBe('tombstoned-document');
  });

  it('reports missing-activation-id before bad-seq', () => {
    const raw = (() => { const e = goodActEnvelope({ seq: -3 }); delete e.activationId; return e; })();
    expect(reasonOf(raw)).toBe('missing-activation-id');
  });

  it('reports the identity fields in a fixed order: activation, then variant, then config', () => {
    const stripped = (() => {
      const e = goodActEnvelope();
      delete e.activationId; delete e.variantKey; delete e.configHash;
      return e;
    })();
    expect(reasonOf(stripped)).toBe('missing-activation-id');
    expect(reasonOf({ ...stripped, activationId: ACT })).toBe('missing-variant-key');
    expect(reasonOf({ ...stripped, activationId: ACT, variantKey: VARIANT })).toBe('missing-config-hash');
  });
});

// ── direction separation and the reflection trick ─────────────────────────────────────────────

describe('validateEnvelope — direction allow-lists', () => {
  it('refuses a parent→child COMMAND echoed back to the parent', () => {
    // The reflection trick: a child that replays the command it was sent, hoping it reads as an
    // acknowledgement. There is no shared type between the directions, so it cannot.
    for (const type of [PREPARE_SECTION, PRESENT_SECTION, ACTIVATE_SECTION, RELEASE_SECTION, INIT_DOCUMENT, DISPOSE_DOCUMENT]) {
      expect(reasonOf(goodActEnvelope({ type }))).toBe('unknown-type');
    }
  });

  it('refuses a child→parent ACKNOWLEDGEMENT delivered to the child', () => {
    const childCtx = ctx({ allowedTypes: CHILD_INBOUND_TYPES });
    for (const type of [SECTION_PRESENTED, SECTION_APPLIED, DOCUMENT_READY, DISPOSED, DOMAIN_EVENT]) {
      expect(reasonOf(goodActEnvelope({ type }), childCtx)).toBe('unknown-type');
    }
  });

  it('has no type in both direction allow-lists', () => {
    const overlap = [...PARENT_INBOUND_TYPES].filter((t) => CHILD_INBOUND_TYPES.has(t));
    expect(overlap).toEqual([]);
  });

  it('lists exactly the inbound types the parent can receive', () => {
    expect([...PARENT_INBOUND_TYPES].sort()).toEqual([
      AUTOMATION_PAUSED, AUTOMATION_RESUMED, CONTEXT_LOST, CONTEXT_RESTORED, DISPOSED,
      DOCUMENT_ERROR, DOCUMENT_READY, DOCUMENT_RESUMED, DOCUMENT_SUSPENDED, DOMAIN_EVENT,
      // P1.2: the two answers a package gives to a policy request. POLICY_REFUSED is the one that
      // makes the restart fallback observable rather than something inferred from a screenshot.
      POLICY_APPLIED, POLICY_REFUSED,
      QUALITY_APPLIED, SECTION_APPLIED, SECTION_ERROR, SECTION_PRESENTED, SECTION_RELEASED,
    ].sort());
  });

  it('lists exactly the inbound types the child can receive', () => {
    expect([...CHILD_INBOUND_TYPES].sort()).toEqual([
      ACTIVATE_SECTION, DISPOSE_DOCUMENT, INIT_DOCUMENT, PAUSE_AUTOMATION, PREPARE_SECTION,
      PRESENT_SECTION, RELEASE_SECTION, RESUME_AUTOMATION, RESUME_DOCUMENT, SET_AUDIBLE,
      // P1.2: the two activation-scoped commands that deliberately leave the activation where they
      // found it — chrome and automation change, the body is never re-run.
      SET_AUTOMATION_POLICY, SET_UI_POLICY,
      SET_QUALITY, SUSPEND_DOCUMENT,
    ].sort());
  });

  it('rejects the v2 wire format outright — legacy traffic can never be read as v3', () => {
    // The shipped v2 protocol posts bare objects to '*'. None of them carry the namespace, so a v2
    // SIM_READY can not authorise anything on the v3 path even if it reaches the same listener.
    expect(reasonOf({ type: 'SIM_READY', token: 1 })).toBe('wrong-namespace');
    expect(reasonOf({ type: 'SCRIPT_APPLIED', token: 7, section: 'a' })).toBe('wrong-namespace');
    expect(reasonOf({ type: 'SIM_PAINTED' })).toBe('wrong-namespace');
  });
});

describe('ACTIVATION_SCOPED_TYPES — every member is held to the identity requirement', () => {
  it('requires activationId, variantKey and configHash on EVERY activation-scoped type', () => {
    const bothDirections = new Set<string>([...PARENT_INBOUND_TYPES, ...CHILD_INBOUND_TYPES]);
    for (const type of ACTIVATION_SCOPED_TYPES) {
      const allowed = PARENT_INBOUND_TYPES.has(type) ? PARENT_INBOUND_TYPES : CHILD_INBOUND_TYPES;
      expect(bothDirections.has(type)).toBe(true);
      const base = goodActEnvelope({ type });
      for (const field of ['activationId', 'variantKey', 'configHash'] as const) {
        const raw = { ...base };
        delete raw[field];
        const r = validateEnvelope(raw, ctx({ allowedTypes: allowed }));
        expect(r.ok, `${type} without ${field} must be rejected`).toBe(false);
        expect(r.ok === false && r.reason).toMatch(/^missing-(activation-id|variant-key|config-hash)$/);
      }
    }
  });

  it('holds DOMAIN_EVENT to the same identity requirement as an acknowledgement', () => {
    // A domain event is the one message a package emits spontaneously and late. Without activation
    // identity a delayed event from a previous entry would be attributed to the current one.
    const raw = (() => { const e = goodActEnvelope({ type: DOMAIN_EVENT }); delete e.activationId; return e; })();
    expect(reasonOf(raw)).toBe('missing-activation-id');
  });
});

// ── construction ──────────────────────────────────────────────────────────────────────────────

describe('makeEnvelope', () => {
  const identity = { playerSessionId: SESSION, packageRevision: REVISION, documentId: DOC };

  it('stamps the namespace and protocol version', () => {
    const env = makeEnvelope(DOCUMENT_READY, identity, 1, { capabilities: null, variants: [] });
    expect(env.namespace).toBe(SIM_PROTOCOL_NAMESPACE);
    expect(env.protocolVersion).toBe(SIM_PROTOCOL_VERSION);
    expect(env.seq).toBe(1);
  });

  it('does NOT create own properties for absent optional identity fields', () => {
    // structuredClone preserves an explicit `activationId: undefined` as an own property, and a
    // future validator written with `in` rather than a truthiness check would then see a field that
    // is present and empty. Never creating the key removes the hazard at the source.
    const env = makeEnvelope(DOCUMENT_READY, identity, 1, {});
    expect('activationId' in env).toBe(false);
    expect('variantKey' in env).toBe(false);
    expect('configHash' in env).toBe(false);
  });

  it('sets the optional identity fields when they are supplied', () => {
    const env = makeEnvelope(
      SECTION_PRESENTED,
      { ...identity, activationId: ACT, variantKey: VARIANT, configHash: CONFIG },
      2,
      { variantKey: VARIANT, configHash: CONFIG, framesSubmitted: 1 },
    );
    expect(env.activationId).toBe(ACT);
    expect(env.variantKey).toBe(VARIANT);
    expect(env.configHash).toBe(CONFIG);
  });

  it('produces envelopes that survive structuredClone and still validate', () => {
    const env = makeEnvelope(
      SECTION_PRESENTED,
      { ...identity, activationId: ACT, variantKey: VARIANT, configHash: CONFIG },
      1,
      { variantKey: VARIANT, configHash: CONFIG, framesSubmitted: 1 },
    );
    const cloned = structuredClone(env);
    expect(validateEnvelope(cloned, ctx()).ok).toBe(true);
    expect('activationId' in cloned).toBe(true);
  });

  it('round-trips through validateEnvelope for every parent-inbound type', () => {
    let seq = 0;
    for (const type of PARENT_INBOUND_TYPES) {
      seq += 1;
      const needsIdentity = ACTIVATION_SCOPED_TYPES.has(type);
      const env = makeEnvelope(
        type,
        needsIdentity ? { ...identity, activationId: ACT, variantKey: VARIANT, configHash: CONFIG } : identity,
        seq,
        { ok: true },
      );
      const r = validateEnvelope(env, ctx({ lastSeq: seq - 1 }));
      expect(r.ok, `${type} should round-trip`).toBe(true);
    }
  });
});

// ── bootstrap (the one message not on the port) ───────────────────────────────────────────────

describe('bootstrap offer/accept guards', () => {
  const offer = {
    kind: SIM_BOOTSTRAP_KIND,
    protocolVersion: SIM_PROTOCOL_VERSION,
    playerSessionId: SESSION,
    packageRevision: REVISION,
    documentId: DOC,
    parentOrigin: 'https://example.test',
  };

  it('accepts a complete offer', () => {
    expect(isBootstrapOffer(offer)).toBe(true);
  });

  it('rejects an offer with the wrong kind, version, or a missing field', () => {
    expect(isBootstrapOffer({ ...offer, kind: 'flowvid.sim' })).toBe(false);
    expect(isBootstrapOffer({ ...offer, protocolVersion: 2 })).toBe(false);
    expect(isBootstrapOffer({ ...offer, parentOrigin: '' })).toBe(false);
    expect(isBootstrapOffer({ ...offer, documentId: '' })).toBe(false);
    expect(isBootstrapOffer({ ...offer, packageRevision: '' })).toBe(false);
    expect(isBootstrapOffer(null)).toBe(false);
    expect(isBootstrapOffer([offer])).toBe(false);
  });

  it('is not confusable with a protocol envelope', () => {
    // The bootstrap uses `kind`, the protocol uses `type`. Neither guard recognises the other.
    expect(isBootstrapOffer(goodDocEnvelope())).toBe(false);
    expect(reasonOf(offer)).toBe('wrong-namespace');
  });

  it('accepts an accept only for the CURRENT document epoch', () => {
    const accept = { kind: SIM_BOOTSTRAP_ACCEPT_KIND, protocolVersion: SIM_PROTOCOL_VERSION, documentId: DOC };
    expect(isBootstrapAccept(accept, DOC)).toBe(true);
    // The navigation hazard: the previous document in the same iframe answering the new offer.
    expect(isBootstrapAccept(accept, 'doc_epoch_2')).toBe(false);
    expect(isBootstrapAccept({ ...accept, protocolVersion: 2 }, DOC)).toBe(false);
    expect(isBootstrapAccept({ ...accept, kind: 'other' }, DOC)).toBe(false);
  });

  it('bounds the handshake wait', () => {
    expect(SIM_BOOTSTRAP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(SIM_BOOTSTRAP_TIMEOUT_MS)).toBe(true);
  });
});
