/**
 * Is this key REALLY inside an immutable revision? Verified against the revision table, not
 * inferred from the shape of the path.
 *
 * WHY PATH SHAPE IS NOT ENOUGH
 * `revisionIdFromKey` is positional: it accepts `simulations/<p>/<s>/revisions/<id>/<...>` where
 * `<id>` matches `^[A-Za-z0-9_-]{8,64}$`. Real revision ids are UUIDs (`sim_revisions.id` is
 * `uuid ... defaultRandom()`), but that pattern also accepts `chapter01`, `assets-v2`, `lecture-3`
 * — ordinary directory names. "Replace simulation" writes a customer's bundle verbatim under the
 * simulation prefix, so a customer whose package contains a top-level `revisions/` directory lands
 * exactly at the canonical depth and is handed `max-age=31536000, immutable` for a MUTABLE object.
 * The next replace overwrites those bytes and every viewer that cached them keeps the old copy for
 * a year with no revalidation path. The route percent-decodes its wildcard, so `%2F` arrives as a
 * real separator and the shape can also be requested directly.
 *
 * The positional parser fixed a narrower version of this (a first-match scan that also matched
 * `package/revisions/...`), and its own comment names the top-level-`revisions/` case — but the
 * canonical-depth check cannot distinguish a customer directory at that depth from ours. Only the
 * revision table can.
 *
 * FAIL CLOSED. Any doubt — unparseable key, non-UUID id, database error, no matching row — answers
 * "not a revision", which yields the pre-existing `no-cache` behaviour. Being wrong in that
 * direction costs a revalidation round trip; being wrong in the other direction poisons a URL for a
 * year.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { sim_revisions } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { revisionIdFromKey } from 'shared/sim/simRevision';

/** Real revision ids are database UUIDs. Cheap pre-filter so ordinary paths never reach the DB. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Canonical layout: simulations/<projectId>/<simulationId>/revisions/<revisionId>/<...> */
const SIMULATION_ID_SEGMENT = 2;

export interface RevisionCoords {
  simulationId: string;
  revisionId: string;
}

/**
 * The (simulation, revision) pair a key claims to belong to, or null when the key is not shaped
 * like a revision at all. Shape only — this makes no claim that either id exists.
 */
export function revisionCoordsFromKey(key: string): RevisionCoords | null {
  const revisionId = revisionIdFromKey(key);
  if (!revisionId || !UUID_RE.test(revisionId)) return null;
  const simulationId = key.split('/')[SIMULATION_ID_SEGMENT];
  if (!simulationId || !UUID_RE.test(simulationId)) return null;
  return { simulationId, revisionId };
}

/**
 * Positive and negative answers are both cached, briefly.
 *
 * A revision's existence is effectively immutable once created, but `gc()` can delete one, so a
 * positive is not cached forever. A negative is cached too, because legacy keys are the common case
 * on this hot path and re-querying for every asset of every legacy package would put a database
 * round trip in front of static file serving. The TTL is short enough that a newly published
 * revision starts getting immutable caching within a minute.
 */
const TTL_MS = 60_000;
const MAX_ENTRIES = 5_000;
const cache = new Map<string, { verified: boolean; at: number }>();

/** Test-only: drop memoised answers so a suite's rows are not shadowed by an earlier suite's. */
export function resetRevisionIdentityCacheForTest(): void {
  cache.clear();
}

function remember(cacheKey: string, verified: boolean): boolean {
  // Bounded, and oldest-first: Map preserves insertion order, so the first key is the oldest.
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey, { verified, at: Date.now() });
  return verified;
}

/**
 * True only when the key names a revision row that exists AND belongs to the simulation in the same
 * key. Both halves matter: without the simulation check, one project's real revision id would grant
 * immutable caching under another simulation's prefix.
 */
export async function isVerifiedRevisionKey(key: string): Promise<boolean> {
  const coords = revisionCoordsFromKey(key);
  if (!coords) return false;

  const cacheKey = `${coords.simulationId}/${coords.revisionId}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.verified;

  try {
    const rows = await db
      .select({ id: sim_revisions.id })
      .from(sim_revisions)
      .where(and(
        eq(sim_revisions.id, coords.revisionId),
        eq(sim_revisions.simulation_id, coords.simulationId),
      ))
      .limit(1);
    return remember(cacheKey, rows.length > 0);
  } catch (err) {
    // Not cached: a transient database fault must not pin "mutable" for the whole TTL, and must
    // never pin "immutable" at all.
    logger.warn({ err, key }, 'revision identity check failed — serving as mutable');
    return false;
  }
}
