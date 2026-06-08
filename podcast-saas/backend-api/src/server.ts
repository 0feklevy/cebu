import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
import { tmpdir } from 'os';
import { logger } from './lib/logger.js';
import { checkDatabaseConnection } from './db/index.js';
import { getFirebaseAdmin } from './services/firebase.js';
import { getStorageAdapter } from './services/storage/getStorageAdapter.js';
import { R2StorageAdapter } from './services/storage/R2StorageAdapter.js';
import { getSimulationContentType } from './services/simulation/SimulationService.js';

// Controllers
import { registerPlatformRoutes } from './controllers/v1/platform.controller.js';
import { registerProjectRoutes } from './controllers/v1/projects.controller.js';
import { registerCorpusRoutes } from './controllers/v1/corpus.controller.js';
import { registerVideoRoutes } from './controllers/v1/video.controller.js';
import { registerSectionsRoutes } from './controllers/v1/sections.controller.js';
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
import { registerSimulationsRoutes } from './controllers/v1/simulations.controller.js';
import { registerBrollRoutes } from './controllers/v1/broll.controller.js';
import { registerImageRoutes } from './controllers/v1/images.controller.js';
import { registerAudioRoutes } from './controllers/v1/audio.controller.js';
import { registerPlaylistRoutes } from './controllers/v1/playlists.controller.js';
import { registerBillingRoutes } from './controllers/v1/billing.controller.js';
import { registerStripeWebhookRoutes } from './controllers/v1/stripe-webhook.controller.js';
import { registerAvatarRoutes } from './controllers/v1/avatar.controller.js';
import { registerAdminAvatarRoutes } from './controllers/admin/v1/avatar.controller.js';
import { registerPublicCourseRoutes } from './controllers/v1/public-courses.controller.js';
import { registerCourseAuthoringRoutes } from './controllers/v1/courses.controller.js';

const PORT = parseInt(process.env.PORT ?? '8080', 10);

function getLocalStorageContentType(key: string): string | undefined {
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
  return undefined;
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

  // Health check
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '0.1.0',
  }));

  // Local file storage (dev only — active when R2 is not configured).
  // Public prefixes (banners, images) need no auth so browsers can load them directly.
  const PUBLIC_LOCAL_PREFIXES = ['playlist-banners/', 'thumbnails/', 'crop/', 'images/', 'audio/', 'captions/'];
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
      const filePath = join(tmpdir(), 'podcast-saas-local-storage', key);
      try {
        const data = await readFile(filePath);
        const contentType = getLocalStorageContentType(key);
        if (contentType) reply.header('Content-Type', contentType);
        return reply
          .header('Cross-Origin-Resource-Policy', 'cross-origin')
          .header('Access-Control-Allow-Origin', '*')
          .send(data);
      } catch {
        return reply.code(404).send({ message: 'File not found' });
      }
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
      const filePath = join(tmpdir(), 'podcast-saas-local-storage', key);
      try {
        const data = await readFile(filePath);
        const contentType = key.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : 'video/mp2t';
        return reply.header('Content-Type', contentType).send(data);
      } catch {
        return reply.code(404).send({ message: 'File not found' });
      }
    },
  );

  // HLS proxy for R2 storage — fetches from the R2 public URL and adds CORS headers.
  // Necessary because pub-*.r2.dev ignores PutBucketCorsCommand CORS rules.
  app.get<{ Params: { '*': string } }>(
    '/hls-proxy/*',
    async (request, reply) => {
      const key = request.params['*'];
      if (!key.startsWith('hls/')) {
        return reply.code(403).send({ message: 'Forbidden' });
      }
      const r2PublicUrl = process.env.R2_PUBLIC_URL;
      if (!r2PublicUrl) {
        return reply.code(500).send({ message: 'R2_PUBLIC_URL not set' });
      }
      try {
        const upstream = await fetch(`${r2PublicUrl}/${key}`);
        if (!upstream.ok) {
          return reply.code(upstream.status).send({ message: 'Upstream error' });
        }
        const contentType = key.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : 'video/mp2t';
        const data = Buffer.from(await upstream.arrayBuffer());
        return reply
          .header('Content-Type', contentType)
          .header('Access-Control-Allow-Origin', '*')
          .header('Cache-Control', 'public, max-age=3600')
          .send(data);
      } catch (err) {
        logger.warn({ key, err }, 'hls-proxy: fetch failed');
        return reply.code(502).send({ message: 'Failed to fetch from storage' });
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
      const filePath = join(tmpdir(), 'podcast-saas-local-storage', key);
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
      if (!key.startsWith('videos/')) {
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
        const code = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
        if (code === 404 || code === 403) return reply.code(404).send({ message: 'Not found' });
        logger.warn({ key, err }, 'video-proxy: R2 fetch failed');
        return reply.code(502).send({ message: 'Failed to fetch from storage' });
      }
    },
  );

  // Public simulation file serving (dev only, no auth) — serves simulations/ prefix with correct content-types.
  // In production, simulation files are served directly from R2 public URL.
  app.get<{ Params: { '*': string } }>(
    '/sim-public/*',
    async (request, reply) => {
      const key = request.params['*'];
      if (!key.startsWith('simulations/')) {
        return reply.code(403).send({ message: 'Forbidden' });
      }
      const filePath = join(tmpdir(), 'podcast-saas-local-storage', key);
      try {
        const data = await readFile(filePath);
        return reply
          .header('Content-Type', getSimulationContentType(key))
          .header('Cross-Origin-Resource-Policy', 'cross-origin')
          .header('Access-Control-Allow-Origin', '*')
          .send(data);
      } catch {
        return reply.code(404).send({ message: 'File not found' });
      }
    },
  );

  // Local upload endpoint — receives PUT from client for large video files in dev
  app.put<{ Params: { '*': string } }>(
    '/local-storage/upload/*',
    async (request, reply) => {
      const { writeFile, mkdir } = await import('fs/promises');
      const key = request.params['*'];
      const dest = join(tmpdir(), 'podcast-saas-local-storage', key);
      const dir = dest.substring(0, dest.lastIndexOf('/'));
      await mkdir(dir, { recursive: true });
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
  await registerPlaylistRoutes(app);
  await registerBillingRoutes(app);
  await registerStripeWebhookRoutes(app);
  await registerAvatarRoutes(app);
  await registerAdminAvatarRoutes(app);
  await registerPublicCourseRoutes(app);
  await registerCourseAuthoringRoutes(app);

  // Phase 2+ stubs (return 501 Not Implemented)
  await registerPhase2StubRoutes(app);

  // Global error handler
  app.setErrorHandler((err, _req, reply) => {
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;

    if (statusCode >= 500) {
      logger.error({ err }, 'Unhandled server error');
    }

    const error_type =
      (err as { error_type?: string }).error_type ?? 'llm_error';

    reply.code(statusCode).send({
      error_type,
      message: err.message ?? 'Internal server error',
    });
  });

  return app;
}

async function start() {
  try {
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

    const app = await build();
    await app.listen({ port: PORT, host: '0.0.0.0' });
    logger.info(`Backend API listening on port ${PORT}`);
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

start();
