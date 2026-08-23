/**
 * Inverting a public URL back into its storage key — the ROUND TRIP, per adapter.
 *
 * WHY THIS EXISTS AS A TEST AT ALL
 * Four columns store a full public URL and no key (`corpora.storage_url`,
 * `avatar_config…faces[].imageUrl`, `guidance_meta.mdUrl`, `guidance[].audioUrl`). The recovery was
 * a heuristic in a service — strip `https://host/`, then strip one of four dev route prefixes —
 * and it is correct only for adapters whose URLs happen to look like that. On Supabase, whose public
 * URL is `{origin}/storage/v1/object/public/{bucket}/{key}`, it recovered a string that still
 * contained the project id: enough for a duplication to plan a copy of it, and enough for that copy
 * to fail `NoSuchKey` and take the whole run down with advice ("try again") that could never work.
 * Every Supabase project with a corpus file was un-duplicatable, and no suite could see it because
 * the only fake in the codebase minted `https://cdn.test/{key}`.
 *
 * The property being pinned is not "the regex is right" — it is that `keyFromPublicUrl` is the
 * INVERSE of the same adapter's `getPublicUrl`/`getSimPublicUrl`, whatever shape those take.
 */
import { describe, it, expect, afterEach } from 'vitest';

import { keyFromPublicUrlAgainst } from '../publicUrlKeys.js';
import { LocalStorageAdapter } from '../LocalStorageAdapter.js';
import { R2StorageAdapter } from '../R2StorageAdapter.js';
import { SupabaseStorageAdapter } from '../SupabaseStorageAdapter.js';

const KEYS = [
  'projects/8f6f0f4e-1111-4111-8111-aaaaaaaaaaaa/corpus/1_paper.pdf',
  'simulations/8f6f0f4e-1111-4111-8111-aaaaaaaaaaaa/2222/guidance/en/g1.deadbeef.mp3',
  'images/8f6f0f4e-1111-4111-8111-aaaaaaaaaaaa/leaf.png',
  // The one key shape built from a name the user chose.
  'projects/8f6f0f4e-1111-4111-8111-aaaaaaaaaaaa/corpus/2_my paper+v2.pdf',
  // …and the characters that make such a name collide with URL grammar. A key like this can only
  // reach storage from a row written before `corpusObjectName` existed, and the presign that
  // downloads it needs the WHOLE key: recovering `…/3_q&a` instead is a `NoSuchKey` on a file that
  // uploaded perfectly.
  'projects/8f6f0f4e-1111-4111-8111-aaaaaaaaaaaa/corpus/3_q&a #2 (draft).pdf',
  'projects/8f6f0f4e-1111-4111-8111-aaaaaaaaaaaa/corpus/4_what?.pdf',
];
/** HLS keys take the token-in-path form on two of the three adapters. */
const HLS_KEY = 'hls/3333/run7/360p/seg_000.ts';

const saved = new Map<string, string | undefined>();
const setEnv = (env: Record<string, string>): void => {
  for (const [k, v] of Object.entries(env)) { saved.set(k, process.env[k]); process.env[k] = v; }
};
afterEach(() => {
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  saved.clear();
});

const ADAPTERS = [
  {
    label: 'Local',
    env: { NODE_ENV: 'development', BACKEND_API_URL: 'http://localhost:4000' } as Record<string, string>,
    make: () => new LocalStorageAdapter(),
  },
  {
    label: 'R2',
    env: {
      R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret',
      R2_BUCKET_NAME: 'media', R2_PUBLIC_URL: 'https://cdn.example.com',
      BACKEND_API_URL: 'https://api.example.com',
    } as Record<string, string>,
    make: () => new R2StorageAdapter(),
  },
  {
    label: 'Supabase',
    env: {
      SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_S3_ACCESS_KEY_ID: 'key',
      SUPABASE_S3_SECRET_ACCESS_KEY: 'secret', SUPABASE_S3_REGION: 'us-east-1',
      SUPABASE_STORAGE_BUCKET: 'media', BACKEND_API_URL: 'https://api.example.com',
    } as Record<string, string>,
    make: () => new SupabaseStorageAdapter(),
  },
];

describe.each(ADAPTERS)('$label: keyFromPublicUrl inverts its own URL builders', ({ env, make }) => {
  it('round-trips getPublicUrl for every key shape the product mints', () => {
    setEnv(env);
    const adapter = make();
    for (const key of [...KEYS, HLS_KEY]) {
      expect(adapter.keyFromPublicUrl(adapter.getPublicUrl(key)), key).toBe(key);
    }
  });

  it('round-trips getSimPublicUrl', () => {
    setEnv(env);
    const adapter = make();
    for (const key of KEYS) {
      expect(adapter.keyFromPublicUrl(adapter.getSimPublicUrl(key)), key).toBe(key);
    }
  });

  it('answers null for a URL this storage did not publish', () => {
    setEnv(env);
    const adapter = make();
    expect(adapter.keyFromPublicUrl('https://someone-else.example/images/x.png')).toBeNull();
    expect(adapter.keyFromPublicUrl('not a url')).toBeNull();
    expect(adapter.keyFromPublicUrl(null)).toBeNull();
    expect(adapter.keyFromPublicUrl('')).toBeNull();
  });
});

describe('Supabase specifically — the shape the old heuristic got wrong', () => {
  it('recovers the key from under /storage/v1/object/public/{bucket}/', () => {
    setEnv(ADAPTERS[2].env);
    const adapter = new SupabaseStorageAdapter();
    const url = 'https://ref.supabase.co/storage/v1/object/public/media/projects/p1/corpus/1_paper.pdf';
    expect(adapter.getPublicUrl('projects/p1/corpus/1_paper.pdf')).toBe(url);
    expect(adapter.keyFromPublicUrl(url)).toBe('projects/p1/corpus/1_paper.pdf');
    // What the host-stripping heuristic produced instead — a "key" that still contains the project
    // id, so a duplication maps it, copies it, and fails NoSuchKey.
    expect(adapter.keyFromPublicUrl(url)).not.toBe('storage/v1/object/public/media/projects/p1/corpus/1_paper.pdf');
  });
});

describe('keyFromPublicUrlAgainst', () => {
  const BASES = ['https://api.test/local-storage', 'https://api.test/sim-public', 'https://api.test/hls-public'];

  it('strips the scoped media token that lives in the path', () => {
    // The token sits between the route and the key so relative segment URLs inherit it.
    expect(keyFromPublicUrlAgainst('https://api.test/hls-public/t/abc.def/hls/v/run/seg.ts', BASES))
      .toBe('hls/v/run/seg.ts');
  });

  it('drops a query the PRODUCT appended — `?section=` and `?v=` on a sim entry URL', () => {
    // The one URL shape a caller extends after the adapter built it: `?section=` is the variant key
    // the bridge dispatches on and `?v=` is the bridge hash. Neither is part of the key, and a
    // caller asking for the key must not get `index.html?section=…` back.
    expect(keyFromPublicUrlAgainst('https://api.test/sim-public/sim/p/index.html?section=abc&v=bh1', BASES))
      .toBe('sim/p/index.html');
    expect(keyFromPublicUrlAgainst('https://api.test/sim-public/sim/p/index.html?v=bh1#top', BASES))
      .toBe('sim/p/index.html');
  });

  it('KEEPS a `?` or `#` that is part of the key, because the key went in verbatim', () => {
    // THIS CASE USED TO READ THE OTHER WAY, and it was wrong: the test asserted that everything
    // after `?`/`#` is URL grammar, which truncated every corpus key minted from a filename
    // containing one. `CorpusBuilder.ingest` then presigned an object that does not exist and the
    // upload failed after succeeding; a duplication of the same project died on `NoSuchKey`.
    // `b.pdf` is not a parameter this product appends, so it is key text.
    expect(keyFromPublicUrlAgainst('https://api.test/local-storage/p/corpus/1_a?b.pdf', BASES))
      .toBe('p/corpus/1_a?b.pdf');
    expect(keyFromPublicUrlAgainst('https://api.test/local-storage/p/corpus/2_q&a #2.pdf', BASES))
      .toBe('p/corpus/2_q&a #2.pdf');
  });

  it('does not percent-decode', () => {
    // The forward builders interpolate the key verbatim, so decoding would invent a key that was
    // never published.
    expect(keyFromPublicUrlAgainst('https://api.test/local-storage/a/my%20file.pdf', BASES))
      .toBe('a/my%20file.pdf');
  });

  it('prefers the LONGEST matching base', () => {
    // A bare public origin alongside a route under it: shortest-first would leave the route in.
    const bases = ['https://cdn.test', 'https://cdn.test/sim-public'];
    expect(keyFromPublicUrlAgainst('https://cdn.test/sim-public/a/b.html', bases)).toBe('a/b.html');
  });

  it('does not match a base that is only a string prefix of the path', () => {
    expect(keyFromPublicUrlAgainst('https://api.test/local-storage-other/a.png', BASES)).toBeNull();
    // The base itself, with nothing under it, names no object.
    expect(keyFromPublicUrlAgainst('https://api.test/local-storage/', BASES)).toBeNull();
  });

  it('ignores empty bases, so an unconfigured public URL cannot swallow everything', () => {
    // `R2_PUBLIC_URL` is `''` when unset; a `''` base would otherwise match every URL.
    expect(keyFromPublicUrlAgainst('https://cdn.test/a/b.png', ['', 'https://other.test'])).toBeNull();
  });
});
