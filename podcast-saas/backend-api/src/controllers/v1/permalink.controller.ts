import type { FastifyInstance, FastifyReply } from 'fastify';
import { db } from '../../db/index.js';
import { projects, playlists } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { firebaseAuthMiddleware, firebaseAuthOptionalMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject, editablePlaylist } from '../../services/collabAccess.js';
import { buildPlayerConfig } from '../../services/buildPlayerConfig.js';
import { buildPlaylistPlayConfig } from './playlists.controller.js';
import { BillingService } from '../../services/billing/BillingService.js';
import {
  normalizePermalinkSlug, permalinkBaseUrl, permalinkUrl,
  rejectPermalinkSlug, rejectionMessage, suggestPermalinkSlug,
  type SlugExclude,
} from '../../services/permalinkService.js';
import { normalizeDubbingLanguage } from '../../services/dubbing/languages.js';
import {
  configSnapshot, isConfigRevalidation, sendConfigSnapshot,
} from '../../services/playerConfigFreshness.js';

/**
 * Creator-controlled permalinks (migration 043): {PUBLIC_SITE_URL}/{slug}.
 *
 * Public resolution rules:
 *   - project  → served only while project.visibility === 'public'
 *   - playlist → having a slug IS what makes it public (playlists have no
 *     visibility column; the random /pl/:token link stays the unlisted link)
 * Denials are 404 (never 403) so private existence isn't revealed.
 */
export async function registerPermalinkRoutes(app: FastifyInstance): Promise<void> {

  /** Load whatever public content owns this slug (projects win a theoretical tie). */
  async function resolvePublicSlug(slug: string) {
    const project = await db.query.projects.findFirst({ where: eq(projects.slug, slug) });
    if (project && project.visibility === 'public') return { type: 'project' as const, project };
    const playlist = await db.query.playlists.findFirst({ where: eq(playlists.slug, slug) });
    if (playlist) return { type: 'playlist' as const, playlist };
    return null;
  }

  // ── Public: GET /api/v1/public/permalink/:slug ─────────────────────────────
  // Lightweight resolve for the Next.js /[slug] page + SEO metadata. Does NOT
  // count a view (the /config fetch below does).
  app.get<{ Params: { slug: string } }>(
    '/api/v1/public/permalink/:slug',
    async (request, reply: FastifyReply) => {
      const resolved = await resolvePublicSlug(request.params.slug);
      if (!resolved) return reply.code(404).send({ message: 'Not found' });

      if (resolved.type === 'project') {
        const p = resolved.project;
        return reply.send({
          type: 'project',
          title: p.title ?? p.topic,
          description: p.seo_description ?? p.topic,
          image: p.thumbnail_url,
        });
      }
      const pl = resolved.playlist;
      return reply.send({
        type: 'playlist',
        title: pl.title,
        description: pl.description,
        image: pl.banner_url,
      });
    },
  );

  // ── Public (optional auth): GET /api/v1/public/permalink/:slug/config ──────
  // Playback config — exactly the payload of /api/v1/share/:token for projects
  // and /api/v1/playlist-share/:token for playlists (incl. the paid `locked` stub).
  // `?lang=he` serves that language's dubbed rendition and captions (migration 067); an unknown
  // or unfinished language falls back to the source track rather than failing.
  app.get<{ Params: { slug: string }; Querystring: { lang?: string } }>(
    '/api/v1/public/permalink/:slug/config',
    { preHandler: [firebaseAuthOptionalMiddleware] },
    async (request, reply: FastifyReply) => {
      const resolved = await resolvePublicSlug(request.params.slug);
      if (!resolved) return reply.code(404).send({ message: 'Not found' });
      const viewerId = request.dbUser?.id ?? null;

      if (resolved.type === 'project') {
        const project = resolved.project;
        if (project.access_type === 'paid') {
          const hasAccess = await BillingService.hasAccess(viewerId, 'project', project.id, project);
          if (!hasAccess) {
            return reply.send({
              locked: true, content_type: 'project', content_id: project.id,
              title: project.title, price_cents: project.price_cents, currency: project.currency,
            });
          }
        }
        // D-13. `resolvePublicSlug` has already refused anything that is not `visibility ===
        // 'public'`, and the paid gate above has already run, so no conditional answer below can
        // outlive the authorization that permitted it.
        const language = normalizeDubbingLanguage(request.query.lang ?? '');
        const snapshot = await configSnapshot(
          // `viewerId` is part of the key because the payload is built FOR that viewer: a
          // cross-project branch edge carries the destination's share token only for someone who
          // can reach it, so a per-slug cache would hand one viewer another's token.
          { surface: 'permalink', contentId: project.id, viewerId, language },
          () => buildPlayerConfig(project.id, viewerId, project, language),
        );
        if (!snapshot) return reply.code(404).send({ message: 'Not found' });

        // Fire-and-forget view count increment — openings only. A D-13 freshness re-poll arrives
        // with `If-None-Match` and must not be counted, or one mid-watch viewer reports ~60 views
        // an hour on a route that bumps on every GET.
        if (!isConfigRevalidation(request)) {
          db.update(projects)
            .set({ view_count: sql`${projects.view_count} + 1` })
            .where(eq(projects.id, project.id))
            .catch(() => {});
        }
        return sendConfigSnapshot(request, reply, snapshot);
      }

      /*
       * PLAYLISTS ARE EXPLICITLY OUT OF SCOPE FOR D-13, and this branch is deliberately
       * unchanged — no ETag, no `Cache-Control`, no revalidation gate on the view count.
       *
       * The ruling allows the playlist and course surfaces to be "covered or explicitly
       * excluded", and half-covering them would be worse than leaving them alone: a playlist's
       * payload is a LIST of per-item player configs built by `buildPlaylistPlayConfig`, and
       * `PlaylistViewer` loads it exactly once with no poll at all. Adding validators here would
       * invite the browser's own revalidation of a payload nothing re-reads — and that
       * revalidation would then be excluded from `view_count` by the rule above, silently
       * changing owner-visible playlist analytics for no freshness benefit.
       *
       * Covering them properly means a per-item freshness poll inside the playlist shell, which
       * is its own change. Until that lands, D-13 stays PARTIAL by the ruling's own terms.
       */
      const playlist = resolved.playlist;
      if (playlist.access_type === 'paid') {
        const hasAccess = await BillingService.hasAccess(viewerId, 'playlist', playlist.id);
        if (!hasAccess) {
          return reply.send({
            locked: true, content_type: 'playlist', content_id: playlist.id,
            title: playlist.title, price_cents: playlist.price_cents, currency: playlist.currency,
          });
        }
      }
      db.update(playlists)
        .set({ view_count: sql`${playlists.view_count} + 1` })
        .where(eq(playlists.id, playlist.id))
        .catch(() => {});
      return reply.send(await buildPlaylistPlayConfig(playlist, viewerId));
    },
  );

  // ── Auth: GET /api/v1/permalink-availability ───────────────────────────────
  // Live feedback while the creator types. Returns the normalised slug so the
  // UI can show what will actually be saved.
  app.get<{ Querystring: { slug?: string; exclude_type?: string; exclude_id?: string } }>(
    '/api/v1/permalink-availability',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const normalized = normalizePermalinkSlug(request.query.slug ?? '');
      const exclude = toExclude(request.query.exclude_type, request.query.exclude_id);
      const reason = await rejectPermalinkSlug(normalized, exclude);
      return reply.send({
        slug: normalized || null,
        available: !reason,
        reason: reason ?? undefined,
        message: reason ? rejectionMessage(reason) : undefined,
      });
    },
  );

  // ── Auth: GET/PUT /api/v1/projects/:id/permalink ───────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/permalink',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const project = await editableProject(request.params.id, request.dbUser!);
      if (!project) return reply.code(404).send({ message: 'Project not found' });
      return reply.send({
        slug: project.slug,
        permalinkUrl: project.slug ? permalinkUrl(project.slug) : null,
        suggestedSlug: project.slug
          ? null
          : await suggestPermalinkSlug(project.title ?? project.topic, { type: 'project', id: project.id }),
        baseUrl: permalinkBaseUrl(),
        visibility: project.visibility,
      });
    },
  );

  app.put<{ Params: { id: string }; Body: { slug?: string | null } }>(
    '/api/v1/projects/:id/permalink',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const project = await editableProject(request.params.id, request.dbUser!);
      if (!project) return reply.code(404).send({ message: 'Project not found' });
      return setSlug(reply, { type: 'project', id: project.id }, request.body?.slug);
    },
  );

  // ── Auth: GET/PUT /api/v1/playlists/:id/permalink ──────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/playlists/:id/permalink',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const playlist = await editablePlaylist(request.params.id, request.dbUser!);
      if (!playlist) return reply.code(404).send({ message: 'Playlist not found' });
      return reply.send({
        slug: playlist.slug,
        permalinkUrl: playlist.slug ? permalinkUrl(playlist.slug) : null,
        suggestedSlug: playlist.slug
          ? null
          : await suggestPermalinkSlug(playlist.title, { type: 'playlist', id: playlist.id }),
        baseUrl: permalinkBaseUrl(),
      });
    },
  );

  app.put<{ Params: { id: string }; Body: { slug?: string | null } }>(
    '/api/v1/playlists/:id/permalink',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const playlist = await editablePlaylist(request.params.id, request.dbUser!);
      if (!playlist) return reply.code(404).send({ message: 'Playlist not found' });
      return setSlug(reply, { type: 'playlist', id: playlist.id }, request.body?.slug);
    },
  );
}

function toExclude(type?: string, id?: string): SlugExclude | undefined {
  if ((type === 'project' || type === 'playlist') && id) return { type, id };
  return undefined;
}

async function updateSlug(target: SlugExclude, value: string | null): Promise<void> {
  if (target.type === 'project') {
    await db.update(projects).set({ slug: value }).where(eq(projects.id, target.id));
  } else {
    await db.update(playlists).set({ slug: value }).where(eq(playlists.id, target.id));
  }
}

/** Shared PUT body handler: null/'' clears the slug, otherwise normalise + validate + save. */
async function setSlug(
  reply: FastifyReply,
  target: SlugExclude,
  raw: string | null | undefined,
) {
  if (raw === null || raw === undefined || raw === '') {
    await updateSlug(target, null);
    return reply.send({ slug: null, permalinkUrl: null, baseUrl: permalinkBaseUrl() });
  }
  if (typeof raw !== 'string' || raw.length > 200) {
    return reply.code(400).send({ message: rejectionMessage('invalid'), reason: 'invalid' });
  }

  const slug = normalizePermalinkSlug(raw);
  const reason = await rejectPermalinkSlug(slug, target);
  if (reason) {
    return reply
      .code(reason === 'taken' ? 409 : 400)
      .send({ message: rejectionMessage(reason), reason });
  }

  try {
    await updateSlug(target, slug);
  } catch (err: unknown) {
    // 23505 = unique violation — lost a same-table race with another writer.
    if ((err as { code?: string }).code === '23505') {
      return reply.code(409).send({ message: rejectionMessage('taken'), reason: 'taken' });
    }
    throw err;
  }
  return reply.send({ slug, permalinkUrl: permalinkUrl(slug), baseUrl: permalinkBaseUrl() });
}
