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
  /** Verified and canary-proven. Eligible to become active. */
  | 'canary_passed'
  /** The pointer points here. Exactly one per simulation. */
  | 'active'
  /** Was active, superseded. Bytes retained for rollback. */
  | 'retired'
  /** Publication failed. Never served. */
  | 'failed'
  /** Was active, then rolled back FROM. Distinct from `retired`: it records a judgement. */
  | 'rolled_back';

export const SIM_REVISION_STATUSES: readonly SimRevisionStatus[] = [
  'draft', 'uploading', 'validating', 'canary_passed', 'active', 'retired', 'failed', 'rolled_back',
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
  canary_passed: ['active', 'failed'],
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
 * Recover the revision id from a storage key, or null.
 *
 * Anchored on the `/revisions/<id>/` segment ALONE, deliberately.
 *
 * This regex used to require `simulations/<projectId>/<simulationId>/revisions/<id>/` — it re-derived
 * the prefix shape instead of parsing what `revisionPrefix` actually emits. That was already the
 * "two constructions of one path" bug, and changing `revisionPrefix` to take the simulation's own
 * `storage_prefix` (a free-form column, not a composed path) made it live: any simulation whose
 * prefix is not exactly that three-segment form would fail to match, and the serving layer would
 * quietly downgrade genuinely immutable bytes to revalidate-every-time. Silent, and in the direction
 * that only costs latency — which is how it would have shipped unnoticed.
 *
 * The FIRST match is the right one: `revisionPrefix` places the segment immediately after the
 * storage prefix, and customer bytes live under `package/` BELOW it. A customer directory that
 * happens to be named `revisions` is therefore found second and cannot win.
 *
 * Returning null for anything unrecognised keeps an unfamiliar key mutable — the safe direction.
 */
export function revisionIdFromKey(key: string): string | null {
  const m = /(?:^|\/)revisions\/([A-Za-z0-9_-]{8,64})\//.exec(key);
  return m ? m[1]! : null;
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
