/**
 * Where /hls-proxy reads a segment FROM.
 *
 * The route used to answer that with `process.env.R2_PUBLIC_URL` — an adapter BYPASS: the storage
 * origin became an env guess made independently of the adapter that actually holds the bytes. On a
 * `STORAGE_BACKEND=supabase` deployment that still carries the legacy R2_* variables (production
 * does) it fetched a bucket Supabase never wrote to, and with the variable unset it answered
 * `500 R2_PUBLIC_URL not set` to every segment.
 *
 * Split out of the route so the decision can be asserted on its OUTPUT rather than by reading the
 * server's source, and so the one rule that must never be broken is stated in one place: the
 * upstream may never be a URL that routes back through /hls-proxy. `R2StorageAdapter.getPublicUrl`
 * deliberately mints exactly that shape (HLS is proxied so CORS headers are guaranteed), so an
 * upstream taken from `getPublicUrl` without this rule would make the route fetch itself.
 */
import { LocalStorageAdapter } from './LocalStorageAdapter.js';
import { R2StorageAdapter } from './R2StorageAdapter.js';
import type { StorageService } from './StorageService.js';

export type HlsProxyUpstream =
  /** Stream the object through the adapter's own authenticated GET (works with a read-only token). */
  | { kind: 'stream' }
  /** Fetch the adapter's public URL and pipe it through, adding the CORS headers r2.dev drops. */
  | { kind: 'fetch'; url: string }
  /** Serve the local copy via /hls-public — where the local adapter points HLS in the first place. */
  | { kind: 'local' };

export function hlsProxyUpstream(storage: StorageService, key: string): HlsProxyUpstream {
  if (storage instanceof R2StorageAdapter) return { kind: 'stream' };
  if (storage instanceof LocalStorageAdapter) return { kind: 'local' };
  const url = storage.getPublicUrl(key);
  // Never recurse into this route. An adapter that proxies HLS through the backend has no
  // fetchable public URL for the key, so the durable local copy is the only honest answer.
  if (url.includes('/hls-proxy/')) return { kind: 'local' };
  return { kind: 'fetch', url };
}
