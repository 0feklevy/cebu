/**
 * The audio edition's API surface — P3-B / A2.1.
 *
 * ── THE PATH IS `/audio-edition`, NOT `/audio`, AND THAT IS NOT COSMETIC ──────────────────────
 * `audio.controller.ts` already owns `GET` and `POST` on `/api/v1/projects/:id/audio` — that is
 * the TIMELINE audio feature (uploaded tracks, generated music and SFX), a different thing that
 * happens to share an obvious noun. Registering these here on the same path made Fastify throw
 * `FST_ERR_DUPLICATED_ROUTE` at startup, so the backend could not boot AT ALL.
 *
 * Nothing caught it: the tests mock the Fastify instance, and `release:verify` typechecks, lints,
 * tests and builds without ever starting a server. The one thing that would have caught it is the
 * candidate-image gate, which boots the actual image — and it had not run successfully yet.
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
import { editionWireStatus } from 'shared';
import { loadEditionSegments } from '../../services/audio/editionSegments.js';
import { askListenerQuestion } from '../../services/audio/ListenerQuestionService.js';
import { listener_questions } from '../../db/schema.js';
import { desc } from 'drizzle-orm';
import { rateLimit } from '../../lib/rateLimit.js';
import { answerVoiceQuestion } from '../../services/audio/VoiceQuestionService.js';
import { withBoundedTempFile } from '../../services/security/uploadLimits.js';
import { VOICE_QUESTION_MAX_BYTES } from 'shared';

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
    '/api/v1/projects/:id/audio-edition',
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
          // TRANSLATED, not passed through. The database says `processing`; the wire — and every
          // client — says `building`. Returning the stored value verbatim is what left the
          // creator's row saying "Create podcast" while the build was running, because
          // `processing` matches nothing the client recognises as in-flight. See
          // shared/src/audio/editionStatus.ts for the three vocabularies and why there is now one.
          status: editionWireStatus(edition?.status),
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
    '/api/v1/projects/:id/audio-edition',
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
      // The query is `loadEditionSegments`, not a hand-written one, and that is the whole point:
      // this gate and the worker it gates have to ask the SAME question. Twice now they have not.
      //
      // First (fixed 2026-08-25) the predicate named a column from a table this query does not
      // select from, which Postgres refuses outright — and the `.catch(() => [])` turned that
      // refusal into an empty list, which `editionRefusalReason` reads as "no media". Every
      // podcast build, on every project, was refused for a reason that was never true.
      //
      // Second (fixed 2026-08-26) the table was right but the filter was not: the worker excludes
      // b-roll and this did not, so a b-roll-only project sailed through the gate and was refused
      // asynchronously — the delayed, unexplained failure the pre-flight exists to prevent.
      //
      // The catch stays: a transient database fault should not 500 a creator's Create-podcast
      // click. What it can no longer hide is a query that is wrong every time.
      const segments = await loadEditionSegments(project.id).catch(() => []);
      const refusal = editionRefusalReason(segments);
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
    '/api/v1/projects/:id/audio-edition/captions.vtt',
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
          ? `/api/v1/projects/${project.id}/audio-edition/captions.vtt${edition.language ? `?language=${encodeURIComponent(edition.language)}` : ''}`
          : null,
        language: edition.language,
        // The page caches on ISR, so it needs to know how old what it is holding is.
        updated_at: edition.updated_at,
        // Cover art for the car-mode player and the lock screen (night run 2026-09-03 §4).
        artwork_url: project.thumbnail_url ?? null,
      });
    },
  );

  /**
   * POST /api/v1/public/audio/:slug/voice-question — the spoken Raise Your Hand (car mode).
   *
   * Multipart: one WAV file (`audio`, 16 kHz mono PCM, ≤ 2 MB, ≤ 30 s), `position_ms`, `language`.
   * The same three things stand between an anonymous stranger and the owner's bill as on the
   * typed route — a per-IP limit (tighter still: a spoken question costs STT and TTS on top of
   * the model), the project's daily answer cap inside `askListenerQuestion`, and a size ceiling
   * on the upload. A transcript that says nothing is `nothing_heard` and never reaches the cap.
   */
  app.post<{ Params: { slug: string } }>(
    '/api/v1/public/audio/:slug/voice-question',
    { preHandler: [firebaseAuthOptionalMiddleware] },
    async (request, reply: FastifyReply) => {
      if (!rateLimit(`askv:${request.ip}`, 6, 60_000)) {
        return reply.code(429).send({ message: 'Too many questions — please slow down.' });
      }

      const project = await db.query.projects.findFirst({ where: eq(projects.slug, request.params.slug) });
      if (!project || project.visibility !== 'public') return reply.code(404).send({ message: 'Not found' });

      const data = await request.file().catch(() => null);
      if (!data) return reply.code(400).send({ message: 'No audio uploaded' });
      const field = (name: string): string => {
        const f = (data.fields as Record<string, { value?: unknown } | undefined>)[name];
        return typeof f?.value === 'string' ? f.value : '';
      };
      const positionMs = Math.max(0, Math.round(Number(field('position_ms')) || 0));
      const language = field('language').trim() || null;

      try {
        const result = await withBoundedTempFile(
          data.file,
          { limitBytes: VOICE_QUESTION_MAX_BYTES, what: 'Spoken question', suffix: '.wav' },
          ({ path }) => answerVoiceQuestion({
            projectId: project.id, language, positionMs, audioPath: path, userId: request.dbUser?.id ?? null,
          }),
        );
        return reply.send({
          status: result.status,
          question: result.question,
          answer: result.answer,
          message: result.message,
          audio_base64: result.audio ? result.audio.toString('base64') : null,
          audio_mime: result.audioMime,
        });
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode === 413 ? 413 : 502;
        request.log.warn({ err }, '[voice-question] failed');
        return reply.code(status).send({
          message: status === 413 ? 'That recording is too long.' : 'Could not answer right now — playback is unaffected.',
        });
      }
    },
  );

  /**
   * POST /api/v1/public/audio/:slug/questions — Raise Your Hand (P3-B / A2.4).
   *
   * PUBLIC and UNAUTHENTICATED, deliberately: the listener is driving, and requiring an account
   * to ask a question about the thing they are already hearing would make the feature unusable
   * for the person it exists for.
   *
   * Which means an anonymous stranger can, from this route, cause an LLM call the project OWNER
   * pays for. Three things stand between that and a bill, and all three are load-bearing:
   *  - a per-IP rate limit here,
   *  - a per-project daily cap on ANSWERS, enforced in the service before any model is called,
   *  - a length ceiling on the question, because its size is a cost lever anyone can pull.
   *
   * `intent: 'save'` is always free and is the hands-free path: a marker with a timestamp, kept
   * for the creator, reviewed by the listener when they have stopped.
   */
  app.post<{
    Params: { slug: string };
    Body: { question?: string; position_ms?: number; intent?: 'answer' | 'save'; language?: string | null };
  }>(
    '/api/v1/public/audio/:slug/questions',
    { preHandler: [firebaseAuthOptionalMiddleware] },
    async (request, reply: FastifyReply) => {
      // Tighter than the read route's limit. A read is cheap and idempotent; this one can cost
      // real money, so the ceiling is set where a genuine listener never notices it and a script
      // hits it immediately.
      if (!rateLimit(`askq:${request.ip}`, 10, 60_000)) {
        return reply.code(429).send({ message: 'Too many questions — please slow down.' });
      }

      const project = await db.query.projects.findFirst({ where: eq(projects.slug, request.params.slug) });
      if (!project || project.visibility !== 'public') return reply.code(404).send({ message: 'Not found' });

      const result = await askListenerQuestion({
        projectId: project.id,
        language: request.body?.language?.trim() || null,
        positionMs: Number(request.body?.position_ms ?? 0),
        question: String(request.body?.question ?? ''),
        // Anything that is not literally 'answer' is treated as a save. Defaulting the other way
        // would make a malformed client spend the owner's money by omission.
        intent: request.body?.intent === 'answer' ? 'answer' : 'save',
        userId: request.dbUser?.id ?? null,
      });

      if (result.status === 'refused') return reply.code(400).send({ message: result.reason });
      return reply.send({
        status: result.status,
        answer: result.answer ?? null,
        // Present whenever the answer was withheld, so the listener learns WHY rather than
        // watching a silent non-response.
        message: result.reason ?? null,
      });
    },
  );

  /**
   * GET /api/v1/projects/:id/questions — what listeners have been asking.
   *
   * The creator's view, and the reason the capped and failed questions are kept rather than
   * discarded: this list is where a lesson's confusing passage becomes visible, and it is the
   * demand signal A2.5 ("Call It") is explicitly waiting on before it gets built.
   */
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/questions',
    { preHandler: [projectIdIsUuid, firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser;
      if (!user) return reply.code(401).send({ message: 'Unauthorized' });
      // EDIT rights, not view: listener questions are audience data, and a viewer of a public
      // lesson has no more claim on them than a reader of a blog has on its analytics.
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const rows = await db.query.listener_questions.findMany({
        where: eq(listener_questions.project_id, project.id),
        orderBy: [desc(listener_questions.created_at)],
        limit: 200,
      });

      return reply.send({
        questions: rows.map((q) => ({
          id: q.id,
          position_ms: q.position_ms,
          question: q.question,
          answer: q.answer,
          status: q.status,
          language: q.language,
          created_at: q.created_at,
        })),
      });
    },
  );
}
