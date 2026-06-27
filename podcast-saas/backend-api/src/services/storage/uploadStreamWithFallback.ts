import { getStorageAdapter } from './getStorageAdapter.js';

/**
 * Stream-upload variant for large files (raw video uploads). **Cloud-only** — the
 * stream is piped straight to the shared object store so the bytes never touch local
 * disk (this is a multi-user, horizontally-scalable app; per-instance local media is
 * invisible to other instances and lost on redeploy). A source stream can't be
 * replayed, so a failure throws and the caller surfaces a real error.
 *
 * (Name kept for compatibility; there is no longer a local-disk fallback. The browser
 * presigned-PUT path is preferred; this is the multipart-through-API fallback, which
 * still lands the bytes in the cloud.)
 */
export async function uploadStreamWithFallback(
  key: string,
  stream: NodeJS.ReadableStream,
  contentType: string,
  contentLength?: number,
): Promise<string> {
  return getStorageAdapter().uploadStream(key, stream, contentType, contentLength);
}
