import { describe, it, expect, afterEach } from 'vitest';
import { getStorageAdapter, forceLocalStorage, resetStorageAdapterForTest } from '../getStorageAdapter.js';
import { LocalStorageAdapter } from '../LocalStorageAdapter.js';
import { SupabaseStorageAdapter } from '../SupabaseStorageAdapter.js';

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
  resetStorageAdapterForTest();
});

function setEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const REAL_SUPABASE = {
  SUPABASE_URL: 'https://abc123ref.supabase.co',
  SUPABASE_S3_ACCESS_KEY_ID: 'realaccesskeyid0000',
  SUPABASE_S3_SECRET_ACCESS_KEY: 'realsecretaccesskey0000',
  SUPABASE_STORAGE_BUCKET: 'media',
  BACKEND_API_URL: 'https://api.flowvidco.com',
};

describe('production storage guard — never local disk in prod', () => {
  it('throws when STORAGE_BACKEND=local in production', () => {
    setEnv({ NODE_ENV: 'production', STORAGE_BACKEND: 'local', ...REAL_SUPABASE });
    expect(() => getStorageAdapter()).toThrow(/not allowed in production/i);
  });

  it('throws when no cloud credentials are configured in production', () => {
    setEnv({
      NODE_ENV: 'production',
      STORAGE_BACKEND: undefined,
      SUPABASE_S3_ACCESS_KEY_ID: undefined,
      SUPABASE_S3_SECRET_ACCESS_KEY: undefined,
      R2_ACCOUNT_ID: undefined,
      R2_ACCESS_KEY_ID: undefined,
      R2_SECRET_ACCESS_KEY: undefined,
    });
    expect(() => getStorageAdapter()).toThrow(/No cloud storage configured/i);
  });

  it('forceLocalStorage() is rejected in production', () => {
    setEnv({ NODE_ENV: 'production', ...REAL_SUPABASE });
    expect(() => forceLocalStorage('read-only R2 probe')).toThrow(/production/i);
  });

  it('resolves Supabase (not local) in production with real creds', () => {
    setEnv({ NODE_ENV: 'production', STORAGE_BACKEND: 'supabase', ...REAL_SUPABASE });
    const adapter = getStorageAdapter();
    expect(adapter).toBeInstanceOf(SupabaseStorageAdapter);
    expect(adapter).not.toBeInstanceOf(LocalStorageAdapter);
  });

  it('LocalStorageAdapter constructor refuses to run in production', () => {
    setEnv({ NODE_ENV: 'production' });
    expect(() => new LocalStorageAdapter()).toThrow(/must not be used in production/i);
  });
});

describe('URL builders never emit localhost in production', () => {
  it('Supabase getSimPublicUrl uses the public API origin', () => {
    setEnv({ NODE_ENV: 'production', STORAGE_BACKEND: 'supabase', ...REAL_SUPABASE });
    const adapter = getStorageAdapter();
    const url = adapter.getSimPublicUrl('simulations/p/v/index.html');
    expect(url).toBe('https://api.flowvidco.com/sim-public/simulations/p/v/index.html');
    expect(url).not.toContain('localhost');
  });

  it('Supabase getPublicUrl points at the Supabase CDN, never localhost', () => {
    setEnv({ NODE_ENV: 'production', STORAGE_BACKEND: 'supabase', ...REAL_SUPABASE });
    const url = getStorageAdapter().getPublicUrl('thumbnails/p/v/a.png');
    expect(url).toContain('abc123ref.supabase.co');
    expect(url).not.toContain('localhost');
  });
});

describe('development still allows local disk', () => {
  it('resolves LocalStorageAdapter in dev when no creds are set', () => {
    setEnv({
      NODE_ENV: 'development',
      STORAGE_BACKEND: undefined,
      SUPABASE_S3_ACCESS_KEY_ID: undefined,
      SUPABASE_S3_SECRET_ACCESS_KEY: undefined,
      R2_ACCOUNT_ID: undefined,
      R2_ACCESS_KEY_ID: undefined,
      R2_SECRET_ACCESS_KEY: undefined,
    });
    expect(getStorageAdapter()).toBeInstanceOf(LocalStorageAdapter);
  });
});
