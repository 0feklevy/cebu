/**
 * GC for a project thumbnail that has just been replaced.
 *
 * Four writers mint `thumbnails/{projectId}/{uuid}` and overwrite `projects.thumbnail_key` —
 * the fresh uuid is deliberate (identical URLs serve the cached previous image), but none of
 * them deleted the predecessor, so the prefix accumulated every thumbnail a project ever had
 * and project delete removed only the current one.
 *
 * Read-old-key → write-new → call this. The worst a concurrent replace can do under that
 * ordering is leak one object (exactly what every write did before) or double-delete an
 * already-deleted key (best-effort, harmless).
 *
 * The prefix guard is deliberate: a caller that accidentally hands this a raw-video or HLS key
 * must be a no-op, not a data loss.
 */
import { deleteWithFallback } from './deleteWithFallback.js';

export async function deleteSupersededThumbnail(
  oldKey: string | null | undefined,
  newKey: string,
): Promise<void> {
  if (!oldKey || oldKey === newKey) return;
  if (!oldKey.startsWith('thumbnails/')) return;
  await deleteWithFallback(oldKey);
}
