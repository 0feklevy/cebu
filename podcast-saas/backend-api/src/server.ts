import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { Readable } from 'stream';
import { dirname, extname } from 'path';
import { and, eq, lt } from 'drizzle-orm';
import { logger } from './lib/logger.js';
import { LOCAL_STORAGE_BASE_DIR } from './services/storage/localStoragePaths.js';
import { safeLocalPath, keyHasTraversal } from './services/storage/pathSafety.js';
import { serveLocalFile } from './services/storage/serveFile.js';
import { checkDatabaseConnection, db, video_files, simulations } from './db/index.js';
import { getFirebaseAdmin } from './services/firebase.js';
import { getStorageAdapter } from './services/storage/getStorageAdapter.js';
import { R2StorageAdapter } from './services/storage/R2StorageAdapter.js';
import { LocalStorageAdapter } from './services/storage/LocalStorageAdapter.js';
import { getSimulationContentType } from './services/simulation/SimulationService.js';
import { startWorker } from './queue/startWorker.js';
import { stopBoss } from './queue/pgBoss.js';
import { drainInlineJobs } from './queue/inlineDriver.js';

// Controllers
import { registerPlatformRoutes } from './controllers/v1/platform.controller.js';
import { registerProjectRoutes } from './controllers/v1/projects.controller.js';
import { registerCorpusRoutes } from './controllers/v1/corpus.controller.js';
import { registerVideoRoutes } from './controllers/v1/video.controller.js';
import { registerSectionsRoutes } from './controllers/v1/sections.controller.js';
import { registerMarkersRoutes } from './controllers/v1/markers.controller.js';
import { registerEditorStateRoutes } from './controllers/v1/editor-state.controller.js';
import { registerAdminSettingsRoutes } from './controllers/admin/v1/settings.controller.js';
import { registerAdminSystemPromptRoutes } from './controllers/admin/v1/system-prompts.controller.js';
import { registerAdminLlmConfigRoutes } from './controllers/admin/v1/llm-config.controller.js';
import { registerAdminUsersRoutes } from './controllers/admin/v1/users.controller.js';
import { registerAdminPipelineStatsRoutes } from './controllers/admin/v1/pipeline-stats.controller.js';
import { registerAdminBillingRoutes } from './controllers/admin/v1/billing.controller.js';
import { firebaseAuthMiddleware } from './middleware/firebase-auth.js';

// Phase 2+ stub routes
import { registerPhase2StubRoutes } from './controllers/stubs.js';
import { registerPlayerRoutes } from './controllers/v1/player.controller.js';
import { registerShareRoutes }  from './controllers/v1/share.controller.js';
import { registerPermalinkRoutes } from './controllers/v1/permalink.controller.js';
import { registerSimulationsRoutes } from './controllers/v1/simulations.controller.js';
import { registerBrollRoutes } from './controllers/v1/broll.controller.js';
import { registerImageRoutes } from './controllers/v1/images.controller.js';
import { registerAudioRoutes } from './controllers/v1/audio.controller.js';
import { registerPlaylistRoutes } from './controllers/v1/playlists.controller.js';
import { registerCollaboratorRoutes } from './controllers/v1/collaborators.controller.js';
import { registerBillingRoutes } from './controllers/v1/billing.controller.js';
import { registerStripeWebhookRoutes } from './controllers/v1/stripe-webhook.controller.js';
import { registerAvatarRoutes } from './controllers/v1/avatar.controller.js';
import { registerAdminAvatarRoutes } from './controllers/admin/v1/avatar.controller.js';
import { registerPublicCourseRoutes } from './controllers/v1/public-courses.controller.js';
import { registerCourseAuthoringRoutes } from './controllers/v1/courses.controller.js';
import { registerBranchRoutes } from './controllers/v1/branch.controller.js';
import { registerPodcastRoutes } from './controllers/v1/podcast.controller.js';
import { registerPodcastScriptRoutes } from './controllers/v1/podcast-script.controller.js';
import { registerPodcastRenderRoutes } from './controllers/v1/podcast-render.controller.js';
import { registerPodcastStudioRoutes } from './controllers/v1/podcast-studio.controller.js';
import { recoverStuckPodcastScripts } from './services/podcast/runPodcastScript.js';
import { recoverStuckPodcastRenders } from './services/podcast/audio/runPodcastRender.js';
import { recoverStuckPodcastMixes } from './services/podcast/audio/runPodcastClips.js';

const PORT = parseInt(process.env.PORT ?? '8080', 10);

function getLocalStorageContentType(key: string): string {
  const ext = extname(key).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.json') return 'application/json';
  if (ext === '.vtt') return 'text/vtt; charset=utf-8';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  // Default so the browser never MIME-sniffs an unknown user-controlled upload.
  return 'application/octet-stream';
}

// On startup, fail any HLS transcode left mid-flight by a previous restart so it can
// be retried instead of sitting at 'processing' forever (there was no graceful drain).
async function recoverStuckTranscodes(): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes
  const recovered = await db
    .update(video_files)
    .set({
      hls_status: 'failed',
      hls_error: 'Interrupted by process restart',
      hls_finished_at: new Date(),
    })
    .where(and(eq(video_files.hls_status, 'processing'), lt(video_files.hls_started_at, cutoff)))
    .returning({ id: video_files.id });
  if (recovered.length > 0) {
    logger.warn({ count: recovered.length }, 'Recovered stuck HLS transcodes on startup');
  }
}

// Simulation ingestion runs in-process after the upload 202s; a restart (or a crash in
// the async chain) strands the row at 'processing' with no watchdog, so the client shows
// "Processing…" forever. Any 'processing' sim at boot is orphaned — flip it to 'failed'
// so the user gets a clear re-upload prompt (mirrors recoverStuckCrops).
async function recoverStuckSimulations(): Promise<void> {
  const recovered = await db
    .update(simulations)
    .set({ status: 'failed', error: 'Interrupted by process restart — please re-upload' })
    .where(eq(simulations.status, 'processing'))
    .returning({ id: simulations.id });
  if (recovered.length > 0) {
    logger.warn({ count: recovered.length }, 'Recovered stuck simulations on startup');
  }
}

// Crop was removed from the read path, so a crashed crop job never self-heals the way
// captions do — it sits at 'processing' forever. On the single-process managed host there is
// no live crop worker after a restart, so flip every leftover 'processing' crop to 'failed'
// (it can be re-claimed by a re-crop / re-upload). (backend-002 / backend-013)
async function recoverStuckCrops(): Promise<void> {
  const recovered = await db
    .update(video_files)
    .set({ crop_status: 'failed', crop_updated_at: new Date() })
    .where(eq(video_files.crop_status, 'processing'))
    .returning({ id: video_files.id });
  if (recovered.length > 0) {
    logger.warn({ count: recovered.length }, 'Recovered stuck crop jobs on startup');
  }
}

async function build() {
  const app = Fastify({
    logger: false, // use pino directly
    trustProxy: true,
  });

  await app.register(cors, {
    origin: [
      process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
      'http://localhost:3001',
    ],
    credentials: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // handled by frontends
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow video/HLS segments cross-origin
  });

  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10 GB (overridden per-route where needed)
  });

  // Health check — reports degraded (503) when the database is unreachable so the
  // platform load balancer can pull the instance instead of routing traffic to it.
  app.get('/health', async (_req, reply) => {
    try {
      await checkDatabaseConnection();
    } catch {
      return reply.code(503).send({
        status: 'degraded',
        reason: 'db_unavailable',
        timestamp: new Date().toISOString(),
      });
    }
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '0.1.0',
    };
  });

  // Local file storage (dev only — active when R2 is not configured).
  // Public prefixes (banners, images) need no auth so browsers can load them directly.
  // 'podcasts/' — studio clips + render masters: immutable, public-URL-modeled (like prod Supabase).
  const PUBLIC_LOCAL_PREFIXES = ['playlist-banners/', 'thumbnails/', 'crop/', 'images/', 'audio/', 'captions/', 'avatar-circles/', 'podcasts/'];
  app.get<{ Params: { '*': string } }>(
    '/local-storage/*',
    async (request, reply) => {
      const key = request.params['*'];
      const isPublic = PUBLIC_LOCAL_PREFIXES.some((p) => key.startsWith(p));
      if (!isPublic) {
        // Private assets (videos, HLS) require auth
        await firebaseAuthMiddleware(request, reply);
        if (reply.sent) return;
      }
      const filePath = safeLocalPath(LOCAL_STORAGE_BASE_DIR, key);
      if (!filePath) return reply.code(403).send({ message: 'Forbidden' });
      return serveLocalFile(request, reply, filePath, getLocalStorageContentType(key), {
        extraHeaders: {
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'cross-origin',
          'Access-Control-Allow-Origin': '*',
        },
      });
    },
  );

  // Public HLS segment serving for local storage (dev only, no auth).
  app.get<{ Params: { '*': string } }>(
    '/hls-public/*',
    async (request, reply) => {
      const key = request.params['*'];
      if (!key.startsWith('hls/')) {
        return reply.code(403).send({ message: 'Forbidden' });
      }
      const filePath = safeLocalPath(LOCAL_STORAGE_BASE_DIR, key);
      if (!filePath) return reply.code(403).send({ message: 'Forbidden' });
      const isSegment = !key.endsWith('.m3u8');
      const contentType = isSegment ? 'video/mp2t' : 'application/vnd.apple.mpegurl';
      return serveLocalFile(request, reply, filePath, contentType, {
        // .ts segments are immutable; the .m3u8 playlist can change on re-transcode.
        cacheControl: isSegment ? 'public, max-age=86400' : 'no-cache',
      });
    },
  );

  // HLS proxy for R2 storage — fetches from the R2 public URL and adds CORS headers.
  // Necessary because pub-*.r2.dev ignores PutBucketCorsCommand CORS rules.
  app.get<{ Params: { '*': string } }>(
    '/hls-proxy/*',
    async (request, reply) => {
      const key = request.params['*'];
      if (!key.startsWith('hls/') || keyHasTraversal(key)) {
        return reply.code(403).send({ message: 'Forbidden' });
      }
      const r2PublicUrl = process.env.R2_PUBLIC_URL;
      if (!r2PublicUrl) {
        return reply.code(500).send({ message: 'R2_PUBLIC_URL not set' });
      }
      const controller = new AbortController();
      request.raw.on('close', () => controller.abort());
      try {
        const upstream = await fetch(`${r2PublicUrl}/${key}`, { signal: controller.signal });
        if (!upstream.ok || !upstream.body) {
          // R2 may not have these segments when a read-only token forced the HLS
          // upload to fall back to durable local disk. Serve the local copy via
          // /hls-public (relative segment URLs then resolve there too).
          return reply.redirect(`/hls-public/${key}`);
        }
        const contentType = key.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : 'video/mp2t';
        // Stream the upstream body through instead of buffering the whole segment
        // into the Node heap (was Buffer.from(await upstream.arrayBuffer())).
        return reply
          .header('Content-Type', contentType)
          .header('Access-Control-Allow-Origin', '*')
          .header('Cache-Control', 'public, max-age=3600')
          .send(Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]));
      } catch (err) {
        if (controller.signal.aborted) return; // client disconnected mid-segment
        logger.warn({ key, err }, 'hls-proxy: R2 fetch failed — falling back to local /hls-public');
        return reply.redirect(`/hls-public/${key}`);
      }
    },
  );

  // Public raw video streaming (dev only, no auth) — only serves files under videos/ prefix.
  // Enables immediate playback in the editor while HLS transcoding runs in the background.
  // Range requests are supported so browser seeking works without buffering the whole file.
  app.get<{ Params: { '*': string } }>(
    '/video-raw/*',
    async (request, reply) => {
      const key = request.params['*'];
      if (!key.startsWith('videos/')) {
        return reply.code(403).send({ message: 'Forbidden' });
      }
      const filePath = safeLocalPath(LOCAL_STORAGE_BASE_DIR, key);
      if (!filePath) return reply.code(403).send({ message: 'Forbidden' });
      try {
        const { stat, createReadStream } = await import('fs');
        const { promisify } = await import('util');
        const fileStats = await promisify(stat)(filePath);
        const fileSize = fileStats.size;
        const ext = key.split('.').pop()?.toLowerCase() ?? 'mp4';
        const contentType = ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : 'video/mp4';

        const rangeHeader = request.headers['range'];
        if (rangeHeader) {
          // Parse "bytes=START-END" — also handles suffix form "bytes=-N" and open-end "bytes=N-"
          const rangeValue = rangeHeader.replace(/^bytes=/, '');
          const dashIdx = rangeValue.indexOf('-');
          const startStr = rangeValue.slice(0, dashIdx);
          const endStr = rangeValue.slice(dashIdx + 1);

          let start: number;
          let end: number;

          if (startStr === '') {
            // Suffix form: bytes=-N  → last N bytes
            const suffixLen = parseInt(endStr, 10);
            start = Math.max(0, fileSize - suffixLen);
            end = fileSize - 1;
          } else {
            start = parseInt(startStr, 10);
            end = endStr ? parseInt(endStr, 10) : fileSize - 1;
          }

          // Clamp to valid range
          end = Math.min(end, fileSize - 1);

          if (isNaN(start) || isNaN(end) || start > end) {
            logger.warn({ key, rangeHeader, start, end }, 'video-raw: invalid Range header');
            return reply
              .code(416)
              .header('Content-Range', `bytes */${fileSize}`)
              .send({ message: 'Range Not Satisfiable' });
          }

          logger.debug({
            key,
            range: rangeHeader,
            start,
            end,
            fileSize,
            status: 206,
            contentType,
          }, 'video-raw range response');

          return reply
            .code(206)
            .header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
            .header('Accept-Ranges', 'bytes')
            .header('Content-Length', end - start + 1)
            .header('Content-Type', contentType)
            .header('Access-Control-Allow-Origin', '*')
            .send(createReadStream(filePath, { start, end }));
        }

        logger.debug({ key, fileSize, status: 200, contentType }, 'video-raw full response');

        return reply
          .header('Accept-Ranges', 'bytes')
          .header('Content-Length', fileSize)
          .header('Content-Type', contentType)
          .header('Access-Control-Allow-Origin', '*')
          .send(createReadStream(filePath));
      } catch (err) {
        logger.warn({ key, err }, 'video-raw: file not found');
        return reply.code(404).send({ message: 'File not found' });
      }
    },
  );

  // R2 video proxy — streams raw videos from R2 with CORS + range-request support.
  // Replaces direct presigned URLs which lack CORS headers on the private R2 endpoint.
  app.get<{ Params: { '*': string } }>(
    '/video-proxy/*',
    async (request, reply) => {
      const key = request.params['*'];
      if (!key.startsWith('videos/') || keyHasTraversal(key)) {
        return reply.code(403).send({ message: 'Forbidden' });
      }
      const storage = getStorageAdapter();
      if (!(storage instanceof R2StorageAdapter)) {
        // Local dev: redirect to the existing /video-raw/ handler
        return reply.redirect(`/video-raw/${key}`);
      }
      try {
        const rangeHeader = request.headers['range'] as string | undefined;
        const { body, contentType, contentLength, statusCode, contentRange, acceptRanges } =
          await storage.streamObject(key, rangeHeader);

        reply
          .code(statusCode)
          .header('Content-Type', contentType)
          .header('Accept-Ranges', acceptRanges)
          .header('Access-Control-Allow-Origin', '*')
          .header('Access-Control-Allow-Headers', 'Range')
          .header('Access-Control-Expose-Headers', 'Content-Range, Content-Length');

        if (contentLength != null) reply.header('Content-Length', contentLength);
        if (contentRange)          reply.header('Content-Range', contentRange);

        return reply.send(body);
      } catch (err: unknown) {
        // R2 may not have the object when a read-only token forced the upload to
        // fall back to durable local disk (uploadStreamWithFallback). Serve the
        // local copy via /video-raw, which 404s only if it is truly absent.
        const code = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
        if (code === 404 || code === 403) return reply.redirect(`/video-raw/${key}`);
        logger.warn({ key, err }, 'video-proxy: R2 fetch failed — trying local fallback');
        return reply.redirect(`/video-raw/${key}`);
      }
    },
  );

  // Public simulation file serving (no auth) — serves the simulations/ prefix with the
  // CORRECT Content-Type. This must be a backend proxy, not a direct bucket link:
  // Supabase's public bucket force-downgrades text/html → text/plain (anti-phishing),
  // so an iframe pointed straight at the bucket renders raw `<!DOCTYPE html>…` source.
  // Local disk is streamed (Range support); cloud objects are read via the adapter and
  // re-emitted with getSimulationContentType so HTML renders and ES-module .js loads.
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
      const appOrigin = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
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
        `frame-ancestors ${appOrigin} http://localhost:3001`,
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

      // Cloud (Supabase / R2): only TEXT types need the proxy — they're the ones whose
      // Content-Type the public bucket mangles (text/html → text/plain) or that must
      // carry the sim CSP. Binary media (images, fonts, audio, video) redirects to the
      // bucket's public URL instead: those types serve with correct MIME, and the
      // browser then loads them straight from the CDN — parallel over HTTP/2 and
      // edge/browser-cached — rather than serializing through this proxy (one full
      // readObject per request), which made image-heavy sims crawl.
      const ext = extname(key).toLowerCase();
      const PROXIED_TEXT_EXTS = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.txt', '.md', '.xml', '.svg', '.vtt', '.csv']);
      // Keys are simId-scoped and write-once — EXCEPT the entry HTML and bridge JS,
      // which bridge (re)generation overwrites in place. Those must revalidate every
      // load (the old max-age=300 could serve a stale bridge right after regeneration);
      // everything else is safe to cache forever.
      const isRewritable = ext === '.html' || ext === '.htm' || ext === '.js' || ext === '.mjs';
      const IMMUTABLE = 'public, max-age=31536000, immutable';

      if (!PROXIED_TEXT_EXTS.has(ext)) {
        return reply
          .header('Cache-Control', IMMUTABLE)
          .header('Access-Control-Allow-Origin', '*')
          .redirect(storage.getPublicUrl(key));
      }

      try {
        const buf = await storage.readObject(key);
        return reply
          .header('Content-Type', contentType)
          .header('Content-Length', buf.length)
          .header('X-Content-Type-Options', 'nosniff')
          .header('Cross-Origin-Resource-Policy', 'cross-origin')
          .header('Access-Control-Allow-Origin', '*')
          .header('Content-Security-Policy', simCsp)
          .header('Cache-Control', isRewritable ? 'no-cache' : IMMUTABLE)
          .send(buf);
      } catch (err) {
        logger.warn({ key, err }, 'sim-public: cloud object read failed');
        return reply.code(404).send({ message: 'File not found' });
      }
    },
  );

  // Local upload endpoint — receives PUT from client for large video files in dev
  app.put<{ Params: { '*': string } }>(
    '/local-storage/upload/*',
    async (request, reply) => {
      // Dev-only durable-local upload path; never expose arbitrary writes in production.
      if (process.env.NODE_ENV === 'production') {
        return reply.code(404).send({ message: 'Not found' });
      }
      await firebaseAuthMiddleware(request, reply);
      if (reply.sent) return;
      const { writeFile, mkdir } = await import('fs/promises');
      const key = request.params['*'];
      const dest = safeLocalPath(LOCAL_STORAGE_BASE_DIR, key);
      if (!dest) return reply.code(403).send({ message: 'Forbidden' });
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, request.body as Buffer);
      return reply.code(200).send({ ok: true });
    },
  );

  // Register all routes
  await registerPlatformRoutes(app);
  await registerProjectRoutes(app);
  await registerCorpusRoutes(app);
  await registerVideoRoutes(app);
  await registerSectionsRoutes(app);
  await registerMarkersRoutes(app);
  await registerEditorStateRoutes(app);
  await registerSimulationsRoutes(app);
  await registerBrollRoutes(app);
  await registerImageRoutes(app);
  await registerAudioRoutes(app);

  // Admin routes
  await registerAdminSettingsRoutes(app);
  await registerAdminSystemPromptRoutes(app);
  await registerAdminLlmConfigRoutes(app);
  await registerAdminUsersRoutes(app);
  await registerAdminPipelineStatsRoutes(app);
  await registerAdminBillingRoutes(app);

  await registerPlayerRoutes(app);
  await registerShareRoutes(app);
  await registerPermalinkRoutes(app);
  await registerPlaylistRoutes(app);
  await registerCollaboratorRoutes(app);
  await registerBillingRoutes(app);
  await registerStripeWebhookRoutes(app);
  await registerAvatarRoutes(app);
  await registerAdminAvatarRoutes(app);
  await registerPublicCourseRoutes(app);
  await registerCourseAuthoringRoutes(app);
  await registerBranchRoutes(app);
  await registerPodcastRoutes(app);
  await registerPodcastScriptRoutes(app);
  await registerPodcastRenderRoutes(app);
  await registerPodcastStudioRoutes(app);

  // Phase 2+ stubs (return 501 Not Implemented)
  await registerPhase2StubRoutes(app);

  // Global error handler
  app.setErrorHandler((err, _req, reply) => {
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;

    if (statusCode >= 500) {
      logger.error({ err }, 'Unhandled server error');
    }

    // Default to a neutral type (was 'llm_error', which mislabelled every storage/DB
    // failure as an LLM error). For 5xx, return a generic message so internal detail
    // (Postgres/R2/fs paths, connection strings) is logged but never sent to clients.
    const error_type = (err as { error_type?: string }).error_type ?? 'server_error';
    const message = statusCode >= 500 ? 'Internal server error' : (err.message ?? 'Request failed');

    reply.code(statusCode).send({ error_type, message });
  });

  return app;
}

async function start() {
  try {
    // Fail closed: never run in production on the in-source encryption fallback key.
    if (process.env.NODE_ENV === 'production' && !process.env.ENCRYPTION_KEY) {
      logger.error('ENCRYPTION_KEY must be set in production — refusing to start');
      process.exit(1);
    }

    getFirebaseAdmin(); // validates env vars early

    // DB check: warn but don't crash — the postgres driver reconnects automatically.
    // A paused/slow DB should not prevent the server from starting.
    try {
      await checkDatabaseConnection();
    } catch (err) {
      logger.warn({ err }, 'Database not reachable at startup — will retry on first request');
    }

    // Configure R2 CORS so browsers can PUT directly to presigned URLs
    try {
      const storage = getStorageAdapter();
      if (storage instanceof R2StorageAdapter) {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
        await storage.ensureBucketCors([appUrl, 'http://localhost:3000', 'http://localhost:3001']);
      }
    } catch (err) {
      logger.warn({ err }, 'R2 CORS setup failed — configure manually in Cloudflare dashboard');
    }

    // Best-effort recovery of transcodes + crops interrupted by a previous restart.
    try {
      await recoverStuckTranscodes();
      await recoverStuckCrops();
      await recoverStuckSimulations();
      await recoverStuckPodcastScripts();
      await recoverStuckPodcastRenders();
      await recoverStuckPodcastMixes();
    } catch (err) {
      logger.warn({ err }, 'Stuck-job recovery failed (non-fatal)');
    }

    const app = await build();
    await app.listen({ port: PORT, host: '0.0.0.0' });
    logger.info(`Backend API listening on port ${PORT}`);

    // Opt-in in-process worker: run pg-boss workers inside the web process. This is the
    // single-process form for the managed host (which can't run a second process) and for
    // local dev. On hosts that support a separate worker service, run `npm run worker`
    // instead and leave WORKER_INLINE unset.
    if (process.env.QUEUE_DRIVER === 'pgboss' && process.env.WORKER_INLINE === '1') {
      try {
        await startWorker();
        logger.info('Worker running in-process (WORKER_INLINE=1)');
      } catch (err) {
        logger.error({ err }, 'In-process worker failed to start (continuing web-only)');
      }
    }

    // Graceful shutdown: drain in-flight HTTP requests before exit so a managed-host
    // redeploy doesn't hard-kill the process mid-request.
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received — draining');
      try {
        await app.close();
        await drainInlineJobs(); // wait for in-flight inline transcode/crop/caption jobs (backend-004)
        await stopBoss(); // drains in-flight pg-boss jobs; no-op when never started
        logger.info('Server closed cleanly — exiting');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during graceful shutdown');
        process.exit(1);
      }
    };
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.on('SIGINT', () => { void shutdown('SIGINT'); });
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

start();
