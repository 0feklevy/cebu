import { randomBytes } from 'crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { db } from '../../db/index.js';
import { projects } from '../../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { firebaseAuthMiddleware, firebaseAuthOptionalMiddleware } from '../../middleware/firebase-auth.js';
import { buildPlayerConfig } from '../../services/buildPlayerConfig.js';
import { BillingService } from '../../services/billing/BillingService.js';

export async function registerShareRoutes(app: FastifyInstance): Promise<void> {

  // ── Public (optional auth): GET /api/v1/share/:shareToken ─────────────────
  // Returns player config, or a `locked` paywall stub for paid, unpurchased content.
  app.get<{ Params: { shareToken: string } }>(
    '/api/v1/share/:shareToken',
    { preHandler: [firebaseAuthOptionalMiddleware] },
    async (request, reply: FastifyReply) => {
      const project = await db.query.projects.findFirst({
        where: eq(projects.share_token, request.params.shareToken),
      });
      if (!project || !project.share_token) {
        return reply.code(404).send({ message: 'Shared video not found or link has been revoked' });
      }

      if (project.access_type === 'paid') {
        const userId = request.dbUser?.id ?? null;
        const hasAccess = await BillingService.hasAccess(userId, 'project', project.id);
        if (!hasAccess) {
          return reply.send({
            locked: true, content_type: 'project', content_id: project.id,
            title: project.title, price_cents: project.price_cents, currency: project.currency,
          });
        }
      }

      const config = await buildPlayerConfig(project.id);
      if (!config) return reply.code(404).send({ message: 'Shared video not found' });

      // Fire-and-forget view count increment
      db.update(projects)
        .set({ view_count: sql`${projects.view_count} + 1` })
        .where(eq(projects.id, project.id))
        .catch(() => {});

      return reply.send(config);
    },
  );

  // ── Auth: GET /api/v1/projects/:id/share ─────────────────────────────────
  // Returns current share token info (null shareToken if not shared).
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/share',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      if (!project.share_token) {
        return reply.send({ shareToken: null, shareUrl: null });
      }
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
      return reply.send({
        shareToken: project.share_token,
        shareUrl:   `${appUrl}/v/${project.share_token}`,
      });
    },
  );

  // ── Auth: POST /api/v1/projects/:id/share ────────────────────────────────
  // Generate (or return existing) share token. Idempotent.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/share',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      // Idempotent — return existing token if already set
      if (project.share_token) {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
        return reply.send({
          shareToken: project.share_token,
          shareUrl:   `${appUrl}/v/${project.share_token}`,
        });
      }

      // Generate a 22-char URL-safe random token
      const shareToken = randomBytes(16).toString('base64url');

      await db
        .update(projects)
        .set({ share_token: shareToken, share_enabled_at: new Date() })
        .where(eq(projects.id, project.id));

      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
      return reply.code(201).send({
        shareToken,
        shareUrl: `${appUrl}/v/${shareToken}`,
      });
    },
  );

  // ── Auth: DELETE /api/v1/projects/:id/share ──────────────────────────────
  // Revoke the share token — all existing shared links become invalid.
  app.delete<{ Params: { id: string } }>(
    '/api/v1/projects/:id/share',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, request.params.id), eq(projects.created_by, user.id)),
      });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      await db
        .update(projects)
        .set({ share_token: null, share_enabled_at: null })
        .where(eq(projects.id, project.id));

      return reply.code(204).send();
    },
  );
}
