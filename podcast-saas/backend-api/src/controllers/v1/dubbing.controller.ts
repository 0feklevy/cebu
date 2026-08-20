/**
 * Dubbing routes — the creator's control surface, plus the public per-language caption read.
 *
 * Two access rules, both inherited from the conventions this codebase already keeps rather than
 * invented here:
 *
 *   • every creator route goes through `editableProject`, and answers 404 rather than 403 when it
 *     refuses, so an unauthorised caller cannot use the endpoint as an existence oracle for
 *     someone else's project;
 *
 *   • the public caption route mirrors `/api/v1/videos/:videoId/captions.vtt` exactly — the same
 *     visibility gate, the same `?share=` token support for unlisted links, and the same paid-
 *     content check. A translated transcript is the same content as an untranslated one and must
 *     not be readable under weaker rules just because it is newer.
 *
 * The POST is the only route here that can cause money to be spent, which is why it is the one
 * that takes a project-editable guard AND leans on `requestProjectDub`'s conflict handling rather
 * than deciding for itself whether a dub already exists.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { projects, video_files } from '../../db/schema.js';
import { firebaseAuthMiddleware, firebaseAuthOptionalMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject, isCollaborator } from '../../services/collabAccess.js';
import { requireProjectAccess } from '../../services/projectAccess.js';
import { BillingService } from '../../services/billing/BillingService.js';
import { requireUuidParams } from '../../lib/uuidParam.js';
import {
  listDubsForProject,
  requestProjectDub,
  deleteProjectDub,
  estimateProjectDubCost,
  isDubServable,
  UnsupportedDubLanguage,
  DUB_PROVIDER_ELEVENLABS,
} from '../../services/dubbing/dubRegistry.js';
import { DUBBING_LANGUAGES, normalizeDubbingLanguage } from '../../services/dubbing/languages.js';
import { logger } from '../../lib/logger.js';

import type { AccessProject } from '../../services/projectAccess.js';

/** Read gate, identical to player.controller's — visibility/owner/share, then collaborators. */
async function projectReadable(
  project: AccessProject & { id: string },
  dbUser: { id: string; email: string | null } | undefined,
  shareToken?: string | null,
): Promise<boolean> {
  if (requireProjectAccess(project, dbUser?.id ?? null, shareToken)) return true;
  if (!dbUser) return false;
  return isCollaborator('project', project.id, dbUser);
}

const projectIdIsUuid = requireUuidParams('id', 'Project not found');
const videoIdIsUuid = requireUuidParams('videoId', 'Captions not available');

export async function registerDubbingRoutes(app: FastifyInstance): Promise<void> {

  // ── Auth: GET /api/v1/projects/:id/dubs ───────────────────────────────────
  // Every dub of every main video in the project, with per-language status and the cost estimate
  // for the languages not yet requested. One call, because the settings page needs both together.
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/dubs',
    { preHandler: [projectIdIsUuid, firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser;
      if (!user) return reply.code(401).send({ message: 'Unauthorized' });
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const dubs = await listDubsForProject(project.id);
      // Priced for ONE language, so the UI can multiply by whatever the creator selects without a
      // round-trip per checkbox.
      const estimate = await estimateProjectDubCost(project.id, 1);

      return reply.send({
        dubs,
        supported_languages: DUBBING_LANGUAGES.map((l) => ({
          code: l.code, name: l.name, endonym: l.endonym, rtl: l.rtl,
        })),
        estimate,
      });
    },
  );

  // ── Auth: POST /api/v1/projects/:id/dubs ──────────────────────────────────
  // Queue a dub of every main video into one language. THE ONLY BILLABLE ROUTE HERE.
  app.post<{ Params: { id: string }; Body: { language?: string; force?: boolean } }>(
    '/api/v1/projects/:id/dubs',
    { preHandler: [projectIdIsUuid, firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser;
      if (!user) return reply.code(401).send({ message: 'Unauthorized' });
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const language = (request.body?.language ?? '').trim();
      if (!language) return reply.code(400).send({ message: 'A target language is required.' });

      try {
        const dubs = await requestProjectDub(project.id, language, { force: request.body?.force });
        if (dubs.length === 0) {
          return reply.code(409).send({
            message: 'This project has no uploaded videos to dub yet.',
          });
        }
        logger.info(
          { projectId: project.id, language, count: dubs.length },
          '[dubbing] dub requested',
        );
        return reply.code(202).send({ dubs });
      } catch (err) {
        if (err instanceof UnsupportedDubLanguage) {
          return reply.code(400).send({ message: err.message });
        }
        throw err;
      }
    },
  );

  // ── Auth: DELETE /api/v1/projects/:id/dubs/:language ──────────────────────
  app.delete<{ Params: { id: string; language: string } }>(
    '/api/v1/projects/:id/dubs/:language',
    { preHandler: [projectIdIsUuid, firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser;
      if (!user) return reply.code(401).send({ message: 'Unauthorized' });
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      try {
        const removed = await deleteProjectDub(project.id, request.params.language);
        return reply.send({ removed });
      } catch (err) {
        if (err instanceof UnsupportedDubLanguage) {
          return reply.code(400).send({ message: err.message });
        }
        throw err;
      }
    },
  );

  // ── Public (optional auth): GET /api/v1/videos/:videoId/captions/:language.vtt ──
  //
  // The per-language twin of `/api/v1/videos/:videoId/captions.vtt`. Fastify has no way to say
  // "the segment ends in .vtt", so the suffix is stripped from the parameter rather than matched —
  // which also means /captions/he and /captions/he.vtt both work, and a viewer that builds either
  // gets the same document.
  app.get<{ Params: { videoId: string; language: string }; Querystring: { share?: string } }>(
    '/api/v1/videos/:videoId/captions/:language',
    { preHandler: [videoIdIsUuid, firebaseAuthOptionalMiddleware] },
    async (request, reply: FastifyReply) => {
      const language = normalizeDubbingLanguage(request.params.language.replace(/\.vtt$/i, ''));
      if (!language) return reply.code(404).send({ message: 'Captions not available' });

      const video = await db.query.video_files.findFirst({
        where: eq(video_files.id, request.params.videoId),
        columns: { id: true, project_id: true },
      });
      if (!video) return reply.code(404).send({ message: 'Captions not available' });

      const dub = await db.query.video_dubs.findFirst({
        where: (t, { and, eq: e }) => and(
          e(t.video_file_id, video.id),
          e(t.target_language, language),
          e(t.provider, DUB_PROVIDER_ELEVENLABS),
        ),
      });
      // `isDubServable` and not `status === 'completed'`: a watermarked dub is finished and paid
      // for but must never reach a viewer, and this route is a viewer-facing read.
      if (!dub || !dub.captions_vtt || !isDubServable(dub)) {
        return reply.code(404).send({ message: 'Captions not available' });
      }

      // Same gate as the source-language route: a private project's transcript must not be
      // readable by video id alone, and 404 rather than 403 so existence is not revealed.
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
        .send(dub.captions_vtt);
    },
  );

  // ── Public (optional auth): GET /api/v1/projects/:id/languages ────────────
  //
  // Which dubbed languages a public/share viewer may switch to. Separate from the player config so
  // a viewer surface that has not loaded a config (a language menu rendered ahead of playback, a
  // link preview) can ask the cheap question on its own.
  app.get<{ Params: { id: string }; Querystring: { share?: string } }>(
    '/api/v1/projects/:id/languages',
    { preHandler: [projectIdIsUuid, firebaseAuthOptionalMiddleware] },
    async (request, reply: FastifyReply) => {
      const project = await db.query.projects.findFirst({ where: eq(projects.id, request.params.id) });
      if (!project) return reply.code(404).send({ message: 'Project not found' });
      if (!(await projectReadable(project, request.dbUser, request.query.share ?? null))) {
        return reply.code(404).send({ message: 'Project not found' });
      }

      const videos = await db.query.video_files.findMany({
        where: eq(video_files.project_id, project.id),
        columns: { id: true, is_broll: true },
      });
      const mainIds = videos.filter((v) => !v.is_broll).map((v) => v.id);
      if (mainIds.length === 0) return reply.send({ languages: [] });

      const dubs = await db.query.video_dubs.findMany({
        where: (t, { inArray }) => inArray(t.video_file_id, mainIds),
      });
      const servable = dubs.filter(isDubServable);

      // Same all-or-nothing rule as the player config: a language is offered only when every main
      // video has it, so a viewer never gets a lesson that reverts to the source partway through.
      const languages = [...new Set(servable.map((d) => d.target_language))]
        .filter((lang) => mainIds.every((id) => servable.some(
          (d) => d.video_file_id === id && d.target_language === lang,
        )))
        .sort()
        .map((code) => {
          const meta = DUBBING_LANGUAGES.find((l) => l.code === code);
          return { code, name: meta?.name ?? code, endonym: meta?.endonym ?? code, rtl: meta?.rtl ?? false };
        });

      return reply.send({ languages });
    },
  );
}
