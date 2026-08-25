/**
 * Immutable package revisions (Priority 7.1 / 7.2) — identity, storage layout, and the publication
 * state machine.
 *
 * WHAT CHANGES HERE
 * Until now a package lived at one mutable prefix and every regeneration overwrote it in place.
 * `packageRevision` was DERIVED (simIdentity.derivePackageRevision) from the simulation id plus the
 * bridge hash — which invalidated posters and canary verdicts correctly, but could not stop a
 * viewer from receiving a half-updated package: the entry HTML and the bridge were separate objects
 * written one after another, and a request landing between the two writes got one of each.
 *
 * A revision fixes that by construction rather than by timing. Every published file lives under a
 * path containing the revision id, so a revision's bytes are never rewritten — a new revision is a
 * new set of paths. Switching which revision is live is then a single pointer update, and a viewer
 * holding the old pointer keeps receiving a complete, self-consistent old package.
 *
 * THE POINTER IS THE ONLY MUTABLE THING
 * `simulation.active_revision_id`. Everything it points at is immutable. That is what makes long
 * immutable cache headers correct for revision files: the URL cannot come to mean different bytes.
 * It is also why the pointer itself must never be cached — see `simRevisionServing.ts`.
 */

import { sha256Hex } from './sha256.js';

// ─── Status ───────────────────────────────────────────────────────────────────────────────────

export type SimRevisionStatus =
  /** Created, nothing uploaded. */
  | 'draft'
  /** Files are being written to the revision prefix. */
  | 'uploading'
  /** All files written; hashes and manifest being verified against stored bytes. */
  | 'validating'
  /**
   * Bytes verified against the manifest, and ELIGIBLE to become active.
   *
   * NOT proof that a canary ran. `validate()` moves a revision here on byte verification alone,
   * and the legacy migration publishes straight into this state, so a migrated package can sit in
   * `canary_passed` having never been canaried. The name is historical; treating it as a
   * canary gate would activate unproven bytes. A canary result lives in `canary_report`/`canary_at`
   * — check those if that is the question being asked.
   */
  | 'canary_passed'
  /**
   * Bytes are staged and a replay proof is RUNNING against them. NON-PUBLIC.
   *
   * This is the state `canary_passed` could not be. A candidate here has bytes in storage under a
   * real revision prefix — inside `simulations/`, which `/sim-public/*` serves without
   * authentication — and nothing has yet demonstrated that the plan they carry does what it
   * claims. `isRevisionStatusPublic` is an allow-list precisely so this status is withheld by
   * default rather than by remembering to add it to a deny-list.
   */
  | 'proof_pending'
  /**
   * The replay proof passed against these exact bytes. Still NON-PUBLIC, and still not active.
   *
   * The gap between this and `active` is deliberate: proof is about the artifact, activation is
   * about the pointer, and a proof that passed does not by itself decide that this revision
   * should be the one serving.
   */
  | 'proof_passed'
  /** The pointer points here. Exactly one per simulation. */
  | 'active'
  /** Was active, superseded. Bytes retained for rollback. */
  | 'retired'
  /** Publication failed. Never served. */
  | 'failed'
  /** Was active, then rolled back FROM. Distinct from `retired`: it records a judgement. */
  | 'rolled_back';

export const SIM_REVISION_STATUSES: readonly SimRevisionStatus[] = [
  'draft', 'uploading', 'validating', 'canary_passed',
  'proof_pending', 'proof_passed',
  'active', 'retired', 'failed', 'rolled_back',
];

/**
 * The legal transitions.
 *
 * `active → retired` and `active → rolled_back` are both reachable and mean different things: the
 * first is "something newer took over", the second is "a human decided this one was wrong". Losing
 * that distinction would make the audit history unable to answer why a revision stopped serving,
 * which is the first question asked after an incident.
 */
const TRANSITIONS: Readonly<Record<SimRevisionStatus, readonly SimRevisionStatus[]>> = {
  draft: ['uploading', 'failed'],
  uploading: ['validating', 'failed'],
  validating: ['canary_passed', 'failed'],
  // canary_passed → proof_pending is the new road. → active is KEPT so the existing publication
  // path, and every legacy row already sitting in canary_passed, still work unchanged; the proof
  // states are additive until a caller opts into them.
  canary_passed: ['proof_pending', 'active', 'failed'],
  proof_pending: ['proof_passed', 'failed'],
  // NOT back to proof_pending: a proof is about specific bytes, and re-proving the same bytes
  // proves nothing new while re-proving different bytes is a different candidate.
  proof_passed: ['active', 'failed'],
  // A revision can be re-activated from retired (that IS rollback) — the bytes never moved.
  active: ['retired', 'rolled_back', 'failed'],
  retired: ['active', 'failed'],
  rolled_back: ['active', 'failed'],
  failed: [],
};

export function canTransition(from: SimRevisionStatus, to: SimRevisionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses whose bytes must be preserved — deleting any of these breaks rollback or the audit. */
export function mustRetainBytes(status: SimRevisionStatus): boolean {
  return status === 'active' || status === 'retired' || status === 'rolled_back';
}

/** May a viewer be served from this revision? Only ever the active one. */
export const isServable = (status: SimRevisionStatus): boolean => status === 'active';

// ─── Identity ─────────────────────────────────────────────────────────────────────────────────

/**
 * Revision ids are opaque, URL-safe, and NOT sequential.
 *
 * `revision_number` exists for humans and ordering; the id is what appears in storage paths and in
 * the `packageRevision` identity axis. Keeping them separate means a renumbering (a migration, a
 * backfill) can never change a path that is already cached as immutable.
 */
export function isValidRevisionId(id: string): boolean {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

/**
 * The `packageRevision` identity axis — ONE resolver, deliberately.
 *
 * An earlier draft of this module exported `packageRevisionOf(revisionId)` as a replacement for
 * `simIdentity.derivePackageRevision`, justified by a defect that no longer exists: the derivation
 * used to read the section URL's `?v=`, which could disagree between two sections of one package.
 * Migration 049 closed that by putting `bridge_hash` on the simulations row, and `buildPlayerConfig`
 * has read the row ever since.
 *
 * Shipping both would fork an axis the reveal invariant compares. Three costs, each traced rather
 * than hypothesised:
 *   • every `sim_posters` row is keyed on the derived value, and the lookup deliberately has NO
 *     fallback — a package that switched derivations would lose every poster it has;
 *   • the canary verdict is cleared only when `bridge_hash` changes, and activation/rollback change
 *     which bytes are served WITHOUT touching it — so after a rollback the player would choose its
 *     path from the withdrawn revision's verdict;
 *   • four Playwright suites and a golden vector pin the derived value.
 *
 * So: a simulation with an active revision takes its identity from that revision — immutable bytes,
 * which is exactly what this axis is supposed to mean — and one without takes the pre-revision
 * derivation. The caller injects the old derivation rather than this module importing it, so the
 * dependency runs one way and `shared` keeps no cycle.
 */
export function packageRevisionFor(
  sim: { id: string; bridge_hash?: string | null; active_revision_id?: string | null },
  derivePreRevision: (simulationId: string, bridgeHash: string | null | undefined) => string,
): string {
  if (sim.active_revision_id) {
    // Same NUL delimiter discipline as derivePackageRevision: a separator that cannot occur in an
    // id is what stops two different inputs rendering to one string.
    return sha256Hex(`rev\u0000${sim.active_revision_id}`).slice(0, 16);
  }
  return derivePreRevision(sim.id, sim.bridge_hash ?? null);
}

// ─── Storage layout ───────────────────────────────────────────────────────────────────────────

/**
 * Everything under here is immutable.
 *
 *   simulations/<projectId>/<simulationId>/revisions/<revisionId>/
 *     manifest.json
 *     package/…        customer bytes
 *     runtime/bridge.js, runtime/guidance.js
 *     posters/<identity>/<size>.<ext>
 *     canary/report.json
 *
 * `package/` is nested rather than flat at the revision root so a customer file called
 * `manifest.json` or a directory called `runtime` cannot shadow ours. That has to be structural: a
 * name-based guard would be a denylist, and the customer chooses the names.
 */
export function revisionPrefix(storagePrefix: string, revisionId: string): string {
  // Takes the simulation's OWN `storage_prefix` rather than re-composing it from ids. Two
  // constructions of one prefix is the same class of mistake as two derivations of one revision —
  // they agree until something moves, and then they disagree silently. `PosterService` already
  // takes the prefix as a parameter for exactly this reason.
  return `${storagePrefix.replace(/\/+$/, '')}/revisions/${revisionId}`;
}

export const MANIFEST_FILENAME = 'manifest.json';

export function revisionManifestKey(storagePrefix: string, revisionId: string): string {
  return `${revisionPrefix(storagePrefix, revisionId)}/${MANIFEST_FILENAME}`;
}

/** Where one manifest-relative path lives inside a revision. */
export function revisionFileKey(
  storagePrefix: string,
  revisionId: string,
  manifestPath: string,
): string {
  return `${revisionPrefix(storagePrefix, revisionId)}/${manifestPath}`;
}

/** The subtree a customer's own bytes live in. */
export const PACKAGE_SUBDIR = 'package';
export const RUNTIME_SUBDIR = 'runtime';
export const POSTERS_SUBDIR = 'posters';
export const CANARY_SUBDIR = 'canary';

/**
 * The canonical simulation-prefix depth: `simulations/<projectId>/<simulationId>`.
 *
 * `storage_prefix` is a free-form column, so `revisionPrefix` takes it verbatim. But a key parser
 * that runs WITHOUT the prefix in hand cannot know where the prefix ends — and guessing is not a
 * neutral mistake here, because guessing "yes, revision" grants a year of immutable caching.
 */
const CANONICAL_PREFIX_SEGMENTS = 3;
export const REVISIONS_SEGMENT = 'revisions';

/**
 * The first path segments under a simulation prefix that belong to the SYSTEM, not to the
 * customer's uploaded bundle.
 *
 * This exists because two subsystems write into one keyspace. Immutable revisions live at
 * `<prefix>/revisions/<id>/…` and captured posters at `<prefix>/posters/<identity>/…`, while the
 * "replace simulation" flow uploads a customer bundle into that same `<prefix>/` and then deletes
 * everything under it that the new bundle does not contain. Nothing told the sweep that these two
 * subtrees are not stale customer files.
 */
export const SYSTEM_OWNED_SEGMENTS: readonly string[] = [REVISIONS_SEGMENT, POSTERS_SUBDIR];

/**
 * Is `key` inside a system-owned subtree of `storagePrefix`?
 *
 * THE SWEEP AND THE UPLOAD VALIDATOR MUST AGREE, so both call this one predicate:
 *
 *  - Deleting these keys destroys published revision bytes whose `sim_revisions` rows survive.
 *    Activation only checks that the row has a `manifest_hash` and an `entry_path`, never that the
 *    bytes exist, so the pointer then flips to an empty prefix and `simulationUrlOf` — which has no
 *    fallback for a pointer that resolves to nothing — serves 404s for every section. Rollback dies
 *    with it, because the retained revisions were swept too. Partial destruction is the likely
 *    shape: a sweep that spares `bridge.js` by filename still removes `index.html` and
 *    `manifest.json` from the same revision.
 *  - WRITING these keys is worse than deleting them. A revision id is public (it appears inside
 *    `simulation_url` in every player config), and revision bytes are served
 *    `max-age=31536000, immutable`. A bundle containing `revisions/<active-id>/package/app.js`
 *    would therefore overwrite verified content in place and pin the replacement for a year with
 *    no revalidation path — defeating the immutability the whole design rests on.
 */
export function isSystemOwnedKey(key: string, storagePrefix: string): boolean {
  const base = storagePrefix.replace(/\/+$/, '');
  if (!key.startsWith(`${base}/`)) return false;
  const first = key.slice(base.length + 1).split('/')[0];
  return first !== undefined && SYSTEM_OWNED_SEGMENTS.includes(first);
}

/** Does a bundle-relative path try to write into a system-owned subtree? */
export function isSystemOwnedRelPath(relPath: string): boolean {
  const first = relPath.replace(/^\/+/, '').split('/')[0];
  return first !== undefined && SYSTEM_OWNED_SEGMENTS.includes(first);
}

/**
 * Recover the revision id from a key whose storage prefix is KNOWN. Exact, no guessing.
 *
 * Prefer this wherever the simulation row is already loaded.
 */
export function revisionIdForPrefix(key: string, storagePrefix: string): string | null {
  const base = `${storagePrefix.replace(/\/+$/, '')}/${REVISIONS_SEGMENT}/`;
  if (!key.startsWith(base)) return null;
  const id = key.slice(base.length).split('/')[0];
  return id && isValidRevisionId(id) && key.length > base.length + id.length ? id : null;
}

/**
 * Recover the revision id from a key WITHOUT knowing its storage prefix — positionally.
 *
 * POSITIONAL, NOT "FIRST MATCH". This was a scan for the first `/revisions/<id>/` anywhere in the
 * key, justified by "customer bytes live under `package/` below the real segment, so the real one is
 * found first". That reasoning holds only for keys that ARE revisions. For a LEGACY key it inverts:
 * a pre-revision package whose bundle contains a top-level `revisions/` directory sits at
 * `simulations/<p>/<s>/revisions/<8+ chars>/…`, the scan matches the CUSTOMER's directory, and a
 * mutable object is handed a year of immutable caching with no revalidation path. Requests can
 * reach that shape directly: the route percent-decodes, so `%2F` arrives as a real separator.
 *
 * So the segment must sit at exactly the depth `revisionPrefix` puts it, under the canonical
 * three-segment simulation prefix. Any other shape returns null and stays mutable — the safe
 * direction, and the reason a non-canonical `storage_prefix` simply never gets immutable caching
 * rather than getting it wrongly.
 */
export function revisionIdFromKey(key: string): string | null {
  const seg = key.split('/');
  // prefix(3) + 'revisions' + id + at least one path segment below it
  if (seg.length < CANONICAL_PREFIX_SEGMENTS + 3) return null;
  if (seg[0] !== 'simulations') return null;
  if (seg[CANONICAL_PREFIX_SEGMENTS] !== REVISIONS_SEGMENT) return null;
  const id = seg[CANONICAL_PREFIX_SEGMENTS + 1];
  if (!id || !isValidRevisionId(id)) return null;
  // The segment below the id must be non-empty. A trailing slash splits to a final '' segment, so a
  // length check alone accepts `…/revisions/<id>/` — a directory marker, not a file in the revision.
  return seg.slice(CANONICAL_PREFIX_SEGMENTS + 2).some((p) => p.length > 0) ? id : null;
}

/** Is this key inside ANY immutable revision? */
export const isImmutableRevisionKey = (key: string): boolean => revisionIdFromKey(key) !== null;

// ─── Cache policy ─────────────────────────────────────────────────────────────────────────────

/**
 * One year, immutable. Correct ONLY because the path contains the revision id and revision bytes
 * are never rewritten — so this URL can never come to mean different bytes.
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Anything that RESOLVES a pointer. Must revalidate, every time.
 *
 * `no-cache` (not `no-store`): revalidation with an ETag is cheap and keeps the 304 path, whereas
 * `no-store` would re-download the pointer payload on every section entry for no benefit. What must
 * never happen is a cached pointer outliving a rollback — that is precisely the window in which a
 * viewer keeps loading a revision an operator has already withdrawn.
 */
export const POINTER_CACHE_CONTROL = 'no-cache, must-revalidate';

/**
 * The entry document is NOT immutable, even inside a revision.
 *
 * `injectSimBootSnippet` runs at SERVE time, so the bytes a viewer receives for the entry HTML are
 * not the bytes stored at that key. A year-long immutable header would pin whichever snippet was
 * live when the response was first cached, so a later snippet fix could never reach those viewers —
 * while the manifest, which hashes STORED bytes, went on reporting perfect agreement.
 *
 * This is the one place where "the path contains the revision id" does not justify caching forever,
 * because the transform is applied downstream of the path.
 */
export function cacheControlForKey(key: string, isEntryDocument = false): string {
  if (isEntryDocument) return POINTER_CACHE_CONTROL;
  return isImmutableRevisionKey(key) ? IMMUTABLE_CACHE_CONTROL : POINTER_CACHE_CONTROL;
}

// ─── Row shape ────────────────────────────────────────────────────────────────────────────────

export interface SimRevisionRecord {
  id: string;
  simulationId: string;
  revisionNumber: number;
  status: SimRevisionStatus;
  manifestHash: string | null;
  bridgeProtocolVersion: number | null;
  runtimeProtocolVersion: number | null;
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  /** Set when this revision was created BY a rollback, naming what it restored. */
  rollbackOfRevisionId: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * `activatedAt` as epoch ms. An unparseable value sorts LAST rather than throwing: a malformed
 * timestamp must not make rollback impossible, but it must never be chosen as the target either.
 */
function activatedAtMs(r: SimRevisionRecord): number {
  const t = Date.parse(String(r.activatedAt));
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * Which revision a rollback should restore: the most recently active one that is not the current.
 *
 * Ordered by `activatedAt` and not by `revisionNumber`, because a rollback re-activates an OLDER
 * number — so after one rollback the highest number is no longer the most recent, and rolling back
 * again by number would restore the revision that was just withdrawn.
 */
export function rollbackTargetFor(
  revisions: readonly SimRevisionRecord[],
  currentActiveId: string | null,
): SimRevisionRecord | null {
  const candidates = revisions
    // `status !== 'active'` is load-bearing, not belt-and-braces. `mustRetainBytes('active')` is
    // true, so a caller passing a null `currentActiveId` — because the pointer it read was out of
    // sync with the status column, which is exactly the situation a rollback is reaching for — was
    // handed back the very revision it is trying to escape.
    .filter((r) =>
      r.id !== currentActiveId &&
      r.status !== 'active' &&
      r.activatedAt !== null &&
      mustRetainBytes(r.status))
    // Compared as epoch milliseconds, not as strings. `activatedAt` is documented as an ISO-8601 UTC
    // string, but lexicographic order only agrees with chronological order when every value shares
    // one format — '...+00:00' sorts before '...Z' for the same instant — and Drizzle returns a Date
    // for `timestamp(..., {withTimezone: true})` unless `mode: 'string'` is set. Date.parse accepts
    // both, so the ordering cannot silently invert on a shape change in the data layer.
    .sort((a, b) => activatedAtMs(b) - activatedAtMs(a));
  return candidates[0] ?? null;
}
