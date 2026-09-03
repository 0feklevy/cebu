import type { FastifyInstance } from 'fastify';
import fastifyCompress from '@fastify/compress';
import { readFile } from 'node:fs/promises';
import { extname } from 'path';
import { constants as zlibConstants } from 'zlib';
import { logger } from '../lib/logger.js';
import { LOCAL_STORAGE_BASE_DIR } from '../services/storage/localStoragePaths.js';
import { safeLocalPath, keyHasTraversal } from '../services/storage/pathSafety.js';
import { serveLocalFile } from '../services/storage/serveFile.js';
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';
import { cacheControlForKey } from 'shared/sim/simRevision';
import { revisionServingFacts, isRevisionStatusPublic } from '../services/simulation/revisionIdentity.js';
import { simTextCache, simLegacyTextCache, strongEtag } from '../services/simulation/simTextCache.js';
import { resolveSimFileKey } from '../services/simulation/simFileResolver.js';
import { LocalStorageAdapter } from '../services/storage/LocalStorageAdapter.js';
import { getSimulationContentType } from '../services/simulation/SimulationService.js';
import { browserOrigins } from '../config/publicOrigins.js';
import { SIM_AUTHORING_NS, SIM_AUTHORING_SCRIPT_PATH } from 'shared/sim/authoringProtocol';
import { SIM_AUTHORING_SCRIPT, SIM_AUTHORING_SCRIPT_ETAG } from '../services/simulation/SimAuthoringBootstrap.js';

// Cloud (Supabase / R2): only TEXT types need the proxy — they're the ones whose
// Content-Type the public bucket mangles (text/html → text/plain) or that must
// carry the sim CSP. Binary media redirects to the bucket's public URL instead
// (see the handler below).
const PROXIED_TEXT_EXTS = new Set([
  '.html', '.htm', '.js', '.mjs', '.css', '.json', '.txt', '.md', '.xml', '.svg', '.vtt', '.csv',
]);

// NOTE: year-long `immutable` caching was removed (audited): replace/regeneration overwrite
// keys in place, so immutable pinned stale CSS/JSON/binaries against new HTML/JS. Restore it
// only for content-addressed revision prefixes (roadmap).

/**
 * Head bootstrap injected into every proxied sim entry HTML.
 *
 * It carries TWO capabilities, and the ordering between them is a correctness property:
 *
 *  1. THE BOOT CLOAK. Reads the `#simboot=<urlencoded JSON {hide:[selectors]}>` fragment the
 *     player puts on the iframe src and applies `display:none` DURING document parse — so a
 *     minimal-UI sim paints minimal from its very first frame instead of flashing the full UI
 *     until the postMessage startScript round-trip lands. Selector sanitization mirrors the
 *     bridge's applyHideUi ({ } < \ rejected — no style breakouts). The style is removed when the
 *     parent posts `clearBootHide`.
 *
 *  2. THE AUTHORING HOOK. On a `CONNECT` from an allowlisted parent origin, it adopts the
 *     transferred MessagePort and loads the authoring script that draws the picker's badges.
 *
 * THE LISTENER IS INSTALLED FIRST, AND THE CLOAK PARSE HAS ITS OWN `try`. Originally one `try`
 * wrapped both, which meant a malformed `#simboot` fragment — a truncated URL, a bad
 * percent-encoding — would throw before the listener existed and silently disable BOTH the cloak
 * clear and authoring for that document. A capability must not be destroyable by unrelated
 * malformed input.
 *
 * Injection happens at serve time, so already-stored sims get both capabilities with no
 * republication. That is the entire reason the authoring hook lives here rather than in the rAF
 * gate: the gate is baked in at publication, so a capability added there reaches only packages
 * republished afterwards.
 *
 * INERT FOR VIEWERS. The hook does nothing until a CONNECT arrives, and only the editor sends one.
 */
function buildSimBootSnippet(): string {
  // The allowlist is embedded at SERVE time from the deployment's own origins — the child cannot
  // be talked into trusting an origin the deployment does not already serve the app from.
  const origins = JSON.stringify(browserOrigins());
  const authoringHook = process.env.SIM_AUTHORING_DISABLED === '1'
    ? ''
    : 'if(d&&d.ns==="' + SIM_AUTHORING_NS + '"&&d.type==="CONNECT"){' +
      'if(AO.indexOf(e.origin)<0)return;var p=e.ports&&e.ports[0];if(!p)return;' +
      'window.__SIM_AUTHORING_PENDING__={port:p,origin:e.origin,sid:d.sid};' +
      'if(window.__SIM_AUTHORING_ADOPT__){window.__SIM_AUTHORING_ADOPT__(window.__SIM_AUTHORING_PENDING__);return}' +
      'if(window.__SIM_AUTHORING_LOADING__)return;window.__SIM_AUTHORING_LOADING__=1;' +
      'var sc=document.createElement("script");sc.src="' + SIM_AUTHORING_SCRIPT_PATH + '";sc.async=true;' +
      // head||documentElement: the snippet runs inside <head>, so document.body may not exist yet.
      '(document.head||document.documentElement).appendChild(sc);return}';

  return '<script data-simboot>(function(){' +
    'var AO=' + origins + ';' +
    // Listener FIRST. Only our own parent may reach either capability (simulation-004).
    'try{window.addEventListener("message",function(e){if(e.source!==window.parent)return;var d=e.data||{};' +
    'if(d&&d.type==="clearBootHide"){var el=document.getElementById("__simBootHide");if(el)el.remove();return}' +
    authoringHook +
    '})}catch(e){}' +
    // Cloak parse SECOND, in its own try — it must not be able to take the listener down with it.
    'try{var m=/[#&]simboot=([^&]*)/.exec(location.hash||"");' +
    'if(m){var c=JSON.parse(decodeURIComponent(m[1]));var s=(c&&c.hide)||[];var r=[];' +
    'for(var i=0;i<s.length;i++){var x=s[i];if(typeof x==="string"&&!/[{}<\\\\]/.test(x))r.push(x+"{display:none !important}")}' +
    'if(r.length){var st=document.createElement("style");st.id="__simBootHide";st.textContent=r.join("\\n");' +
    '(document.head||document.documentElement).appendChild(st)}}}catch(e){}' +
    // Painted fallback THIRD, own try. A package published before the rAF gate never posts
    // SIM_PAINTED, and every cover that waits for it waits for a timer instead (the library
    // overlay sat on "Loading simulation…" for load + 2.5 s). The gate is baked at publication;
    // this runs at serve time, so it reaches every stored package. Two frames after load is
    // when a document that draws at all has drawn; a gated package answers first and this stays
    // silent. It is its OWN message type, deliberately: SIM_PAINTED means "a real frame was
    // drawn" and the player's hold is built on that (sim-transitions spec 11 — a package that
    // never draws must never get one). The library overlay honours both; the player keeps its
    // contract. AND the gate is checked BEFORE any frame is scheduled: the gate wraps
    // requestAnimationFrame and acks SIM_PAINTED on the first callback that completes, so a
    // fallback that scheduled its own frames through the wrapper would make the gate lie about a
    // package that never draws — exactly the false ack spec 11 exists to catch. The gate script
    // runs at the top of <head>, so its flag is set long before `load`.
    'try{window.addEventListener("load",function(){if(window.__SIM_RAF_GATE__)return;requestAnimationFrame(function(){requestAnimationFrame(function(){' +
    'try{if(window.parent&&window.parent!==window)window.parent.postMessage({type:"SIM_PAINTED_FALLBACK"},"*")}catch(e){}' +
    '})})})}catch(e){}' +
    '})()</script>';
}

/**
 * Computed once per process. `browserOrigins()` reads deploy configuration that does not change
 * while the server runs, and this string is spliced into every entry-HTML response.
 */
let _snippet: string | undefined;
const simBootSnippet = (): string => (_snippet ??= buildSimBootSnippet());

/**
 * Test seam — the same shape `resetSimFileCache` and `resetRevisionIdentityCacheForTest` already
 * use in this subsystem. Without it, a test cannot observe what the SIM_AUTHORING_DISABLED branch
 * actually emits: the snippet is built once per process, so the first call in a suite fixes it.
 */
export function resetSimBootSnippetForTest(): void {
  _snippet = undefined;
}

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
  if (head) return html.slice(0, head.index + head[0].length) + simBootSnippet() + html.slice(head.index + head[0].length);
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + simBootSnippet() + html.slice(root.index + root[0].length);
  return simBootSnippet() + html;
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

  /**
   * The picker's in-document half. Unauthenticated static JavaScript, exactly like the bridge and
   * gate bytes this route already serves — it contains no project data and grants nothing on its
   * own: it is inert until an allowlisted parent transfers it a MessagePort.
   *
   * Root path, NOT under /sim-public/. That wildcard 403s any key not starting `simulations/`,
   * and the snippet must be able to load this with a root-relative src from the sim's own origin.
   *
   * SIM_AUTHORING_DISABLED=1 turns the feature off server-side without a migration or a deploy of
   * the editor: the hook stops being emitted and this route stops answering, so a live problem is
   * one env var away from contained.
   */
  app.get('/sim-authoring.js', { helmet: false }, async (request, reply) => {
    if (process.env.SIM_AUTHORING_DISABLED === '1') {
      return reply.code(404).send({ message: 'Not found' });
    }
    if (etagMatches(request.headers['if-none-match'], SIM_AUTHORING_SCRIPT_ETAG)) {
      return reply
        .header('ETag', SIM_AUTHORING_SCRIPT_ETAG)
        .header('Cache-Control', 'no-cache')
        .code(304)
        .send();
    }
    return reply
      .header('Content-Type', 'application/javascript')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .header('Access-Control-Allow-Origin', '*')
      .header('ETag', SIM_AUTHORING_SCRIPT_ETAG)
      // no-cache, not immutable: the bytes change with a deploy, and a year-cached picker that
      // disagrees with its editor is the same class of bug as a year-cached entry document.
      .header('Cache-Control', 'no-cache')
      .header('Vary', 'accept-encoding')
      .compress(Buffer.from(SIM_AUTHORING_SCRIPT, 'utf8'));
  });

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

      // ── Revision-aware cache policy ────────────────────────────────────────────────────────
      // The blanket `no-cache` below exists because NO key under a sim prefix used to be
      // write-once: "Replace simulation" overwrites every user file in place. A revision prefix
      // IS write-once — its path contains a revision id and its bytes are never rewritten — so
      // those keys, and only those, can finally be cached for a year.
      //
      // VERIFIED IDENTITY, NOT PATH RESEMBLANCE.
      //
      // `revisionIdFromKey` is positional, which fixed an earlier first-match scan that also
      // matched `package/revisions/...`. Positional is still not sufficient on its own: it accepts
      // any id matching `^[A-Za-z0-9_-]{8,64}$`, so a customer package containing a top-level
      // `revisions/chapter01/` directory sits at exactly the canonical depth and was handed a year
      // of `immutable` caching for a MUTABLE object — "Replace simulation" overwrites those bytes
      // in place, and every viewer holding the cached copy keeps it for a year with no
      // revalidation path. The route percent-decodes its wildcard, so that shape can also be
      // requested directly.
      //
      // `isVerifiedRevisionKey` requires a UUID at the revision position AND a `sim_revisions` row
      // with that id belonging to the simulation named in the same key. It fails closed on any
      // doubt, including a database fault, so anything unverified keeps today's `no-cache`
      // behaviour byte for byte.
      const revision = await revisionServingFacts(key);
      // PUBLICATION GATE (simulation-007). A revision prefix is inside `simulations/`, so this
      // unauthenticated route served a `draft`/`uploading`/`validating`/`failed` revision's bytes
      // exactly like the active one — an aborted publication left a customer's unpublished package
      // world-readable forever, since `RevisionService.gc()` has no production caller. 404 rather
      // than 403: the correct answer to "does this URL name something the public may read" is that
      // it names nothing. Checked BEFORE the storage read, so the bytes are never fetched, and
      // before the binary branch, which would otherwise hand out the bucket's own public URL.
      if (revision.verified && !isRevisionStatusPublic(revision.status)) {
        // Logged, not silent. The allow-list inversion moved `canary_passed` from served to
        // refused on the argument that nothing hands out a URL into one — three independent
        // checks, none of which is a substitute for production disagreeing. If that argument is
        // wrong, this line is how it becomes visible instead of arriving as a support ticket.
        // It cannot be spammed by arbitrary input: the gate runs only for a VERIFIED revision, so
        // reaching it requires a real revision id that really belongs to that simulation.
        logger.warn({ key, status: revision.status }, 'sim-public: refused a non-public revision');
        return reply.code(404).send({ message: 'Not found' });
      }
      const isRevision = revision.verified;
      const isEntryDocument = /\.html?$/i.test(key);
      // The entry document is never immutable even inside a revision: injectSimBootSnippet runs
      // at SERVE time (below), so served bytes are not stored bytes — and the CSP
      // `frame-ancestors` list is deploy-dependent, so a year-long cache would freeze it and a
      // newly-added app origin could never reach an already-cached document.
      const revisionCacheControl = isRevision ? cacheControlForKey(key, isEntryDocument) : null;

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
        if (localExt === '.html' || localExt === '.htm') {
          try {
            const raw = await readFile(filePath, 'utf8');
            const html = injectSimBootSnippet(raw);
            return reply
              .header('X-Content-Type-Options', 'nosniff')
              .header('Cross-Origin-Resource-Policy', 'cross-origin')
              .header('Access-Control-Allow-Origin', '*')
              .header('Content-Security-Policy', simCsp)
              .header('Cache-Control', revisionCacheControl ?? 'no-cache')
              .header('Content-Type', contentType)
              .send(html);
          } catch {
            return reply.code(404).send({ message: 'Not found' });
          }
        }
        return serveLocalFile(request, reply, filePath, contentType, {
          // This branch previously emitted no Cache-Control at all — the only one that did not.
          ...(revisionCacheControl ? { cacheControl: revisionCacheControl } : {}),
          extraHeaders: {
            'X-Content-Type-Options': 'nosniff',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Access-Control-Allow-Origin': '*',
            'Content-Security-Policy': simCsp,
          },
        });
      }

      const ext = extname(key).toLowerCase();
      // NO key under a sim prefix is truly write-once anymore: "Replace simulation" overwrites
      // EVERY user file in place (same keys, new bytes), and bridge (re)generation rewrites the
      // entry HTML + bridge JS. Year-long `immutable` caching therefore served stale CSS/JSON/
      // binaries against freshly-replaced HTML/JS (audited). Until content-addressed revision
      // prefixes exist (roadmap), text revalidates (cheap 304s via strong ETags) and binary
      // redirects cache for a bounded hour — the worst case after a replace is one hour of a
      // stale texture, not a year of a broken package.
      if (!PROXIED_TEXT_EXTS.has(ext)) {
        // Binary assets redirect to the bucket CDN: those types serve with correct MIME,
        // and the browser then loads them straight from the CDN — parallel over HTTP/2
        // and edge/browser-cached — rather than serializing through this proxy (one full
        // readObject per request), which made image-heavy sims crawl.
        // Still a 302, not a 308: a permanently-cached redirect to an immutable response has no
        // revalidation path at all. The bounded hour stays the fallback for legacy keys.
        // DEDUPLICATED PACKAGES (migration 080): the requested path is a NAME; the bytes may live
        // at `blobs/<digest>`, shared with every other simulation containing the same file.
        // Resolved here — after every access check above has passed on the requested key — so
        // sharing bytes can never widen who may read them.
        return reply
          .header('Cache-Control', revisionCacheControl ?? 'public, max-age=3600')
          .header('Access-Control-Allow-Origin', '*')
          .redirect(storage.getPublicUrl(await resolveSimFileKey(key)), 302);
      }

      try {
        // A served REVISION's text is immutable by construction, so it is read from storage,
        // injected and hashed ONCE per process and then served from memory — the S3 GET + sha1 +
        // brotli that used to run per file per viewer is the single largest CPU cost this route
        // had (night run 2026-09-03 §6/§7). Legacy, in-place-replaceable keys are never cached.
        const resolvedKey = await resolveSimFileKey(key);
        const cached = isRevision ? simTextCache.get(resolvedKey) : simLegacyTextCache.get(resolvedKey);
        let buf: Buffer;
        let etag: string;
        if (cached) {
          buf = cached.bytes;
          etag = cached.etag;
        } else {
          buf = await storage.readObject(resolvedKey);
          // Entry HTML gets the minimal-UI boot bootstrap injected at serve time (see
          // SIM_BOOT_SNIPPET) — BEFORE the ETag, so the tag matches the served bytes.
          if (ext === '.html' || ext === '.htm') {
            buf = Buffer.from(injectSimBootSnippet(buf.toString('utf8')), 'utf8');
          }
          // Strong ETag = sha1 of the exact bytes. Combined with `no-cache` on the
          // rewritable entry HTML / bridge JS this is the point: the browser still
          // revalidates every load, but an unchanged file costs a 304, not a re-download.
          etag = strongEtag(buf);
          (isRevision ? simTextCache : simLegacyTextCache).set(resolvedKey, { bytes: buf, etag, contentType });
        }

        reply
          .header('X-Content-Type-Options', 'nosniff')
          .header('Cross-Origin-Resource-Policy', 'cross-origin')
          .header('Access-Control-Allow-Origin', '*')
          .header('Content-Security-Policy', simCsp)
          .header('Cache-Control', revisionCacheControl ?? 'no-cache')
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
