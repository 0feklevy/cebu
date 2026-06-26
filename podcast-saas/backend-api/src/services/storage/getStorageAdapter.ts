import { R2StorageAdapter } from './R2StorageAdapter.js';
import { LocalStorageAdapter } from './LocalStorageAdapter.js';
import type { StorageService } from './StorageService.js';
import { logger } from '../../lib/logger.js';

let _adapter: StorageService | null = null;
let _forceLocal = false;

// A real R2 credential is non-empty, not a copied .env.example placeholder
// (e.g. "your-account-id"), and long enough to be a genuine Cloudflare value.
// This prevents partially-filled .env files from flipping storage to a broken
// R2 adapter (which 502s on every list/read) instead of using local disk.
function isRealCred(v: string | undefined): boolean {
  if (!v) return false;
  const t = v.trim();
  if (t.length < 10) return false;
  if (/^your-/i.test(t)) return false;
  if (/^(changeme|placeholder|xxx+|todo|dummy)$/i.test(t)) return false;
  return true;
}

/**
 * Force every storage operation onto durable local disk for the rest of the
 * process. Called at startup when the R2 write-probe is denied (read-only token →
 * PutObject AccessDenied): keeping R2 would make uploads 500 and writes silently
 * vanish, so we route the whole pipeline (uploads, HLS, thumbnails, …) to local,
 * which has serve routes for every prefix (/local-storage, /video-raw, /hls-public).
 * Idempotent and safe to call before or after the adapter is first resolved.
 */
export function forceLocalStorage(reason: string): void {
  if (_forceLocal && _adapter instanceof LocalStorageAdapter) return;
  _forceLocal = true;
  _adapter = new LocalStorageAdapter();
  logger.warn(`Storage backend forced to local disk — ${reason}`);
}

export function getStorageAdapter(): StorageService {
  if (_adapter) return _adapter;

  // Explicit opt-in (e.g. a read-only R2 environment) or runtime probe result.
  if (_forceLocal || process.env.STORAGE_BACKEND === 'local') {
    _adapter = new LocalStorageAdapter();
    return _adapter;
  }

  const hasR2 =
    isRealCred(process.env.R2_ACCOUNT_ID) &&
    isRealCred(process.env.R2_ACCESS_KEY_ID) &&
    isRealCred(process.env.R2_SECRET_ACCESS_KEY);

  // If R2 vars are present but look like placeholders, warn and use local disk.
  const r2VarsPresent =
    process.env.R2_ACCOUNT_ID || process.env.R2_ACCESS_KEY_ID || process.env.R2_SECRET_ACCESS_KEY;
  if (!hasR2 && r2VarsPresent) {
    logger.warn('R2_* env vars look like placeholders — using local disk storage. Set real Cloudflare R2 credentials (or leave them blank) to use R2.');
  }

  _adapter = hasR2 ? new R2StorageAdapter() : new LocalStorageAdapter();
  return _adapter;
}
