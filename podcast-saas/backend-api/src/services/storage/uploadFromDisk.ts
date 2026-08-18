import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { getStorageAdapter } from './getStorageAdapter.js';
import { logger } from '../../lib/logger.js';

/**
 * Upload a file that is already on local disk, without ever holding it in the heap
 * (security-007 / performance-001 / -002).
 *
 * `uploadWithFallback` takes a Buffer, which is exactly what the guarded upload routes must stop
 * producing; `uploadStreamWithFallback` takes a stream but cannot retry, because a request body
 * cannot be replayed. A FILE can be replayed — a fresh `createReadStream` is a fresh source — so
 * this variant keeps the same three-attempt retry that `uploadWithFallback` has, with the memory
 * profile of the streaming one.
 *
 * Cloud-only, like both of them: media must live in the shared bucket so every instance can serve
 * it. A persistent failure throws and the caller surfaces a real error.
 */
export async function uploadFileFromDisk(
  key: string,
  filePath: string,
  contentType: string,
): Promise<string> {
  const { size } = await stat(filePath);
  const attempts = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await getStorageAdapter().uploadStream(key, createReadStream(filePath), contentType, size);
    } catch (err) {
      lastErr = err;
      if (attempt < attempts - 1) {
        logger.warn(
          { key, attempt, err: (err as Error).message?.slice(0, 120) },
          '[storage] cloud upload from disk failed — retrying',
        );
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
  }
  throw lastErr;
}
