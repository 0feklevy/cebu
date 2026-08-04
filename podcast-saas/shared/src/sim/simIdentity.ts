/**
 * The identity model the activation-scoped protocol is built on.
 *
 * WHY IDENTITIES AND NOT NAMES
 * The whole class of defect this protocol closes is "a message that is TRUE about some past state
 * arrives and is applied to the present". Every earlier iteration tried to close it with a
 * narrower and narrower comparison — section name, then name + a monotonic token — and each one
 * left a hole, because a name is not an identity and a token is only unique within one parent's
 * lifetime. An A → B → A cycle produces two activations that agree on section name, variant,
 * config, document and package; only a per-activation identity tells them apart.
 *
 * SIX AXES, EACH INDEPENDENTLY ABLE TO GO STALE
 *   playerSessionId  one viewer/player session. Survives seeks and section changes; changes when
 *                    the player is torn down and rebuilt. Scopes everything below it.
 *   packageRevision  the logical version of the stored package bytes. Changes when the package is
 *                    republished/replaced. A message from the previous revision describes files
 *                    that are no longer served.
 *   documentId       one iframe DOCUMENT EPOCH. A navigation, a reload, a crash-and-recreate all
 *                    mint a new one. Deliberately NOT the iframe element identity: the element
 *                    survives navigation, which is precisely why `contentWindow` comparison was
 *                    never sufficient.
 *   activationId     one section entry, re-entry, seek, or configuration change. The axis that
 *                    makes A → B → A safe.
 *   variantKey       the intended sub-simulation inside the package.
 *   configHash       canonical hash of everything that changes what the section should LOOK like.
 *
 * `seq` is transport bookkeeping, not identity — see runtimeProtocol.ts.
 *
 * ID GENERATION
 * Ids are opaque strings. They are minted with a session-scoped counter plus a random suffix
 * rather than a bare counter: two players on one page (the editor timeline and the section-editor
 * preview do this by design) would otherwise mint colliding ids, and a collision here is a stale
 * message that PASSES the identity check.
 */

import { sha256Hex } from './sha256.js';

// ─── Identity types ───────────────────────────────────────────────────────────────────────────

export type PlayerSessionId = string;
export type PackageRevision = string;
export type DocumentId = string;
export type ActivationId = string;
export type VariantKey = string;
export type ConfigHash = string;

/**
 * The five fields the reveal invariant compares. `playerSessionId` is deliberately NOT part of it:
 * a client instance never sees another session's transport, and including it would imply the
 * comparison is what enforces session scoping when in fact the transport does.
 */
export interface PresentationIdentity {
  packageRevision: PackageRevision;
  documentId: DocumentId;
  activationId: ActivationId;
  variantKey: VariantKey;
  configHash: ConfigHash;
}

// ─── Presentation configuration ───────────────────────────────────────────────────────────────

export type SimQualityProfile = 'high' | 'balanced' | 'low';

/** Aspect handling the package is asked to lay out for. */
export type SimAspectProfile = 'wide' | 'standard' | 'portrait' | 'native';

/**
 * Everything that changes what a prepared section should look like. Two activations that agree on
 * every field here are visually interchangeable, which is exactly the property a poster needs in
 * order to be reusable — so this type is the input to BOTH `configHash` and the poster key.
 */
export interface SimPresentationConfig {
  /** Minimal-UI on/off. */
  simpleUi: boolean;
  /** Selectors mechanically hidden while Minimal UI is on. Order is not significant. */
  hideSelectors: string[];
  /** Whether the section's own automation runs on activation. */
  autoScript: boolean;
  quality: SimQualityProfile;
  aspect: SimAspectProfile;
  /** Author-set initial camera/simulation state, if the section pins one. */
  initialState?: Record<string, string | number | boolean | null> | null;
  /** The section renders over video and must not paint its own background. */
  transparent?: boolean;
}

export const DEFAULT_PRESENTATION_CONFIG: SimPresentationConfig = {
  simpleUi: false,
  hideSelectors: [],
  autoScript: true,
  quality: 'high',
  aspect: 'wide',
  initialState: null,
  transparent: false,
};

/**
 * Canonical JSON for hashing: object keys sorted, `undefined` and `null` collapsed to a single
 * representation, and `hideSelectors` sorted+deduplicated because it is semantically a SET —
 * a selector list that differs only in order describes the same picture, and hashing it as a
 * sequence would mint a second poster and a second canary run for an identical presentation.
 *
 * Numbers are emitted through `JSON.stringify` so -0 and 0 agree (both "0"), and non-finite
 * numbers are rejected rather than silently becoming null.
 */
export function canonicalizeConfig(config: SimPresentationConfig): string {
  const initial = config.initialState ?? null;
  const initialKeys = initial ? Object.keys(initial).sort() : [];
  for (const k of initialKeys) {
    const v = initial![k];
    if (typeof v === 'number' && !Number.isFinite(v)) {
      throw new Error(`initialState.${k} is not finite — a non-finite value cannot be hashed stably`);
    }
  }

  const parts: string[] = [
    `simpleUi:${config.simpleUi ? 1 : 0}`,
    `autoScript:${config.autoScript ? 1 : 0}`,
    `quality:${config.quality}`,
    `aspect:${config.aspect}`,
    `transparent:${config.transparent ? 1 : 0}`,
    `hide:[${[...new Set(config.hideSelectors)].sort().map((s) => JSON.stringify(s)).join(',')}]`,
    `init:{${initialKeys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(initial![k])}`).join(',')}}`,
  ];
  return parts.join('|');
}

/**
 * The config hash carried on the wire and in poster paths.
 *
 * TRUNCATED to 16 hex chars (64 bits) on purpose: it appears in storage paths and in every
 * envelope, and 64 bits of a SHA-256 is far beyond what a per-package variant space can collide
 * in — while a 64-char hash in a path is merely unreadable. The full digest stays available via
 * `sha256Hex(canonicalizeConfig(...))` for anything that needs it.
 */
export function computeConfigHash(config: SimPresentationConfig): ConfigHash {
  return sha256Hex(canonicalizeConfig(config)).slice(0, 16);
}

// ─── Variant key ──────────────────────────────────────────────────────────────────────────────

/**
 * The `?section=` parameter of a section URL, or null when the URL carries none.
 *
 * The regex fallback exists because this runs against stored values: a row written before a URL
 * shape changed, or a relative path, must still yield its variant rather than throwing.
 */
export function variantParamOf(url: string): string | null {
  try {
    // The base only exists so a relative stored URL parses; it never appears in the result.
    return new URL(url, 'http://x').searchParams.get('section');
  } catch {
    const m = /[?&]section=([^&#]+)/.exec(url);
    return m ? decodeURIComponent(m[1]) : null;
  }
}

/**
 * The variant key of one timeline section — the sub-simulation a package must be told to run, and
 * one of the five axes the reveal invariant compares.
 *
 * THE URL PARAM IS AUTHORITATIVE. Bridge bodies are keyed by the section id the URL was minted
 * with (`?section=<id>&v=<hash>` at bridge-upload time), and a DUPLICATED section keeps the
 * ORIGINAL's URL while its own row id has no body in the bridge. The persisted `sim_script` is the
 * literal 'main' on every generated row — a legacy entry-point name, not a section identity — and a
 * bridge resolves 'main' to the LOADED document's `?section` default, which in a pooled document is
 * whichever section happened to be pooled first.
 *
 * This lives in `shared` because the player DISPATCHES on this value and the backend keys POSTERS
 * on it. Two implementations of it would mean a poster minted for one variant being served for
 * another — the exact defect posterIdentity.ts exists to make impossible.
 */
export function variantKeyFor(section: {
  id: string;
  simulation_url?: string | null;
  sim_script?: string | null;
}): VariantKey {
  const urlKey = section.simulation_url ? variantParamOf(section.simulation_url) : null;
  if (urlKey) return urlKey;
  // No ?section= on the URL (single-section / legacy-shaped packages): a real named script still
  // wins; the meaningless literal 'main' falls through to the section id.
  if (section.sim_script && section.sim_script !== 'main') return section.sim_script;
  return section.id;
}

// ─── Id minting ───────────────────────────────────────────────────────────────────────────────

/**
 * Monotonic-per-process counter. Combined with randomness (not used alone) so that ids are both
 * ordered-looking for humans reading telemetry AND collision-free across two players on one page.
 */
let idCounter = 0;

/**
 * A short random suffix. `crypto.getRandomValues` where available; otherwise `Math.random`, which
 * is acceptable here because these ids are anti-COLLISION, never anti-forgery — forgery is
 * prevented by the transport (a private MessagePort plus source/origin validation), never by the
 * unguessability of an id.
 */
function randomSuffix(): string {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } };
  const getRandomValues = g.crypto?.getRandomValues;
  if (typeof getRandomValues === 'function') {
    const buf = new Uint32Array(2);
    getRandomValues.call(g.crypto, buf);
    return buf[0].toString(36) + buf[1].toString(36);
  }
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

function mintId(prefix: string): string {
  idCounter = (idCounter + 1) % 0xffffffff;
  return `${prefix}_${idCounter.toString(36)}_${randomSuffix()}`;
}

export const newPlayerSessionId = (): PlayerSessionId => mintId('ps');
export const newDocumentId = (): DocumentId => mintId('doc');
export const newActivationId = (): ActivationId => mintId('act');

/** Test-only: make minted ids reproducible by resetting the counter. Never affects correctness. */
export function __resetIdCounterForTests(): void {
  idCounter = 0;
}

// ─── Package revision ─────────────────────────────────────────────────────────────────────────

/**
 * The logical package revision, derived from the bytes that are actually served.
 *
 * IMMUTABLE PACKAGE PUBLICATION IS NOT IMPLEMENTED YET (that is Priority 7). Until it is, a
 * package's "revision" is a hash of its identifying, already-stored inputs — the simulation row id
 * plus the bridge hash the entry document loads. That is stable while nothing changes, changes
 * whenever the bridge is regenerated or the package replaced, and requires no new storage. When
 * immutable revisions land, only this function changes: every consumer already treats the value as
 * an opaque string.
 */
export function derivePackageRevision(simulationId: string, bridgeHash: string | null | undefined): PackageRevision {
  return sha256Hex(`${simulationId} ${bridgeHash ?? 'no-bridge'}`).slice(0, 16);
}
