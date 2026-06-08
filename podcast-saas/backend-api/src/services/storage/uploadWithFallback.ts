import { getStorageAdapter } from './getStorageAdapter.js';
import { LocalStorageAdapter } from './LocalStorageAdapter.js';
import { logger } from '../../lib/logger.js';

/**
 * Upload to the primary storage adapter; if the primary write is rejected (e.g.
 * a read-only R2 token returns "Access Denied"), fall back to local-disk storage
 * (served by the /local-storage/* route). Returns the public URL.
 *
 * Mirrors the inline fallback already used for thumbnails/banners so generated
 * media (music, SFX, …) keeps working when object-storage writes are unavailable.
 */
export async function uploadWithFallback(key: string, data: Buffer, contentType: string): Promise<string> {
  try {
    return await getStorageAdapter().uploadFile(key, data, contentType);
  } catch (err) {
    logger.warn(
      { key, err: (err as Error).message?.slice(0, 120) },
      '[storage] primary upload failed — falling back to local storage',
    );
    return new LocalStorageAdapter().uploadFile(key, data, contentType);
  }
}
