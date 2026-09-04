/**
 * STORAGE_BACKEND=migrating resolves the cutover adapter from two NAMED providers with real
 * credentials — and refuses a half-configured window rather than becoming one provider silently.
 * STORAGE_BACKEND=r2 is an explicit provider now, and the R2 custom domain is the public base.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildNamedAdapter, getStorageAdapter, resetStorageAdapterForTest } from '../getStorageAdapter.js';
import { MigratingStorageAdapter } from '../MigratingStorageAdapter.js';
import { R2StorageAdapter } from '../R2StorageAdapter.js';
import { SupabaseStorageAdapter } from '../SupabaseStorageAdapter.js';

const KEYS = ['NODE_ENV', 'STORAGE_BACKEND', 'STORAGE_PRIMARY', 'STORAGE_SECONDARY', 'SUPABASE_URL', 'SUPABASE_S3_ACCESS_KEY_ID', 'SUPABASE_S3_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_URL', 'R2_PUBLIC_BASE_URL', 'PUBLIC_API_URL', 'NEXT_PUBLIC_API_URL'];
const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
function setEnv(env: Record<string, string | undefined>) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
}
const REAL_SUPABASE = { SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_S3_ACCESS_KEY_ID: 'sb-key-1234567890', SUPABASE_S3_SECRET_ACCESS_KEY: 'sb-secret-1234567890' };
const REAL_R2 = { R2_ACCOUNT_ID: 'acct-1234567890', R2_ACCESS_KEY_ID: 'r2-key-1234567890', R2_SECRET_ACCESS_KEY: 'r2-secret-1234567890', R2_PUBLIC_URL: 'https://pub.r2.dev/podcast-saas' };

afterEach(() => {
  resetStorageAdapterForTest();
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('STORAGE_BACKEND=migrating', () => {
  it('resolves the cutover adapter from two named providers, in production too', () => {
    setEnv({ NODE_ENV: 'production', STORAGE_BACKEND: 'migrating', STORAGE_PRIMARY: 'r2', STORAGE_SECONDARY: 'supabase', ...REAL_SUPABASE, ...REAL_R2 });
    const a = getStorageAdapter();
    expect(a).toBeInstanceOf(MigratingStorageAdapter);
    expect((a as MigratingStorageAdapter).primary).toBeInstanceOf(R2StorageAdapter);
    expect((a as MigratingStorageAdapter).secondary).toBeInstanceOf(SupabaseStorageAdapter);
  });

  it('refuses a window missing a provider name, the same provider twice, or placeholder credentials', () => {
    setEnv({ STORAGE_BACKEND: 'migrating', STORAGE_PRIMARY: 'r2', ...REAL_SUPABASE, ...REAL_R2 });
    expect(() => getStorageAdapter()).toThrow(/STORAGE_PRIMARY and STORAGE_SECONDARY/);
    resetStorageAdapterForTest();
    setEnv({ STORAGE_BACKEND: 'migrating', STORAGE_PRIMARY: 'r2', STORAGE_SECONDARY: 'r2', ...REAL_R2 });
    expect(() => getStorageAdapter()).toThrow(/must differ/);
    resetStorageAdapterForTest();
    setEnv({ STORAGE_BACKEND: 'migrating', STORAGE_PRIMARY: 'r2', STORAGE_SECONDARY: 'supabase', ...REAL_SUPABASE, R2_ACCOUNT_ID: 'your-account-id', R2_ACCESS_KEY_ID: 'your-access-key', R2_SECRET_ACCESS_KEY: 'your-secret-key' });
    expect(() => getStorageAdapter()).toThrow(/R2 is named but/);
  });
});

describe('named providers', () => {
  it('STORAGE_BACKEND=r2 is explicit, and buildNamedAdapter refuses an unknown name', () => {
    setEnv({ STORAGE_BACKEND: 'r2', ...REAL_R2, ...REAL_SUPABASE });
    expect(getStorageAdapter()).toBeInstanceOf(R2StorageAdapter);
    expect(() => buildNamedAdapter('minio')).toThrow(/Unknown storage provider/);
  });

  it('the R2 custom domain is the public base when set, and both bases reverse to a key', () => {
    setEnv({ ...REAL_R2, R2_PUBLIC_BASE_URL: 'https://media.flowvidco.com/' });
    const r2 = new R2StorageAdapter();
    // Sim ENTRY urls go through the /sim-public proxy — the direct-bucket answer this line used
    // to pin was the sim-review 2026-09-04 P0 (no CSP, no boot snippet, no publication gate).
    // The custom domain remains the base for the binary-asset redirect and for the inverse.
    expect(r2.getSimPublicUrl('simulations/p/s/index.html')).toContain('/sim-public/simulations/p/s/index.html');
    expect(r2.getSimAssetRedirectUrl('simulations/p/s/models/m.glb')).toBe('https://media.flowvidco.com/simulations/p/s/models/m.glb');
    expect(r2.keyFromPublicUrl('https://media.flowvidco.com/images/a.png')).toBe('images/a.png');
    expect(r2.keyFromPublicUrl('https://pub.r2.dev/podcast-saas/images/a.png')).toBe('images/a.png');
  });
});
