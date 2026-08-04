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
 * The `packageRevision` the runtime protocol compares.
 *
 * Derived from the revision id alone — not from bytes, not from the bridge hash — because with
 * immutable revisions the id already IS the identity of the bytes. This replaces
 * `simIdentity.derivePackageRevision`, whose input (the section URL's `?v=`) could disagree between
 * two sections of one package.
 */
export function packageRevisionOf(revisionId: string): string {
  return sha256Hex(`rev:${revisionId}`).slice(0, 16);
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
export function revisionPrefix(projectId: string, simulationId: string, revisionId: string): string {
  return `simulations/${projectId}/${simulationId}/revisions/${revisionId}`;
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
    .filter((r) => r.id !== currentActiveId && r.activatedAt !== null && mustRetainBytes(r.status))
    .sort((a, b) => (a.activatedAt! < b.activatedAt! ? 1 : a.activatedAt! > b.activatedAt! ? -1 : 0));
  return candidates[0] ?? null;
}
