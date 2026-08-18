/**
 * CoursePublishingService — authoring mutations + the publication state machine.
 * Enforces organization ownership and keeps the DB archive invariants satisfied
 * (archive fields are cleared whenever a course leaves the 'archived' state).
 * Slugs are stable after creation; changing a published slug is an explicit action.
 *
 * Every mutation that affects public output dispatches a single centralized
 * invalidation event (PublishingInvalidationService) — no scattered revalidate.
 */
import { randomUUID } from 'crypto';
import { db } from '../../db/index.js';
import { projects, course_lessons, type Course } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { CourseRepository } from './CourseRepository.js';
import { CourseLessonRepository } from './CourseLessonRepository.js';
import { allocateSlug, normalizeAuthorSlug } from '../seo/SlugService.js';
import { jsonbStringArray } from '../../db/jsonb.js';
import { resolveLessonContent, assessLessonReadiness } from './LessonContentService.js';
import { validateCanonicalOverride } from './CanonicalUrlService.js';
import { dispatchInvalidation } from './PublishingInvalidationService.js';

export type ArchiveDisposition = 'temporary' | 'permanent' | 'redirect';

export class CourseAuthzError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export interface AuthUser { id: string; orgId: string }

async function loadOwned(courseId: string, user: AuthUser): Promise<Course> {
  const course = await CourseRepository.findById(courseId);
  if (!course) throw new CourseAuthzError(404, 'Course not found');
  if (course.org_id !== user.orgId) throw new CourseAuthzError(403, 'Not authorized for this course');
  return course;
}

async function affectedLessonSlugs(courseId: string): Promise<string[]> {
  return (await CourseLessonRepository.listByCourse(courseId)).map((l) => l.slug);
}

async function invalidate(course: Course, previousSlug?: string | null): Promise<void> {
  await dispatchInvalidation({
    type: 'course_changed',
    courseSlug: course.slug,
    affectedLessonSlugs: await affectedLessonSlugs(course.id),
    previousCourseSlug: previousSlug ?? null,
  });
}

/**
 * A 23505 from the course slug index specifically — not any unique violation on this table, so a
 * future constraint cannot be silently swallowed by the retry loop below.
 */
function isCourseSlugConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint_name?: string; constraint?: string; message?: string } | null;
  if (!e || e.code !== '23505') return false;
  const named = e.constraint_name ?? e.constraint ?? '';
  return named === 'uniq_courses_host_slug' || (named === '' && (e.message ?? '').includes('uniq_courses_host_slug'));
}

export const CoursePublishingService = {
  async validateSlugAvailability(user: AuthUser, slug: string, excludeId?: string): Promise<{ available: boolean; normalized: string }> {
    const normalized = normalizeAuthorSlug(slug);
    if (!normalized) return { available: false, normalized: '' };
    const taken = await CourseRepository.slugTaken(normalized, null, excludeId);
    return { available: !taken, normalized };
  },

  /**
   * ALLOCATE AGAINST THE NAMESPACE THE INDEX ENFORCES, NOT THE ONE THE CALLER CAN SEE.
   *
   * This used to dedupe against `listByOrg(user.orgId)`, but `uniq_courses_host_slug` is
   * `(COALESCE(canonical_host,'@platform'), slug)` — GLOBAL across organizations. Two tenants who
   * both created "Intro to Physics" both allocated `intro-to-physics`, and the second INSERT threw
   * a raw 23505 straight out of the endpoint: a 500 on a first-run action, caused by data the user
   * is not allowed to see and can do nothing about.
   *
   * The INDEX is the correct half. `/api/v1/public/courses/:slug` resolves through
   * `findByPlatformSlug` with no tenant segment, so a per-org index would let one URL address two
   * courses — silently wrong instead of loudly wrong. `validateSlugAvailability` and `changeSlug`
   * already ask the host-global question; `createCourse` was the lone dissenter. Hence no
   * migration: the allocator was moved to the namespace that already exists.
   *
   * AND THE READ IS STILL A READ. Two creates that interleave both see the pre-insert namespace and
   * can still pick the same slug, so the insert is retried against a freshly-read namespace when
   * the index rejects it. That is what makes this correct rather than merely less likely to fail;
   * new courses are always created on the platform host, so `null` is the host every time.
   */
  async createCourse(user: AuthUser, input: {
    title?: string | null; description?: string | null; subtitle?: string | null;
    kind?: 'single' | 'playlist'; slug?: string | null; language?: string;
  }): Promise<Course> {
    // Bounded: each attempt re-reads the namespace and moves at least one step further along the
    // -2, -3, … ladder, so a retry can only lose to a slug allocated in the same instant. Five is
    // far past any real concurrency on one title; beyond that, failing loudly beats spinning.
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; ; attempt++) {
      const taken = new Set(await CourseRepository.slugsForHost(null));
      const { slug } = allocateSlug(input.title, randomUUID(), taken, 'c', input.slug ?? null);
      try {
        return await CourseRepository.create({
          org_id: user.orgId, created_by: user.id,
          kind: input.kind ?? 'single',
          title: input.title ?? null, description: input.description ?? null, subtitle: input.subtitle ?? null,
          slug, language: input.language ?? 'en', publish_state: 'draft',
        });
      } catch (err) {
        if (!isCourseSlugConflict(err) || attempt >= MAX_ATTEMPTS) throw err;
      }
    }
  },

  async updateCourseContent(user: AuthUser, id: string, patch: Partial<Pick<Course,
    'title' | 'subtitle' | 'description' | 'cover_image_url' | 'instructor_name' | 'instructor_bio' | 'instructor_avatar_url' | 'language'>>
    & { learning_outcomes?: string[] | null }): Promise<Course> {
    const course = await loadOwned(id, user);
    // learning_outcomes is jsonb: build the array server-side so postgres-js does
    // not double-encode it into a jsonb string (see src/db/jsonb.ts).
    const { learning_outcomes, ...rest } = patch;
    const values: Record<string, unknown> = { ...rest };
    if (learning_outcomes !== undefined) values.learning_outcomes = jsonbStringArray(learning_outcomes);
    const updated = await CourseRepository.update(id, values as never);
    await invalidate(updated ?? course);
    return updated!;
  },

  async updateCourseSeo(user: AuthUser, id: string, patch: Partial<Pick<Course,
    'seo_title' | 'seo_description' | 'og_title' | 'og_description' | 'og_image_url' | 'indexable' | 'canonical_url'>>): Promise<Course> {
    const course = await loadOwned(id, user);
    if (patch.canonical_url && !validateCanonicalOverride(patch.canonical_url)) {
      throw new CourseAuthzError(400, 'Invalid canonical URL override');
    }
    const updated = await CourseRepository.update(id, patch as never);
    await invalidate(updated ?? course);
    return updated!;
  },

  /** Explicit slug change (collision-checked under the platform host). */
  async changeSlug(user: AuthUser, id: string, newSlug: string): Promise<Course> {
    const course = await loadOwned(id, user);
    const normalized = normalizeAuthorSlug(newSlug);
    if (!normalized) throw new CourseAuthzError(400, 'Invalid slug');
    if (await CourseRepository.slugTaken(normalized, course.canonical_host, id)) {
      throw new CourseAuthzError(409, 'Slug already in use');
    }
    const previous = course.slug;
    const updated = await CourseRepository.update(id, { slug: normalized });
    await invalidate(updated ?? course, previous);
    return updated!;
  },

  async addLesson(user: AuthUser, courseId: string, projectId: string, input: { title?: string | null; summary?: string | null; slug?: string | null }): Promise<void> {
    const course = await loadOwned(courseId, user);
    const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId), columns: { id: true, org_id: true, title: true } });
    if (!project) throw new CourseAuthzError(404, 'Project not found');
    if (project.org_id !== user.orgId) throw new CourseAuthzError(403, 'Not authorized for this project');

    const existing = await CourseLessonRepository.listByCourse(courseId);
    if (existing.some((l) => l.project_id === projectId)) throw new CourseAuthzError(409, 'Project already in this course');

    const taken = new Set(existing.map((l) => l.slug));
    const { slug } = allocateSlug(input.title ?? project.title, projectId, taken, 'l', input.slug ?? null);
    const position = (await CourseLessonRepository.maxPosition(courseId)) + 1;
    await CourseLessonRepository.create({ course_id: courseId, project_id: projectId, position, slug, title: input.title ?? null, summary: input.summary ?? null });
    await invalidate(course);
  },

  async updateLesson(user: AuthUser, lessonId: string, patch: { title?: string | null; summary?: string | null; seo_title?: string | null; seo_description?: string | null; indexable?: boolean | null }): Promise<void> {
    const lesson = await CourseLessonRepository.findById(lessonId);
    if (!lesson) throw new CourseAuthzError(404, 'Lesson not found');
    const course = await loadOwned(lesson.course_id, user);
    await CourseLessonRepository.update(lessonId, patch as never);
    await invalidate(course);
  },

  async removeLesson(user: AuthUser, lessonId: string): Promise<void> {
    const lesson = await CourseLessonRepository.findById(lessonId);
    if (!lesson) throw new CourseAuthzError(404, 'Lesson not found');
    const course = await loadOwned(lesson.course_id, user);
    await CourseLessonRepository.remove(lessonId);
    await invalidate(course);
  },

  /** Reorder by supplying lesson ids in the desired order. Uses a deferred-unique-safe two-phase update. */
  async reorderLessons(user: AuthUser, courseId: string, orderedLessonIds: string[]): Promise<void> {
    const course = await loadOwned(courseId, user);
    const lessons = await CourseLessonRepository.listByCourse(courseId);
    const ids = new Set(lessons.map((l) => l.id));
    if (orderedLessonIds.length !== lessons.length || !orderedLessonIds.every((id) => ids.has(id))) {
      throw new CourseAuthzError(400, 'Reorder list must contain exactly the course lessons');
    }
    // Two-phase to avoid colliding on the unique (course_id, position): park high, then
    // set final. Wrapped in a transaction so a mid-reorder crash can't strand lessons at
    // positions 1000+i (the unique constraint is DEFERRABLE for exactly this) — review db-001.
    await db.transaction(async (tx) => {
      for (let i = 0; i < orderedLessonIds.length; i++) {
        await tx.update(course_lessons).set({ position: 1000 + i }).where(eq(course_lessons.id, orderedLessonIds[i]));
      }
      for (let i = 0; i < orderedLessonIds.length; i++) {
        await tx.update(course_lessons).set({ position: i }).where(eq(course_lessons.id, orderedLessonIds[i]));
      }
    });
    await invalidate(course);
  },

  /**
   * Per-lesson SEO readiness — flags lessons that would publish an SEO-thin page
   * (no transcript source AND no substantive summary). Used to gate publish().
   */
  async assessReadiness(user: AuthUser, id: string): Promise<{ ready: boolean; thinLessons: Array<{ lessonSlug: string; reason: string }> }> {
    await loadOwned(id, user);
    const lessons = await CourseLessonRepository.listByCourse(id);
    const thin: Array<{ lessonSlug: string; reason: string }> = [];
    for (const l of lessons) {
      const content = await resolveLessonContent(l.project_id);
      const r = assessLessonReadiness({ transcript: content.transcript, summary: l.summary });
      if (!r.ok) thin.push({ lessonSlug: l.slug, reason: r.reason ?? 'thin' });
    }
    return { ready: thin.length === 0, thinLessons: thin };
  },

  async publish(user: AuthUser, id: string, opts: { force?: boolean } = {}): Promise<Course> {
    const course = await loadOwned(id, user);
    if (!opts.force) {
      const readiness = await this.assessReadiness(user, id);
      if (!readiness.ready) {
        const err = new CourseAuthzError(422, `Cannot publish: ${readiness.thinLessons.length} lesson(s) lack a transcript or meaningful summary. Add text or publish with force=true.`);
        (err as CourseAuthzError & { details?: unknown }).details = readiness.thinLessons;
        throw err;
      }
    }
    const updated = await CourseRepository.update(id, {
      publish_state: 'published',
      published_at: course.published_at ?? (new Date() as never),
      // leaving 'archived' (if it was) requires clearing archive fields
      archive_disposition: null, archived_replacement_url: null, archived_at: null,
    });
    await invalidate(updated ?? course);
    return updated!;
  },

  async unpublish(user: AuthUser, id: string): Promise<Course> {
    const course = await loadOwned(id, user);
    const updated = await CourseRepository.update(id, {
      publish_state: 'draft', archive_disposition: null, archived_replacement_url: null, archived_at: null,
    });
    await invalidate(updated ?? course);
    return updated!;
  },

  async setUnlisted(user: AuthUser, id: string): Promise<Course> {
    const course = await loadOwned(id, user);
    const updated = await CourseRepository.update(id, {
      publish_state: 'unlisted', archive_disposition: null, archived_replacement_url: null, archived_at: null,
    });
    await invalidate(updated ?? course);
    return updated!;
  },

  async archive(user: AuthUser, id: string, disposition: ArchiveDisposition, replacementUrl?: string | null): Promise<Course> {
    const course = await loadOwned(id, user);
    let replacement: string | null = null;
    if (disposition === 'redirect') {
      replacement = validateCanonicalOverride(replacementUrl);
      if (!replacement) throw new CourseAuthzError(400, 'redirect disposition requires a valid replacement URL');
    }
    const updated = await CourseRepository.update(id, {
      publish_state: 'archived',
      archive_disposition: disposition,
      archived_at: new Date() as never,
      archived_replacement_url: replacement,
    });
    await invalidate(updated ?? course);
    return updated!;
  },

  async restore(user: AuthUser, id: string): Promise<Course> {
    // Restore to draft (safe default); archive fields cleared to satisfy invariants.
    return this.unpublish(user, id);
  },
};
