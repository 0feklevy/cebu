import { R2StorageAdapter } from './R2StorageAdapter.js';
import { SupabaseStorageAdapter } from './SupabaseStorageAdapter.js';
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

// Supabase Storage is the chosen writable provider (R2 token is read-only). Active when
// its S3 credentials are present, or when STORAGE_BACKEND=supabase is set explicitly.
function hasSupabaseStorage(): boolean {
  return (
    isRealCred(process.env.SUPABASE_S3_ACCESS_KEY_ID) &&
    isRealCred(process.env.SUPABASE_S3_SECRET_ACCESS_KEY) &&
    !!(process.env.SUPABASE_URL || process.env.SUPABASE_S3_ENDPOINT)
  );
}

export function getStorageAdapter(): StorageService {
  if (_adapter) return _adapter;

  const backend = process.env.STORAGE_BACKEND; // optional explicit override

  // Explicit opt-in (e.g. a read-only R2 environment) or runtime probe result.
  if (_forceLocal || backend === 'local') {
    _adapter = new LocalStorageAdapter();
    return _adapter;
  }

  // Prefer Supabase Storage (the writable provider) when configured. Stays off the R2
  // path entirely so the read-only-R2 fallback fragility doesn't apply.
  if (backend === 'supabase' || (!backend && hasSupabaseStorage())) {
    _adapter = new SupabaseStorageAdapter();
    logger.info('Storage backend: Supabase Storage (S3-compatible)');
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

  // Fail closed in production: this is a multi-user, scalable app — media must be in a
  // shared cloud bucket, never per-instance local disk. Refuse to silently use local.
  if (!hasR2 && process.env.NODE_ENV === 'production') {
    throw new Error(
      'No cloud storage configured. Set SUPABASE_S3_* (or real R2_*) credentials — ' +
        'local-disk storage is not allowed in production.',
    );
  }

  _adapter = hasR2 ? new R2StorageAdapter() : new LocalStorageAdapter();
  return _adapter;
}

/**
 * Test-only: reset the cached adapter + forced-local flag so each test starts from a
 * clean slate. The module-level singleton otherwise leaks state across tests in the
 * same vitest worker (see review tq-007 / arch-002).
 */
export function resetStorageAdapterForTest(): void {
  _adapter = null;
  _forceLocal = false;
}
