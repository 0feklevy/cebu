import type { FastifyInstance } from 'fastify';
import fastifyCompress from '@fastify/compress';
import { createHash } from 'crypto';
import { extname } from 'path';
import { constants as zlibConstants } from 'zlib';
import { logger } from '../lib/logger.js';
import { LOCAL_STORAGE_BASE_DIR } from '../services/storage/localStoragePaths.js';
import { safeLocalPath, keyHasTraversal } from '../services/storage/pathSafety.js';
import { serveLocalFile } from '../services/storage/serveFile.js';
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';
import { LocalStorageAdapter } from '../services/storage/LocalStorageAdapter.js';
import { getSimulationContentType } from '../services/simulation/SimulationService.js';
import { browserOrigins } from '../config/publicOrigins.js';

// Cloud (Supabase / R2): only TEXT types need the proxy — they're the ones whose
// Content-Type the public bucket mangles (text/html → text/plain) or that must
// carry the sim CSP. Binary media redirects to the bucket's public URL instead
// (see the handler below).
const PROXIED_TEXT_EXTS = new Set([
  '.html', '.htm', '.js', '.mjs', '.css', '.json', '.txt', '.md', '.xml', '.svg', '.vtt', '.csv',
]);

const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Weak-comparison If-None-Match check (RFC 9110 §13.1.2): strip any `W/` prefix
 * from the candidates, honor `*`, and compare the opaque tags byte-for-byte.
 * `ifNoneMatch` is the raw request header (possibly a comma-separated list).
 */
function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch
    .split(',')
    .some((candidate) => candidate.trim().replace(/^W\//, '') === etag);
}

/**
 * Public simulation file serving (no auth) — serves the simulations/ prefix with the
 * CORRECT Content-Type. This must be a backend proxy, not a direct bucket link:
 * Supabase's public bucket force-downgrades text/html → text/plain (anti-phishing),
 * so an iframe pointed straight at the bucket renders raw `<!DOCTYPE html>…` source.
 * Local disk is streamed (Range support); cloud objects are read via the adapter and
 * re-emitted with getSimulationContentType so HTML renders and ES-module .js loads.
 *
 * Cloud text responses are compressed (br preferred, gzip/deflate fallback — see the
 * scoped @fastify/compress registration below) and carry a strong sha1 ETag so the
 * `no-cache` entry HTML / bridge JS revalidate with a 304 instead of a full re-download.
 */
export async function registerSimPublicRoutes(app: FastifyInstance): Promise<void> {
  // Compression is deliberately NOT global: media/HLS/video streaming routes must never
  // grow an onSend compression hook (Range responses + already-compressed codecs). With
  // `global: false` the plugin only decorates `reply.compress()`, and compression happens
  // solely where this handler explicitly calls it (the sim-public text path).
  if (!app.hasReplyDecorator('compress')) {
    await app.register(fastifyCompress, {
      global: false,
      // Server-side preference order; the client's Accept-Encoding is still honored.
      encodings: ['br', 'gzip', 'deflate', 'identity'],
      // With global:false the plugin skips its recommended brotli default (quality 4),
      // falling back to Node's quality 11 — far too slow for on-the-fly compression.
      brotliOptions: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } },
      // The plugin's default compressible-types regex misses application/javascript
      // (what getSimulationContentType returns for .js/.mjs). Extend it; breadth is
      // safe because only this route ever calls reply.compress().
      customTypes:
        /^text\/(?!event-stream)|(?:\+|\/)json(?:;|$)|(?:\+|\/)xml(?:;|$)|javascript(?:;|$)|octet-stream(?:;|$)/u,
    });
  }

  app.get<{ Params: { '*': string } }>(
    '/sim-public/*',
    // Opt this route out of helmet: it serves sim files INTO a cross-origin <iframe>, and
    // helmet's default `X-Frame-Options: SAMEORIGIN` would refuse to display them. We set
    // our own security headers (nosniff + cross-origin CORP) on every response below.
    { helmet: false },
    async (request, reply) => {
      const key = request.params['*'];
      if (!key.startsWith('simulations/') || keyHasTraversal(key)) {
        return reply.code(403).send({ message: 'Forbidden' });
      }
      const contentType = getSimulationContentType(key);
      const storage = getStorageAdapter();

      // Restrictive CSP for served sims (security-003). The sim body is arbitrary
      // user-uploaded HTML/JS, so we keep script/style/img/etc. permissive (inline +
      // data/blob) to avoid breaking legit sims, but lock down the ambient surface:
      //  • frame-ancestors → only the app origin(s), so a private sim URL can't be
      //    reframed/clickjacked by an attacker page.
      //  • base-uri/form-action → 'self', so a sim can't retarget navigation/base to
      //    attacker infrastructure.
      // Note: dropping the iframe's `allow-same-origin` sandbox flag (the fuller
      // security-003 hardening) is deferred — it would break sims that use
      // localStorage/canvas-with-same-origin-data and needs runtime verification.
      // Only the app + admin public origins may frame sims (localhost added in dev only).
      const simFrameAncestors = browserOrigins().join(' ');
      // script/style/connect allow https: — sims legitimately pull CDN libs, Google
      // Fonts, and remote data, and blocking them adds no security when 'unsafe-inline'
      // + 'unsafe-eval' are already required by real sims (inline script can do anything
      // a remote one can). The ambient lockdown (frame-ancestors/base-uri/form-action)
      // is what actually protects the app. media-src covers sim audio/video, including
      // assets redirected to the bucket's public URL below.
      const simCsp = [
        "default-src 'self' data: blob:",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:",
        "style-src 'self' 'unsafe-inline' https:",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data: https:",
        "media-src 'self' data: blob: https:",
        "connect-src 'self' data: blob: https:",
        `frame-ancestors ${simFrameAncestors}`,
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; ');

      // Local disk: stream from the filesystem with HTTP Range support.
      if (storage instanceof LocalStorageAdapter) {
        const filePath = safeLocalPath(LOCAL_STORAGE_BASE_DIR, key);
        if (!filePath) return reply.code(403).send({ message: 'Forbidden' });
        return serveLocalFile(request, reply, filePath, contentType, {
          extraHeaders: {
            'X-Content-Type-Options': 'nosniff',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Access-Control-Allow-Origin': '*',
            'Content-Security-Policy': simCsp,
          },
        });
      }

      const ext = extname(key).toLowerCase();
      // Keys are simId-scoped and write-once — EXCEPT the entry HTML and bridge JS,
      // which bridge (re)generation overwrites in place. Those must revalidate every
      // load (the old max-age=300 could serve a stale bridge right after regeneration);
      // everything else is safe to cache forever.
      const isRewritable = ext === '.html' || ext === '.htm' || ext === '.js' || ext === '.mjs';

      if (!PROXIED_TEXT_EXTS.has(ext)) {
        // Binary assets redirect to the bucket CDN: those types serve with correct MIME,
        // and the browser then loads them straight from the CDN — parallel over HTTP/2
        // and edge/browser-cached — rather than serializing through this proxy (one full
        // readObject per request), which made image-heavy sims crawl.
        // 308 Permanent Redirect (not 302): these keys are write-once, and a permanent,
        // method-preserving status lets browsers/CDNs actually cache the redirect per
        // the immutable Cache-Control instead of re-asking on every load.
        return reply
          .header('Cache-Control', IMMUTABLE)
          .header('Access-Control-Allow-Origin', '*')
          .redirect(storage.getPublicUrl(key), 308);
      }

      try {
        const buf = await storage.readObject(key);
        // Strong ETag = sha1 of the exact bytes. Combined with `no-cache` on the
        // rewritable entry HTML / bridge JS this is the point: the browser still
        // revalidates every load, but an unchanged file costs a 304, not a re-download.
        const etag = `"${createHash('sha1').update(buf).digest('hex')}"`;

        reply
          .header('X-Content-Type-Options', 'nosniff')
          .header('Cross-Origin-Resource-Policy', 'cross-origin')
          .header('Access-Control-Allow-Origin', '*')
          .header('Content-Security-Policy', simCsp)
          .header('Cache-Control', isRewritable ? 'no-cache' : IMMUTABLE)
          .header('ETag', etag)
          // The representation varies by Accept-Encoding whether or not THIS reply ends
          // up compressed — set Vary unconditionally so shared caches key correctly.
          // (lowercase to match @fastify/compress's own value, so it never appends a dup)
          .header('Vary', 'accept-encoding');

        if (etagMatches(request.headers['if-none-match'], etag)) {
          // 304 keeps the cache headers above; Fastify strips body/Content-Length/Type.
          return reply.code(304).send();
        }

        reply.header('Content-Type', contentType).header('Content-Length', buf.length);
        // reply.compress(): negotiates Accept-Encoding (br > gzip > deflate), compresses
        // when the content type matches and the body clears the size threshold — dropping
        // Content-Length and setting Content-Encoding — and sends the buffer unchanged
        // (Content-Length intact) otherwise.
        reply.compress(buf);
        // compress() returns void, and resolving this async handler with `undefined`
        // before the compressed stream has flushed makes Fastify's wrapThenable
        // double-send an empty body (reply.sent tracks writableEnded). Returning the
        // reply thenable defers resolution until the response actually finishes.
        return reply;
      } catch (err) {
        logger.warn({ key, err }, 'sim-public: cloud object read failed');
        return reply.code(404).send({ message: 'File not found' });
      }
    },
  );
}
