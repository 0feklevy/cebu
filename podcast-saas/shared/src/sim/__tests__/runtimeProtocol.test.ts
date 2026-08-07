/**
 * The v3 wire protocol — shared-side.
 *
 * RELATIONSHIP TO client-web/__tests__/simProtocolEnvelope.test.ts
 * That file already drives a `Record<EnvelopeRejectReason, RejectCase>` in which each case carries
 * exactly ONE defect, and it spot-checks six ordering pairs. This file asks a strictly harder
 * question of the same 18 reasons.
 *
 * WHY A CASCADE RATHER THAN ONE DEFECT PER CASE
 * `validateEnvelope` is a chain of early returns, so "reason R is reachable" and "reason R is what
 * you get when R is true" are different claims. A single-defect case proves only the first: with
 * one thing wrong, the one check that fires is the one that fires. It cannot detect a check moved
 * to the wrong position, because with every other field valid there is nothing for it to shadow.
 *
 * So each case here starts from a valid envelope and applies its OWN defect PLUS the defect of
 * every reason checked AFTER it. The result must still be that case's reason. Run over all 18, that
 * asserts the entire precedence lattice — a check that migrated even one position produces a
 * different reason for some case and the table fails. The ordering is not cosmetic: `tombstoned-
 * document` must beat `unknown-document` (a dead epoch is rejected for being dead, not for being
 * unrecognised) and `wrong-namespace` must beat every field complaint (foreign traffic on the page
 * must not be reported as a malformed message of ours).
 *
 * Typed as a total Record over the union, so a new reason without a case is a COMPILE error.
 */
import { describe, it, expect } from 'vitest';
import {
  ACTIVATION_SCOPED_TYPES,
  CHILD_INBOUND_TYPES,
  DOCUMENT_READY,
  PARENT_INBOUND_TYPES,
  SECTION_PRESENTED,
  SIM_PROTOCOL_NAMESPACE,
  SIM_PROTOCOL_VERSION,
  makeEnvelope,
  validateEnvelope,
  type AnySimEnvelope,
  type EnvelopeRejectReason,
  type SimInboundType,
  type SimOutboundType,
  type ValidateContext,
} from '../runtimeProtocol.js';

const SESSION = 'ps_live_session';
const DOC = 'doc_epoch_1';
const DEAD_DOC = 'doc_epoch_0';
const REVISION = 'a3f9c1d0e7b45268';
const LAST_SEQ = 7;

const baseCtx = (): ValidateContext => ({
  playerSessionId: SESSION,
  documentId: DOC,
  tombstonedDocumentIds: new Set<string>(),
  lastSeq: LAST_SEQ,
  allowedTypes: PARENT_INBOUND_TYPES,
});

/**
 * The base is ACTIVATION-scoped so the three identity requirements are in play for every case. A
 * document-scoped base would make `missing-activation-id` unreachable for the upstream cases and
 * quietly shrink the cascade.
 */
const baseEnvelope = (): Record<string, unknown> => ({
  namespace: SIM_PROTOCOL_NAMESPACE,
  protocolVersion: SIM_PROTOCOL_VERSION,
  type: SECTION_PRESENTED,
  playerSessionId: SESSION,
  packageRevision: REVISION,
  documentId: DOC,
  activationId: 'act_1',
  variantKey: 'sec-1',
  configHash: '0123456789abcdef',
  seq: LAST_SEQ + 1,
  payload: { variantKey: 'sec-1', configHash: '0123456789abcdef', framesSubmitted: 1 },
});

interface Draft {
  raw: unknown;
  ctx: ValidateContext;
}

interface CascadeCase {
  /** Applies this reason's defect. Mutates the draft in place. */
  apply(d: Draft): void;
  /** What the defect is, and why this reason and not a neighbouring one. */
  why: string;
}

/**
 * The order `validateEnvelope` performs its checks in, restated independently of the source.
 * `duplicate-seq` and `out-of-order-seq` are mutually exclusive on the same field, so a case for
 * one cannot also carry the other; every other pair genuinely stacks.
 */
const CHECK_ORDER: readonly EnvelopeRejectReason[] = [
  'not-an-object',
  'wrong-namespace',
  'wrong-protocol-version',
  'missing-type',
  'unknown-type',
  'missing-player-session',
  'wrong-player-session',
  'missing-package-revision',
  'missing-document-id',
  'tombstoned-document',
  'unknown-document',
  'missing-activation-id',
  'missing-variant-key',
  'missing-config-hash',
  'bad-seq',
  'duplicate-seq',
  'out-of-order-seq',
  'malformed-payload',
];

const asObject = (d: Draft): Record<string, unknown> => d.raw as Record<string, unknown>;

const CASES: Record<EnvelopeRejectReason, CascadeCase> = {
  'not-an-object': {
    apply: (d) => { d.raw = 'flowvid.sim'; },
    why: 'a scalar cannot carry any field, so no field complaint could be honest',
  },
  'wrong-namespace': {
    apply: (d) => { asObject(d).namespace = 'someone.else'; },
    why: 'another library on the page must never be reported as a malformed message of ours',
  },
  'wrong-protocol-version': {
    apply: (d) => { asObject(d).protocolVersion = SIM_PROTOCOL_VERSION + 1; },
    why: 'a partially-understood protocol is refused before any field of it is read',
  },
  'missing-type': {
    apply: (d) => { asObject(d).type = ''; },
    why: 'an empty type is absent, not a type literally named ""',
  },
  'unknown-type': {
    apply: (d) => { asObject(d).type = 'SIM_READY'; },
    why: 'v2 traffic and echoed commands are outside this direction\'s allow-list',
  },
  'missing-player-session': {
    apply: (d) => { asObject(d).playerSessionId = ''; },
    why: 'absent before wrong — an empty id belongs to no session at all',
  },
  'wrong-player-session': {
    apply: (d) => { asObject(d).playerSessionId = 'ps_the_other_player'; },
    why: 'the editor timeline and the section preview are two players on one page',
  },
  'missing-package-revision': {
    apply: (d) => { asObject(d).packageRevision = ''; },
    why: 'a message that cannot say which package bytes produced it',
  },
  'missing-document-id': {
    apply: (d) => { asObject(d).documentId = ''; },
    why: 'checked before the tombstone: an empty id is in no tombstone set',
  },
  'tombstoned-document': {
    apply: (d) => {
      asObject(d).documentId = DEAD_DOC;
      d.ctx = { ...d.ctx, tombstonedDocumentIds: new Set<string>([DEAD_DOC]) };
    },
    why: 'a dead epoch is rejected for BEING dead — reporting it as unknown would be true but useless',
  },
  'unknown-document': {
    apply: (d) => { asObject(d).documentId = 'doc_never_seen'; },
    why: 'a live-looking epoch this transport is simply not bound to',
  },
  'missing-activation-id': {
    apply: (d) => { delete asObject(d).activationId; },
    why: 'the axis that makes A -> B -> A safe, on a type that must carry it',
  },
  'missing-variant-key': {
    apply: (d) => { delete asObject(d).variantKey; },
    why: 'an acknowledgement that cannot say which sub-simulation it means',
  },
  'missing-config-hash': {
    apply: (d) => { delete asObject(d).configHash; },
    why: 'an acknowledgement that cannot say which picture it produced',
  },
  'bad-seq': {
    apply: (d) => { asObject(d).seq = 0; },
    why: 'sequences start at 1, so 0 is malformed before it is compared to lastSeq',
  },
  'duplicate-seq': {
    apply: (d) => { asObject(d).seq = LAST_SEQ; },
    why: 'exactly the last accepted number — a replay, not a reordering',
  },
  'out-of-order-seq': {
    apply: (d) => { asObject(d).seq = LAST_SEQ - 4; },
    why: 'older than the last accepted number',
  },
  'malformed-payload': {
    apply: (d) => { asObject(d).payload = null; },
    why: 'the last check, so it is what remains when everything upstream is clean',
  },
};

/**
 * Build the input for one reason: its own defect plus every defect checked after it.
 *
 * Applied in REVERSE order so that when two reasons mutate the same field (type, playerSessionId,
 * documentId, seq) the earlier-checked one is written last and therefore wins — which is exactly
 * the shadowing the assertion is about.
 */
function cascadeFor(reason: EnvelopeRejectReason): Draft {
  const start = CHECK_ORDER.indexOf(reason);
  if (start < 0) throw new Error(`${reason} is missing from CHECK_ORDER`);
  const draft: Draft = { raw: baseEnvelope(), ctx: baseCtx() };
  for (let i = CHECK_ORDER.length - 1; i >= start; i--) {
    const r = CHECK_ORDER[i];
    // duplicate/out-of-order both write `seq`; only the one under test may contribute.
    if (r !== reason && (r === 'duplicate-seq' || r === 'out-of-order-seq')) continue;
    CASES[r].apply(draft);
  }
  return draft;
}

const reasonOf = (d: Draft): EnvelopeRejectReason | 'ACCEPTED' => {
  const result = validateEnvelope(d.raw, d.ctx);
  return result.ok ? 'ACCEPTED' : result.reason;
};

describe('validateEnvelope — the rejection order is total, not merely reachable', () => {
  it('accepts the unmodified base envelope, so every cascade below starts from something valid', () => {
    // Without this the whole table could pass on an input that was broken to begin with.
    expect(reasonOf({ raw: baseEnvelope(), ctx: baseCtx() })).toBe('ACCEPTED');
  });

  for (const reason of CHECK_ORDER) {
    it(`reports '${reason}' even with every later defect also present (${CASES[reason].why})`, () => {
      expect(reasonOf(cascadeFor(reason))).toBe(reason);
    });
  }

  it('cascades really are stacking defects — each carries at least as many as the next', () => {
    // Guards the table from becoming a set of single-defect cases if `cascadeFor` is ever
    // simplified: the first reason must stack 17 downstream defects, the last exactly none.
    const first = cascadeFor(CHECK_ORDER[0]);
    expect(first.raw).not.toEqual(baseEnvelope());
    const lastReason = CHECK_ORDER[CHECK_ORDER.length - 1];
    const last = cascadeFor(lastReason);
    const onlyPayloadDiffers = { ...baseEnvelope(), payload: null };
    expect(last.raw).toEqual(onlyPayloadDiffers);
  });

  it('covers every reason in the union exactly once', () => {
    // The Record type already forces every key to exist; this catches the other direction — a
    // CHECK_ORDER that lost, repeated, or invented an entry.
    expect(CHECK_ORDER.length).toBe(18);
    expect(new Set(CHECK_ORDER).size).toBe(18);
    expect([...CHECK_ORDER].sort()).toEqual(Object.keys(CASES).sort());
  });
});

describe('validateEnvelope — the two seq rejections that cannot stack', () => {
  it('distinguishes a replay from a reordering on an otherwise clean envelope', () => {
    const replay: Draft = { raw: { ...baseEnvelope(), seq: LAST_SEQ }, ctx: baseCtx() };
    const reordered: Draft = { raw: { ...baseEnvelope(), seq: LAST_SEQ - 1 }, ctx: baseCtx() };
    expect(reasonOf(replay)).toBe('duplicate-seq');
    expect(reasonOf(reordered)).toBe('out-of-order-seq');
  });

  it('accepts a forward gap — a dropped message must not wedge the transport', () => {
    expect(reasonOf({ raw: { ...baseEnvelope(), seq: LAST_SEQ + 50 }, ctx: baseCtx() })).toBe('ACCEPTED');
  });

  it('accepts seq 1 on a fresh transport, where lastSeq is 0', () => {
    const ctx = { ...baseCtx(), lastSeq: 0 };
    expect(reasonOf({ raw: { ...baseEnvelope(), seq: 1 }, ctx })).toBe('ACCEPTED');
    expect(reasonOf({ raw: { ...baseEnvelope(), seq: 0 }, ctx })).toBe('bad-seq');
  });

  it('rejects every non-positive-integer sequence as bad-seq', () => {
    const bad = [0, -1, 1.5, NaN, Infinity, -Infinity, '3', null, undefined, [], {}];
    for (const seq of bad) {
      expect(reasonOf({ raw: { ...baseEnvelope(), seq }, ctx: baseCtx() })).toBe('bad-seq');
    }
  });
});

// ── round-tripping every message type in the protocol ─────────────────────────────────────────

/**
 * Total records over the two direction unions. A message type added to the protocol without an
 * entry here is a COMPILE error, which is the property that makes this a coverage guarantee rather
 * than a list someone remembered to extend.
 */
const INBOUND_IS_ACTIVATION_SCOPED = {
  DOCUMENT_READY: false, DOCUMENT_SUSPENDED: false, DOCUMENT_RESUMED: false,
  QUALITY_APPLIED: false, DISPOSED: false, CONTEXT_LOST: false, CONTEXT_RESTORED: false,
  DOCUMENT_ERROR: false,
  SECTION_APPLIED: true, SECTION_PRESENTED: true, SECTION_RELEASED: true,
  AUTOMATION_PAUSED: true, AUTOMATION_RESUMED: true, SECTION_ERROR: true, DOMAIN_EVENT: true,
} satisfies Record<SimInboundType, boolean>;

const OUTBOUND_IS_ACTIVATION_SCOPED = {
  INIT_DOCUMENT: false, SUSPEND_DOCUMENT: false, RESUME_DOCUMENT: false,
  SET_AUDIBLE: false, SET_QUALITY: false, DISPOSE_DOCUMENT: false,
  PREPARE_SECTION: true, PRESENT_SECTION: true, ACTIVATE_SECTION: true,
  PAUSE_AUTOMATION: true, RESUME_AUTOMATION: true, RELEASE_SECTION: true,
} satisfies Record<SimOutboundType, boolean>;

describe('makeEnvelope round-trips through validateEnvelope for EVERY message type', () => {
  const identity = {
    playerSessionId: SESSION,
    packageRevision: REVISION,
    documentId: DOC,
    activationId: 'act_1',
    variantKey: 'sec-1',
    configHash: '0123456789abcdef',
  };

  const directions: [string, Record<string, boolean>, ReadonlySet<string>][] = [
    ['parent inbound', INBOUND_IS_ACTIVATION_SCOPED, PARENT_INBOUND_TYPES],
    ['child inbound', OUTBOUND_IS_ACTIVATION_SCOPED, CHILD_INBOUND_TYPES],
  ];

  for (const [label, table, allowed] of directions) {
    for (const [type, scoped] of Object.entries(table)) {
      it(`${label}: ${type} validates, and its identity requirement is ${scoped ? 'enforced' : 'not imposed'}`, () => {
        const ctx: ValidateContext = { ...baseCtx(), lastSeq: 0, allowedTypes: allowed };
        const full = makeEnvelope(type, identity, 1, { any: 'payload' });
        expect(validateEnvelope(full, ctx).ok).toBe(true);

        // The same message stripped of activation identity: required exactly when scoped.
        const stripped = makeEnvelope(
          type,
          { playerSessionId: SESSION, packageRevision: REVISION, documentId: DOC },
          1,
          { any: 'payload' },
        );
        const result = validateEnvelope(stripped, ctx);
        expect(result.ok).toBe(!scoped);
        if (!result.ok) expect(result.reason).toBe('missing-activation-id');
      });
    }
  }

  it('agrees with ACTIVATION_SCOPED_TYPES about which types are scoped', () => {
    const restated = new Set<string>([
      ...Object.entries(INBOUND_IS_ACTIVATION_SCOPED).filter(([, v]) => v).map(([k]) => k),
      ...Object.entries(OUTBOUND_IS_ACTIVATION_SCOPED).filter(([, v]) => v).map(([k]) => k),
    ]);
    expect([...restated].sort()).toEqual([...ACTIVATION_SCOPED_TYPES].sort());
  });

  it('has no type in both direction allow-lists — an echoed command can never look like an answer', () => {
    const both = [...PARENT_INBOUND_TYPES].filter((t) => CHILD_INBOUND_TYPES.has(t));
    expect(both).toEqual([]);
  });

  it('lists exactly the types each direction may receive', () => {
    expect([...PARENT_INBOUND_TYPES].sort()).toEqual(Object.keys(INBOUND_IS_ACTIVATION_SCOPED).sort());
    expect([...CHILD_INBOUND_TYPES].sort()).toEqual(Object.keys(OUTBOUND_IS_ACTIVATION_SCOPED).sort());
  });
});

describe('makeEnvelope omits absent optional identity fields rather than setting them undefined', () => {
  it('creates no own property for an identity field that was not supplied', () => {
    // An explicit `activationId: undefined` survives structured clone as an OWN property. A
    // validator written with `in` rather than a truthiness check would then see a field that is
    // present and empty, which is the shape most likely to be trusted by accident.
    const env = makeEnvelope(DOCUMENT_READY, {
      playerSessionId: SESSION, packageRevision: REVISION, documentId: DOC,
    }, 1, {});
    expect(Object.prototype.hasOwnProperty.call(env, 'activationId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(env, 'variantKey')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(env, 'configHash')).toBe(false);
    expect(Object.keys(env).sort()).toEqual(
      ['documentId', 'namespace', 'packageRevision', 'payload', 'playerSessionId', 'protocolVersion', 'seq', 'type'],
    );
  });

  it('survives structuredClone with the same key set and still validates', () => {
    const env = makeEnvelope(SECTION_PRESENTED, {
      playerSessionId: SESSION, packageRevision: REVISION, documentId: DOC,
      activationId: 'act_1', variantKey: 'sec-1', configHash: '0123456789abcdef',
    }, 1, { framesSubmitted: 1 });
    const cloned = structuredClone(env) as AnySimEnvelope;
    expect(Object.keys(cloned).sort()).toEqual(Object.keys(env).sort());
    expect(validateEnvelope(cloned, { ...baseCtx(), lastSeq: 0 }).ok).toBe(true);
  });
});
