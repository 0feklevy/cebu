import { getStorageAdapter } from './getStorageAdapter.js';
import { R2StorageAdapter } from './R2StorageAdapter.js';
import { LocalStorageAdapter } from './LocalStorageAdapter.js';
import { logger } from '../../lib/logger.js';

// Deletes must hit wherever the bytes actually landed. Because uploads fall back to
// local disk when R2 is read-only (uploadWithFallback), media may live on local disk
// even though the primary adapter is R2 — in which case an R2-only delete is a no-op
// and the local bytes leak forever (review backend-003). These helpers delete from the
// primary AND, when the primary is R2, best-effort from local disk too.

export async function deleteWithFallback(key: string): Promise<void> {
  const storage = getStorageAdapter();
  await storage.deleteFile(key).catch((err) =>
    logger.warn({ key, err: (err as Error).message?.slice(0, 120) }, '[storage] primary delete failed'),
  );
  if (storage instanceof R2StorageAdapter) {
    await new LocalStorageAdapter().deleteFile(key).catch(() => {});
  }
}

export async function deleteWithPrefixFallback(prefix: string): Promise<void> {
  const storage = getStorageAdapter();
  await storage.deleteWithPrefix(prefix).catch((err) =>
    logger.warn({ prefix, err: (err as Error).message?.slice(0, 120) }, '[storage] primary prefix delete failed'),
  );
  if (storage instanceof R2StorageAdapter) {
    await new LocalStorageAdapter().deleteWithPrefix(prefix).catch(() => {});
  }
}
