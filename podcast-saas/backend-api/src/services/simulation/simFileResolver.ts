/**
 * Where a simulation's file actually lives — its own prefix, or a shared blob (migration 080).
 *
 * ── WHAT THIS SITS IN FRONT OF ────────────────────────────────────────────────────────────────
 * `/sim-public/*` receives a storage key under a simulation's prefix and either proxies it or
 * redirects to its CDN URL. Both branches need one thing: the key the bytes are actually at. For
 * a package uploaded the old way that is the requested key itself. For a DEDUPLICATED package —
 * one imported from another project without copying a byte — the bytes are at `blobs/<digest>`
 * and the requested path is a name, not a location.
 *
 * So this resolves a name to a location, and every caller downstream is unchanged.
 *
 * ── THE CACHE, AND WHY BOTH ANSWERS ARE CACHED ────────────────────────────────────────────────
 * A sim serves dozens of assets per page load and the serving path already caches its revision
 * lookup the same way. Caching only the HITS would leave every legacy simulation — the common
 * case, and the one with the most files — paying a database round trip per asset forever. So a
 * miss is cached too, and briefly: short enough that an import becomes visible without a restart,
 * long enough that one page load is one query rather than forty.
 *
 * ── WHY A MISS IS NEVER AN ERROR ──────────────────────────────────────────────────────────────
 * "No mapping" is the correct, expected answer for every package that predates 080. A resolver
 * that threw, or that treated a failed query as "not found and remember that", would take working
 * simulations offline on a transient database blip. A query FAILURE is therefore not cached and
 * resolves to the prefix key — the behaviour that has always been right for that key.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { sim_files, media_blobs } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';

/** How long a resolution is trusted. Short — an import must become visible without a restart. */
export const SIM_FILE_CACHE_MS = 60_000;

interface Entry { key: string | null; at: number }
const cache = new Map<string, Entry>();

/** Test seam, and the hook a future invalidation-on-import can use. */
export function resetSimFileCache(): void {
  cache.clear();
}

/**
 * Split a full sim storage key into the simulation it belongs to and the path within it.
 *
 * The prefix grammar is `simulations/{projectId}/{simulationId}/...`, three fixed segments before
 * the bundle-relative remainder. Positional rather than pattern-matched, exactly as
 * `revisionIdFromKey` is: ids are not fixed-length and a regex over them is a guess.
 */
export function splitSimKey(key: string): { simulationId: string; relPath: string } | null {
  const parts = key.split('/');
  if (parts.length < 4 || parts[0] !== 'simulations') return null;
  const simulationId = parts[2];
  const relPath = parts.slice(3).join('/');
  if (!simulationId || !relPath) return null;
  return { simulationId, relPath };
}

/**
 * The storage key holding this file's bytes.
 *
 * Returns the requested key unchanged when the simulation is not deduplicated — which is every
 * package that predates 080, and the reason this is safe to put in front of everything.
 */
export async function resolveSimFileKey(requestedKey: string): Promise<string> {
  const split = splitSimKey(requestedKey);
  // A key that is not under a simulation prefix is not ours to reinterpret.
  if (!split) return requestedKey;

  const cacheKey = `${split.simulationId}|${split.relPath}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < SIM_FILE_CACHE_MS) {
    return hit.key ?? requestedKey;
  }

  // Declared WITHOUT an initialiser on purpose: the catch below returns, so the only way to
  // reach the cache write is the try completing and assigning. A `= null` here would be dead,
  // and worse, it would read as "not deduplicated" being a real outcome of a failed query — the
  // exact confusion the catch's own comment warns against.
  let blobKey: string | null;
  try {
    const [row] = await db
      .select({ storage_key: media_blobs.storage_key })
      .from(sim_files)
      .innerJoin(media_blobs, eq(media_blobs.id, sim_files.blob_id))
      .where(and(eq(sim_files.simulation_id, split.simulationId), eq(sim_files.rel_path, split.relPath)))
      .limit(1);
    blobKey = row?.storage_key ?? null;
  } catch (e) {
    // NOT cached, and NOT an error to the viewer: a transient database problem must not take a
    // working simulation offline, and must not be remembered as "this file is not deduplicated".
    logger.warn({ evt: 'sim_file_resolve_failed', err: (e as Error)?.name }, '[SimFiles] resolve failed — serving the prefix key');
    return requestedKey;
  }

  cache.set(cacheKey, { key: blobKey, at: Date.now() });
  return blobKey ?? requestedKey;
}

/** True when this simulation stores its files as shared blobs rather than under its own prefix. */
export async function isDeduplicatedSimulation(simulationId: string): Promise<boolean> {
  const [row] = await db
    .select({ blob_id: sim_files.blob_id })
    .from(sim_files)
    .where(eq(sim_files.simulation_id, simulationId))
    .limit(1);
  return !!row;
}
