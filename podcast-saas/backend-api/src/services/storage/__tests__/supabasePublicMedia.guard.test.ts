/**
 * security-001 — GUARD, NOT A FIX. This file pins the exposure that exists today so that it is
 * visible in the suite, cannot be half-fixed silently, and names precisely what must change.
 * Nothing here makes production safer on its own; the ordered migration is at the bottom of this
 * comment, and these assertions are its checklist.
 *
 * ── WHAT IS WRONG ──────────────────────────────────────────────────────────────────────────
 * Production is Supabase (`deploy/.env.example`: "Production is CLOUD-ONLY Supabase Storage …
 * the backend/worker containers set STORAGE_BACKEND=supabase and FAIL TO START without real
 * Supabase S3 credentials"). `SupabaseStorageAdapter` builds every media URL as
 * `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${key}` — Supabase's PUBLIC-object
 * endpoint, which serves only from a bucket marked public. So either that bucket is public, or
 * production media has never played at all. It plays; the bucket is public.
 *
 * That single fact voids TWO separate access-control systems this codebase implements:
 *
 *   1. The scoped media token + `canServeMediaKey` (security-002). Both sibling adapters route
 *      `hls/` through the backend with a token in the PATH so relative child-playlist and
 *      segment URLs inherit it. Supabase points the player straight at the bucket, so
 *      `authorizeMediaRequest` is never on the path and the gate is dead code in production.
 *   2. Presigned downloads. `getPresignedDownloadUrl(key, 3600)` is called for raw masters,
 *      export masters, podcast renders and corpus documents — a TTL that does not exist,
 *      because the identical object also answers UNSIGNED, forever, at the public URL.
 *
 * ── WHAT IS *NOT* WRONG, so the fix is not aimed at the wrong thing ────────────────────────
 * The keys are not meaningfully guessable. Every one carries a random uuid:
 * `videos/{projectId}/{randomUUID()}.mp4`, `thumbnails/{projectId}/{randomUUID()}.jpg`,
 * `exports/{projectId}/{exportId}/master.mp4`, `hls/{videoFileId}/{runId}/…`. The only
 * low-entropy component is the HLS `runId` (`Date.now().toString(36)`,
 * `runVideoTranscode.ts:57`), and its parent segment is a uuid. The exposure is therefore NOT
 * brute force — it is that a URL, once out, is a permanent unrevocable grant: making a project
 * private, revoking a share token, unpublishing, or refunding a purchase takes nothing back.
 *
 * ── THE FIX, IN THE ONLY ORDER THAT DOES NOT CAUSE AN OUTAGE ───────────────────────────────
 * The end state is the bucket PRIVATE, with every read going through either a presigned URL or
 * the backend's token-gated proxy. Getting there is four landings, not one, and the last one is
 * the only irreversible step.
 *
 *   STEP 1 — DONE. /hls-proxy no longer reads R2_PUBLIC_URL: `hlsProxyUpstream()` resolves the
 *     upstream from the RESOLVED adapter (R2 streams over its own S3 GET, any other cloud adapter
 *     is fetched at its public URL, local disk redirects to /hls-public), so a Supabase deployment
 *     can adopt the route instead of getting `500 R2_PUBLIC_URL not set` on every segment. It
 *     changed no URL anyone holds — nothing points at /hls-proxy under Supabase yet — which is
 *     exactly why it was safe to land first. The last test below pins that behaviour.
 *   STEP 2 — CAPACITY, and this is the real cost, not a footnote. Today zero video bytes touch
 *     the API process; Supabase's CDN serves them. Step 3 moves 100% of segment traffic onto
 *     the Node tier on a 2-vCPU host. Measure concurrent-viewer segment throughput against that
 *     box BEFORE step 3, and put nginx caching in front of /hls-proxy (the versioned run tree
 *     `hls/{id}/{runId}/…` is write-once, so it is safely cacheable — `hlsCacheControlForKey`
 *     already says so). Skipping this step trades a confidentiality bug for an availability one.
 *   STEP 3 — switch `SupabaseStorageAdapter.getPublicUrl` to mint `/hls-proxy/t/{token}/{key}`
 *     for `hls/` keys, exactly as R2StorageAdapter already does. NO BACKFILL IS NEEDED for HLS:
 *     `buildPlayerConfig` computes hls_url from `hls_master_key` on every request, so the new
 *     shape takes effect on the next config fetch. Note `keyFromPublicUrl` must keep accepting
 *     the OLD bucket shape as well as the new one, or duplication/deletion stop resolving keys
 *     for every existing row.
 *   STEP 4 — make the bucket private. THIS IS THE STEP THAT BREAKS THINGS, and only this one:
 *       (a) every `_url` column holds an ABSOLUTE public-bucket URL — thumbnail_url,
 *           original_url, storage_url, image_url, banner_url, simulation_url and the rest
 *           (db/schema.ts). All of them go dead and need the `backfill-localhost-urls.ts`
 *           treatment before the flip, not after.
 *       (b) `sim-public.controller.ts:244` 302-REDIRECTS binary sim assets to
 *           `storage.getPublicUrl(key)` — a deliberate optimisation to keep images off the
 *           proxy. It must fall back to streaming, or those sims break.
 *       (c) the genuinely-public prefixes (thumbnails/, images/, audio/, captions/,
 *           playlist-banners/, avatar-circles/, podcasts/ — see PUBLIC_LOCAL_PREFIXES in
 *           server.ts) need a serving story of their own; they are public BY DESIGN and must
 *           not be dragged behind the media gate.
 *     Only after (a)–(c) does the presigning that already exists start to mean anything.
 *
 * DO NOT "just presign the HLS master". An .m3u8 lists its child playlists and segments by
 * RELATIVE path, so a query-string signature is dropped the moment the player resolves a child
 * URL — every segment 400s IMMEDIATELY, not at expiry. That is precisely why the token in this
 * codebase is a PATH segment (`/t/{token}/`) and not a query parameter; see mediaToken.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { SupabaseStorageAdapter } from '../SupabaseStorageAdapter.js';
import { R2StorageAdapter } from '../R2StorageAdapter.js';
import { LocalStorageAdapter } from '../LocalStorageAdapter.js';
import { hlsProxyUpstream } from '../hlsProxyUpstream.js';
import type { StorageService } from '../StorageService.js';
import { mediaKeyScope } from '../mediaToken.js';

const SAVED = { ...process.env };
afterEach(() => { process.env = { ...SAVED }; });

const SUPABASE_ENV = {
  SUPABASE_URL: 'https://abc123ref.supabase.co',
  SUPABASE_S3_ACCESS_KEY_ID: 'k',
  SUPABASE_S3_SECRET_ACCESS_KEY: 's',
  SUPABASE_STORAGE_BUCKET: 'media',
  BACKEND_API_URL: 'https://api.flowvidco.com',
};
const R2_ENV = {
  R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's',
  R2_PUBLIC_URL: 'https://pub.r2.dev/podcast-saas', BACKEND_API_URL: 'https://api.flowvidco.com',
};
function setEnv(env: Record<string, string>) { Object.assign(process.env, env); }

const HLS_KEY = 'hls/11111111-1111-4111-8111-111111111111/mfa2k3/master.m3u8';

describe('security-001 — the three prefixes the media gate is supposed to cover', () => {
  it('mediaKeyScope claims hls/, videos/ and exports/ — the machinery exists', () => {
    expect(mediaKeyScope(HLS_KEY)).toBe('hls/11111111-1111-4111-8111-111111111111');
    expect(mediaKeyScope('videos/22222222-2222-4222-8222-222222222222/a.mp4'))
      .toBe('videos/22222222-2222-4222-8222-222222222222');
    expect(mediaKeyScope('exports/33333333-3333-4333-8333-333333333333/e/master.mp4'))
      .toBe('exports/33333333-3333-4333-8333-333333333333');
  });
});

describe('security-001 — R2 gates HLS; Supabase does not', () => {
  it('R2 routes HLS through the backend with a scoped token in the PATH', () => {
    setEnv(R2_ENV);
    const url = new R2StorageAdapter().getPublicUrl(HLS_KEY);
    // Through the API origin, so authorizeMediaRequest() is on the path.
    expect(url.startsWith('https://api.flowvidco.com/hls-proxy/')).toBe(true);
    // Token as a path segment, so RELATIVE segment URLs inherit it — the design in mediaToken.ts.
    expect(url).toMatch(/\/hls-proxy\/t\/\d+-[0-9a-f]{32}\//);
    expect(url).not.toContain('r2.dev');
  });

  it('SUPABASE POINTS THE PLAYER STRAIGHT AT THE BUCKET — no token, no signature, no gate', () => {
    setEnv(SUPABASE_ENV);
    const url = new SupabaseStorageAdapter().getPublicUrl(HLS_KEY);

    expect(url).toBe(`https://abc123ref.supabase.co/storage/v1/object/public/media/${HLS_KEY}`);
    // The `/object/public/` endpoint is the tell: it serves ONLY from a public bucket.
    expect(url).toContain('/storage/v1/object/public/');
    // Never transits the backend, so canServeMediaKey / authorizeMediaRequest cannot run.
    expect(url).not.toContain('api.flowvidco.com');
    expect(url).not.toContain('/hls-proxy');
    expect(url).not.toContain('/hls-public');
    // No scoped media token …
    expect(url).not.toMatch(/\/t\/\d+-[0-9a-f]{32}\//);
    // … and no presigned-URL machinery either: nothing expires.
    expect(url).not.toContain('X-Amz-Signature');
    expect(url).not.toContain('?');
  });

  it('the same hole covers raw masters and export masters, not just HLS', () => {
    setEnv(SUPABASE_ENV);
    const a = new SupabaseStorageAdapter();
    for (const key of [
      'videos/22222222-2222-4222-8222-222222222222/aaaa.mp4',
      'exports/33333333-3333-4333-8333-333333333333/e1/master.mp4',
    ]) {
      const url = a.getPublicUrl(key);
      expect(url, key).toBe(`https://abc123ref.supabase.co/storage/v1/object/public/media/${key}`);
      expect(url, key).not.toContain('X-Amz-Signature');
    }
  });

  it('presigning is decorative while the bucket is public: same object, two URLs', async () => {
    // getPresignedDownloadUrl is what export.controller.ts:460, runVideoTranscode.ts:44 and a
    // dozen other call sites hand out, each with a TTL. This asserts the SIGNED url really is
    // signed — and that the adapter will ALSO hand out an unsigned URL for the identical key.
    // Purely local AWS SDK signing; no network call is made.
    setEnv(SUPABASE_ENV);
    const a = new SupabaseStorageAdapter();
    const key = 'exports/33333333-3333-4333-8333-333333333333/e1/master.mp4';
    const signed = await a.getPresignedDownloadUrl(key, 3600);
    expect(signed).toContain('X-Amz-Signature');
    expect(signed).toContain('X-Amz-Expires=3600');
    // …and the TTL means nothing, because this reaches the same bytes with no signature at all:
    expect(a.getPublicUrl(key)).not.toContain('X-Amz-Signature');
  });
});

describe('security-001 STEP 1 — /hls-proxy resolves its upstream from the adapter, not R2_* env', () => {
  // Asserted on the OUTPUT of the decision the route makes. Reading server.ts as text (which is
  // what this used to do) proves only that a string is present, and would have gone on passing
  // while the behaviour changed underneath it.

  it('under Supabase it fetches the SUPABASE object — even with the legacy R2 vars still set', () => {
    setEnv({ ...R2_ENV, ...SUPABASE_ENV });
    const upstream = hlsProxyUpstream(new SupabaseStorageAdapter(), HLS_KEY);
    expect(upstream).toEqual({
      kind: 'fetch',
      url: `https://abc123ref.supabase.co/storage/v1/object/public/media/${HLS_KEY}`,
    });
  });

  it('and it does NOT depend on R2_PUBLIC_URL — the variable production is still carrying', () => {
    setEnv(SUPABASE_ENV);
    delete process.env.R2_PUBLIC_URL;
    const upstream = hlsProxyUpstream(new SupabaseStorageAdapter(), HLS_KEY);
    // The old route replied `500 R2_PUBLIC_URL not set` here, for every segment.
    expect(upstream.kind).toBe('fetch');
    expect(JSON.stringify(upstream)).not.toContain('r2.dev');
  });

  it('under R2 it streams through the adapter rather than fetching a URL out of the environment', () => {
    setEnv(R2_ENV);
    expect(hlsProxyUpstream(new R2StorageAdapter(), HLS_KEY)).toEqual({ kind: 'stream' });
  });

  it('never hands the route a URL that points back at /hls-proxy — the self-fetch loop', () => {
    setEnv({ ...R2_ENV, ...SUPABASE_ENV });
    // R2's getPublicUrl deliberately mints the proxied shape; taking it as an upstream would make
    // the route fetch itself. Any adapter whose public URL is proxied falls back to local disk.
    const proxied = { getPublicUrl: (k: string) => `https://api.flowvidco.com/hls-proxy/${k}` } as StorageService;
    expect(hlsProxyUpstream(proxied, HLS_KEY)).toEqual({ kind: 'local' });
    for (const adapter of [new R2StorageAdapter(), new SupabaseStorageAdapter()] as StorageService[]) {
      const up = hlsProxyUpstream(adapter, HLS_KEY);
      if (up.kind === 'fetch') expect(up.url).not.toContain('/hls-proxy/');
    }
  });

  it('local disk is served by /hls-public, where the local adapter points HLS anyway', () => {
    setEnv({ BACKEND_API_URL: 'http://localhost:8080' });
    expect(hlsProxyUpstream(new LocalStorageAdapter(), HLS_KEY)).toEqual({ kind: 'local' });
  });
});

describe('under Supabase, no browser-visible URL builder emits the legacy R2 origin', () => {
  // The production container carries SUPABASE_S3_* and every R2_* variable at once. Anything that
  // decides an origin from env rather than from the resolved adapter therefore points browsers at
  // a bucket Supabase never wrote to. Pinned on output for the two shapes the adapter publishes.
  it('media URLs stay on Supabase and sim URLs stay on the API origin, with R2_* still set', () => {
    setEnv({ ...R2_ENV, ...SUPABASE_ENV });
    const a = new SupabaseStorageAdapter();
    for (const key of [HLS_KEY, 'captions/p/v/en.vtt', 'thumbnails/p/a.jpg', 'avatar-circles/p/a.png']) {
      expect(a.getPublicUrl(key), key).toBe(`https://abc123ref.supabase.co/storage/v1/object/public/media/${key}`);
      expect(a.getPublicUrl(key), key).not.toContain('r2.dev');
    }
    // The sim entry document is the one URL that must be FRAMABLE: the frontend's
    // `frame-src` allows the API origin and nothing on r2.dev.
    const sim = a.getSimPublicUrl('simulations/p/v/index.html');
    expect(sim).toBe('https://api.flowvidco.com/sim-public/simulations/p/v/index.html');
    expect(sim).not.toContain('r2.dev');
  });
});
