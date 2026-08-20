import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { projects, video_files } from '../../db/schema.js';
import { buildPlayerConfig } from '../../services/buildPlayerConfig.js';
import { firebaseAuthMiddleware, firebaseAuthOptionalMiddleware } from '../../middleware/firebase-auth.js';
import { BillingService } from '../../services/billing/BillingService.js';
import { enqueueCaptionsForProject, getCaptionStatusForProject } from '../../services/captions/CaptionService.js';
import { requireProjectAccess } from '../../services/projectAccess.js';
import { editableProject, isCollaborator } from '../../services/collabAccess.js';
import { requireUuidParams } from '../../lib/uuidParam.js';
import { normalizeDubbingLanguage } from '../../services/dubbing/languages.js';

import type { AccessProject } from '../../services/projectAccess.js';

/** Read gate: visibility/owner/share-token first, then invited collaborators (042). */
async function projectReadable(
  project: AccessProject & { id: string },
  dbUser: { id: string; email: string | null } | undefined,
  shareToken?: string | null,
): Promise<boolean> {
  if (requireProjectAccess(project, dbUser?.id ?? null, shareToken)) return true;
  if (!dbUser) return false;
  return isCollaborator('project', project.id, dbUser);
}

/**
 * backend-001. `:id` goes straight into `eq(projects.id, …)` against a `uuid` column, and
 * Postgres REFUSES a malformed literal at bind time (SQLSTATE 22P02) rather than missing — so
 * `/api/v1/projects/banana/player-config` raised a driver error with no `statusCode` and the
 * global handler turned it into a 500. These guards answer 404 before the query is built, with
 * each route's own not-found body: these routes already 404-rather-than-403 so a private
 * project's existence is not confirmed, and a distinguishable "malformed id" body would hand
 * back exactly the oracle that choice denies.
 */
const projectIdIsUuid = requireUuidParams('id', 'Project not found');
const videoIdIsUuid = requireUuidParams('videoId', 'Captions not available');

// Public (optional-auth) endpoint — returns player config for a project's viewer
// page, or a `locked` paywall stub when the project is paid and the viewer has
// not purchased it.

export async function registerPlayerRoutes(app: FastifyInstance): Promise<void> {
  // `?lang=he` serves that language's dubbed rendition and captions (migration 067); an unknown
  // or unfinished language falls back to the source track rather than failing.
  app.get<{ Params: { id: string }; Querystring: { lang?: string } }>(
    '/api/v1/projects/:id/player-config',
    { preHandler: [projectIdIsUuid, firebaseAuthOptionalMiddleware] },
    async (request, reply: FastifyReply) => {
      const projectId = request.params.id;
      const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
      if (!project) return reply.code(404).send({ message: 'Project not found' });
      // Visibility gate: a draft/private project isn't world-readable by id. 404 (not 403)
      // so its existence isn't revealed. Owner/collaborator (auth) and public projects pass.
      if (!(await projectReadable(project, request.dbUser))) {
        return reply.code(404).send({ message: 'Project not found' });
      }

      // Pass the already-loaded `project` row through the billing + config builders so
      // they don't each re-SELECT the same row on this hot path (loadperf-002/backend-110).
      const pricing = await BillingService.getPricing('project', projectId, project);
      if (!pricing) return reply.code(404).send({ message: 'Project not found' });

      if (pricing.accessType === 'paid') {
        const userId = request.dbUser?.id ?? null;
        const hasAccess = await BillingService.hasAccess(userId, 'project', projectId, project);
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

      const config = await buildPlayerConfig(
        projectId, request.dbUser?.id ?? null, project, normalizeDubbingLanguage(request.query.lang ?? ''),
      );
      if (!config) return reply.code(404).send({ message: 'Project not found' });
      return reply.send(config);
    },
  );

  // ?share=<token> lets unlisted share-link viewers read caption status too — the shell's
  // status poll runs without Firebase auth, and without the token a private/unlisted
  // project 404s here and the CC button never lights up. (cc fix)
  app.get<{ Params: { id: string }; Querystring: { share?: string } }>(
    '/api/v1/projects/:id/captions',
    { preHandler: [projectIdIsUuid, firebaseAuthOptionalMiddleware] },
    async (request, reply: FastifyReply) => {
      const projectId = request.params.id;
      const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
      if (!project) return reply.code(404).send({ message: 'Project not found' });
      if (!(await projectReadable(project, request.dbUser, request.query.share ?? null))) {
        return reply.code(404).send({ message: 'Project not found' });
      }

      // Thread the already-loaded `project` row through billing so it isn't re-SELECTed
      // (mirrors the player-config route above — perf-018).
      const pricing = await BillingService.getPricing('project', projectId, project);
      if (!pricing) return reply.code(404).send({ message: 'Project not found' });

      if (pricing.accessType === 'paid') {
        const userId = request.dbUser?.id ?? null;
        const hasAccess = await BillingService.hasAccess(userId, 'project', projectId, project);
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
  app.get<{ Params: { videoId: string }; Querystring: { share?: string } }>(
    '/api/v1/videos/:videoId/captions.vtt',
    { preHandler: [videoIdIsUuid, firebaseAuthOptionalMiddleware] },
    async (request, reply: FastifyReply) => {
      const video = await db.query.video_files.findFirst({
        where: eq(video_files.id, request.params.videoId),
        columns: { id: true, project_id: true, captions_vtt: true, captions_status: true },
      });
      if (!video || !video.captions_vtt || video.captions_status !== 'ready') {
        return reply.code(404).send({ message: 'Captions not available' });
      }
      // Visibility gate (mirror player-config): a private/draft project's caption transcript
      // must not be readable by video id alone, only its paid status was checked before
      // (security-105). 404 so existence isn't revealed. ?share=<token> mirrors the status
      // route so unlisted share-link viewers can read the VTT. (cc fix)
      const project = await db.query.projects.findFirst({ where: eq(projects.id, video.project_id) });
      if (!project || !(await projectReadable(project, request.dbUser, request.query.share ?? null))) {
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
    { preHandler: [projectIdIsUuid, firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const projectId = request.params.id;
      // Ownership check: only the project owner/collaborator may force a (billable)
      // caption re-run. (Existence probe alone allowed cross-tenant retries → IDOR +
      // ffmpeg cost-DoS.)
      const user = request.dbUser;
      if (!user) return reply.code(401).send({ message: 'Unauthorized' });
      const project = await editableProject(projectId, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });
      await enqueueCaptionsForProject(projectId, { force: true }).catch(() => {});
      return reply.send(await getCaptionStatusForProject(projectId));
    },
  );
}
