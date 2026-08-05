/**
 * The `packageRevision` identity axis for a simulation — ONE resolver, deliberately.
 *
 * An earlier draft exported `packageRevisionOf(revisionId)` as a replacement for
 * `simIdentity.derivePackageRevision`, justified by a defect that no longer exists: the derivation
 * used to read the section URL's `?v=`, which could disagree between two sections of one package.
 * Migration 049 fixed that by putting `bridge_hash` on the simulations row, and `buildPlayerConfig`
 * has read the row ever since.
 *
 * Shipping both would fork the axis, and the axis is compared by the reveal invariant. Three costs,
 * each traced rather than hypothesised:
 *   • every `sim_posters` row is keyed on the derived value, and the lookup has a deliberate
 *     no-fallback policy — a package that switched derivations would lose every poster it has;
 *   • the canary verdict is cleared only when `bridge_hash` changes, and activation/rollback change
 *     which bytes are served WITHOUT touching it — so after a rollback the player would pick its
 *     path from the withdrawn revision's verdict;
 *   • four Playwright suites and a golden vector pin the derived value.
 *
 * So: a simulation with an active revision takes its identity from the revision (immutable bytes,
 * exactly what the axis is supposed to mean); one without takes the pre-revision derivation. The
 * caller passes what it has, and there is only ever one answer.
 */
export function packageRevisionFor(
  sim: { id: string; bridge_hash?: string | null; active_revision_id?: string | null },
  derivePreRevision: (simulationId: string, bridgeHash: string | null | undefined) => string,
): string {
  return sim.active_revision_id
    ? sha256Hex(`rev\u0000${sim.active_revision_id}`).slice(0, 16)
    : derivePreRevision(sim.id, sim.bridge_hash ?? null);
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
  // Takes the simulation's OWN storage_prefix rather than re-composing it from ids. Two
  // constructions of one prefix is the same mistake as two derivations of one revision, and
  // PosterService already takes the prefix as a parameter for exactly this reason.
  return `${storagePrefix.replace(/\/+$/, '')}/revisions/${revisionId}`;
}

export const MANIFEST_FILENAME = 'manifest.json';

export function revisionManifestKey(projectId: string, simulationId: string, revisionId: string): string {
  return `${revisionPrefix(projectId, simulationId, revisionId)}/${MANIFEST_FILENAME}`;
}

/** Where one manifest-relative path lives inside a revision. */
export function revisionFileKey(
  projectId: string,
  simulationId: string,
  revisionId: string,
  manifestPath: string,
): string {
  return `${revisionPrefix(projectId, simulationId, revisionId)}/${manifestPath}`;
}

/** The subtree a customer's own bytes live in. */
export const PACKAGE_SUBDIR = 'package';
export const RUNTIME_SUBDIR = 'runtime';
export const POSTERS_SUBDIR = 'posters';
export const CANARY_SUBDIR = 'canary';

/**
 * Recover the revision id from a storage key, or null.
 *
 * The serving layer needs this to decide whether a key is inside a revision (cacheable forever) or
 * on a legacy mutable path (must revalidate). Returning null for anything unrecognised means an
 * unfamiliar key is treated as mutable — the safe direction.
 */
export function revisionIdFromKey(key: string): string | null {
  const m = /^simulations\/[^/]+\/[^/]+\/revisions\/([A-Za-z0-9_-]{8,64})\//.exec(key);
  return m ? m[1] : null;
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

export function cacheControlForKey(key: string): string {
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
  // ISO-8601 UTC strings, NOT Date. Drizzle returns `Date` for `timestamp(..., {withTimezone})`
  // unless `mode: 'string'` is set, and the ordering below compares lexicographically — handed a
  // Date it would compare object identity and silently order by insertion. The mapper at the DB
  // boundary must call .toISOString(); this type is what makes forgetting that a compile error.
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  /** Set when this revision was created BY a rollback, naming what it restored. */
  rollbackOfRevisionId: string | null;
  metadata: Record<string, unknown> | null;
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
    // `status !== 'active'` is load-bearing, not belt-and-braces: mustRetainBytes('active') is true,
    // so a caller that passes a null currentActiveId — because the pointer it read was out of sync
    // with the status column — would be handed back the very revision it is trying to escape.
    .filter((r) =>
      r.id !== currentActiveId &&
      r.status !== 'active' &&
      r.activatedAt !== null &&
      mustRetainBytes(r.status))
    .sort((a, b) => (a.activatedAt! < b.activatedAt! ? 1 : a.activatedAt! > b.activatedAt! ? -1 : 0));
  return candidates[0] ?? null;
}
