/**
 * library-share.controller — one public read and four owner routes for the materials mini-site.
 *
 * Conventions this file inherits rather than invents:
 *   • Every denial is 404, never 403 — unknown, revoked, expired and not-yours are indistinguishable
 *     from outside, which is what `share.controller.ts` and `permalink.controller.ts` already do.
 *   • Owner routes are `firebaseAuthMiddleware` then `editableProject(id, user)` — creator OR
 *     invited collaborator — which is the two-line opening every write route in this codebase has.
 *   • Paid projects keep the existing contract: the `{ locked: true, … }` stub `PaywallOverlay`
 *     already renders, never a 403 and never a bare config.
 *
 * What IS new here, deliberately: the public GET sets `Cache-Control`. Verified that
 * `/api/v1/share/:token`, `/api/v1/public/permalink/:slug/config` and `/api/v1/public/courses/*`
 * all return JSON with no cache header at all. This endpoint sits behind an ISR page whose whole
 * economy is one backend render per path per minute, so the header is the half of that contract
 * the backend owes.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { library_shares } from '../../db/schema.js';
import { firebaseAuthMiddleware, firebaseAuthOptionalMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject } from '../../services/collabAccess.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { BillingService } from '../../services/billing/BillingService.js';
import { buildLibraryView, filterLibraryView } from '../../services/library/buildLibraryView.js';
import {
  bumpRenderCount, libraryCleanUrl, libraryShareUrl, liveShareForProject, mintShare, resolveShare,
  revokeShare, type LibraryShareRow, type ProjectRow,
} from '../../services/library/LibraryShareService.js';
import { dispatchLibraryInvalidation } from '../../services/course/PublishingInvalidationService.js';
import { LIBRARY_TYPE_SEGMENTS, LibraryMaterialTypeSchema } from 'shared';
import type { LibraryMaterialType, LibraryShareState } from 'shared';
import { logger } from '../../lib/logger.js';

/** 60 requests per minute per IP, the `sim-rum` precedent. 64 bits behind this is not enumerable. */
const PUBLIC_RATE_MAX = 60;
const PUBLIC_RATE_WINDOW_MS = 60_000;

const NOT_FOUND = { message: 'Library not found' };

/** `?type=` accepts either the canonical path segment or the raw material type. */
function parseTypeParam(raw: string | undefined): LibraryMaterialType | null | 'invalid' {
  if (!raw) return null;
  if (raw in LIBRARY_TYPE_SEGMENTS) return LIBRARY_TYPE_SEGMENTS[raw];
  const direct = LibraryMaterialTypeSchema.safeParse(raw);
  return direct.success ? direct.data : 'invalid';
}

const patchBody = z.object({
  includeTypes: z.array(LibraryMaterialTypeSchema).min(1).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

/** The owner-facing projection of a share row. `code` is never in it — the URL already carries it. */
function shareState(share: LibraryShareRow, project: ProjectRow): LibraryShareState {
  return {
    slug: share.slug,
    url: libraryShareUrl(share),
    cleanUrl: libraryCleanUrl(project),
    includeTypes: share.include_types as LibraryMaterialType[],
    expiresAt: share.expires_at ? share.expires_at.toISOString() : null,
    createdAt: share.created_at.toISOString(),
    title: project.title ?? null,
  };
}

/** No live link yet — but the project still has a title, and the dialog names it either way. */
function noShare(project: ProjectRow): LibraryShareState {
  return {
    slug: null, url: null, cleanUrl: null, includeTypes: null, expiresAt: null, createdAt: null,
    title: project.title ?? null,
  };
}

export async function registerLibraryShareRoutes(app: FastifyInstance): Promise<void> {

  // ── Public (optional auth): GET /api/v1/public/library/:slug?type= ─────────
  app.get<{ Params: { slug: string }; Querystring: { type?: string } }>(
    '/api/v1/public/library/:slug',
    { preHandler: [firebaseAuthOptionalMiddleware] },
    async (request, reply: FastifyReply) => {
      // `request.ip` is trustworthy because Fastify runs with `trustProxy: TRUST_PROXY_HOPS` —
      // a hop COUNT, not `true`, so a spoofed X-Forwarded-For cannot walk past the real proxy.
      if (!rateLimit(`libshare:${request.ip}`, PUBLIC_RATE_MAX, PUBLIC_RATE_WINDOW_MS)) {
        return reply.code(429).send({ message: 'Too many requests — please slow down.' });
      }

      const type = parseTypeParam(request.query.type);
      if (type === 'invalid') return reply.code(404).send(NOT_FOUND);

      const resolved = await resolveShare(request.params.slug);
      if (!resolved) return reply.code(404).send(NOT_FOUND);
      const { share, project } = resolved;

      // A type outside the share's scope is not "empty", it does not exist: the sub-route 404s
      // rather than rendering a bucket the owner deliberately withheld.
      if (type && !share.include_types.includes(type)) return reply.code(404).send(NOT_FOUND);

      if (project.access_type === 'paid') {
        const userId = request.dbUser?.id ?? null;
        const hasAccess = await BillingService.hasAccess(userId, 'project', project.id, project);
        if (!hasAccess) {
          return reply.send({
            locked: true, content_type: 'project', content_id: project.id,
            title: project.title, price_cents: project.price_cents, currency: project.currency,
          });
        }
      }

      const view = await buildLibraryView({
        projectId: project.id,
        title: project.title,
        includeTypes: share.include_types,
        canonicalUrl: libraryShareUrl(share),
      });

      // Unawaited on purpose: at most one write per path per 60s behind ISR, and a counter that
      // fails must never fail a page.
      bumpRenderCount(share.id);

      return reply
        .header('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300')
        .send(filterLibraryView(view, type));
    },
  );

  // ── Auth: GET /api/v1/projects/:id/library-share ──────────────────────────
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/library-share',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const project = await editableProject(request.params.id, request.dbUser!);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const share = await liveShareForProject(project.id);
      return reply.send(share ? shareState(share, project) : noShare(project));
    },
  );

  // ── Auth: POST /api/v1/projects/:id/library-share ─────────────────────────
  // Mint. Idempotent: a second POST returns the same slug rather than a second link.
  app.post<{ Params: { id: string } }>(
    '/api/v1/projects/:id/library-share',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const share = await mintShare(project, user.id);
      return reply.code(201).send(shareState(share, project));
    },
  );

  // ── Auth: PATCH /api/v1/projects/:id/library-share ────────────────────────
  app.patch<{ Params: { id: string } }>(
    '/api/v1/projects/:id/library-share',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const project = await editableProject(request.params.id, request.dbUser!);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const parsed = patchBody.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ message: 'Invalid library share update.' });

      const share = await liveShareForProject(project.id);
      if (!share) return reply.code(404).send(NOT_FOUND);

      const updated = await updateShare(share, parsed.data);
      await dispatchLibraryInvalidation({ slug: updated.slug, cleanSlug: project.slug });
      return reply.send(shareState(updated, project));
    },
  );

  // ── Auth: DELETE /api/v1/projects/:id/library-share ───────────────────────
  app.delete<{ Params: { id: string } }>(
    '/api/v1/projects/:id/library-share',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const project = await editableProject(request.params.id, request.dbUser!);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const revoked = await revokeShare(project.id);
      if (revoked) {
        // Best-effort: `dispatchLibraryInvalidation` no-ops without REVALIDATE_URL, so the honest
        // worst case is that the page keeps serving from ISR for up to its 60-second window.
        await dispatchLibraryInvalidation({ slug: revoked.slug, cleanSlug: project.slug })
          .catch((err) => logger.warn({ err, projectId: project.id }, 'library share purge dispatch failed'));
      }
      return reply.code(204).send();
    },
  );
}

/** The PATCH write, kept out of the handler so the route reads as routing. */
async function updateShare(
  share: LibraryShareRow,
  patch: z.infer<typeof patchBody>,
): Promise<LibraryShareRow> {
  const set: Partial<typeof share> = { updated_at: new Date() };
  if (patch.includeTypes) set.include_types = patch.includeTypes;
  if (patch.expiresAt !== undefined) set.expires_at = patch.expiresAt ? new Date(patch.expiresAt) : null;

  const [row] = await db.update(library_shares).set(set).where(eq(library_shares.id, share.id)).returning();
  return row ?? share;
}
