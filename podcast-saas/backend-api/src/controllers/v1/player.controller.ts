import type { FastifyInstance, FastifyReply } from 'fastify';
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

  // Force a caption (re)generation — used to retry failed captions immediately,
  // bypassing the failed-retry cooldown. Requires auth (project owner action).
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/captions/retry',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const projectId = request.params.id;
      const pricing = await BillingService.getPricing('project', projectId);
      if (!pricing) return reply.code(404).send({ message: 'Project not found' });
      await enqueueCaptionsForProject(projectId, { force: true }).catch(() => {});
      return reply.send(await getCaptionStatusForProject(projectId));
    },
  );
}
