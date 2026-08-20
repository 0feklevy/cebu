import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { Readable } from 'stream';
import { dirname, extname } from 'path';
import { eq } from 'drizzle-orm';
import { logger } from './lib/logger.js';
import { TRUST_PROXY_HOPS } from './config/trustProxy.js';
import { LOCAL_STORAGE_BASE_DIR } from './services/storage/localStoragePaths.js';
import { safeLocalPath, keyHasTraversal } from './services/storage/pathSafety.js';
import { serveLocalFile } from './services/storage/serveFile.js';
import { checkDatabaseConnection, db, video_files, simulations } from './db/index.js';
import { getFirebaseAdmin } from './services/firebase.js';
import { getStorageAdapter } from './services/storage/getStorageAdapter.js';
import { R2StorageAdapter } from './services/storage/R2StorageAdapter.js';
import {
  browserOrigins,
  assertPublicOriginsForProd,
} from './config/publicOrigins.js';
import { startWorker } from './queue/startWorker.js';
import { stopBoss } from './queue/pgBoss.js';
import { drainInlineJobs } from './queue/inlineDriver.js';

// Controllers
import { registerSimPublicRoutes } from './controllers/sim-public.controller.js';
import { registerSimRumRoutes } from './controllers/sim-rum.controller.js';
import { startRumRetentionSweep } from './services/simulation/RumService.js';
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
import { firebaseAuthMiddleware, firebaseAuthOptionalMiddleware } from './middleware/firebase-auth.js';
import { registerCorrelationId } from './middleware/correlationId.js';
import { canServeMediaKey } from './services/storage/mediaAccess.js';
import { splitMediaTokenPrefix } from './services/storage/mediaToken.js';
import { assertEncryptionKeyEnv } from './services/security/encryptionKey.js';
import { GLOBAL_MULTIPART_FILE_LIMIT_BYTES } from './services/security/uploadLimits.js';
import { apiErrorHandler } from './lib/apiErrorHandler.js';
import { hlsCacheControlForKey } from './services/video/hlsVersioning.js';
import { startHlsRetentionSweep } from './services/video/hlsRetention.js';
import { startDuplicationSweep } from './services/project/ProjectDuplicationService.js';
import { startExportSweep } from './services/export/ProjectExportService.js';
import { startHlsRecoverySweep, sweepStuckTranscodes } from './services/video/hlsRecovery.js';
import { startRevisionGcSweep } from './services/simulation/revisionGcSweep.js';
import { startCorpusIngestionSweep } from './services/ingestion/corpusRecovery.js';
import { registerExportRoutes } from './controllers/v1/export.controller.js';
import { registerHealthRoutes } from './controllers/v1/health.controller.js';

// Phase 2+ stub routes
import { registerPhase2StubRoutes } from './controllers/stubs.js';
import { registerPlayerRoutes } from './controllers/v1/player.controller.js';
import { registerShareRoutes }  from './controllers/v1/share.controller.js';
import { registerDubbingRoutes } from './controllers/v1/dubbing.controller.js';
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
import { recoverStuckVideoGenerations } from './jobs/video.generate.js';

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

// Fail any HLS transcode left mid-flight so it can be retried instead of sitting at 'processing'
// forever (there was no graceful drain). The rule itself lives in `services/video/hlsRecovery.ts`
// — it is shared with the REPEATING sweep started in `build()`, and this file cannot be imported
// by a test (module scope opens listeners and a database connection), so a copy here would be an
// untestable second definition of the same predicate.
//
// This boot call is now only the FIRST pass, not the only one. It used to be the only one, and it
// demanded thirty minutes of staleness, so a transcode orphaned five minutes before the restart
// was too young for it and nothing ever looked again (job-queue-003).
async function recoverStuckTranscodes(): Promise<void> {
  await sweepStuckTranscodes();
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
    /**
     * EXACTLY ONE TRUSTED HOP, not `true`.
     *
     * `true` trusts the whole X-Forwarded-For chain and takes the LEFTMOST entry — which the caller
     * writes. Every IP-keyed rate limit in this app was therefore keyed on a value the caller
     * chooses: one forged header per request means every request is the first in its own bucket,
     * which is not a weaker bound but no bound at all. That affects `/sim-rum` (unauthenticated)
     * and the two avatar routes.
     *
     * The production topology is a single VM where nginx terminates TLS and is the ONLY hop in
     * front of this process (deploy/docker-compose.yml — nginx alone binds 80/443; the API is
     * reachable only on a private Docker network). nginx forwards
     * `X-Forwarded-For: $proxy_add_x_forwarded_for`, which APPENDS the real peer to whatever the
     * caller sent. So the true client is always the entry nginx appended, and `1` — trust one hop
     * from this server — selects exactly that and ignores everything to its left.
     *
     * Measured, all against a real Fastify instance:
     *
     *   XFF "1.2.3.4, 203.0.113.9" from peer 172.18.0.5
     *     trustProxy: true -> req.ip = 1.2.3.4       (the spoof)
     *     trustProxy: 1    -> req.ip = 203.0.113.9   (the real client)
     *
     * `X-Forwarded-Proto` and `X-Forwarded-Host` are unaffected — verified: protocol still resolves
     * to https and hostname to the forwarded host under `1`.
     *
     * NOT `socket.remoteAddress`: behind nginx that is the proxy's container address, identical for
     * every viewer, so it would collapse the entire internet into one shared bucket — trading a
     * spoofable limit for a denial of service against honest users.
     *
     * IF A SECOND PROXY IS EVER PUT IN FRONT (a CDN, an ALB), THIS NUMBER MUST CHANGE TO MATCH THE
     * HOP COUNT, or req.ip becomes spoofable again.
     *
     * The number itself lives in ./config/trustProxy.ts so the proxy suite builds its Fastify
     * instance from the SAME constant. When the suite declared its own local copy, reverting this
     * line to `true` — the precise vulnerability it exists to prevent — left it fully green.
     */
    trustProxy: TRUST_PROXY_HOPS,
  });

  // observability-003 — FIRST, before any plugin that registers its own hooks.
  //
  // This opens the per-request AsyncLocalStorage scope that the pino mixin reads (lib/logger.ts),
  // so every line emitted while serving a request — controller, service, vendor retry, and any
  // inline job the request schedules — carries the same `cid`. It also writes the one
  // request-completion line: Fastify runs with `logger: false` here, so before this there was no
  // request log at all, and a failing request left behind only whatever a service happened to say.
  //
  // Ordering is load-bearing: hooks run in registration order, so anything registered above this
  // would log outside the scope and its lines would carry no id.
  registerCorrelationId(app);

  await app.register(cors, {
    // App + admin public origins, plus the local dev origins ONLY outside production.
    // (browserOrigins() includes localhost:3000/3001 only when NODE_ENV !== 'production',
    // so production never ships dev origins, and the admin origin is always included.)
    origin: browserOrigins(),
    credentials: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // handled by frontends
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow video/HLS segments cross-origin
  });

  // The global ceiling is the PROXY's body limit, not a number picked out of the air
  // (performance-005). 10 GB was neither a real capability nor a real bound: every byte of a
  // multipart request crosses nginx, whose `client_max_body_size` is smaller, so the only thing
  // the larger number achieved was that a route which forgot its own limit had none. Routes that
  // need less declare it per route (see services/security/uploadLimits.ts); the direct-to-storage
  // paths (presigned PUT, S3 multipart) never pass through this plugin and keep their own cap.
  await app.register(multipart, {
    limits: { fileSize: GLOBAL_MULTIPART_FILE_LIMIT_BYTES },
  });

  // Health check (observability-008). `/health` keeps its old contract for the platform load
  // balancer and the docker-compose healthcheck — 200/503 on whether THIS process can serve a
  // request, i.e. the database — but its body now reports the queue and the worker too, which is
  // where work on this system actually dies. `/health/ready` is the strict aggregate for humans
  // and alerting and must not be wired to the load balancer; see health.controller.ts.
  registerHealthRoutes(app);

  // Per-object media authorization for the video/HLS serve+proxy routes
  // (security-002 — fiji's checkVideoAccess pattern). Strips the optional
  // `t/{token}/` path prefix minted by the storage adapters, verifies the
  // expected key prefix, then allows: valid scoped token OR public/unlisted
  // project OR authenticated owner/collaborator. Replies 403 and returns null
  // otherwise.
  async function authorizeMediaRequest(
    request: FastifyRequest,
    reply: FastifyReply,
    raw: string,
    prefix: 'hls/' | 'videos/' | 'exports/',
  ): Promise<{ key: string; token: string | null } | null> {
    const { key, token } = splitMediaTokenPrefix(raw);
    if (!key.startsWith(prefix)) {
      reply.code(403).send({ message: 'Forbidden' });
      return null;
    }
    // Anonymous pass first (token / public project) — players never send auth headers.
    if (await canServeMediaKey(key, token, null)) return { key, token };
    if (request.headers.authorization) {
      await firebaseAuthOptionalMiddleware(request, reply);
      if (reply.sent) return null;
      const user = request.dbUser ?? null;
      if (user && (await canServeMediaKey(key, token, user))) return { key, token };
    }
    reply.code(403).send({ message: 'Access denied' });
    return null;
  }

  // Local file storage (dev only — active when R2 is not configured).
  // Public prefixes (banners, images) need no auth so browsers can load them directly.
  // 'podcasts/' — studio clips + render masters: immutable, public-URL-modeled (like prod Supabase).
  const PUBLIC_LOCAL_PREFIXES = ['playlist-banners/', 'thumbnails/', 'crop/', 'images/', 'audio/', 'captions/', 'avatar-circles/', 'podcasts/'];
  app.get<{ Params: { '*': string } }>(
    '/local-storage/*',
    async (request, reply) => {
      // The path may carry the adapters' `t/{token}/` prefix (export downloads are plain <a>
      // navigations with no auth header). Public checks and the served file both use the
      // STRIPPED key; authorization re-parses the raw path itself.
      const raw = request.params['*'];
      const key = splitMediaTokenPrefix(raw).key;
      // Reject `..` BEFORE the public-prefix branch — the same guard /video-raw, /video-proxy and
      // /sim-public already apply. Without it, an encoded-slash key like `podcasts/..%2fexports/…`
      // decodes to a `..` segment whose leading part matches a PUBLIC prefix (skipping auth) while
      // safeLocalPath resolves it back to the private `exports/…` file. `..` never appears in a key
      // this app mints, so this only ever rejects an attack.
      if (keyHasTraversal(key)) return reply.code(403).send({ message: 'Forbidden' });
      const isPublic = PUBLIC_LOCAL_PREFIXES.some((p) => key.startsWith(p));
      if (!isPublic) {
        // Media keys get per-object authorization (any-logged-in-user was too
        // broad — it let every account read every private key, security-002).
        if (key.startsWith('videos/') || key.startsWith('hls/') || key.startsWith('exports/')) {
          const authorized = await authorizeMediaRequest(
            request, reply, raw,
            key.startsWith('hls/') ? 'hls/' : key.startsWith('videos/') ? 'videos/' : 'exports/',
          );
          if (!authorized) return;
        } else {
          // Other private assets keep the legacy any-authenticated-user gate.
          await firebaseAuthMiddleware(request, reply);
          if (reply.sent) return;
        }
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

  // HLS segment serving for local storage — per-object authorized (see
  // authorizeMediaRequest); the token travels in the path so relative segment
  // URLs stay authorized.
  app.get<{ Params: { '*': string } }>(
    '/hls-public/*',
    async (request, reply) => {
      const authorized = await authorizeMediaRequest(request, reply, request.params['*'], 'hls/');
      if (!authorized) return;
      const { key } = authorized;
      const filePath = safeLocalPath(LOCAL_STORAGE_BASE_DIR, key);
      if (!filePath) return reply.code(403).send({ message: 'Forbidden' });
      const isSegment = !key.endsWith('.m3u8');
      const contentType = isSegment ? 'video/mp2t' : 'application/vnd.apple.mpegurl';
      return serveLocalFile(request, reply, filePath, contentType, {
        // Objects inside a versioned run tree (hls/{id}/{runId}/…) are write-once → immutable,
        // playlists included (a re-transcode flips the DB pointer to a NEW tree). Legacy
        // unversioned keys keep the old defaults: segments a day, playlists no-cache (they
        // were overwritten in place).
        cacheControl: hlsCacheControlForKey(key) ?? (isSegment ? 'public, max-age=86400' : 'no-cache'),
      });
    },
  );

  // HLS proxy for R2 storage — fetches from the R2 public URL and adds CORS headers.
  // Necessary because pub-*.r2.dev ignores PutBucketCorsCommand CORS rules.
  app.get<{ Params: { '*': string } }>(
    '/hls-proxy/*',
    async (request, reply) => {
      const authorized = await authorizeMediaRequest(request, reply, request.params['*'], 'hls/');
      if (!authorized) return;
      const { key, token } = authorized;
      if (keyHasTraversal(key)) {
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
          // /hls-public (relative segment URLs then resolve there too) — keep the
          // media token so the redirect target stays authorized.
          return reply.redirect(token ? `/hls-public/t/${token}/${key}` : `/hls-public/${key}`);
        }
        const contentType = key.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : 'video/mp2t';
        // Stream the upstream body through instead of buffering the whole segment
        // into the Node heap (was Buffer.from(await upstream.arrayBuffer())).
        //
        // Versioned run trees are write-once → immutable (playlists included; the mutable
        // pointer is the DB row). Legacy/unrecognised keys keep the old 1h default.
        return reply
          .header('Content-Type', contentType)
          .header('Access-Control-Allow-Origin', '*')
          .header('Cache-Control', hlsCacheControlForKey(key) ?? 'public, max-age=3600')
          .send(Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]));
      } catch (err) {
        if (controller.signal.aborted) return; // client disconnected mid-segment
        logger.warn({ key, err }, 'hls-proxy: R2 fetch failed — falling back to local /hls-public');
        return reply.redirect(token ? `/hls-public/t/${token}/${key}` : `/hls-public/${key}`);
      }
    },
  );

  // Public raw video streaming (dev only, no auth) — only serves files under videos/ prefix.
  // Enables immediate playback in the editor while HLS transcoding runs in the background.
  // Range requests are supported so browser seeking works without buffering the whole file.
  app.get<{ Params: { '*': string } }>(
    '/video-raw/*',
    async (request, reply) => {
      const authorized = await authorizeMediaRequest(request, reply, request.params['*'], 'videos/');
      if (!authorized) return;
      const { key } = authorized;
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
      const authorized = await authorizeMediaRequest(request, reply, request.params['*'], 'videos/');
      if (!authorized) return;
      const { key, token } = authorized;
      if (keyHasTraversal(key)) {
        return reply.code(403).send({ message: 'Forbidden' });
      }
      const storage = getStorageAdapter();
      if (!(storage instanceof R2StorageAdapter)) {
        // Local dev: redirect to the existing /video-raw/ handler (token preserved).
        return reply.redirect(token ? `/video-raw/t/${token}/${key}` : `/video-raw/${key}`);
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

  // Public simulation file serving (no auth) — /sim-public/*. Extracted to its own
  // controller (correct Content-Type proxy + sim CSP + compression + ETag/304 for
  // cloud text, 308 CDN redirect for binary assets). See sim-public.controller.ts.
  await registerSimPublicRoutes(app);
  // Sampled field measurement (migration 051). Registered unconditionally: the endpoint is inert
  // until an operator raises rum_sample_rate above 0, and the client sends nothing until the player
  // config tells it to. Gating the ROUTE on the flag would mean flipping the switch requires a
  // deploy, which is the property the switch exists to avoid.
  registerSimRumRoutes(app);
  // Retention is enforced, not intended. Without a caller the migration's own promise that "the
  // reaper is part of this change rather than a follow-up" would be false and the table would grow
  // without bound.
  startRumRetentionSweep();
  // Same posture for retired HLS trees (migration 053): a re-transcode RECORDS the old run
  // tree in hls_retired_runs instead of deleting it mid-session under viewers; this sweep is
  // what actually deletes those trees once their grace window has passed.
  startHlsRetentionSweep();
  // And the third sweep of the same shape (migration 056): a project duplication runs for minutes
  // on the inline driver, so a deploy or a crash mid-copy leaves its job row stuck in `copying`
  // forever — where the partial unique index turns it into a permanent block on ever duplicating
  // that project again. This is what declares such a row dead so the next attempt can start.
  startDuplicationSweep();
  // And the fourth (migration 058): an export encodes for minutes on the same driver, so the
  // same deploy/crash strands its row in an in-flight status where the partial unique index
  // blocks every future export of that project. Same reaper shape, same staleness rule.
  startExportSweep();
  // And the fifth, which is a different failure from the four above (job-queue-003): HLS recovery
  // was the one that ran ONLY at boot. A transcode orphaned minutes before a deploy is younger
  // than the stale window at boot, and the boot pass was the last thing that would ever look at
  // it — so it stayed at 'processing' for the life of the database. Live transcodes now beat a
  // heartbeat (`beatHlsHeartbeat`), which is what makes repeating the sweep safe rather than a
  // way to kill an honest long encode.
  startHlsRecoverySweep();
  // And the sixth (observability-002): corpus ingestion runs fire-and-forget off the upload
  // request and its only writers are its own happy path and its own catch — neither of which runs
  // when the process dies. There was no sweep at all, so a crash mid-ingest left the row at
  // 'processing' with nothing anywhere that would ever clear it.
  startCorpusIngestionSweep();
  // And the seventh, which is not a stuck-row reaper but a byte reclaimer: RevisionService.gc()
  // — keep-2 floor, age grace, rows-before-bytes — existed fully implemented and was called by
  // NOTHING in production, a fact two of its neighbours assert in their own comments. Superseded
  // simulation revisions accumulated for the life of every live simulation.
  startRevisionGcSweep();

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
  await registerDubbingRoutes(app);
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
  await registerExportRoutes(app);

  // Phase 2+ stubs (return 501 Not Implemented)
  await registerPhase2StubRoutes(app);

  // Global error handler — see lib/apiErrorHandler.ts (extracted so it is directly testable).
  app.setErrorHandler(apiErrorHandler);

  return app;
}

async function start() {
  try {
    // Fail closed: never run in production on the in-source encryption fallback key, and never
    // run ANYWHERE on a key that is set but unusable. A non-hex value decodes to a truncated or
    // empty buffer and `createHmac` signs with it silently, so a mistyped key used to mean media
    // tokens signed with no secret at all (security-004). The message names the variable.
    try {
      assertEncryptionKeyEnv();
    } catch (err) {
      logger.error({ err }, (err as Error).message);
      process.exit(1);
    }

    // Fail closed: never serve/store localhost or internal-docker URLs to browsers in prod.
    try {
      assertPublicOriginsForProd();
    } catch (err) {
      logger.error({ err }, (err as Error).message);
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
        await storage.ensureBucketCors(browserOrigins());
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
      await recoverStuckVideoGenerations();
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
