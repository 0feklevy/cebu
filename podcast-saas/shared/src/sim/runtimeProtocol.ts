/**
 * The activation-scoped simulation runtime protocol (v3) — wire format and validation.
 *
 * RELATIONSHIP TO THE SHIPPED PROTOCOL
 * The v2 wire protocol (`SIM_READY` / `SCRIPT_APPLIED` / `startScript`, bare objects posted to
 * `'*'`) still ships and still works; every stored package speaks it and nothing here changes
 * that. v3 is a SECOND, additive protocol that a package must explicitly prove it speaks, and the
 * player falls back to v2 for everything else. The two never mix on one transport: v3 traffic
 * lives on a transferred MessagePort, v2 traffic on `window.postMessage`, so a v2 message can not
 * be mistaken for a v3 one even by accident.
 *
 * WHAT v3 ADDS, AND WHY EACH PIECE IS LOAD-BEARING
 *  • Identity on every envelope (simIdentity.ts). v2's `token` is unique only within one parent's
 *    lifetime and says nothing about which document or package revision produced the message.
 *  • A private transport. v2 posts to `'*'` and accepts from any source that happens to match the
 *    frame's contentWindow — which survives navigation, so a message from the PREVIOUS document in
 *    the same iframe passes that check.
 *  • Sequence numbers, so a duplicated or reordered message is detectable rather than merely
 *    unlikely.
 *  • An explicit separation of "the runtime can accept commands" (DOCUMENT_READY) from "this exact
 *    activation has submitted its render" (SECTION_PRESENTED). Conflating those two is the single
 *    defect that produced every wrong-sub-simulation frame in this codebase's history.
 *
 * VALIDATION PHILOSOPHY
 * `validateEnvelope` returns a REASON, never a bare boolean. A rejection that cannot say why is
 * indistinguishable from a rejection that is itself the bug, and every rejection path here has at
 * least one test asserting the exact reason code.
 */

import type {
  ActivationId,
  ConfigHash,
  DocumentId,
  PackageRevision,
  PlayerSessionId,
  SimPresentationConfig,
  SimQualityProfile,
  VariantKey,
} from './simIdentity.js';
import type { SimPolicyKind, SimPolicyRefusal } from './simPolicy.js';

// ─── Constants ────────────────────────────────────────────────────────────────────────────────

/** Namespace stamped on every v3 envelope. Anything without it is not our traffic. */
export const SIM_PROTOCOL_NAMESPACE = 'flowvid.sim' as const;
export type SimProtocolNamespace = typeof SIM_PROTOCOL_NAMESPACE;

/**
 * Wire version. Bump ONLY on an incompatible change; the parent refuses a child advertising a
 * different major version rather than guessing, because a partially-understood protocol is how a
 * reveal gets authorised by a message the parent did not actually parse.
 */
export const SIM_PROTOCOL_VERSION = 3 as const;

// ─── Message types ────────────────────────────────────────────────────────────────────────────

/** Parent → child, document scope. */
export const INIT_DOCUMENT = 'INIT_DOCUMENT' as const;
export const SUSPEND_DOCUMENT = 'SUSPEND_DOCUMENT' as const;
export const RESUME_DOCUMENT = 'RESUME_DOCUMENT' as const;
export const SET_AUDIBLE = 'SET_AUDIBLE' as const;
export const SET_QUALITY = 'SET_QUALITY' as const;
export const DISPOSE_DOCUMENT = 'DISPOSE_DOCUMENT' as const;

/** Child → parent, document scope. */
export const DOCUMENT_READY = 'DOCUMENT_READY' as const;
export const DOCUMENT_SUSPENDED = 'DOCUMENT_SUSPENDED' as const;
export const DOCUMENT_RESUMED = 'DOCUMENT_RESUMED' as const;
export const QUALITY_APPLIED = 'QUALITY_APPLIED' as const;
export const DISPOSED = 'DISPOSED' as const;
export const CONTEXT_LOST = 'CONTEXT_LOST' as const;
export const CONTEXT_RESTORED = 'CONTEXT_RESTORED' as const;
export const DOCUMENT_ERROR = 'DOCUMENT_ERROR' as const;

/** Parent → child, activation scope. */
export const PREPARE_SECTION = 'PREPARE_SECTION' as const;
export const PRESENT_SECTION = 'PRESENT_SECTION' as const;
export const ACTIVATE_SECTION = 'ACTIVATE_SECTION' as const;
export const PAUSE_AUTOMATION = 'PAUSE_AUTOMATION' as const;
export const RESUME_AUTOMATION = 'RESUME_AUTOMATION' as const;
export const RELEASE_SECTION = 'RELEASE_SECTION' as const;
/**
 * POLICY, not lifecycle (audit P1.2). These change the section's CHROME and AUTOMATION on the
 * activation that is already live — no release, no cleanup, no re-run of the body, no solver
 * reset. They are activation-scoped for the same reason every other command here is: a policy
 * that arrived one activation late would otherwise be applied to whatever is on screen now.
 *
 * They are deliberately NOT modelled as a config change. `configHash` is an axis of activation
 * identity, so a config change IS a new activation by construction — which is exactly the defect
 * this pair exists to remove.
 */
export const SET_UI_POLICY = 'SET_UI_POLICY' as const;
export const SET_AUTOMATION_POLICY = 'SET_AUTOMATION_POLICY' as const;

/** Child → parent, activation scope. */
export const SECTION_APPLIED = 'SECTION_APPLIED' as const;
export const SECTION_PRESENTED = 'SECTION_PRESENTED' as const;
export const SECTION_RELEASED = 'SECTION_RELEASED' as const;
export const AUTOMATION_PAUSED = 'AUTOMATION_PAUSED' as const;
export const AUTOMATION_RESUMED = 'AUTOMATION_RESUMED' as const;
/** A policy landed. Carries `changed:false` for an idempotent re-post — a no-op, not a failure. */
export const POLICY_APPLIED = 'POLICY_APPLIED' as const;
/**
 * The package cannot honour this policy without being restarted, and says so rather than pretending
 * it applied. The parent's only correct answer is a full re-activation — the honest fallback the
 * finding demands be OBSERVABLE rather than silent.
 */
export const POLICY_REFUSED = 'POLICY_REFUSED' as const;
export const SECTION_ERROR = 'SECTION_ERROR' as const;
/** Anything the section reports about itself (interaction, milestone, custom telemetry). */
export const DOMAIN_EVENT = 'DOMAIN_EVENT' as const;

export type SimOutboundType =
  | typeof INIT_DOCUMENT | typeof SUSPEND_DOCUMENT | typeof RESUME_DOCUMENT
  | typeof SET_AUDIBLE | typeof SET_QUALITY | typeof DISPOSE_DOCUMENT
  | typeof PREPARE_SECTION | typeof PRESENT_SECTION | typeof ACTIVATE_SECTION
  | typeof PAUSE_AUTOMATION | typeof RESUME_AUTOMATION | typeof RELEASE_SECTION
  | typeof SET_UI_POLICY | typeof SET_AUTOMATION_POLICY;

export type SimInboundType =
  | typeof DOCUMENT_READY | typeof DOCUMENT_SUSPENDED | typeof DOCUMENT_RESUMED
  | typeof QUALITY_APPLIED | typeof DISPOSED | typeof CONTEXT_LOST | typeof CONTEXT_RESTORED
  | typeof DOCUMENT_ERROR
  | typeof SECTION_APPLIED | typeof SECTION_PRESENTED | typeof SECTION_RELEASED
  | typeof AUTOMATION_PAUSED | typeof AUTOMATION_RESUMED
  | typeof POLICY_APPLIED | typeof POLICY_REFUSED | typeof SECTION_ERROR
  | typeof DOMAIN_EVENT;

/**
 * Message types that MUST carry activation identity. Kept as data (not an `if` chain) so the
 * validator and the tests read from the same list — a new activation-scoped message added to the
 * union but forgotten here would otherwise silently skip its identity requirement.
 */
export const ACTIVATION_SCOPED_TYPES: ReadonlySet<string> = new Set<string>([
  PREPARE_SECTION, PRESENT_SECTION, ACTIVATE_SECTION,
  PAUSE_AUTOMATION, RESUME_AUTOMATION, RELEASE_SECTION,
  SET_UI_POLICY, SET_AUTOMATION_POLICY,
  SECTION_APPLIED, SECTION_PRESENTED, SECTION_RELEASED,
  AUTOMATION_PAUSED, AUTOMATION_RESUMED,
  POLICY_APPLIED, POLICY_REFUSED, SECTION_ERROR, DOMAIN_EVENT,
]);

// ─── Envelope ─────────────────────────────────────────────────────────────────────────────────

export interface SimRuntimeEnvelope<TType extends string = string, TPayload = unknown> {
  namespace: SimProtocolNamespace;
  protocolVersion: number;
  type: TType;
  playerSessionId: PlayerSessionId;
  packageRevision: PackageRevision;
  documentId: DocumentId;
  activationId?: ActivationId;
  variantKey?: VariantKey;
  configHash?: ConfigHash;
  /** Monotonically increasing per transport DIRECTION. Starts at 1. */
  seq: number;
  payload: TPayload;
}

export type AnySimEnvelope = SimRuntimeEnvelope<string, unknown>;

// ─── Payload shapes ───────────────────────────────────────────────────────────────────────────

export interface InitDocumentPayload {
  /** Origin the child must accept commands from, so the child can validate the parent too. */
  parentOrigin: string;
  /** Section ids this document is expected to serve, for the child's own sanity checks. */
  knownVariants?: string[];
  quality: SimQualityProfile;
  /** A document is born hidden and silent; the parent lifts both explicitly. */
  audible: { muted: boolean; volume: number };
}

export interface DocumentReadyPayload {
  /** Everything the runtime can actually do — the honest capability report. */
  capabilities: SimRuntimeCapabilities;
  /** Section ids the document really has. */
  variants: string[];
  /**
   * Policy families this document's bridge can apply WITHOUT a re-activation (audit P1.2).
   *
   * DELIBERATELY NOT A `SimRuntimeCapabilities` FIELD. That record is the reveal-path contract the
   * canary classifies — every flag in it is load-bearing for `managed-presentable`, and a package
   * that cannot hot-swap chrome is not thereby unable to present a correct frame. Folding policy
   * support in there would demote healthy packages for a reason that has nothing to do with what
   * they draw.
   *
   * ABSENT (undefined) IS THE ANSWER AN OLD PACKAGE GIVES. The bridge is regenerated per
   * publication, so a package published before this protocol simply does not send the field — and
   * the parent must read that as "no policy support" and fall back to a full restart, loudly.
   */
  policies?: SimPolicyKind[];
}

export interface SimRuntimeCapabilities {
  /** Implements prepare → applied → present → presented with activation identity. */
  activationScoped: boolean;
  /** Owns its resources through the managed scope and can prove a suspension. */
  managedLifecycle: boolean;
  /** Can render one explicit frame on demand (required for honest SECTION_PRESENTED). */
  onDemandRender: boolean;
  /** Reports WebGL context loss/restore. */
  contextEvents: boolean;
  /** Can suspend to a provably quiescent state and report resource counts. */
  suspendable: boolean;
  /** Can set audio state without a document reload. */
  audioControl: boolean;
  /** Can switch quality profiles at runtime. */
  qualityControl: boolean;
}

export const NO_CAPABILITIES: SimRuntimeCapabilities = {
  activationScoped: false,
  managedLifecycle: false,
  onDemandRender: false,
  contextEvents: false,
  suspendable: false,
  audioControl: false,
  qualityControl: false,
};

export interface PrepareSectionPayload {
  variantKey: VariantKey;
  config: SimPresentationConfig;
}

export interface SectionAppliedPayload {
  /** Echoed so a mis-wired child that applies a DIFFERENT section is caught, not trusted. */
  variantKey: VariantKey;
  /** Echoed config hash — the child recomputes it from what it actually installed. */
  configHash: ConfigHash;
  /** Milliseconds the body took, for telemetry only. */
  applyMs?: number;
}

export interface SectionPresentedPayload {
  variantKey: VariantKey;
  configHash: ConfigHash;
  /** Canvas backing-store size at submit time — proves something real was sized and drawn. */
  canvas?: { width: number; height: number } | null;
  /** Frames the managed scope has submitted for THIS activation. Must be >= 1. */
  framesSubmitted: number;
}

export interface SetUiPolicyPayload {
  simpleUi: boolean;
  /**
   * The MECHANICAL hide set — always an array on the wire, because this message drives ONLY the
   * `#__simHideUi` style and never re-runs the body. The `null`-vs-`[]` distinction that matters
   * on a restart (see simPolicy.ts) has no meaning here: the body never sees this value.
   */
  hideSelectors: string[];
}

export interface SetAutomationPolicyPayload {
  autoScript: boolean;
}

export interface PolicyAppliedPayload {
  kind: SimPolicyKind;
  /** False for an idempotent re-post: the package was already in this state. Not a failure. */
  changed: boolean;
  /** Automation only — registered handles actually stopped. 0 is legitimate and is not a failure. */
  stopped?: number;
  /** Automation only — registered handles actually restarted. */
  restarted?: number;
  /**
   * Automation only — handles that were paused but could not be recreated. Reported rather than
   * hidden: a "resumed" acknowledgement covering timers that are in fact dead is worse than an
   * honest zero.
   */
  unrestorable?: number;
  /**
   * UI only. False when the section body exposes no re-apply hook, so only the MECHANICAL hides
   * moved and the body's own hiding (if it has any) was not re-evaluated. The parent does NOT
   * restart for this — restarting is the reset this whole message exists to avoid — but the
   * residual is reported so it is visible in the field rather than inferred from a screenshot.
   */
  bodyHook?: boolean;
}

export interface PolicyRefusedPayload {
  kind: SimPolicyKind;
  reason: SimPolicyRefusal;
  /** Always true today: every refusal here means "re-activate me". Explicit so it can stop being. */
  requiresRestart: boolean;
}

export interface SetAudiblePayload {
  muted: boolean;
  /** 0..1. */
  volume: number;
}

export interface SetQualityPayload {
  profile: SimQualityProfile;
}

export interface QualityAppliedPayload {
  profile: SimQualityProfile;
  /** What the package actually did — 'applied' | 'clamped' | 'unsupported'. */
  outcome: 'applied' | 'clamped' | 'unsupported';
}

/** Resource counters the managed scope tracks. Every field is a COUNT of live resources. */
export interface SimResourceCounts {
  rafCallbacks: number;
  timeouts: number;
  intervals: number;
  listeners: number;
  abortControllers: number;
  workers: number;
  ports: number;
  mediaElements: number;
  animations: number;
  audioContexts: number;
  audioNodes: number;
  objectUrls: number;
  imageBitmaps: number;
  observers: number;
  glRenderers: number;
  glGeometries: number;
  glMaterials: number;
  glTextures: number;
  glRenderTargets: number;
  glPrograms: number;
}

export const ZERO_RESOURCE_COUNTS: SimResourceCounts = {
  rafCallbacks: 0, timeouts: 0, intervals: 0, listeners: 0, abortControllers: 0,
  workers: 0, ports: 0, mediaElements: 0, animations: 0, audioContexts: 0, audioNodes: 0,
  objectUrls: 0, imageBitmaps: 0, observers: 0, glRenderers: 0, glGeometries: 0,
  glMaterials: 0, glTextures: 0, glRenderTargets: 0, glPrograms: 0,
};

export interface DocumentSuspendedPayload {
  /** Proof of quiescence, not a promise of it. */
  counts: SimResourceCounts;
  /** Anything the package could NOT stop — reported, never hidden. */
  unstoppable: string[];
}

export interface DisposedPayload {
  counts: SimResourceCounts;
  /** Resources still live after dispose — a non-empty list is a leak, and it is reported. */
  leaked: string[];
}

export interface SectionErrorPayload {
  message: string;
  /** Which step failed — prepare/present/activate/release. */
  stage: 'prepare' | 'present' | 'activate' | 'release' | 'automation';
  /** True when the document is still usable for another activation. */
  recoverable: boolean;
}

export interface DocumentErrorPayload {
  message: string;
  fatal: boolean;
}

export interface DomainEventPayload {
  /** e.g. 'userInteraction', 'milestone'. */
  event: string;
  detail?: Record<string, unknown>;
}

export interface ContextLostPayload {
  /** Which context was lost, for the rare document with more than one. */
  contextKind: 'webgl' | 'webgl2' | 'webgpu' | 'audio' | 'unknown';
}

// ─── Validation ───────────────────────────────────────────────────────────────────────────────

export type EnvelopeRejectReason =
  | 'not-an-object'
  | 'wrong-namespace'
  | 'wrong-protocol-version'
  | 'missing-type'
  | 'unknown-type'
  | 'missing-player-session'
  | 'wrong-player-session'
  | 'missing-package-revision'
  | 'missing-document-id'
  | 'unknown-document'
  | 'tombstoned-document'
  | 'missing-activation-id'
  | 'missing-variant-key'
  | 'missing-config-hash'
  | 'bad-seq'
  | 'duplicate-seq'
  | 'out-of-order-seq'
  | 'malformed-payload';

export type ValidateResult<T extends AnySimEnvelope = AnySimEnvelope> =
  | { ok: true; envelope: T }
  | { ok: false; reason: EnvelopeRejectReason; detail?: string };

export interface ValidateContext {
  /** The session this transport belongs to. A message for another session is not ours. */
  playerSessionId: PlayerSessionId;
  /** The document epoch currently bound to this transport. */
  documentId: DocumentId;
  /** Document ids that have been disposed/navigated away from. Messages from them are dead. */
  tombstonedDocumentIds?: ReadonlySet<DocumentId>;
  /** Highest inbound seq accepted so far on this transport (0 before the first). */
  lastSeq: number;
  /** The set of types this direction may legally receive. */
  allowedTypes: ReadonlySet<string>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Validate ONE inbound envelope against a transport's context.
 *
 * ORDERING IS DELIBERATE. Namespace and version are checked before anything else so that traffic
 * belonging to some other library on the page produces `wrong-namespace` rather than a confusing
 * complaint about a missing field it was never supposed to have. Tombstone is checked before
 * sequence, because a message from a dead document must be rejected for BEING from a dead document
 * — reporting it as an out-of-order sequence would be true but useless.
 */
export function validateEnvelope(raw: unknown, ctx: ValidateContext): ValidateResult {
  if (!isObject(raw)) return { ok: false, reason: 'not-an-object' };
  if (raw.namespace !== SIM_PROTOCOL_NAMESPACE) return { ok: false, reason: 'wrong-namespace' };
  if (raw.protocolVersion !== SIM_PROTOCOL_VERSION) {
    return { ok: false, reason: 'wrong-protocol-version', detail: String(raw.protocolVersion) };
  }
  if (!isNonEmptyString(raw.type)) return { ok: false, reason: 'missing-type' };
  if (!ctx.allowedTypes.has(raw.type)) return { ok: false, reason: 'unknown-type', detail: raw.type };

  if (!isNonEmptyString(raw.playerSessionId)) return { ok: false, reason: 'missing-player-session' };
  if (raw.playerSessionId !== ctx.playerSessionId) {
    return { ok: false, reason: 'wrong-player-session', detail: raw.playerSessionId };
  }
  if (!isNonEmptyString(raw.packageRevision)) return { ok: false, reason: 'missing-package-revision' };
  if (!isNonEmptyString(raw.documentId)) return { ok: false, reason: 'missing-document-id' };

  if (ctx.tombstonedDocumentIds?.has(raw.documentId)) {
    return { ok: false, reason: 'tombstoned-document', detail: raw.documentId };
  }
  if (raw.documentId !== ctx.documentId) {
    return { ok: false, reason: 'unknown-document', detail: raw.documentId };
  }

  if (ACTIVATION_SCOPED_TYPES.has(raw.type)) {
    if (!isNonEmptyString(raw.activationId)) return { ok: false, reason: 'missing-activation-id' };
    if (!isNonEmptyString(raw.variantKey)) return { ok: false, reason: 'missing-variant-key' };
    if (!isNonEmptyString(raw.configHash)) return { ok: false, reason: 'missing-config-hash' };
  }

  if (typeof raw.seq !== 'number' || !Number.isInteger(raw.seq) || raw.seq < 1) {
    return { ok: false, reason: 'bad-seq', detail: String(raw.seq) };
  }
  if (raw.seq === ctx.lastSeq) return { ok: false, reason: 'duplicate-seq', detail: String(raw.seq) };
  if (raw.seq < ctx.lastSeq) return { ok: false, reason: 'out-of-order-seq', detail: String(raw.seq) };

  if (!isObject(raw.payload)) return { ok: false, reason: 'malformed-payload' };

  return { ok: true, envelope: raw as unknown as AnySimEnvelope };
}

/**
 * The types a PARENT may legally receive. Anything else — including a parent→child command echoed
 * back — is rejected as `unknown-type`, which closes the reflection trick where a child replays a
 * command it was sent in order to look like an acknowledgement.
 */
export const PARENT_INBOUND_TYPES: ReadonlySet<string> = new Set<string>([
  DOCUMENT_READY, DOCUMENT_SUSPENDED, DOCUMENT_RESUMED, QUALITY_APPLIED, DISPOSED,
  CONTEXT_LOST, CONTEXT_RESTORED, DOCUMENT_ERROR,
  SECTION_APPLIED, SECTION_PRESENTED, SECTION_RELEASED,
  AUTOMATION_PAUSED, AUTOMATION_RESUMED,
  POLICY_APPLIED, POLICY_REFUSED, SECTION_ERROR, DOMAIN_EVENT,
]);

/** The types a CHILD may legally receive. */
export const CHILD_INBOUND_TYPES: ReadonlySet<string> = new Set<string>([
  INIT_DOCUMENT, SUSPEND_DOCUMENT, RESUME_DOCUMENT, SET_AUDIBLE, SET_QUALITY, DISPOSE_DOCUMENT,
  PREPARE_SECTION, PRESENT_SECTION, ACTIVATE_SECTION,
  PAUSE_AUTOMATION, RESUME_AUTOMATION, RELEASE_SECTION,
  SET_UI_POLICY, SET_AUTOMATION_POLICY,
]);

// ─── Construction ─────────────────────────────────────────────────────────────────────────────

export interface EnvelopeIdentity {
  playerSessionId: PlayerSessionId;
  packageRevision: PackageRevision;
  documentId: DocumentId;
  activationId?: ActivationId;
  variantKey?: VariantKey;
  configHash?: ConfigHash;
}

/**
 * Build an envelope. `seq` is supplied by the transport, never by the caller, so a caller can not
 * accidentally mint two messages with the same sequence number.
 */
export function makeEnvelope<TType extends string, TPayload>(
  type: TType,
  identity: EnvelopeIdentity,
  seq: number,
  payload: TPayload,
): SimRuntimeEnvelope<TType, TPayload> {
  const env: SimRuntimeEnvelope<TType, TPayload> = {
    namespace: SIM_PROTOCOL_NAMESPACE,
    protocolVersion: SIM_PROTOCOL_VERSION,
    type,
    playerSessionId: identity.playerSessionId,
    packageRevision: identity.packageRevision,
    documentId: identity.documentId,
    seq,
    payload,
  };
  // Only SET the optional identity fields when present: an explicit `activationId: undefined`
  // survives structured clone as an own property, and a validator that checks `in` rather than
  // truthiness would then see a field that is there but empty.
  if (identity.activationId !== undefined) env.activationId = identity.activationId;
  if (identity.variantKey !== undefined) env.variantKey = identity.variantKey;
  if (identity.configHash !== undefined) env.configHash = identity.configHash;
  return env;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────────────────────

/**
 * The ONE message that is posted with `window.postMessage` rather than over the port, because it
 * is the message that DELIVERS the port. It is deliberately a different shape from a normal
 * envelope (`kind` rather than `type`) so that no code path can confuse a bootstrap offer with
 * protocol traffic.
 */
export const SIM_BOOTSTRAP_KIND = 'flowvid.sim.bootstrap' as const;

export interface SimBootstrapOffer {
  kind: typeof SIM_BOOTSTRAP_KIND;
  protocolVersion: number;
  playerSessionId: PlayerSessionId;
  packageRevision: PackageRevision;
  documentId: DocumentId;
  /** The origin the child must post back to. Never '*' after bootstrap. */
  parentOrigin: string;
}

/** The child's answer, also on `window.postMessage`, proving it took the port. */
export const SIM_BOOTSTRAP_ACCEPT_KIND = 'flowvid.sim.bootstrap.accept' as const;

export interface SimBootstrapAccept {
  kind: typeof SIM_BOOTSTRAP_ACCEPT_KIND;
  protocolVersion: number;
  documentId: DocumentId;
}

export function isBootstrapAccept(data: unknown, documentId: DocumentId): data is SimBootstrapAccept {
  return (
    isObject(data) &&
    data.kind === SIM_BOOTSTRAP_ACCEPT_KIND &&
    data.protocolVersion === SIM_PROTOCOL_VERSION &&
    data.documentId === documentId
  );
}

export function isBootstrapOffer(data: unknown): data is SimBootstrapOffer {
  return (
    isObject(data) &&
    data.kind === SIM_BOOTSTRAP_KIND &&
    data.protocolVersion === SIM_PROTOCOL_VERSION &&
    isNonEmptyString(data.playerSessionId) &&
    isNonEmptyString(data.packageRevision) &&
    isNonEmptyString(data.documentId) &&
    isNonEmptyString(data.parentOrigin)
  );
}

/**
 * How long the parent waits for a child to accept the bootstrap before concluding the package is
 * legacy. Generous on purpose: a slow package that is genuinely modern being misclassified as
 * legacy costs it the modern guarantees for the whole session, whereas waiting an extra second
 * costs one section entry a poster it was going to show anyway.
 */
export const SIM_BOOTSTRAP_TIMEOUT_MS = 1_500;
