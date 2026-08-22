/**
 * The audio edition's API surface — P3-B / A2.1.
 *
 * Three routes and one security decision. The decision is the whole file: an edition is a DERIVED
 * form of a project, so it is exactly as public as that project is and never more. That sounds
 * obvious and is the precise mistake this codebase has already made twice — `podcasts/` was
 * modelled as a public prefix for immutable studio clips, then user source documents were added to
 * it and became world-readable to anyone holding the URL (security-016).
 *
 * So: the artifact lives under a PRIVATE storage prefix, and every read re-derives access from the
 * project through `requireProjectAccess` — the same function the player uses, honouring the same
 * share tokens. Nothing here decides access by looking at the edition row.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { project_audio_editions, projects } from '../../db/schema.js';
import { firebaseAuthMiddleware, firebaseAuthOptionalMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject } from '../../services/collabAccess.js';
import { requireProjectAccess } from '../../services/projectAccess.js';
import { requireUuidParams } from '../../lib/uuidParam.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { enqueueJob } from '../../queue/index.js';
import { editionRefusalReason } from '../../services/audio/audioEdition.js';
import { rateLimit } from '../../lib/rateLimit.js';

const projectIdIsUuid = requireUuidParams('id');

/** How long a signed audio URL lives. */
const AUDIO_URL_TTL_SECONDS = 6 * 60 * 60;
// Six hours, not six minutes: a listener may open the page, drive for an hour, and only then press
// play — and a URL that expired in the car is a failure with no recovery path on a locked phone.
// Not six days either: the link is a bearer capability, and the shorter it lives the less a
// forwarded URL can do. Six hours covers the longest realistic listening session.

/** The row, or null. `language: null` means the source edition — see migration 071. */
async function findEdition(projectId: string, language: string | null) {
  return db.query.project_audio_editions.findFirst({
    where: language === null
      ? and(eq(project_audio_editions.project_id, projectId), isNull(project_audio_editions.language))
      : and(eq(project_audio_editions.project_id, projectId), eq(project_audio_editions.language, language)),
  });
}

export async function registerAudioEditionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/projects/:id/audio — the listener's route.
   *
   * Optional auth: a public project's edition is readable by anyone, exactly like its player.
   * `?share=` carries the same capability the rest of the mini-site honours, so a shared-but-
   * private project's audio link works for the people the creator gave it to and nobody else.
   */
  app.get<{ Params: { id: string }; Querystring: { share?: string; language?: string } }>(
    '/api/v1/projects/:id/audio',
    { preHandler: [projectIdIsUuid, firebaseAuthOptionalMiddleware] },
    async (request, reply: FastifyReply) => {
      const project = await db.query.projects.findFirst({ where: eq(projects.id, request.params.id) });
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      // ACCESS COMES FROM THE PROJECT, NOT THE EDITION. Reading a flag off the edition row would
      // be a second source of truth for one fact, and the two would eventually disagree — most
      // likely the moment a creator makes a project private and the edition keeps its old answer.
      if (!requireProjectAccess(project, request.dbUser?.id ?? null, request.query.share)) {
        // 404, not 403: to an unauthorised requester the existence of an edition is itself
        // information, and the honest answer to "is there audio at this URL" is that there is
        // nothing here for you.
        return reply.code(404).send({ message: 'Project not found' });
      }

      const language = request.query.language?.trim() || null;
      const edition = await findEdition(project.id, language);
      if (!edition || edition.status !== 'ready' || !edition.m4a_key) {
        return reply.send({
          status: edition?.status ?? 'none',
          // The creator sees the reason; a listener sees a status they can wait on. Both get the
          // same shape, because a route that changes shape by caller is a route with two contracts.
          error: edition?.error ?? null,
          audio_url: null,
          duration_ms: null,
          chapters: [],
        });
      }

      const storage = getStorageAdapter();
      return reply.send({
        status: 'ready',
        error: null,
        audio_url: await storage.getPresignedDownloadUrl(edition.m4a_key, AUDIO_URL_TTL_SECONDS),
        duration_ms: edition.duration_ms,
        chapters: edition.chapters_json ?? [],
        // Served inline rather than as a second request: a locked phone on a dropped connection
        // should already hold everything the page needs to keep playing.
        captions_vtt: edition.captions_vtt ?? null,
        language: edition.language,
        updated_at: edition.updated_at,
      });
    },
  );

  /**
   * POST /api/v1/projects/:id/audio — the creator's "make/refresh the audio edition".
   *
   * Requires EDIT rights, not view rights. Deriving an edition costs compute, and a route that let
   * any viewer trigger it would let any viewer spend the owner's money by reloading a page.
   */
  app.post<{ Params: { id: string }; Body: { language?: string | null; force?: boolean } }>(
    '/api/v1/projects/:id/audio',
    { preHandler: [projectIdIsUuid, firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser;
      if (!user) return reply.code(401).send({ message: 'Unauthorized' });
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const language = request.body?.language?.trim() || null;

      // Refuse EARLY, with the reason, rather than queueing work that will refuse itself later.
      // A creator who is told "no playable audio yet" can act; one who watches a job go to
      // `failed` two minutes later has to guess, and is likely to guess "this feature is broken".
      const segments = await db.query.video_files.findMany({
        where: eq(projects.id, project.id),
        columns: { storage_key: true, duration_sec: true },
      }).catch(() => []);
      const refusal = editionRefusalReason(
        segments.map((s) => ({ audioKey: s.storage_key ?? '', durationMs: Math.round((s.duration_sec ?? 0) * 1000) })),
      );
      if (refusal) return reply.code(409).send({ message: refusal });

      enqueueJob('audio_edition', { projectId: project.id, language, force: request.body?.force === true });
      // 202: the work is accepted, not done. The client polls the GET above, which is the same
      // route the listener uses — one status surface rather than two that can disagree.
      return reply.code(202).send({ status: 'queued', language });
    },
  );

  /**
   * GET /api/v1/projects/:id/audio/captions.vtt — the caption track, as a file.
   *
   * A `<track>` element needs a URL, not a JSON field, so this exists beside the inline copy in
   * the GET above rather than replacing it. Same access rule, from the same function.
   */
  app.get<{ Params: { id: string }; Querystring: { share?: string; language?: string } }>(
    '/api/v1/projects/:id/audio/captions.vtt',
    { preHandler: [projectIdIsUuid, firebaseAuthOptionalMiddleware] },
    async (request, reply: FastifyReply) => {
      const project = await db.query.projects.findFirst({ where: eq(projects.id, request.params.id) });
      if (!project) return reply.code(404).send({ message: 'Not found' });
      if (!requireProjectAccess(project, request.dbUser?.id ?? null, request.query.share)) {
        return reply.code(404).send({ message: 'Not found' });
      }

      const edition = await findEdition(project.id, request.query.language?.trim() || null);
      if (!edition?.captions_vtt) return reply.code(404).send({ message: 'No captions for this edition' });

      // `text/vtt` explicitly. A browser handed `text/plain` refuses to use the track, and the
      // failure is silent — captions simply never appear, with nothing in the console.
      return reply.header('content-type', 'text/vtt; charset=utf-8').send(edition.captions_vtt);
    },
  );

  /**
   * GET /api/v1/public/audio/:slug — the mini-site's data source for `/{slug}/audio`.
   *
   * A PERMALINK route, not a share-token one: `/{slug}/audio` is the canonical per-project audio
   * surface, a sibling of `/{slug}/{lang}`, so it resolves the same way the permalink page does
   * and is served under the same condition — the project is public. Private projects reach their
   * audio through the authenticated route above, which honours share tokens.
   *
   * Rate-limited by IP like every other unauthenticated public route here: a slug is guessable,
   * and an endpoint that resolves one cheaply is an endpoint someone will enumerate.
   */
  app.get<{ Params: { slug: string }; Querystring: { language?: string } }>(
    '/api/v1/public/audio/:slug',
    async (request, reply: FastifyReply) => {
      if (!rateLimit(`audioslug:${request.ip}`, 60, 60_000)) {
        return reply.code(429).send({ message: 'Too many requests — please slow down.' });
      }

      const project = await db.query.projects.findFirst({ where: eq(projects.slug, request.params.slug) });
      // `visibility === 'public'` explicitly, not `requireProjectAccess` with a null user. The two
      // agree today, and stating the condition here means a future change to share-token handling
      // cannot quietly make private projects resolvable by GUESSING a slug — which is a different
      // threat from following a link someone was given.
      if (!project || project.visibility !== 'public') return reply.code(404).send({ message: 'Not found' });

      const edition = await findEdition(project.id, request.query.language?.trim() || null);
      if (!edition || edition.status !== 'ready' || !edition.m4a_key) {
        return reply.code(404).send({ message: 'Not found' });
      }

      const storage = getStorageAdapter();
      return reply.send({
        title: project.title,
        // The transcript-derived SEO description (migration 034), which is what every other
        // public surface uses — a second source of prose here would drift from all of them.
        description: project.seo_description ?? null,
        audio_url: await storage.getPresignedDownloadUrl(edition.m4a_key, AUDIO_URL_TTL_SECONDS),
        duration_ms: edition.duration_ms,
        chapters: edition.chapters_json ?? [],
        captions_url: edition.captions_vtt
          ? `/api/v1/projects/${project.id}/audio/captions.vtt${edition.language ? `?language=${encodeURIComponent(edition.language)}` : ''}`
          : null,
        language: edition.language,
        // The page caches on ISR, so it needs to know how old what it is holding is.
        updated_at: edition.updated_at,
      });
    },
  );
}
