/**
 * REGRESSION — the adapter bypass that minted `https://pub-*.r2.dev/<key>` caption tracks while
 * Supabase held the bytes.
 *
 * `captionPublicUrl` used to read `R2_ACCOUNT_ID` / `R2_PUBLIC_URL` straight from the environment
 * and return the legacy bucket origin whenever they were set — a decision made INDEPENDENTLY of the
 * adapter that stores the object. Production is `STORAGE_BACKEND=supabase` and still carries every
 * R2_* variable, so that branch was live: any VTT written to storage got a track URL pointing at a
 * bucket it was never uploaded to. It is masked today only because every ready row also carries
 * `captions_vtt` in the database, so `captionUrlForVideo` prefers the API route.
 *
 * These assert on the FUNCTION'S OUTPUT under each storage configuration, including the exact
 * production one (Supabase selected, R2 variables still present).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { captionPublicUrl, captionUrlForVideo } from '../CaptionService.js';
import { getStorageAdapter, resetStorageAdapterForTest } from '../../storage/getStorageAdapter.js';
import { R2StorageAdapter } from '../../storage/R2StorageAdapter.js';

const SAVED = { ...process.env };
const KEY = 'captions/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/en.vtt';

const R2_ENV = {
  R2_ACCOUNT_ID: 'acct-1234567890',
  R2_ACCESS_KEY_ID: 'key-1234567890',
  R2_SECRET_ACCESS_KEY: 'secret-1234567890',
  R2_PUBLIC_URL: 'https://pub-6bea814f7eb54c5abb6e25af0efe31d5.r2.dev',
};
const SUPABASE_ENV = {
  SUPABASE_URL: 'https://abc123ref.supabase.co',
  SUPABASE_S3_ACCESS_KEY_ID: 'supabase-key-1234567890',
  SUPABASE_S3_SECRET_ACCESS_KEY: 'supabase-secret-1234567890',
  SUPABASE_STORAGE_BUCKET: 'media',
};

function setEnv(env: Record<string, string>) {
  Object.assign(process.env, env);
  resetStorageAdapterForTest();
}

beforeEach(() => {
  process.env = { ...SAVED, BACKEND_API_URL: 'https://api.flowvidco.com' };
  for (const k of Object.keys(R2_ENV)) delete process.env[k];
  for (const k of Object.keys(SUPABASE_ENV)) delete process.env[k];
  delete process.env.STORAGE_BACKEND;
  resetStorageAdapterForTest();
});
afterEach(() => {
  process.env = { ...SAVED };
  resetStorageAdapterForTest();
});

describe('captionPublicUrl — the storage ADAPTER decides the origin', () => {
  it('PRODUCTION SHAPE: Supabase selected while R2_* is still configured → never r2.dev', () => {
    setEnv({ ...R2_ENV, ...SUPABASE_ENV, STORAGE_BACKEND: 'supabase' });
    const url = captionPublicUrl(KEY);
    expect(url).toBe(`https://abc123ref.supabase.co/storage/v1/object/public/media/${KEY}`);
    expect(url).not.toContain('r2.dev');
  });

  it('DELEGATES: an R2 deployment gets whatever the R2 adapter mints, not a re-derived origin', () => {
    // The point of the fix is that the ADAPTER answers, so this asserts equality with the
    // adapter's own output rather than a hard-coded shape. (R2StorageAdapter.getPublicUrl
    // currently routes every key — not only `hls/` — through /hls-proxy; that is a separate,
    // pre-existing R2-only defect and deliberately not restated as an expectation here.)
    setEnv(R2_ENV);
    const adapter = getStorageAdapter();
    expect(adapter).toBeInstanceOf(R2StorageAdapter);
    expect(captionPublicUrl(KEY)).toBe(adapter.getPublicUrl(KEY));
  });

  it('local development is unchanged: the /local-storage route on the API origin', () => {
    setEnv({});
    expect(captionPublicUrl(KEY)).toBe(`https://api.flowvidco.com/local-storage/${KEY}`);
  });

  it('returns null when there is no key', () => {
    setEnv({ ...R2_ENV, ...SUPABASE_ENV, STORAGE_BACKEND: 'supabase' });
    expect(captionPublicUrl(null)).toBeNull();
    expect(captionPublicUrl(undefined)).toBeNull();
    expect(captionPublicUrl('')).toBeNull();
  });
});

describe('captionUrlForVideo — the track URL a viewer is actually served', () => {
  const video = (over: Partial<Parameters<typeof captionUrlForVideo>[0]>) => ({
    id: '33333333-3333-4333-8333-333333333333',
    captions_status: 'ready',
    captions_vtt: null,
    captions_vtt_key: KEY,
    ...over,
  }) as Parameters<typeof captionUrlForVideo>[0];

  it('THE UNMASKED CASE — VTT in storage, not in the DB column: served from Supabase, not r2.dev', () => {
    setEnv({ ...R2_ENV, ...SUPABASE_ENV, STORAGE_BACKEND: 'supabase' });
    const url = captionUrlForVideo(video({}));
    expect(url).toBe(`https://abc123ref.supabase.co/storage/v1/object/public/media/${KEY}`);
    expect(url).not.toContain('r2.dev');
  });

  it('still prefers the DB-backed API route when captions_vtt is present', () => {
    setEnv({ ...R2_ENV, ...SUPABASE_ENV, STORAGE_BACKEND: 'supabase' });
    expect(captionUrlForVideo(video({ captions_vtt: 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nhi\n' })))
      .toBe('https://api.flowvidco.com/api/v1/videos/33333333-3333-4333-8333-333333333333/captions.vtt');
  });

  it('offers no track at all until captions are ready', () => {
    setEnv({ ...R2_ENV, ...SUPABASE_ENV, STORAGE_BACKEND: 'supabase' });
    expect(captionUrlForVideo(video({ captions_status: 'processing' }))).toBeNull();
  });
});
