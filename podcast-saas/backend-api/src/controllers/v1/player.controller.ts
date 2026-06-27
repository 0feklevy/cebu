import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { projects, video_files } from '../../db/schema.js';
import { buildPlayerConfig } from '../../services/buildPlayerConfig.js';
import { firebaseAuthMiddleware, firebaseAuthOptionalMiddleware } from '../../middleware/firebase-auth.js';
import { BillingService } from '../../services/billing/BillingService.js';
import { enqueueCaptionsForProject, getCaptionStatusForProject } from '../../services/captions/CaptionService.js';

// Public (optional-auth) endpoint — returns player config for a project's viewer
// page, or a `locked` paywall stub when the project is paid and the viewer has
// not purchased it.

export async function registerPlayerRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/player-config',
    { preHandler: [firebaseAuthOptionalMiddleware] },
    async (request, reply: FastifyReply) => {
      const projectId = request.params.id;
      const pricing = await BillingService.getPricing('project', projectId);
      if (!pricing) return reply.code(404).send({ message: 'Project not found' });

      if (pricing.accessType === 'paid') {
        const userId = request.dbUser?.id ?? null;
        const hasAccess = await BillingService.hasAccess(userId, 'project', projectId);
        if (!hasAccess) {
          return reply.send({
            locked: true,
            content_type: 'project',
            content_id: projectId,
            title: pricing.title,
            price_cents: pricing.priceCents,
            currency: pricing.currency,
          });
        }
      }

      const config = await buildPlayerConfig(projectId);
      if (!config) return reply.code(404).send({ message: 'Project not found' });
      return reply.send(config);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/captions',
    { preHandler: [firebaseAuthOptionalMiddleware] },
    async (request, reply: FastifyReply) => {
      const projectId = request.params.id;
      const pricing = await BillingService.getPricing('project', projectId);
      if (!pricing) return reply.code(404).send({ message: 'Project not found' });

      if (pricing.accessType === 'paid') {
        const userId = request.dbUser?.id ?? null;
        const hasAccess = await BillingService.hasAccess(userId, 'project', projectId);
        if (!hasAccess) {
          return reply.code(403).send({ message: 'Captions are locked for this paid video' });
        }
      }

      await enqueueCaptionsForProject(projectId).catch(() => {});
      return reply.send(await getCaptionStatusForProject(projectId));
    },
  );

  // Serve a video's DB-stored caption WebVTT (no object storage dependency).
  // Public for free videos; gated for paid content via the project's access.
  app.get<{ Params: { videoId: string } }>(
    '/api/v1/videos/:videoId/captions.vtt',
    { preHandler: [firebaseAuthOptionalMiddleware] },
    async (request, reply: FastifyReply) => {
      const video = await db.query.video_files.findFirst({
        where: eq(video_files.id, request.params.videoId),
        columns: { id: true, project_id: true, captions_vtt: true, captions_status: true },
      });
      if (!video || !video.captions_vtt || video.captions_status !== 'ready') {
        return reply.code(404).send({ message: 'Captions not available' });
      }
      const pricing = await BillingService.getPricing('project', video.project_id);
      if (pricing?.accessType === 'paid') {
        const hasAccess = await BillingService.hasAccess(request.dbUser?.id ?? null, 'project', video.project_id);
        if (!hasAccess) return reply.code(403).send({ message: 'Captions are locked for this paid video' });
      }
      return reply
        .header('content-type', 'text/vtt; charset=utf-8')
        .header('cache-control', 'public, max-age=3600')
        .send(video.captions_vtt);
    },
  );

  // Force a caption (re)generation — used to retry failed captions immediately,
  // bypassing the failed-retry cooldown. Requires auth (project owner action).
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/captions/retry',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const projectId = request.params.id;
      // Ownership check: only the project owner may force a (billable) caption re-run.
      // (Existence probe alone allowed cross-tenant retries → IDOR + ffmpeg cost-DoS.)
      const userId = request.dbUser?.id;
      if (!userId) return reply.code(401).send({ message: 'Unauthorized' });
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, projectId), eq(projects.created_by, userId)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });
      await enqueueCaptionsForProject(projectId, { force: true }).catch(() => {});
      return reply.send(await getCaptionStatusForProject(projectId));
    },
  );
}
