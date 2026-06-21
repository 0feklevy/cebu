import { isAbsolute, join, resolve } from 'path';

/**
 * Durable base directory for local-disk storage — the fallback used whenever an
 * R2 object write is denied (read-only token → "Access Denied").
 *
 * This MUST be a persistent directory. The previous implementation wrote to
 * `os.tmpdir()`, which managed hosts (and the OS) wipe on restart/redeploy — so
 * thumbnails, playlist banners and other fallback media silently vanished from
 * the server even though their URLs were saved in the DB. Writing under the app
 * working directory (or an explicit LOCAL_STORAGE_DIR) keeps them across restarts.
 *
 * The adapter (LocalStorageAdapter) and the server's /local-storage, /hls-public,
 * /video-raw and /sim-public serve routes all resolve to THIS constant, so reads
 * and writes always agree.
 */
export const LOCAL_STORAGE_BASE_DIR: string = (() => {
  const override = process.env.LOCAL_STORAGE_DIR?.trim();
  if (override) return isAbsolute(override) ? override : resolve(process.cwd(), override);
  return join(process.cwd(), '.local-storage');
})();

/** Absolute on-disk path for a storage key under the durable base dir. */
export function localStoragePathFor(key: string): string {
  return join(LOCAL_STORAGE_BASE_DIR, key);
}
