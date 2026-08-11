/**
 * Cache-Control for every object under a VERSIONED HLS run tree (`hls/{videoFileId}/{runId}/…`).
 *
 * The whole run tree — segments, variant playlists, AND the master playlist — is write-once:
 * a re-transcode writes a fresh tree under a new runId and flips the DB pointer
 * (`video_files.hls_master_key`); nothing under an existing runId is ever rewritten. The
 * mutable thing is the DB row, so run-tree bytes can be cached forever.
 */
export const HLS_IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

interface VersionedHlsKey {
  videoFileId: string;
  runId: string;
  /** The path inside the run tree, e.g. `master.m3u8` or `360p/seg_000.ts`. */
  rest: string;
}

/**
 * Parse a storage key of the versioned shape `hls/{videoFileId}/{runId}/{rest}` — the ONE
 * key-shape definition shared by the GC filter and the cache-header helper below, so the two
 * can never disagree about what "versioned" means.
 *
 * Returns null for legacy unversioned keys (`hls/{id}/master.m3u8` — only 3 segments), for
 * non-HLS keys, and for keys with empty path segments.
 */
function parseVersionedHlsKey(key: string): VersionedHlsKey | null {
  const parts = key.split('/');
  if (parts.length < 4 || parts[0] !== 'hls') return null;
  const [, videoFileId, runId, ...rest] = parts;
  if (!videoFileId || !runId || rest.some((seg) => seg.length === 0)) return null;
  return { videoFileId, runId, rest: rest.join('/') };
}

/**
 * Given a video's previous `hls_master_key`, return the prefix of the previous *versioned*
 * HLS tree to garbage-collect after a new transcode run — or `null` when there's nothing
 * safe to delete.
 *
 * Only a versioned old tree (`hls/{id}/{oldRunId}/master.m3u8`) is GC'd, and only when the
 * run differs. Legacy unversioned keys (`hls/{id}/master.m3u8`) return `null` so we never
 * delete the new tree, which lives under the same `hls/{id}/` parent.
 */
export function previousHlsTreeToGc(
  videoFileId: string,
  oldMasterKey: string | null | undefined,
  currentRunId: string,
): string | null {
  if (!oldMasterKey) return null;
  const parsed = parseVersionedHlsKey(oldMasterKey);
  if (!parsed || parsed.videoFileId !== videoFileId || parsed.rest !== 'master.m3u8') return null;
  if (parsed.runId === currentRunId) return null;
  return `hls/${videoFileId}/${parsed.runId}`;
}

/**
 * The response Cache-Control for a served HLS key, or `null` meaning "use the route default".
 *
 * Keys inside a versioned run tree are immutable (see HLS_IMMUTABLE_CACHE_CONTROL). Legacy
 * unversioned keys stay on the route defaults because legacy trees were overwritten in place
 * on re-transcode — marking them immutable would pin a stale playlist for a year.
 *
 * Shape disambiguation (versioned trees are one level deeper than legacy ones):
 * - `hls/{id}/{runId}/master.m3u8`        → immutable (a legacy master sits at depth 3, never 4)
 * - `hls/{id}/{runId}/{tier}/{file}`       → immutable (legacy keys never reach depth 5)
 * - `hls/{id}/{x}/{file}` (not master)     → null: shape-identical to a legacy tier file
 *                                            (`hls/{id}/360p/seg_000.ts`), so stay conservative.
 * - non-HLS / malformed / depth < 4        → null
 */
export function hlsCacheControlForKey(key: string): string | null {
  const parsed = parseVersionedHlsKey(key);
  if (!parsed) return null;
  if (parsed.rest === 'master.m3u8') return HLS_IMMUTABLE_CACHE_CONTROL;
  if (parsed.rest.includes('/')) return HLS_IMMUTABLE_CACHE_CONTROL;
  return null;
}
