import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { createHash } from 'crypto';
import { gunzipSync, brotliDecompressSync } from 'zlib';
import { registerSimPublicRoutes } from '../sim-public.controller.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  // Plain object → fails `instanceof LocalStorageAdapter` → the route takes the
  // cloud (Supabase/R2) path, which is what these tests exercise.
  mockStorage: {
    readObject: vi.fn<(key: string) => Promise<Buffer>>(),
    getPublicUrl: vi.fn((key: string) => `https://cdn.example.com/storage/v1/object/public/media/${key}`),
  },
}));

vi.mock('../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => mocks.mockStorage,
}));

// Keep the heavy SimulationService graph (db, LLM SDKs) out of this unit test; the
// stub mirrors the real CONTENT_TYPES entries for the extensions used below.
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
    };
    return map[ext] ?? 'application/octet-stream';
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { mockStorage } = mocks;

// ── Helpers ───────────────────────────────────────────────────────────────────

const HTML_KEY = 'simulations/proj-1/sim-1/index.html';
const CSS_KEY = 'simulations/proj-1/sim-1/styles.css';
const PNG_KEY = 'simulations/proj-1/sim-1/assets/sprite.png';

// Over the plugin's 1024-byte threshold so compression actually engages.
const BIG_HTML = `<!doctype html><html><body>${'sim '.repeat(1000)}</body></html>`;
// Under the threshold — served identity even when the client accepts encodings.
const SMALL_HTML = '<!doctype html><html><body>tiny sim</body></html>';

const IMMUTABLE = 'public, max-age=31536000, immutable';

function sha1Etag(body: string | Buffer): string {
  return `"${createHash('sha1').update(body).digest('hex')}"`;
}

async function makeApp() {
  const app = Fastify();
  await registerSimPublicRoutes(app);
  return app;
}

beforeEach(() => {
  mockStorage.readObject.mockReset();
  mockStorage.getPublicUrl.mockClear();
});

// ── (a) Text path: ETag + Content-Type + cache/security headers ───────────────

describe('GET /sim-public/* — cloud text path', () => {
  it('serves HTML with correct Content-Type, strong sha1 ETag, no-cache and Vary', async () => {
    mockStorage.readObject.mockResolvedValue(Buffer.from(SMALL_HTML));
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${HTML_KEY}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['etag']).toBe(sha1Etag(SMALL_HTML));
    // Rewritable entry HTML keeps no-cache — the ETag makes revalidation a 304, not a re-download.
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['vary']).toBe('accept-encoding');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['content-security-policy']).toContain('frame-ancestors');
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(SMALL_HTML)));
    expect(res.body).toBe(SMALL_HTML);
  });

  it('serves non-rewritable text (.css) with immutable Cache-Control and an ETag', async () => {
    const css = 'body { background: #000; }';
    mockStorage.readObject.mockResolvedValue(Buffer.from(css));
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${CSS_KEY}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/css');
    expect(res.headers['cache-control']).toBe(IMMUTABLE);
    expect(res.headers['etag']).toBe(sha1Etag(css));
  });

  it('returns 404 when the cloud object read fails', async () => {
    mockStorage.readObject.mockRejectedValue(new Error('NoSuchKey'));
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${HTML_KEY}` });

    expect(res.statusCode).toBe(404);
  });
});

// ── (b) Conditional requests: If-None-Match → 304 ─────────────────────────────

describe('GET /sim-public/* — If-None-Match revalidation', () => {
  it('returns 304 with empty body and same cache headers when the ETag matches', async () => {
    mockStorage.readObject.mockResolvedValue(Buffer.from(SMALL_HTML));
    const app = await makeApp();

    const first = await app.inject({ method: 'GET', url: `/sim-public/${HTML_KEY}` });
    const etag = first.headers['etag'] as string;
    expect(etag).toBeTruthy();

    const second = await app.inject({
      method: 'GET',
      url: `/sim-public/${HTML_KEY}`,
      headers: { 'if-none-match': etag },
    });

    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
    expect(second.headers['etag']).toBe(etag);
    expect(second.headers['cache-control']).toBe('no-cache');
    expect(second.headers['vary']).toBe('accept-encoding');
    expect(second.headers['access-control-allow-origin']).toBe('*');
    // A 304 must not carry a body length.
    expect(second.headers['content-length']).toBeUndefined();
  });

  it('matches weak validators and comma-separated If-None-Match lists', async () => {
    mockStorage.readObject.mockResolvedValue(Buffer.from(SMALL_HTML));
    const app = await makeApp();
    const etag = sha1Etag(SMALL_HTML);

    const weak = await app.inject({
      method: 'GET',
      url: `/sim-public/${HTML_KEY}`,
      headers: { 'if-none-match': `W/${etag}` },
    });
    expect(weak.statusCode).toBe(304);

    const list = await app.inject({
      method: 'GET',
      url: `/sim-public/${HTML_KEY}`,
      headers: { 'if-none-match': `"stale-etag", ${etag}` },
    });
    expect(list.statusCode).toBe(304);
  });

  it('serves the full 200 body when If-None-Match does not match (content changed)', async () => {
    mockStorage.readObject.mockResolvedValue(Buffer.from(SMALL_HTML));
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: `/sim-public/${HTML_KEY}`,
      headers: { 'if-none-match': '"0000000000000000000000000000000000000000"' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(SMALL_HTML);
    expect(res.headers['etag']).toBe(sha1Etag(SMALL_HTML));
  });
});

// ── (c) Compression: brotli preferred, gzip fallback, Vary set ────────────────

describe('GET /sim-public/* — compression', () => {
  it('brotli-compresses large text when Accept-Encoding allows br', async () => {
    mockStorage.readObject.mockResolvedValue(Buffer.from(BIG_HTML));
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: `/sim-public/${HTML_KEY}`,
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    });

    expect(res.statusCode).toBe(200);
    // Server preference picks br over gzip when the client offers both.
    expect(res.headers['content-encoding']).toBe('br');
    expect(res.headers['vary']).toBe('accept-encoding');
    // The compressed stream replaces the buffer: the original length header is dropped.
    expect(res.headers['content-length']).toBeUndefined();
    // ETag stays the sha1 of the UNCOMPRESSED bytes (what If-None-Match round-trips).
    expect(res.headers['etag']).toBe(sha1Etag(BIG_HTML));
    expect(brotliDecompressSync(res.rawPayload).toString()).toBe(BIG_HTML);
  });

  it('falls back to gzip when the client only accepts gzip', async () => {
    mockStorage.readObject.mockResolvedValue(Buffer.from(BIG_HTML));
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: `/sim-public/${HTML_KEY}`,
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['vary']).toBe('accept-encoding');
    expect(gunzipSync(res.rawPayload).toString()).toBe(BIG_HTML);
  });

  it('compresses application/javascript (custom compressible type)', async () => {
    const js = `export const data = [${'1,'.repeat(2000)}];`;
    mockStorage.readObject.mockResolvedValue(Buffer.from(js));
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: '/sim-public/simulations/proj-1/sim-1/bridge.js',
      headers: { 'accept-encoding': 'br' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/javascript');
    expect(res.headers['content-encoding']).toBe('br');
    expect(brotliDecompressSync(res.rawPayload).toString()).toBe(js);
  });

  it('serves identity (uncompressed, correct Content-Length) without Accept-Encoding', async () => {
    mockStorage.readObject.mockResolvedValue(Buffer.from(BIG_HTML));
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${HTML_KEY}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(BIG_HTML)));
    expect(res.body).toBe(BIG_HTML);
    // Still varies by Accept-Encoding so shared caches key the identity variant correctly.
    expect(res.headers['vary']).toBe('accept-encoding');
  });

  it('skips compression below the size threshold', async () => {
    mockStorage.readObject.mockResolvedValue(Buffer.from(SMALL_HTML));
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: `/sim-public/${HTML_KEY}`,
      headers: { 'accept-encoding': 'br, gzip' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.body).toBe(SMALL_HTML);
  });
});

// ── (d) Binary assets: 308 permanent redirect to the bucket CDN ───────────────

describe('GET /sim-public/* — binary asset redirect', () => {
  it('308-redirects non-text assets to the public bucket URL with immutable caching', async () => {
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: `/sim-public/${PNG_KEY}` });

    expect(res.statusCode).toBe(308);
    expect(res.headers['location']).toBe(
      `https://cdn.example.com/storage/v1/object/public/media/${PNG_KEY}`,
    );
    expect(res.headers['cache-control']).toBe(IMMUTABLE);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    // The proxy never buffers binary assets.
    expect(mockStorage.readObject).not.toHaveBeenCalled();
  });
});

// ── (e) Key guards: prefix + traversal rejection ──────────────────────────────

describe('GET /sim-public/* — key guards', () => {
  it('rejects keys outside the simulations/ prefix', async () => {
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: '/sim-public/videos/private.mp4' });

    expect(res.statusCode).toBe(403);
    expect(mockStorage.readObject).not.toHaveBeenCalled();
  });

  it('rejects traversal keys (plain and URL-encoded ..)', async () => {
    const app = await makeApp();

    const plain = await app.inject({
      method: 'GET',
      url: '/sim-public/simulations/../secrets/creds.html',
    });
    expect(plain.statusCode).toBe(403);

    const encoded = await app.inject({
      method: 'GET',
      url: '/sim-public/simulations/a/%2e%2e/%2e%2e/secrets.html',
    });
    expect(encoded.statusCode).toBe(403);

    expect(mockStorage.readObject).not.toHaveBeenCalled();
    expect(mockStorage.getPublicUrl).not.toHaveBeenCalled();
  });
});

// ── Production wiring: helmet registered globally, route opted out ────────────

describe('GET /sim-public/* — coexistence with global helmet (server.ts wiring)', () => {
  it('honors { helmet: false } so sims stay frameable, with compression still working', async () => {
    const { default: helmet } = await import('@fastify/helmet');
    const app = Fastify();
    await app.register(helmet, {
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    });
    await registerSimPublicRoutes(app);

    mockStorage.readObject.mockResolvedValue(Buffer.from(BIG_HTML));
    const res = await app.inject({
      method: 'GET',
      url: `/sim-public/${HTML_KEY}`,
      headers: { 'accept-encoding': 'br' },
    });

    expect(res.statusCode).toBe(200);
    // helmet's X-Frame-Options: SAMEORIGIN would break the cross-origin sim iframe.
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['content-encoding']).toBe('br');
    expect(res.headers['etag']).toBe(sha1Etag(BIG_HTML));
    expect(brotliDecompressSync(res.rawPayload).toString()).toBe(BIG_HTML);
  });
});
