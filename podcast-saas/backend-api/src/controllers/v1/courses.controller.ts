/**
 * Authoring API for courses (auth required). Backend surface for a later creator
 * UI — no UI / SEO Check panel built here. Every operation enforces organization
 * ownership via CoursePublishingService.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { CoursePublishingService, CourseAuthzError, type AuthUser } from '../../services/course/CoursePublishingService.js';

function authUser(req: FastifyRequest): AuthUser {
  const u = req.dbUser!;
  if (!u.default_org_id) throw new CourseAuthzError(400, 'User has no organization');
  return { id: u.id, orgId: u.default_org_id };
}

async function handle(reply: FastifyReply, fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return reply.send((await fn()) ?? { ok: true });
  } catch (err) {
    if (err instanceof CourseAuthzError) return reply.code(err.statusCode).send({ message: err.message });
    throw err;
  }
}

export async function registerCourseAuthoringRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: [firebaseAuthMiddleware] };

  app.post<{ Body: { title?: string; description?: string; subtitle?: string; kind?: 'single' | 'playlist'; slug?: string; language?: string } }>(
    '/api/v1/courses', auth,
    (req, reply) => handle(reply, () => CoursePublishingService.createCourse(authUser(req), req.body ?? {})),
  );

  const contentSchema = z.object({
    title: z.string().nullable().optional(), subtitle: z.string().nullable().optional(),
    description: z.string().nullable().optional(), cover_image_url: z.string().nullable().optional(),
    instructor_name: z.string().nullable().optional(), instructor_bio: z.string().nullable().optional(),
    instructor_avatar_url: z.string().nullable().optional(), language: z.string().optional(),
    learning_outcomes: z.array(z.string()).nullable().optional(),
  });
  app.patch<{ Params: { id: string } }>('/api/v1/courses/:id', auth, (req, reply) =>
    handle(reply, () => CoursePublishingService.updateCourseContent(authUser(req), req.params.id, contentSchema.parse(req.body))));

  const seoSchema = z.object({
    seo_title: z.string().nullable().optional(), seo_description: z.string().nullable().optional(),
    og_title: z.string().nullable().optional(), og_description: z.string().nullable().optional(),
    og_image_url: z.string().nullable().optional(), indexable: z.boolean().optional(),
    canonical_url: z.string().nullable().optional(),
  });
  app.patch<{ Params: { id: string } }>('/api/v1/courses/:id/seo', auth, (req, reply) =>
    handle(reply, () => CoursePublishingService.updateCourseSeo(authUser(req), req.params.id, seoSchema.parse(req.body))));

  app.post<{ Params: { id: string }; Body: { slug: string } }>('/api/v1/courses/:id/slug', auth, (req, reply) =>
    handle(reply, () => CoursePublishingService.changeSlug(authUser(req), req.params.id, req.body.slug)));

  app.get<{ Querystring: { slug: string; excludeId?: string } }>('/api/v1/courses/slug-available', auth, (req, reply) =>
    handle(reply, () => CoursePublishingService.validateSlugAvailability(authUser(req), req.query.slug, req.query.excludeId)));

  // Lessons
  app.post<{ Params: { id: string }; Body: { projectId: string; title?: string; summary?: string; slug?: string } }>(
    '/api/v1/courses/:id/lessons', auth,
    (req, reply) => handle(reply, () => CoursePublishingService.addLesson(authUser(req), req.params.id, req.body.projectId, req.body)));

  app.patch<{ Params: { lessonId: string } }>('/api/v1/course-lessons/:lessonId', auth, (req, reply) =>
    handle(reply, () => CoursePublishingService.updateLesson(authUser(req), req.params.lessonId, (req.body ?? {}) as never)));

  app.delete<{ Params: { lessonId: string } }>('/api/v1/course-lessons/:lessonId', auth, (req, reply) =>
    handle(reply, () => CoursePublishingService.removeLesson(authUser(req), req.params.lessonId)));

  app.post<{ Params: { id: string }; Body: { orderedLessonIds: string[] } }>('/api/v1/courses/:id/reorder', auth, (req, reply) =>
    handle(reply, () => CoursePublishingService.reorderLessons(authUser(req), req.params.id, req.body.orderedLessonIds)));

  // SEO readiness preview (flag thin lessons before publishing)
  app.get<{ Params: { id: string } }>('/api/v1/courses/:id/readiness', auth, (req, reply) =>
    handle(reply, () => CoursePublishingService.assessReadiness(authUser(req), req.params.id)));

  // State transitions
  app.post<{ Params: { id: string }; Body: { force?: boolean } }>('/api/v1/courses/:id/publish', auth, (req, reply) =>
    handle(reply, () => CoursePublishingService.publish(authUser(req), req.params.id, { force: req.body?.force })));
  app.post<{ Params: { id: string } }>('/api/v1/courses/:id/unpublish', auth, (req, reply) => handle(reply, () => CoursePublishingService.unpublish(authUser(req), req.params.id)));
  app.post<{ Params: { id: string } }>('/api/v1/courses/:id/unlist',    auth, (req, reply) => handle(reply, () => CoursePublishingService.setUnlisted(authUser(req), req.params.id)));
  app.post<{ Params: { id: string }; Body: { disposition: 'temporary' | 'permanent' | 'redirect'; replacementUrl?: string } }>(
    '/api/v1/courses/:id/archive', auth,
    (req, reply) => handle(reply, () => CoursePublishingService.archive(authUser(req), req.params.id, req.body.disposition, req.body.replacementUrl)));
  app.post<{ Params: { id: string } }>('/api/v1/courses/:id/restore', auth, (req, reply) => handle(reply, () => CoursePublishingService.restore(authUser(req), req.params.id)));
}
