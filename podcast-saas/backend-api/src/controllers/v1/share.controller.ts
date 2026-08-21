import { randomBytes } from 'crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { db } from '../../db/index.js';
import { projects } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { firebaseAuthMiddleware, firebaseAuthOptionalMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject } from '../../services/collabAccess.js';
import { buildPlayerConfig } from '../../services/buildPlayerConfig.js';
import { BillingService } from '../../services/billing/BillingService.js';
import { normalizeDubbingLanguage } from '../../services/dubbing/languages.js';
import {
  configSnapshot, isConfigRevalidation, sendConfigSnapshot,
} from '../../services/playerConfigFreshness.js';

export async function registerShareRoutes(app: FastifyInstance): Promise<void> {

  // ── Public (optional auth): GET /api/v1/share/:shareToken ─────────────────
  // Returns player config, or a `locked` paywall stub for paid, unpurchased content.
  // `?lang=he` serves that language's dubbed rendition and its matching captions (migration 067).
  // An unknown or unfinished language falls back to the source track inside buildPlayerConfig, so
  // a shared /he link keeps working when the dub is deleted rather than 404ing at the viewer.
  app.get<{ Params: { shareToken: string }; Querystring: { lang?: string } }>(
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
        // Reuse the already-loaded project row (loadperf-002/backend-110).
        const hasAccess = await BillingService.hasAccess(userId, 'project', project.id, project);
        if (!hasAccess) {
          return reply.send({
            locked: true, content_type: 'project', content_id: project.id,
            title: project.title, price_cents: project.price_cents, currency: project.currency,
          });
        }
      }

      // D-13. The share-token and paid gates above have already run, so the conditional answer
      // below can never turn a revoked link into a stale allow: a revoked token 404s before this
      // point, `If-None-Match` or not.
      const language = normalizeDubbingLanguage(request.query.lang ?? '');
      const snapshot = await configSnapshot(
        // `viewerId: null` mirrors the build argument — this route deliberately builds an
        // anonymous payload for everyone, so every share viewer of one language IS one audience.
        { surface: 'share', contentId: project.id, viewerId: null, language },
        () => buildPlayerConfig(project.id, null, project, language),
      );
      if (!snapshot) return reply.code(404).send({ message: 'Shared video not found' });

      // Fire-and-forget view count increment — for an OPENING, not for a freshness re-poll.
      // This route bumps on every GET, so without the guard D-13's ~60 revalidations an hour
      // would report one viewer of a one-hour lecture as sixty (D-13: "config revalidation must
      // not count as a view").
      if (!isConfigRevalidation(request)) {
        db.update(projects)
          .set({ view_count: sql`${projects.view_count} + 1` })
          .where(eq(projects.id, project.id))
          .catch(() => {});
      }

      return sendConfigSnapshot(request, reply, snapshot);
    },
  );

  // ── Auth: GET /api/v1/projects/:id/share ─────────────────────────────────
  // Returns current share token info (null shareToken if not shared).
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/share',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
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
      const project = await editableProject(request.params.id, user);
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
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      await db
        .update(projects)
        .set({ share_token: null, share_enabled_at: null })
        .where(eq(projects.id, project.id));

      return reply.code(204).send();
    },
  );
}
