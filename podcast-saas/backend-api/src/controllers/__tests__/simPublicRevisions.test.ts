/**
 * Serving immutable revisions (Priority 7) through /sim-public/*.
 *
 * The property under test is narrow and total: a URL that answers with `immutable` must be a URL
 * whose bytes can never change. Two directions, both of which have to hold on every request —
 *
 *   • a revision key gets the year-long header AND is served byte-for-byte as published, so the
 *     ETag a client holds equals the SHA-256 the manifest recorded for that path;
 *   • every other key — legacy package files, near-misses of the revision layout, and anything
 *     that resolves which revision is live — keeps revalidating exactly as it does today.
 *
 * The second direction is the one that costs a year of stale bytes when it is wrong, so it is
 * asserted as a biconditional against `isImmutableRevisionKey` rather than key by key.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { brotliDecompressSync } from 'zlib';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  IMMUTABLE_CACHE_CONTROL,
  POINTER_CACHE_CONTROL,
  cacheControlForKey,
  isImmutableRevisionKey,
  revisionFileKey,
  revisionManifestKey,
} from 'shared/src/sim/simRevision';
import {
  SIM_MANIFEST_VERSION,
  validateManifest,
  type SimManifest,
} from 'shared/src/sim/simManifest';
import { sha256Hex } from 'shared/src/sim/sha256';

// ── Mocks ─────────────────────────────────────────────────────────────────────
//
// `current.adapter` is what getStorageAdapter() returns. Plain object → fails
// `instanceof LocalStorageAdapter` → the cloud (Supabase/R2) branch; a real LocalStorageAdapter
// (installed by the local-disk describe below) → the filesystem branch.

const mocks = vi.hoisted(() => ({
  cloudStorage: {
    readObject: vi.fn<(key: string) => Promise<Buffer>>(),
    getPublicUrl: vi.fn((key: string) => `https://cdn.example.com/storage/v1/object/public/media/${key}`),
  },
  current: { adapter: null as unknown },
}));

vi.mock('../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => mocks.current.adapter ?? mocks.cloudStorage,
}));

// Keep the heavy SimulationService graph (db, LLM SDKs) out of this unit test; the stub mirrors
// the real CONTENT_TYPES entries for the extensions used below.
vi.mock('../../services/simulation/SimulationService.js', () => ({
  getSimulationContentType: (path: string) => {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      html: 'text/html; charset=utf-8',
      htm: 'text/html; charset=utf-8',
      js: 'application/javascript',
      mjs: 'application/javascript',
      css: 'text/css',
      json: 'application/json',
      png: 'image/png',
      webp: 'image/webp',
      mp3: 'audio/mpeg',
    };
    return map[ext] ?? 'application/octet-stream';
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { cloudStorage, current } = mocks;

// ── Fixture identity ──────────────────────────────────────────────────────────

const PROJECT = 'proj-1';
const SIM = 'sim-1';
const REV = 'rev_7f3a91c4e8b2';

// Keys are built with the SHARED layout helpers, never hand-typed: a test that agreed with a
// hard-coded string while the layout function moved would prove nothing about what is served.
const ENTRY_KEY = revisionFileKey(PROJECT, SIM, REV, 'package/index.html');
const BRIDGE_KEY = revisionFileKey(PROJECT, SIM, REV, 'runtime/bridge.js');
const SPRITE_KEY = revisionFileKey(PROJECT, SIM, REV, 'package/assets/sprite.png');
const MANIFEST_KEY = revisionManifestKey(PROJECT, SIM, REV);

const LEGACY_HTML = `simulations/${PROJECT}/${SIM}/index.html`;
const LEGACY_CSS = `simulations/${PROJECT}/${SIM}/styles.css`;
const LEGACY_PNG = `simulations/${PROJECT}/${SIM}/assets/sprite.png`;
// A pointer document is the one object that says which revision is live. It lives OUTSIDE any
// revision prefix precisely so it can be rewritten, which is why it must never cache immutably.
const POINTER_KEY = `simulations/${PROJECT}/${SIM}/active-revision.json`;

// Shapes that resemble the revision layout without being it. Each must fall to the mutable side.
const NEAR_MISS_SHORT_ID = `simulations/${PROJECT}/${SIM}/revisions/short/app.js`;
const NEAR_MISS_DEPTH = `simulations/${PROJECT}/${SIM}/package/revisions/abcdefghij/app.js`;
const NEAR_MISS_NO_FILE = `simulations/${PROJECT}/${SIM}/revisions/${REV}`;

const ENTRY_HTML = '<!doctype html><html><head><title>rev</title></head><body>sim</body></html>';
const BRIDGE_JS = `;(function(){window.__bridge=${'1,'.repeat(2000)}0})();`;
const SPRITE_BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));

const sha256 = (body: string | Buffer): string => createHash('sha256').update(body).digest('hex');
const sha1 = (body: string | Buffer): string => createHash('sha1').update(body).digest('hex');

/**
 * The manifest the publisher would have written for this revision — built from the SAME bytes the
 * route serves. `validateManifest` is run over it in the suite below so the hashes being compared
 * belong to a manifest the pipeline would actually accept; comparing against a shape the validator
 * rejects would make the ETag equality meaningless.
 */
const MANIFEST: SimManifest = {
  manifestVersion: SIM_MANIFEST_VERSION,
  simulationId: SIM,
  projectId: PROJECT,
  revisionId: REV,
  revisionNumber: 4,
  bridgeProtocolVersion: 3,
  runtimeProtocolVersion: 3,
  entry: 'package/index.html',
  runtime: ['runtime/bridge.js'],
  files: [
    {
      path: 'package/index.html',
      role: 'entry',
      hash: sha256(ENTRY_HTML),
      bytes: Buffer.byteLength(ENTRY_HTML),
      contentType: 'text/html; charset=utf-8',
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    },
    {
      path: 'runtime/bridge.js',
      role: 'runtime',
      hash: sha256(BRIDGE_JS),
      bytes: Buffer.byteLength(BRIDGE_JS),
      contentType: 'application/javascript',
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    },
    {
      path: 'package/assets/sprite.png',
      role: 'asset',
      hash: sha256(SPRITE_BYTES),
      bytes: SPRITE_BYTES.length,
      contentType: 'image/png',
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    },
  ],
  variants: [{ variantKey: 'section-a', configHashes: ['0123456789abcdef'] }],
  posters: [],
  qualityProfiles: [],
  externalDependencies: [],
  generatedFrom: {},
  canary: { classification: 'managed-presentable', ranAt: '2026-08-01T00:00:00.000Z', engine: 'chromium' },
  createdAt: '2026-08-01T00:00:00.000Z',
  createdBy: 'publisher',
};

const manifestHashFor = (path: string): string => MANIFEST.files.find((f) => f.path === path)!.hash;

// ── App under test ────────────────────────────────────────────────────────────
//
// The controller is imported dynamically so LOCAL_STORAGE_DIR is already pointing at this suite's
// scratch directory when localStoragePaths computes LOCAL_STORAGE_BASE_DIR at module load — a
// static import would have frozen it to the developer's real .local-storage first.

let registerSimPublicRoutes: (app: FastifyInstance) => Promise<void>;
let injectSimBootSnippet: (html: string) => string;
let LocalStorageAdapter: new () => object;
let localRoot: string;

beforeAll(async () => {
  localRoot = mkdtempSync(join(tmpdir(), 'sim-public-rev-'));
  process.env.LOCAL_STORAGE_DIR = localRoot;
  ({ registerSimPublicRoutes, injectSimBootSnippet } = await import('../sim-public.controller.js'));
  ({ LocalStorageAdapter } = await import('../../services/storage/LocalStorageAdapter.js'));
});

afterAll(() => {
  rmSync(localRoot, { recursive: true, force: true });
  delete process.env.LOCAL_STORAGE_DIR;
});

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerSimPublicRoutes(app);
  return app;
}

function writeLocal(key: string, body: string | Buffer): void {
  const abs = join(localRoot, key);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

beforeEach(() => {
  current.adapter = null;
  cloudStorage.readObject.mockReset();
  cloudStorage.getPublicUrl.mockReset();
  cloudStorage.getPublicUrl.mockImplementation(
    (key: string) => `https://cdn.example.com/storage/v1/object/public/media/${key}`,
  );
});

// ── (a) The cache-policy biconditional ────────────────────────────────────────

describe('GET /sim-public/* — immutable only for revision keys', () => {
  it('serves a revision file with the shared IMMUTABLE policy', async () => {
    cloudStorage.readObject.mockResolvedValue(Buffer.from(BRIDGE_JS));
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${BRIDGE_KEY}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['content-type']).toBe('application/javascript');
  });

  it('leaves the legacy mutable path exactly as it was — no-cache, sha1 ETag, snippet injected', async () => {
    cloudStorage.readObject.mockResolvedValue(Buffer.from(ENTRY_HTML));
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${LEGACY_HTML}` });

    const served = injectSimBootSnippet(ENTRY_HTML);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['etag']).toBe(`"${sha1(served)}"`);
    expect(res.body).toBe(served);
    expect(res.body).toContain('data-simboot');
  });

  it('never answers `immutable` for a key outside a revision prefix (biconditional)', async () => {
    const cases: Array<{ key: string; body: string | Buffer }> = [
      { key: ENTRY_KEY, body: ENTRY_HTML },
      { key: BRIDGE_KEY, body: BRIDGE_JS },
      { key: MANIFEST_KEY, body: JSON.stringify(MANIFEST) },
      { key: SPRITE_KEY, body: SPRITE_BYTES },
      { key: LEGACY_HTML, body: ENTRY_HTML },
      { key: LEGACY_CSS, body: 'body{}' },
      { key: LEGACY_PNG, body: SPRITE_BYTES },
      { key: POINTER_KEY, body: JSON.stringify({ activeRevisionId: REV }) },
      // Near-misses: the id is too short, the `revisions/` segment is at the wrong depth, and the
      // revision prefix names no file at all. Anything unrecognised must land on the mutable side.
      { key: NEAR_MISS_SHORT_ID, body: 'x' },
      { key: NEAR_MISS_DEPTH, body: 'x' },
      { key: NEAR_MISS_NO_FILE, body: 'x' },
    ];
    const app = await makeApp();

    for (const { key, body } of cases) {
      cloudStorage.readObject.mockResolvedValue(Buffer.from(body as string));
      const res = await app.inject({ method: 'GET', url: `/sim-public/${key}` });
      const cacheControl = String(res.headers['cache-control']);
      expect(
        { key, immutable: cacheControl.includes('immutable') },
        `${key} → ${cacheControl}`,
      ).toEqual({ key, immutable: isImmutableRevisionKey(key) });
    }
  });

  it('a pointer document — the thing that says which revision is live — must revalidate', async () => {
    // The pointer is the only mutable object in the design, and a cached pointer outliving a
    // rollback is exactly the window in which viewers keep loading a withdrawn revision.
    expect(cacheControlForKey(POINTER_KEY)).toBe(POINTER_CACHE_CONTROL);
    expect(POINTER_CACHE_CONTROL).not.toBe(IMMUTABLE_CACHE_CONTROL);

    cloudStorage.readObject.mockResolvedValue(Buffer.from(JSON.stringify({ activeRevisionId: REV })));
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${POINTER_KEY}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['etag']).toBeTruthy(); // revalidation still costs a 304, not a re-download
  });
});

// ── (b) ETag ≡ the bytes the manifest hashes ──────────────────────────────────

describe('GET /sim-public/* — revision ETags are the manifest hash', () => {
  it('the manifest under test is one the pipeline would accept', () => {
    // Otherwise the hash equality below would be a comparison against an invalid document.
    expect(validateManifest(MANIFEST, new Set(['runtime/bridge.js', 'package/assets/sprite.png']))).toEqual([]);
  });

  it('entry HTML is served byte-for-byte, with an ETag equal to the manifest hash', async () => {
    cloudStorage.readObject.mockResolvedValue(Buffer.from(ENTRY_HTML));
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${ENTRY_KEY}` });

    expect(res.statusCode).toBe(200);
    // No serve-time transform: a published object must equal what the manifest attests.
    expect(res.body).toBe(ENTRY_HTML);
    expect(res.body).not.toContain('data-simboot');
    expect(res.headers['etag']).toBe(`"${manifestHashFor('package/index.html')}"`);
    expect(res.headers['etag']).toBe(`"${sha256(ENTRY_HTML)}"`);
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(ENTRY_HTML)));
    expect(res.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it('the ETag digest agrees with the pure-TS hasher the publisher stamps manifests with', async () => {
    // sha256Hex (shared) and node's crypto must produce the same hex for the same bytes, or the
    // manifest and the served ETag would describe the same file with different strings.
    expect(sha256Hex(ENTRY_HTML)).toBe(sha256(ENTRY_HTML));
    expect(sha256Hex(ENTRY_HTML)).toBe(manifestHashFor('package/index.html'));
  });

  it('a runtime file 304s on its manifest hash and keeps the immutable header', async () => {
    cloudStorage.readObject.mockResolvedValue(Buffer.from(BRIDGE_JS));
    const app = await makeApp();
    const etag = `"${manifestHashFor('runtime/bridge.js')}"`;

    const res = await app.inject({
      method: 'GET',
      url: `/sim-public/${BRIDGE_KEY}`,
      headers: { 'if-none-match': etag },
    });

    expect(res.statusCode).toBe(304);
    expect(res.body).toBe('');
    expect(res.headers['etag']).toBe(etag);
    expect(res.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it('compression still engages, and the ETag stays the hash of the UNCOMPRESSED bytes', async () => {
    cloudStorage.readObject.mockResolvedValue(Buffer.from(BRIDGE_JS));
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: `/sim-public/${BRIDGE_KEY}`,
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
    expect(res.headers['vary']).toBe('accept-encoding');
    expect(res.headers['etag']).toBe(`"${manifestHashFor('runtime/bridge.js')}"`);
    expect(brotliDecompressSync(res.rawPayload).toString()).toBe(BRIDGE_JS);
  });

  it('a legacy key keeps its sha1 ETag — the algorithm change is scoped to revisions', async () => {
    cloudStorage.readObject.mockResolvedValue(Buffer.from('body{}'));
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${LEGACY_CSS}` });

    expect(res.headers['etag']).toBe(`"${sha1('body{}')}"`);
    expect(res.headers['etag']).not.toBe(`"${sha256('body{}')}"`);
  });

  it('404s when the revision object cannot be read (a missing file is never a 200)', async () => {
    cloudStorage.readObject.mockRejectedValue(new Error('NoSuchKey'));
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${ENTRY_KEY}` });

    expect(res.statusCode).toBe(404);
  });
});

// ── (c) Redirects may never point at a mutable target ─────────────────────────

describe('GET /sim-public/* — binary assets under a revision', () => {
  it('redirects immutably when the bucket URL is itself revision-scoped', async () => {
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${SPRITE_KEY}` });

    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe(
      `https://cdn.example.com/storage/v1/object/public/media/${SPRITE_KEY}`,
    );
    // The location carries the revision id, so caching the redirect forever cannot outlive the
    // bytes it names.
    expect(res.headers['location']).toContain(`/revisions/${REV}/`);
    expect(res.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(cloudStorage.readObject).not.toHaveBeenCalled();
  });

  it('refuses to redirect immutably to an aliased (non-key-scoped) URL, and proxies instead', async () => {
    // An adapter that maps keys onto opaque blob ids: nothing about that URL can be shown to be
    // immutable, so a year-long redirect to it would be a promise we cannot keep.
    cloudStorage.getPublicUrl.mockReturnValue('https://cdn.example.com/aliased/blob-42');
    cloudStorage.readObject.mockResolvedValue(SPRITE_BYTES);
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${SPRITE_KEY}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['location']).toBeUndefined();
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(res.headers['etag']).toBe(`"${manifestHashFor('package/assets/sprite.png')}"`);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(Buffer.compare(res.rawPayload, SPRITE_BYTES)).toBe(0);
    expect(cloudStorage.readObject).toHaveBeenCalledWith(SPRITE_KEY);
  });

  it('refuses a relative/unparseable redirect target the same way', async () => {
    cloudStorage.getPublicUrl.mockReturnValue(`/local-storage/${SPRITE_KEY}`);
    cloudStorage.readObject.mockResolvedValue(SPRITE_BYTES);
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${SPRITE_KEY}` });

    expect(res.statusCode).toBe(200);
    expect(Buffer.compare(res.rawPayload, SPRITE_BYTES)).toBe(0);
  });

  it('accepts a percent-encoded location that still addresses the key', async () => {
    const spacedKey = revisionFileKey(PROJECT, SIM, REV, 'package/assets/my sprite.png');
    cloudStorage.getPublicUrl.mockImplementation(
      (key: string) => `https://cdn.example.com/bucket/${encodeURI(key)}`,
    );
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${encodeURI(spacedKey)}` });

    expect(res.statusCode).toBe(302);
    expect(res.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(cloudStorage.readObject).not.toHaveBeenCalled();
  });

  it('keeps the legacy bounded-hour redirect for mutable binaries', async () => {
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${LEGACY_PNG}` });

    expect(res.statusCode).toBe(302);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(cloudStorage.readObject).not.toHaveBeenCalled();
  });

  it('serves a byte range from the proxied binary (seeking must survive the fallback)', async () => {
    cloudStorage.getPublicUrl.mockReturnValue('https://cdn.example.com/aliased/blob-42');
    cloudStorage.readObject.mockResolvedValue(SPRITE_BYTES);
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: `/sim-public/${SPRITE_KEY}`,
      headers: { range: 'bytes=100-199' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 100-199/${SPRITE_BYTES.length}`);
    expect(res.headers['content-length']).toBe('100');
    expect(Buffer.compare(res.rawPayload, SPRITE_BYTES.subarray(100, 200))).toBe(0);
  });

  it('serves an open-ended and a suffix range', async () => {
    cloudStorage.getPublicUrl.mockReturnValue('https://cdn.example.com/aliased/blob-42');
    cloudStorage.readObject.mockResolvedValue(SPRITE_BYTES);
    const app = await makeApp();
    const size = SPRITE_BYTES.length;

    const openEnded = await app.inject({
      method: 'GET',
      url: `/sim-public/${SPRITE_KEY}`,
      headers: { range: `bytes=${size - 10}-` },
    });
    expect(openEnded.statusCode).toBe(206);
    expect(openEnded.headers['content-range']).toBe(`bytes ${size - 10}-${size - 1}/${size}`);

    const suffix = await app.inject({
      method: 'GET',
      url: `/sim-public/${SPRITE_KEY}`,
      headers: { range: 'bytes=-16' },
    });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.headers['content-range']).toBe(`bytes ${size - 16}-${size - 1}/${size}`);
    expect(Buffer.compare(suffix.rawPayload, SPRITE_BYTES.subarray(size - 16))).toBe(0);
  });

  it('416s an unsatisfiable range instead of quietly sending everything', async () => {
    cloudStorage.getPublicUrl.mockReturnValue('https://cdn.example.com/aliased/blob-42');
    cloudStorage.readObject.mockResolvedValue(SPRITE_BYTES);
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: `/sim-public/${SPRITE_KEY}`,
      headers: { range: `bytes=${SPRITE_BYTES.length}-` },
    });

    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${SPRITE_BYTES.length}`);
    expect(res.body).toBe('');
  });

  it('ignores a multi-range request and answers the complete body', async () => {
    cloudStorage.getPublicUrl.mockReturnValue('https://cdn.example.com/aliased/blob-42');
    cloudStorage.readObject.mockResolvedValue(SPRITE_BYTES);
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: `/sim-public/${SPRITE_KEY}`,
      headers: { range: 'bytes=0-99,200-299' },
    });

    expect(res.statusCode).toBe(200);
    expect(Buffer.compare(res.rawPayload, SPRITE_BYTES)).toBe(0);
  });
});

// ── (d) Key guards are untouched ──────────────────────────────────────────────

describe('GET /sim-public/* — guards still reject before any revision logic', () => {
  it('rejects keys outside the simulations/ prefix', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/sim-public/videos/private.mp4' });
    expect(res.statusCode).toBe(403);
    expect(cloudStorage.readObject).not.toHaveBeenCalled();
  });

  it('rejects a traversal key even when it is dressed as a revision path', async () => {
    const app = await makeApp();

    // Encoded SLASHES, not encoded dots: the router collapses `..` / `%2e%2e` segments itself, so
    // `..%2f..%2f` is the form that actually arrives at the handler with traversal intact — and it
    // arrives carrying a valid-looking revision prefix, which `revisionIdFromKey` would happily
    // parse. The traversal guard has to win before any cache decision is reached.
    const escaped = `simulations/${PROJECT}/${SIM}/revisions/${REV}/..%2f..%2f..%2fsecrets/creds.js`;
    expect(isImmutableRevisionKey(decodeURIComponent(escaped))).toBe(true);

    const res = await app.inject({ method: 'GET', url: `/sim-public/${escaped}` });

    expect(res.statusCode).toBe(403);
    expect(res.headers['cache-control']).not.toBe(IMMUTABLE_CACHE_CONTROL);
    expect(cloudStorage.readObject).not.toHaveBeenCalled();
    expect(cloudStorage.getPublicUrl).not.toHaveBeenCalled();
  });
});

// ── (e) Local disk branch (dev parity) ────────────────────────────────────────

describe('GET /sim-public/* — local-disk branch', () => {
  beforeEach(() => {
    current.adapter = new LocalStorageAdapter();
  });

  it('streams revision HTML verbatim with the immutable header and Range support', async () => {
    writeLocal(ENTRY_KEY, ENTRY_HTML);
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${ENTRY_KEY}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(res.headers['accept-ranges']).toBe('bytes');
    // Byte-for-byte: the local branch must not re-run the boot injection on published bytes either,
    // or local dev would serve a different document than production for the same manifest hash.
    expect(res.body).toBe(ENTRY_HTML);
    expect(res.body).not.toContain('data-simboot');
  });

  it('keeps injecting the boot snippet into LEGACY html with no-cache (audited local/cloud parity)', async () => {
    writeLocal(LEGACY_HTML, ENTRY_HTML);
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${LEGACY_HTML}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toBe(injectSimBootSnippet(ENTRY_HTML));
  });

  it('serves a revision binary immutably, honouring Range', async () => {
    writeLocal(SPRITE_KEY, SPRITE_BYTES);
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: `/sim-public/${SPRITE_KEY}`,
      headers: { range: 'bytes=0-9' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(res.headers['content-range']).toBe(`bytes 0-9/${SPRITE_BYTES.length}`);
    expect(Buffer.compare(res.rawPayload, SPRITE_BYTES.subarray(0, 10))).toBe(0);
  });

  it('leaves legacy binaries with no Cache-Control at all (unchanged behaviour)', async () => {
    writeLocal(LEGACY_PNG, SPRITE_BYTES);
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${LEGACY_PNG}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBeUndefined();
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('403s a traversal key before touching the filesystem', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/sim-public/simulations/../etc/passwd' });
    expect(res.statusCode).toBe(403);
  });
});
