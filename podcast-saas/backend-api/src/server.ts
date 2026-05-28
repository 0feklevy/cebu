import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from './lib/logger.js';
import { checkDatabaseConnection } from './db/index.js';
import { getFirebaseAdmin } from './services/firebase.js';

// Controllers
import { registerPlatformRoutes } from './controllers/v1/platform.controller.js';
import { registerProjectRoutes } from './controllers/v1/projects.controller.js';
import { registerCorpusRoutes } from './controllers/v1/corpus.controller.js';
import { registerScriptRoutes } from './controllers/v1/scripts.controller.js';
import { registerStreamRoutes } from './controllers/v1/stream.controller.js';
import { registerAudioRoutes } from './controllers/v1/audio.controller.js';
import { registerAdminSettingsRoutes } from './controllers/admin/v1/settings.controller.js';
import { registerAdminSystemPromptRoutes } from './controllers/admin/v1/system-prompts.controller.js';
import { registerAdminLlmConfigRoutes } from './controllers/admin/v1/llm-config.controller.js';
import { registerAdminUsersRoutes } from './controllers/admin/v1/users.controller.js';
import { firebaseAuthMiddleware } from './middleware/firebase-auth.js';

// Phase 2+ stub routes
import { registerPhase2StubRoutes } from './controllers/stubs.js';

const PORT = parseInt(process.env.PORT ?? '8080', 10);

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
  });

  await app.register(multipart, {
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  });

  // Health check
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '0.1.0',
  }));

  // Local file storage (dev only — active when R2 is not configured)
  app.get<{ Params: { '*': string } }>(
    '/local-storage/*',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply) => {
      const filePath = join(tmpdir(), 'podcast-saas-local-storage', request.params['*']);
      try {
        const data = await readFile(filePath);
        return reply.send(data);
      } catch {
        return reply.code(404).send({ message: 'File not found' });
      }
    },
  );

  // Register all routes
  await registerPlatformRoutes(app);
  await registerProjectRoutes(app);
  await registerCorpusRoutes(app);
  await registerScriptRoutes(app);
  await registerStreamRoutes(app);
  await registerAudioRoutes(app);

  // Admin routes
  await registerAdminSettingsRoutes(app);
  await registerAdminSystemPromptRoutes(app);
  await registerAdminLlmConfigRoutes(app);
  await registerAdminUsersRoutes(app);

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
    // Verify dependencies
    await checkDatabaseConnection();
    getFirebaseAdmin(); // validates env vars early

    const app = await build();
    await app.listen({ port: PORT, host: '0.0.0.0' });
    logger.info(`Backend API listening on port ${PORT}`);
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

start();
