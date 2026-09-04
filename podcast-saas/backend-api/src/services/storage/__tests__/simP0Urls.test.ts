/**
 * Sim-review 2026-09-04 P0 — the R2 adapter handed out DIRECT BUCKET URLs for simulation
 * files, bypassing /sim-public entirely: no sim CSP, no serve-time boot snippet, and no
 * revision publication gate, so a draft revision's bytes were world-readable at a URL that
 * appears in every player config. Separately, the /sim-public binary redirect used
 * `getPublicUrl`, which on R2 wraps everything in `/hls-proxy/…` — whose 'hls/' scope check
 * 403s `simulations/` keys.
 *
 * The contract pinned here:
 *   1. EVERY adapter's `getSimPublicUrl` routes through the backend's /sim-public proxy
 *      (bar the content-addressed poster fast-path, which is deliberately direct).
 *   2. R2's `getSimAssetRedirectUrl` — the 302 target for binary sim assets, used only
 *      after the route's access checks — is the direct bucket URL, never /hls-proxy.
 *   3. `MigratingStorageAdapter` answers with the primary's redirect target, falling back
 *      to `getPublicUrl` when the primary does not implement the optional method.
 *   4. Old direct-bucket sim URLs (rows written before this fix) still invert to their keys.
 */
import { describe, it, expect, afterEach } from 'vitest';

import { LocalStorageAdapter } from '../LocalStorageAdapter.js';
import { R2StorageAdapter } from '../R2StorageAdapter.js';
import { SupabaseStorageAdapter } from '../SupabaseStorageAdapter.js';
import { MigratingStorageAdapter } from '../MigratingStorageAdapter.js';

const SIM_KEY = 'simulations/8f6f0f4e-1111-4111-8111-aaaaaaaaaaaa/2222/models/kinesin.glb';
const ENTRY_KEY = 'simulations/8f6f0f4e-1111-4111-8111-aaaaaaaaaaaa/2222/index.html';
const POSTER_KEY = 'simulations/8f6f0f4e-1111-4111-8111-aaaaaaaaaaaa/2222/posters/abc123/standard.webp';

const R2_ENV: Record<string, string> = {
  R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET_NAME: 'media', R2_PUBLIC_URL: 'https://cdn.example.com',
  BACKEND_API_URL: 'https://api.example.com',
};
const SUPA_ENV: Record<string, string> = {
  SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_S3_ACCESS_KEY_ID: 'key',
  SUPABASE_S3_SECRET_ACCESS_KEY: 'secret', SUPABASE_S3_REGION: 'us-east-1',
  SUPABASE_STORAGE_BUCKET: 'media', BACKEND_API_URL: 'https://api.example.com',
};

const saved = new Map<string, string | undefined>();
const setEnv = (env: Record<string, string>): void => {
  for (const [k, v] of Object.entries(env)) { saved.set(k, process.env[k]); process.env[k] = v; }
};
afterEach(() => {
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  saved.clear();
});

describe('P0: sim files are served through /sim-public on every adapter', () => {
  it('R2 mints /sim-public URLs for entry HTML and package files', () => {
    setEnv(R2_ENV);
    const r2 = new R2StorageAdapter();
    expect(r2.getSimPublicUrl(ENTRY_KEY)).toBe(`https://api.example.com/sim-public/${ENTRY_KEY}`);
    expect(r2.getSimPublicUrl(SIM_KEY)).toBe(`https://api.example.com/sim-public/${SIM_KEY}`);
  });

  it('R2 keeps the content-addressed poster fast path on the bucket (mirrors Supabase)', () => {
    setEnv(R2_ENV);
    const r2 = new R2StorageAdapter();
    expect(r2.getSimPublicUrl(POSTER_KEY)).toBe(`https://cdn.example.com/${POSTER_KEY}`);
    setEnv(SUPA_ENV);
    const supa = new SupabaseStorageAdapter();
    expect(supa.getSimPublicUrl(POSTER_KEY)).toBe(supa.getPublicUrl(POSTER_KEY));
  });

  it('Supabase and local were already proxied — pinned so they cannot regress either', () => {
    setEnv(SUPA_ENV);
    expect(new SupabaseStorageAdapter().getSimPublicUrl(ENTRY_KEY)).toContain(`/sim-public/${ENTRY_KEY}`);
    setEnv({ NODE_ENV: 'development', BACKEND_API_URL: 'http://localhost:4000' });
    expect(new LocalStorageAdapter().getSimPublicUrl(ENTRY_KEY)).toContain(`/sim-public/${ENTRY_KEY}`);
  });
});

describe('P0: the binary-asset 302 target never lands on /hls-proxy', () => {
  it('R2 redirects binaries straight to the bucket CDN', () => {
    setEnv(R2_ENV);
    const r2 = new R2StorageAdapter();
    expect(r2.getSimAssetRedirectUrl(SIM_KEY)).toBe(`https://cdn.example.com/${SIM_KEY}`);
    // The trap this method exists to avoid: getPublicUrl on R2 answers /hls-proxy for this key.
    expect(r2.getPublicUrl(SIM_KEY)).toContain('/hls-proxy/');
  });

  it('MigratingStorageAdapter delegates to the primary, with a getPublicUrl fallback', () => {
    setEnv({ ...R2_ENV, ...SUPA_ENV });
    const migrating = new MigratingStorageAdapter(new R2StorageAdapter(), new SupabaseStorageAdapter());
    expect(migrating.getSimAssetRedirectUrl(SIM_KEY)).toBe(`https://cdn.example.com/${SIM_KEY}`);
    const supaPrimary = new MigratingStorageAdapter(new SupabaseStorageAdapter(), new R2StorageAdapter());
    // Supabase has no override — the fallback must be its getPublicUrl (a bucket URL), not a throw.
    expect(supaPrimary.getSimAssetRedirectUrl(SIM_KEY)).toBe(new SupabaseStorageAdapter().getPublicUrl(SIM_KEY));
  });
});

describe('P0: rows written before the fix still resolve', () => {
  it('R2 inverts BOTH the new proxy shape and the old direct-bucket shape', () => {
    setEnv(R2_ENV);
    const r2 = new R2StorageAdapter();
    expect(r2.keyFromPublicUrl(`https://api.example.com/sim-public/${ENTRY_KEY}`)).toBe(ENTRY_KEY);
    expect(r2.keyFromPublicUrl(`https://cdn.example.com/${ENTRY_KEY}`)).toBe(ENTRY_KEY);
    // The appended sim-entry query is grammar, not key (publicUrlKeys.ts).
    expect(r2.keyFromPublicUrl(`https://api.example.com/sim-public/${ENTRY_KEY}?section=s1&v=abc`)).toBe(ENTRY_KEY);
  });
});
