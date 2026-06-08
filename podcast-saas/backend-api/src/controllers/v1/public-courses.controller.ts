/**
 * Public course API (no auth) — the data source for the server-rendered /c/ pages,
 * sitemaps and legacy redirect resolution. Returns public-only view models and
 * maps publication state to HTTP status.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { PublicCourseQueryService, resolveCourseStatus } from '../../services/course/PublicCourseQueryService.js';
import { SitemapService } from '../../services/course/SitemapService.js';
import { LegacyRedirectResolver } from '../../services/course/LegacyRedirectResolver.js';
import { CourseRepository } from '../../services/course/CourseRepository.js';
import { CourseLessonRepository } from '../../services/course/CourseLessonRepository.js';

export async function registerPublicCourseRoutes(app: FastifyInstance): Promise<void> {
  // Lightweight status (no view-model build) — used by Next middleware to set the
  // correct HTTP status (404/410/redirect) that a Server Component page cannot.
  app.get<{ Params: { slug: string } }>('/api/v1/public/courses/:slug/status', async (req, reply) => {
    const course = await CourseRepository.findByPlatformSlug(req.params.slug);
    if (!course) return reply.send({ status: 'not_found' });
    return reply.send(resolveCourseStatus(course));
  });

  app.get<{ Params: { slug: string; lessonSlug: string } }>(
    '/api/v1/public/courses/:slug/lessons/:lessonSlug/status',
    async (req, reply) => {
      const course = await CourseRepository.findByPlatformSlug(req.params.slug);
      if (!course) return reply.send({ status: 'not_found' });
      const cs = resolveCourseStatus(course);
      if (cs.status !== 'ok') return reply.send(cs);
      const lesson = await CourseLessonRepository.findByCourseAndSlug(course.id, req.params.lessonSlug);
      return reply.send({ status: lesson ? 'ok' : 'not_found' });
    },
  );

  // GET /api/v1/public/courses/:slug
  app.get<{ Params: { slug: string } }>('/api/v1/public/courses/:slug', async (req, reply: FastifyReply) => {
    const result = await PublicCourseQueryService.getCourse(req.params.slug);
    switch (result.status) {
      case 'ok':       return reply.send(result.course);
      case 'gone':     return reply.code(410).send({ status: 'gone' });
      case 'redirect': return reply.code(409).send({ status: 'redirect', redirectUrl: result.redirectUrl });
      default:         return reply.code(404).send({ status: 'not_found' });
    }
  });

  // GET /api/v1/public/courses/:slug/lessons/:lessonSlug
  app.get<{ Params: { slug: string; lessonSlug: string } }>(
    '/api/v1/public/courses/:slug/lessons/:lessonSlug',
    async (req, reply: FastifyReply) => {
      const result = await PublicCourseQueryService.getLesson(req.params.slug, req.params.lessonSlug);
      switch (result.status) {
        case 'ok':       return reply.send(result.lesson);
        case 'gone':     return reply.code(410).send({ status: 'gone' });
        case 'redirect': return reply.code(409).send({ status: 'redirect', redirectUrl: result.redirectUrl });
        default:         return reply.code(404).send({ status: 'not_found' });
      }
    },
  );

  // Sitemap data (the Next route handlers turn these into XML).
  app.get('/api/v1/public/sitemap/courses', async (_req, reply) => reply.send(await SitemapService.courseEntries()));
  app.get('/api/v1/public/sitemap/videos', async (_req, reply) => reply.send(await SitemapService.videoEntries()));

  // Legacy redirect resolution — returns { redirectUrl } or { redirectUrl: null }.
  app.get<{ Params: { token: string } }>('/api/v1/public/legacy-redirect/project/:token', async (req, reply) => {
    return reply.send({ redirectUrl: await LegacyRedirectResolver.resolveProject(req.params.token) });
  });
  app.get<{ Params: { token: string } }>('/api/v1/public/legacy-redirect/playlist/:token', async (req, reply) => {
    return reply.send({ redirectUrl: await LegacyRedirectResolver.resolvePlaylist(req.params.token) });
  });
}
