import { getStorageAdapter } from './getStorageAdapter.js';
import { R2StorageAdapter } from './R2StorageAdapter.js';
import { LocalStorageAdapter } from './LocalStorageAdapter.js';
import { logger } from '../../lib/logger.js';
import { isContentAddressedKey } from './projectDeletionPlan.js';

// Deletes must hit wherever the bytes actually landed. Because uploads fall back to
// local disk when R2 is read-only (uploadWithFallback), media may live on local disk
// even though the primary adapter is R2 — in which case an R2-only delete is a no-op
// and the local bytes leak forever (review backend-003). These helpers delete from the
// primary AND, when the primary is R2, best-effort from local disk too.

export async function deleteWithFallback(key: string): Promise<void> {
  // ── SHARED BYTES ARE NOT ANY CALLER'S TO DELETE (migration 078) ─────────────────────────────
  // A key under blobs/ is content-addressed and may be referenced by ANY number of projects. The
  // row deletions the callers here perform are correct and sufficient — the bytes themselves are
  // removed only by the sweeper, once nothing references the blob row and a grace period has
  // passed. Refusing here, at the one chokepoint every deleter goes through, means no current or
  // FUTURE call site can destroy bytes another project is serving; the alternative — trusting
  // every caller to remember — is the pattern that produced this repo's writer/deleter asymmetry
  // in the first place.
  if (isContentAddressedKey(key)) {
    logger.info({ evt: 'blob_delete_refused', key }, '[storage] delete of a shared blob key refused — the sweeper owns blob lifecycle');
    return;
  }
  const storage = getStorageAdapter();
  await storage.deleteFile(key).catch((err) =>
    logger.warn({ key, err: (err as Error).message?.slice(0, 120) }, '[storage] primary delete failed'),
  );
  if (storage instanceof R2StorageAdapter) {
    await new LocalStorageAdapter().deleteFile(key).catch(() => {});
  }
}

export async function deleteWithPrefixFallback(prefix: string): Promise<void> {
  // Same refusal for prefix deletes: a prefix at or inside blobs/ could sweep shared bytes en
  // masse. (A per-project prefix like `images/{projectId}` can never reach blobs/ — the namespaces
  // are disjoint by construction — so legitimate callers lose nothing.)
  if (isContentAddressedKey(prefix)) {
    logger.warn({ evt: 'blob_prefix_delete_refused', prefix }, '[storage] prefix delete inside the blob namespace refused');
    return;
  }
  const storage = getStorageAdapter();
  await storage.deleteWithPrefix(prefix).catch((err) =>
    logger.warn({ prefix, err: (err as Error).message?.slice(0, 120) }, '[storage] primary prefix delete failed'),
  );
  if (storage instanceof R2StorageAdapter) {
    await new LocalStorageAdapter().deleteWithPrefix(prefix).catch(() => {});
  }
}
