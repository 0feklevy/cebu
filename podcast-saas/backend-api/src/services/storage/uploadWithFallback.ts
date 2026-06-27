import { getStorageAdapter } from './getStorageAdapter.js';
import { logger } from '../../lib/logger.js';

/**
 * Upload to cloud object storage. **Cloud-only** — media must live in the shared
 * bucket so every app instance can serve it and nothing is lost on redeploy (this is
 * a multi-user, horizontally-scalable app — no per-instance local disk). Transient
 * failures are retried; a persistent failure throws (callers surface a real error)
 * rather than silently writing to local disk where other instances can't see it.
 *
 * (The name is kept for compatibility; the "fallback" is now retry, not local disk.)
 */
export async function uploadWithFallback(key: string, data: Buffer, contentType: string): Promise<string> {
  const attempts = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await getStorageAdapter().uploadFile(key, data, contentType);
    } catch (err) {
      lastErr = err;
      if (attempt < attempts - 1) {
        logger.warn(
          { key, attempt, err: (err as Error).message?.slice(0, 120) },
          '[storage] cloud upload failed — retrying',
        );
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
  }
  throw lastErr;
}
