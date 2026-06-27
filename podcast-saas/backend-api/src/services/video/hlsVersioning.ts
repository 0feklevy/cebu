function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const re = new RegExp(`^hls/${escapeRegex(videoFileId)}/([^/]+)/master\\.m3u8$`);
  const oldRunId = oldMasterKey.match(re)?.[1];
  if (oldRunId && oldRunId !== currentRunId) return `hls/${videoFileId}/${oldRunId}`;
  return null;
}
