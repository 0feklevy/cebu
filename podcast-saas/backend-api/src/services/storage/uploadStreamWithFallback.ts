import { createReadStream, statSync } from 'fs';
import { getStorageAdapter } from './getStorageAdapter.js';
import { LocalStorageAdapter } from './LocalStorageAdapter.js';
import { R2StorageAdapter } from './R2StorageAdapter.js';
import { localStoragePathFor } from './localStoragePaths.js';
import { logger } from '../../lib/logger.js';

/**
 * Stream-upload variant of uploadWithFallback for large files (raw video uploads).
 *
 * A source stream can only be consumed once, so we cannot try R2 first and then
 * re-pipe the same stream to local disk on failure. Instead we ALWAYS write the
 * stream to durable local disk first (which is always writable), then BEST-EFFORT
 * re-upload the saved file to the primary adapter (R2). When the R2 token is
 * read-only (PutObject → AccessDenied) the local copy is kept and served via the
 * /video-proxy → /video-raw fallback, so the upload never 500s.
 *
 * The caller persists `storage_key` (not the returned URL); URL resolution happens
 * later via getPresignedDownloadUrl, which the /video-proxy route resolves against
 * R2 first and falls back to the local file when R2 lacks the object.
 */
export async function uploadStreamWithFallback(
  key: string,
  stream: NodeJS.ReadableStream,
  contentType: string,
  contentLength?: number,
): Promise<string> {
  const primary = getStorageAdapter();

  // If the primary adapter is already local disk, there is nothing to fall back to.
  if (!(primary instanceof R2StorageAdapter)) {
    return primary.uploadStream(key, stream, contentType, contentLength);
  }

  // 1) Durable write to local disk — always succeeds, consumes the source stream once.
  const local = new LocalStorageAdapter();
  const localUrl = await local.uploadStream(key, stream, contentType, contentLength);

  // 2) Best-effort re-upload to R2 from the saved file. If the token is read-only
  //    this throws AccessDenied; we swallow it and keep the local copy.
  try {
    const diskPath = localStoragePathFor(key);
    const size = contentLength ?? statSync(diskPath).size;
    const replay = createReadStream(diskPath);
    return await primary.uploadStream(key, replay, contentType, size);
  } catch (err) {
    logger.warn(
      { key, err: (err as Error).message?.slice(0, 120) },
      '[storage] primary stream upload failed — serving from local storage fallback',
    );
    return localUrl;
  }
}
