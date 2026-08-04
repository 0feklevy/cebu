import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyCompress from '@fastify/compress';
import { createHash } from 'crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'path';
import { constants as zlibConstants } from 'zlib';
import {
  IMMUTABLE_CACHE_CONTROL,
  cacheControlForKey,
  isImmutableRevisionKey,
} from 'shared/src/sim/simRevision';
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

// NOTE: year-long `immutable` caching was removed (audited) for MUTABLE keys: replace/
// regeneration overwrite them in place, so immutable pinned stale CSS/JSON/binaries against new
// HTML/JS. It is restored for — and only for — keys inside an immutable revision prefix
// (`simulations/<project>/<sim>/revisions/<revisionId>/…`), where a new publication is a new set
// of paths and a URL therefore cannot come to mean different bytes. `cacheControlForKey` in
// shared/src/sim/simRevision is the single decision point; see simCacheControl below.

/**
 * Head bootstrap injected into every proxied sim entry HTML. It reads the
 * `#simboot=<urlencoded JSON {hide:[selectors]}>` fragment the player puts on the
 * iframe src and applies `display:none` DURING document parse — so a minimal-UI
 * sim paints minimal from its very first frame instead of flashing the full UI
 * until the postMessage startScript round-trip lands. Selector sanitization
 * mirrors the bridge's applyHideUi ({ } < \ rejected — no style breakouts).
 * The style is removed when the parent posts `clearBootHide` (sent right after
 * every startScript, whose __simHideUi style is the definitive hide set).
 * Injection happens at serve time, so already-stored sims get it too.
 */
const SIM_BOOT_SNIPPET =
  '<script data-simboot>(function(){try{' +
  'var m=/[#&]simboot=([^&]*)/.exec(location.hash||"");' +
  'if(m){var c=JSON.parse(decodeURIComponent(m[1]));var s=(c&&c.hide)||[];var r=[];' +
  'for(var i=0;i<s.length;i++){var x=s[i];if(typeof x==="string"&&!/[{}<\\\\]/.test(x))r.push(x+"{display:none !important}")}' +
  'if(r.length){var st=document.createElement("style");st.id="__simBootHide";st.textContent=r.join("\\n");' +
  '(document.head||document.documentElement).appendChild(st)}}' +
  'window.addEventListener("message",function(e){var d=e.data||{};' +
  'if(d&&d.type==="clearBootHide"){var el=document.getElementById("__simBootHide");if(el)el.remove()}});' +
  '}catch(e){}})()</script>';

/** Inject the boot snippet right after <head> (or <html>, or prepend) in sim entry HTML. */
export function injectSimBootSnippet(html: string): string {
  // Idempotency check matches the exact injected OPEN TAG, never a bare substring — a sim
  // whose own source merely mentions "data-simboot" (a comment, a docs string) must not
  // silently lose the minimal-UI boot cloak (audited false-positive suppression).
  if (/<script\s+data-simboot[\s>]/i.test(html)) return html;
  // `(\s[^>]*)?` — never a bare `<head[^>]*>` probe, which also matches `<header …>` (including
  // one inside an inline script's string literal, where splicing a `</script>`-bearing snippet
  // terminates the sim's own script element and destroys the document). Same hardening as
  // injectRafGate, which was fixed for exactly this (audited parity gap).
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + SIM_BOOT_SNIPPET + html.slice(head.index + head[0].length);
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + SIM_BOOT_SNIPPET + html.slice(root.index + root[0].length);
  return SIM_BOOT_SNIPPET + html;
}

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
 * The `Cache-Control` for one sim key: shared policy for revision paths, today's behaviour for
 * everything else.
 *
 * `cacheControlForKey` answers with exactly two policies — IMMUTABLE for a key inside a revision
 * prefix, POINTER (`no-cache, must-revalidate`) for anything else. Only the first is adopted here.
 * POINTER is written for the document that RESOLVES a pointer, and this route serves no such
 * document; the legacy mutable package files it does serve already revalidate on every request
 * under plain `no-cache`, which is the same contract (`must-revalidate` only governs what a cache
 * may do with an ALREADY-stale entry, and `no-cache` never lets one become usable without
 * revalidation). Rewriting the header string would therefore change what every existing client
 * sees — and what the Priority 1-6 suites pin — while buying nothing.
 *
 * Deliberately NOT hardened further here: whether a key counts as a revision key is
 * `isImmutableRevisionKey`'s decision alone, because the publisher stamps each manifest entry's
 * `cacheControl` from the same function. A second, stricter opinion in the serving layer would let
 * a manifest attest `immutable` for an object this route revalidates — an inconsistency the
 * manifest exists to make impossible. (Residual hazard, owned by the write side: a customer bundle
 * containing a top-level `revisions/<8+ chars>/` directory lands on keys shaped exactly like
 * published revision files. The fix is to reserve that segment in the upload path normalizer, not
 * to second-guess it at serve time.)
 */
function simCacheControl(key: string, mutableDefault: string): string {
  const policy = cacheControlForKey(key);
  return policy === IMMUTABLE_CACHE_CONTROL ? policy : mutableDefault;
}

/**
 * May an immutable response be answered with a redirect to `target`?
 *
 * A redirect cached for a year is a promise about a LOCATION, not about bytes. The promise only
 * holds if the location is itself revision-scoped — i.e. it addresses this exact immutable key —
 * because a location that resolves to a mutable alias would hand the client a year-long pin on
 * an object that regeneration is free to overwrite: precisely the stale-package failure immutable
 * revisions exist to eliminate, reintroduced one hop away where no ETag can catch it.
 *
 * Every adapter today builds its public URL by appending the full key (Supabase's bucket origin,
 * R2's proxy route, local's serve route — proven in storageAdapterParity.test.ts), so this holds.
 * An adapter that mapped keys onto some alias would not, and its immutability cannot be proven
 * from here, so this fails closed and the caller proxies the bytes instead — slower, always right.
 */
export function redirectPreservesKey(key: string, target: string): boolean {
  let pathname: string;
  try {
    // decode first: a key with a space/# is percent-encoded into the URL, and comparing the
    // encoded form against the raw key would reject a redirect that is in fact key-scoped.
    pathname = decodeURIComponent(new URL(target).pathname);
  } catch {
    return false; // relative, unparseable, or malformed %-escape → unprovable → refuse
  }
  return pathname.endsWith(`/${key}`);
}

type ByteRange = { start: number; end: number };

/**
 * Parse a single-range `Range` header against a known body size.
 *
 * Returns null when there is no range to honour (absent header, or a form this handler chooses to
 * ignore — RFC 9110 §14.2 explicitly permits ignoring a Range, and answering 200-with-everything
 * is always a valid response), `'unsatisfiable'` when the client named a range that cannot exist
 * (which must be a 416, never a silent full body), or the resolved byte offsets.
 *
 * Multi-range requests are ignored rather than half-served: a multipart/byteranges response this
 * route has no reason to produce is worse than the complete body no client can misread.
 */
function parseSingleRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, startStr, endStr] = m;
  if (startStr === '' && endStr === '') return 'unsatisfiable';

  let start: number;
  let end: number;
  if (startStr === '') {
    const suffixLength = Number(endStr);
    if (suffixLength === 0) return 'unsatisfiable'; // "bytes=-0" names an empty tail
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/**
 * Send an in-memory body, honouring `Range`.
 *
 * Binary sim assets include audio and video, which browsers fetch with `Range` — so range support
 * has to travel with the BODY, not with the transport that happened to deliver it. The cloud path
 * normally redirects binaries to the CDN (which ranges for us); when it cannot (see
 * redirectPreservesKey) the bytes come through here, and dropping range support at that point
 * would break seeking in exactly the packages that were careful enough to be published immutably.
 */
function sendBufferMaybeRanged(
  request: FastifyRequest,
  reply: FastifyReply,
  buf: Buffer,
  contentType: string,
): FastifyReply {
  reply.header('Content-Type', contentType).header('Accept-Ranges', 'bytes');
  const range = parseSingleRange(request.headers['range'], buf.length);
  if (range === 'unsatisfiable') {
    return reply.code(416).header('Content-Range', `bytes */${buf.length}`).send();
  }
  if (range) {
    return reply
      .code(206)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${buf.length}`)
      .header('Content-Length', range.end - range.start + 1)
      .send(buf.subarray(range.start, range.end + 1));
  }
  return reply.header('Content-Length', buf.length).send(buf);
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
      // Inside a revision prefix nothing is ever rewritten, so this key's bytes are fixed for as
      // long as the key exists. That single fact is what licenses BOTH the year-long header below
      // and the refusal to transform the body at serve time (see the entry-HTML branches).
      const immutable = isImmutableRevisionKey(key);

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
        const localExt = extname(key).toLowerCase();
        // PARITY (audited divergence): entry HTML must get the same serve-time boot-snippet
        // transform as the cloud path — the local early-return skipped it, so minimal-UI
        // sims flashed their full UI ONLY in local dev, hiding the exact bug the snippet
        // exists to kill. HTML is small; buffering it here is fine (no Range use case).
        // Revision HTML is exempt: its bytes were hashed into the manifest at publication, so a
        // serve-time rewrite would make every viewer's copy differ from what the manifest attests
        // — and the publisher already bakes the snippet in (injectSimBootSnippet is exported for
        // exactly that). Such HTML streams below like any other immutable file.
        if (!immutable && (localExt === '.html' || localExt === '.htm')) {
          try {
            const raw = await readFile(filePath, 'utf8');
            const html = injectSimBootSnippet(raw);
            return reply
              .header('X-Content-Type-Options', 'nosniff')
              .header('Cross-Origin-Resource-Policy', 'cross-origin')
              .header('Access-Control-Allow-Origin', '*')
              .header('Content-Security-Policy', simCsp)
              .header('Cache-Control', simCacheControl(key, 'no-cache'))
              .header('Content-Type', contentType)
              .send(html);
          } catch {
            return reply.code(404).send({ message: 'Not found' });
          }
        }
        return serveLocalFile(request, reply, filePath, contentType, {
          // Legacy keys keep getting no Cache-Control at all from this branch (unchanged); only a
          // revision key adds one, and only the immutable one.
          ...(immutable ? { cacheControl: IMMUTABLE_CACHE_CONTROL } : {}),
          extraHeaders: {
            'X-Content-Type-Options': 'nosniff',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Access-Control-Allow-Origin': '*',
            'Content-Security-Policy': simCsp,
          },
        });
      }

      const ext = extname(key).toLowerCase();
      // NO key OUTSIDE a revision prefix is write-once: "Replace simulation" overwrites EVERY user
      // file in place (same keys, new bytes), and bridge (re)generation rewrites the entry HTML +
      // bridge JS. Year-long `immutable` caching therefore served stale CSS/JSON/binaries against
      // freshly-replaced HTML/JS (audited). So legacy text revalidates (cheap 304s via strong
      // ETags) and legacy binary redirects cache for a bounded hour — the worst case after a
      // replace is one hour of a stale texture, not a year of a broken package. Revision keys are
      // the exception the audit called for, and only because their bytes cannot be replaced at all.
      const isProxiedText = PROXIED_TEXT_EXTS.has(ext);
      if (!isProxiedText) {
        // Binary assets redirect to the bucket CDN: those types serve with correct MIME,
        // and the browser then loads them straight from the CDN — parallel over HTTP/2
        // and edge/browser-cached — rather than serializing through this proxy (one full
        // readObject per request), which made image-heavy sims crawl.
        const target = storage.getPublicUrl(key);
        if (!immutable || redirectPreservesKey(key, target)) {
          return reply
            .header('Cache-Control', simCacheControl(key, 'public, max-age=3600'))
            .header('Access-Control-Allow-Origin', '*')
            .redirect(target, 302);
        }
        // The adapter's public URL does not address this key, so a year-long redirect to it
        // cannot be shown to be immutable. Fall through and serve the bytes from here instead.
      }

      try {
        let buf = await storage.readObject(key);
        // Entry HTML gets the minimal-UI boot bootstrap injected at serve time (see
        // SIM_BOOT_SNIPPET) — BEFORE the ETag, so the tag matches the served bytes.
        // Revision HTML is served byte-for-byte as published instead: see the local branch above
        // for why an immutable object must never be transformed on the way out.
        if (!immutable && (ext === '.html' || ext === '.htm')) {
          buf = Buffer.from(injectSimBootSnippet(buf.toString('utf8')), 'utf8');
        }
        // Strong ETag = a hash of the exact bytes being sent. Combined with `no-cache` on the
        // rewritable entry HTML / bridge JS this is the point: the browser still
        // revalidates every load, but an unchanged file costs a 304, not a re-download.
        //
        // Revision files use SHA-256 of the untransformed stored bytes, which is BY CONSTRUCTION
        // the same digest the manifest records for this path (simManifest: "hash is the SHA-256 of
        // the exact bytes stored at path"). So the ETag a client holds is directly comparable to
        // the manifest entry — "is the CDN serving what was published" becomes a string compare
        // instead of an act of faith. A different algorithm here would leave that unanswerable.
        const etag = immutable
          ? `"${createHash('sha256').update(buf).digest('hex')}"`
          : `"${createHash('sha1').update(buf).digest('hex')}"`;

        reply
          .header('X-Content-Type-Options', 'nosniff')
          .header('Cross-Origin-Resource-Policy', 'cross-origin')
          .header('Access-Control-Allow-Origin', '*')
          .header('Content-Security-Policy', simCsp)
          .header('Cache-Control', simCacheControl(key, 'no-cache'))
          .header('ETag', etag);

        // The representation varies by Accept-Encoding whether or not THIS reply ends
        // up compressed — set Vary unconditionally so shared caches key correctly.
        // (lowercase to match @fastify/compress's own value, so it never appends a dup)
        // Binaries never reach reply.compress(), so their representation does not vary.
        if (isProxiedText) reply.header('Vary', 'accept-encoding');

        if (etagMatches(request.headers['if-none-match'], etag)) {
          // 304 keeps the cache headers above; Fastify strips body/Content-Length/Type.
          return reply.code(304).send();
        }

        if (!isProxiedText) return sendBufferMaybeRanged(request, reply, buf, contentType);

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
