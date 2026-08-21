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
import {
  DUBBING_LANGUAGES,
  dubbingLanguageRank,
  findDubbingLanguage,
  normalizeDubbingLanguage,
} from '../../services/dubbing/languages.js';
import {
  declareProjectSourceLanguage,
  resolveProjectSourceLanguage,
} from '../../services/dubbing/sourceLanguage.js';
import { checkDubbingBudget } from '../../services/dubbing/budget.js';
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

      // RESOLVED, not read. The column was added in migration 068 and nothing ever wrote it, so
      // reading it returned null for every project in existence and the exclusion below never fired
      // — an English lesson was offered English as a paid target. `resolveProjectSourceLanguage`
      // detects it from the transcript this product already stores, caches the answer, and reports
      // WHERE the answer came from so the UI can distinguish a guess from a declaration.
      //
      // The exclusion itself stays server-side and is repeated on POST: a disabled checkbox is
      // advice, and advice does not stop a scripted client from spending $2.20 a minute.
      const source = await resolveProjectSourceLanguage(project.id);

      return reply.send({
        dubs,
        source_language: source.code,
        /** 'declared' | 'detected' | 'vendor' — how much the value should be trusted, and by whom. */
        source_language_origin: source.origin,
        /** A guess too weak to act on. Prefills the picker; excludes nothing. */
        source_language_suggestion: source.suggestion,
        /** 'no_transcript' | 'undecided' — why there is no answer, when there is none. */
        source_language_reason: source.reason,
        supported_languages: DUBBING_LANGUAGES.map((l) => ({
          code: l.code, name: l.name, endonym: l.endonym, rtl: l.rtl,
          // The default sort order. Ninety-four rows alphabetised by ENGLISH name put Spanish
          // seventy-six below Afrikaans; the rank travels with the language so the client sorts
          // without a second table to keep in step.
          rank: dubbingLanguageRank(l.code),
          is_source: source.code !== null && l.code === source.code,
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

      // Refuse the source language outright. This is not UI politeness: dubbing a video into the
      // language it is already spoken in is a complete, billable vendor run whose output is a
      // degraded copy of the input. The check lives on the server because a disabled checkbox is
      // advice, and advice does not stop a scripted client from spending $2.20 a minute.
      const projectSource = (await resolveProjectSourceLanguage(project.id)).code;
      if (projectSource && normalizeDubbingLanguage(language) === projectSource) {
        const named = findDubbingLanguage(projectSource);
        return reply.code(409).send({
          message: `This project is already in ${named?.name ?? projectSource}. Dubbing it into its own language would be billed in full and return a worse copy of the original — pick a different language.`,
        });
      }

      // THE CEILING GOES HERE, ahead of `requestProjectDub`, because the vendor bills on job
      // creation and has no idempotency key: a limit enforced after that call is a report, not a
      // limit. Priced for this one language, which is exactly what this request would spend.
      const budgetEstimate = await estimateProjectDubCost(project.id, 1);
      const verdict = await checkDubbingBudget({
        userId: user.id,
        estimateCents: Math.round(budgetEstimate.estimated_usd * 100),
      });
      if (!verdict.allowed) {
        logger.warn(
          { projectId: project.id, userId: user.id, spentCents: verdict.spentCents, budgetCents: verdict.budgetCents },
          '[dubbing] refused — monthly budget would be exceeded',
        );
        return reply.code(409).send({
          message: verdict.reason,
          budget: {
            spent_cents: verdict.spentCents,
            budget_cents: verdict.budgetCents,
            estimate_cents: verdict.estimateCents,
          },
        });
      }

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

  // ── Auth: PUT /api/v1/projects/:id/source-language ────────────────────────
  //
  // The creator's correction, and the reason detection is allowed to act on its own at all.
  //
  // Automatic detection is right most of the time and wrong some of the time, and when it is wrong
  // it removes a language somebody wanted with no way to argue. This route is that way. A declared
  // value outranks everything afterwards — including a later vendor detection — because a person
  // who has told us what their own video is in should not be contradicted by a machine.
  //
  // `null` clears it, which returns the project to "undeclared" and lets detection run again.
  app.put<{ Params: { id: string }; Body: { language?: string | null } }>(
    '/api/v1/projects/:id/source-language',
    { preHandler: [projectIdIsUuid, firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser;
      if (!user) return reply.code(401).send({ message: 'Unauthorized' });
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const raw = request.body?.language;
      if (raw === null || raw === undefined || raw === '') {
        await declareProjectSourceLanguage(project.id, null);
        return reply.send({ source_language: null, source_language_origin: null });
      }

      // Only a language this product actually offers may be declared. Not a validation formality:
      // the declared value is what the POST route compares a target against, and a tag outside the
      // known set could never match one, so it would silently stop excluding anything.
      const code = normalizeDubbingLanguage(String(raw));
      if (!code) {
        return reply.code(400).send({
          message: `"${String(raw)}" is not a language this product can work with.`,
        });
      }

      await declareProjectSourceLanguage(project.id, code);
      logger.info({ projectId: project.id, code }, '[dubbing] source language declared by the creator');
      return reply.send({ source_language: code, source_language_origin: 'declared' });
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
