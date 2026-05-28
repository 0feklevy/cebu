import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../db/index.js';
import { projects } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { scriptGenerationRateLimit } from '../../middleware/rate-limit.js';
import { initSSE } from '../../lib/sse.js';
import { ScriptPipeline } from '../../services/script/ScriptPipeline.js';
import { LLMErrorType } from 'shared';

export async function registerStreamRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/projects/:id/stream
  // Starts SSE connection AND runs the script pipeline.
  // Client connects here after POST /script/generate.
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/stream',
    { preHandler: [firebaseAuthMiddleware, scriptGenerationRateLimit] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const sse = initSSE(reply);
      const heartbeat = sse.keepAlive();
      const abortController = new AbortController();

      // Cancel LLM calls on client disconnect
      request.raw.on('close', () => {
        abortController.abort();
        clearInterval(heartbeat);
      });

      sse.emit({ type: 'connected', project_id: project.id });

      const pipeline = new ScriptPipeline();

      try {
        await pipeline.run(project.id, sse, abortController.signal);
      } catch (err: unknown) {
        const isAbort =
          (err as { name?: string }).name === 'AbortError' ||
          (err as { error_type?: string }).error_type === LLMErrorType.ABORTED;

        if (!isAbort) {
          const errorType =
            (err as { error_type?: LLMErrorType }).error_type ?? LLMErrorType.LLM_ERROR;
          const message =
            err instanceof Error ? err.message : 'Script generation failed';
          sse.emit({ type: 'error', error_type: errorType, message });
        }
      } finally {
        clearInterval(heartbeat);
        sse.close();
      }
    },
  );
}
