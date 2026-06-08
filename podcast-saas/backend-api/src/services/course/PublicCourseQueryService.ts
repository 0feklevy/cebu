/**
 * PublicCourseQueryService — builds render-ready, PUBLIC view models for the
 * /c/[courseSlug] and /c/[courseSlug]/[lessonSlug] pages. Centralizes publication
 * -state → HTTP behaviour and composes the pure SEO/canonical/JSON-LD services.
 *
 * Exposes only public fields: no share tokens, storage keys, org ids or secrets.
 * The interactive player payload is produced by the existing buildPlayerConfig
 * (already public-safe — public HLS/caption/sim URLs only).
 */
import { db } from '../../db/index.js';
import { projects, timeline_sections } from '../../db/schema.js';
import { and, eq, asc, inArray } from 'drizzle-orm';
import type { Course, CourseLesson } from '../../db/schema.js';
import type {
  CourseView, LessonView, PublicCourseResult, PublicLessonResult, CourseLessonLink, Breadcrumb,
} from 'shared';
import { CourseRepository } from './CourseRepository.js';
import { CourseLessonRepository } from './CourseLessonRepository.js';
import { buildPlayerConfig } from '../buildPlayerConfig.js';
import { resolveLessonContent } from './LessonContentService.js';
import * as Canonical from './CanonicalUrlService.js';
import * as Seo from './SeoResolver.js';
import * as Ld from './JsonLdService.js';

type Status = 'ok' | 'not_found' | 'gone' | 'redirect';

/** Map a course's publication state to a public resolution outcome. */
export function resolveCourseStatus(course: Course): { status: Status; redirectUrl?: string } {
  switch (course.publish_state) {
    case 'published':
    case 'unlisted':
      return { status: 'ok' };
    case 'draft':
      return { status: 'not_found' };
    case 'archived': {
      switch (course.archive_disposition) {
        case 'permanent': return { status: 'gone' };
        case 'redirect': {
          const url = Canonical.validateCanonicalOverride(course.archived_replacement_url);
          // Only redirect to a valid destination; otherwise fall back to 404.
          return url ? { status: 'redirect', redirectUrl: url } : { status: 'not_found' };
        }
        case 'temporary':
        default:
          return { status: 'not_found' };
      }
    }
    default:
      return { status: 'not_found' };
  }
}

function ogImageUrlFor(path: string, version: number): string {
  return `${Canonical.platformBaseUrl()}${path}/og?v=${version}`;
}
const versionOf = (d: Date | string | null): number => (d ? new Date(d).getTime() : 0);

function lessonLink(courseSlug: string, l: CourseLesson, projectTitle: string | null, durationSec: number | null, thumb: string | null): CourseLessonLink {
  const title = Seo.humanizeTitleFor(l.title, projectTitle, l.slug);
  return {
    slug: l.slug,
    title,
    summary: l.summary ?? null,
    position: l.position,
    durationSec,
    thumbnailUrl: thumb,
    href: `/c/${courseSlug}/${l.slug}`,
  };
}

export const PublicCourseQueryService = {
  async getCourse(slug: string): Promise<PublicCourseResult> {
    const course = await CourseRepository.findByPlatformSlug(slug);
    if (!course) return { status: 'not_found' };
    const resolved = resolveCourseStatus(course);
    if (resolved.status !== 'ok') return { status: resolved.status, redirectUrl: resolved.redirectUrl };

    const lessons = await CourseLessonRepository.listByCourse(course.id);

    // Per-lesson display data (project title + thumbnail + duration) — public fields.
    const projIds = [...new Set(lessons.map((l) => l.project_id))];
    const projRows = projIds.length
      ? await db.query.projects.findMany({ where: inArray(projects.id, projIds), columns: { id: true, title: true, thumbnail_url: true } })
      : [];
    const projById = new Map(projRows.map((p) => [p.id, p]));

    const canonicalUrl = Canonical.validateCanonicalOverride(course.canonical_url) ?? Canonical.courseUrl(course.slug);
    const ogImageUrl = course.og_image_url ?? ogImageUrlFor(`/c/${course.slug}`, versionOf(course.updated_at));

    const lessonLinks: CourseLessonLink[] = lessons.map((l) => {
      const p = projById.get(l.project_id);
      return lessonLink(course.slug, l, p?.title ?? null, null, p?.thumbnail_url ?? null);
    });

    const seo = Seo.resolveCourseSeo(
      {
        slug: course.slug, publishState: course.publish_state, title: course.title, subtitle: course.subtitle,
        description: course.description, language: course.language, indexable: course.indexable,
        seoTitle: course.seo_title, seoDescription: course.seo_description,
        ogTitle: course.og_title, ogDescription: course.og_description, ogImageOverride: course.og_image_url,
      },
      { canonicalUrl, ogImageUrl },
    );

    const breadcrumbs: Breadcrumb[] = [
      { name: Seo.brandName(), url: Canonical.platformBaseUrl() },
      { name: seo.title, url: canonicalUrl },
    ];

    const lessonLdItems = lessonLinks.map((l) => ({ title: l.title, url: `${Canonical.platformBaseUrl()}${l.href}` }));
    const jsonLd: Record<string, unknown>[] = [
      Ld.course({ name: seo.title, description: seo.description, url: canonicalUrl, inLanguage: seo.language, lessons: lessonLdItems }),
      Ld.itemList(lessonLdItems),
      Ld.breadcrumbList(breadcrumbs),
      Ld.organization(),
    ];

    const view: CourseView = {
      slug: course.slug,
      kind: course.kind,
      title: seo.title,
      subtitle: course.subtitle,
      description: course.description,
      coverImageUrl: course.cover_image_url,
      language: course.language,
      instructor: course.instructor_name
        ? { name: course.instructor_name, bio: course.instructor_bio, avatarUrl: course.instructor_avatar_url }
        : null,
      learningOutcomes: Array.isArray(course.learning_outcomes) ? (course.learning_outcomes as string[]) : [],
      lessons: lessonLinks,
      breadcrumbs,
      canonicalUrl,
      ogImageUrl,
      seo,
      jsonLd,
      publishState: course.publish_state,
    };
    return { status: 'ok', course: view };
  },

  async getLesson(courseSlug: string, lessonSlug: string): Promise<PublicLessonResult> {
    const course = await CourseRepository.findByPlatformSlug(courseSlug);
    if (!course) return { status: 'not_found' };
    const resolved = resolveCourseStatus(course);
    if (resolved.status !== 'ok') return { status: resolved.status, redirectUrl: resolved.redirectUrl };

    // Scope strictly to this course — a lesson slug from another course → 404.
    const lesson = await CourseLessonRepository.findByCourseAndSlug(course.id, lessonSlug);
    if (!lesson) return { status: 'not_found' };

    const allLessons = await CourseLessonRepository.listByCourse(course.id);
    const idx = allLessons.findIndex((l) => l.id === lesson.id);
    const prevL = idx > 0 ? allLessons[idx - 1] : null;
    const nextL = idx >= 0 && idx < allLessons.length - 1 ? allLessons[idx + 1] : null;

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, lesson.project_id),
      columns: { id: true, title: true, topic: true, thumbnail_url: true, created_at: true },
    });

    // Sanitized interactive player payload (existing renderer's data source).
    const player = await buildPlayerConfig(lesson.project_id);

    // Chapters from timeline sections (main track, labelled) — real data only.
    const sections = await db.query.timeline_sections.findMany({
      where: and(eq(timeline_sections.project_id, lesson.project_id), eq(timeline_sections.track, 'main')),
      orderBy: [asc(timeline_sections.start_sec)],
    });
    const chapters = sections
      .filter((s) => (s.label ?? '').trim().length > 0)
      .map((s) => ({ label: s.label as string, startSec: s.start_sec, endSec: s.end_sec }));

    // Video facts (real) from the player config.
    const segs = (player?.segments ?? []) as Array<{ hls_url: string | null; duration_sec: number; captions?: { vtt_url: string | null } }>;
    const durationSec = segs.reduce((sum, s) => sum + (s.duration_sec || 0), 0) || null;
    const contentUrl = segs.find((s) => s.hls_url)?.hls_url ?? null;

    // Meaningful lesson text from stored sources (transcript, topics, interactive
    // element descriptions) so the page is not SEO-thin.
    const content = await resolveLessonContent(lesson.project_id);
    const transcriptText = content.transcript;

    const canonicalUrl = Canonical.lessonUrl(course.slug, lesson.slug);
    const ogImageUrl = lesson.og_image_url ?? ogImageUrlFor(`/c/${course.slug}/${lesson.slug}`, versionOf(lesson.updated_at) || versionOf(course.updated_at));

    const seo = Seo.resolveLessonSeo(
      {
        publishState: course.publish_state, courseIndexable: course.indexable,
        courseTitle: Seo.humanizeTitleFor(course.title, null, course.slug), courseLanguage: course.language,
        position: lesson.position,
        seoTitle: lesson.seo_title, seoDescription: lesson.seo_description, ogTitle: lesson.og_title,
        ogDescription: lesson.og_description, ogImageOverride: lesson.og_image_url,
        lessonTitle: lesson.title, lessonSummary: lesson.summary, lessonLanguage: lesson.language,
        lessonIndexable: lesson.indexable,
        projectTitle: project?.title ?? null, projectTopic: project?.topic ?? null,
      },
      { canonicalUrl, ogImageUrl },
    );

    const courseHref = `/c/${course.slug}`;
    const courseTitleEff = Seo.humanizeTitleFor(course.title, null, course.slug);
    const breadcrumbs: Breadcrumb[] = [
      { name: Seo.brandName(), url: Canonical.platformBaseUrl() },
      { name: courseTitleEff, url: Canonical.courseUrl(course.slug) },
      { name: seo.title, url: canonicalUrl },
    ];

    const videoLd = Ld.videoObject({
      name: seo.title, description: seo.description, url: canonicalUrl,
      thumbnailUrl: project?.thumbnail_url ?? null,
      uploadDate: project?.created_at ? new Date(project.created_at).toISOString() : null,
      durationSec, contentUrl, inLanguage: seo.language,
    });
    const jsonLd: Record<string, unknown>[] = [
      ...(videoLd ? [videoLd] : []),
      Ld.breadcrumbList(breadcrumbs),
      Ld.course({ name: courseTitleEff, description: seo.description, url: Canonical.courseUrl(course.slug), inLanguage: course.language, lessons: [] }),
      ...Ld.clips(canonicalUrl, chapters),
    ];

    const navHref = (l: CourseLesson) => `/c/${course.slug}/${l.slug}`;
    const view: LessonView = {
      courseSlug: course.slug,
      courseTitle: courseTitleEff,
      courseHref,
      slug: lesson.slug,
      title: seo.title,
      summary: lesson.summary,
      language: seo.language,
      position: lesson.position,
      transcriptText,
      transcriptSource: content.transcriptSource,
      topics: content.topics,
      learningOutcomes: Array.isArray(course.learning_outcomes) ? (course.learning_outcomes as string[]) : [],
      interactiveElements: content.interactiveElements,
      chapters,
      prev: prevL ? { slug: prevL.slug, title: Seo.humanizeTitleFor(prevL.title, null, prevL.slug), href: navHref(prevL) } : null,
      next: nextL ? { slug: nextL.slug, title: Seo.humanizeTitleFor(nextL.title, null, nextL.slug), href: navHref(nextL) } : null,
      breadcrumbs,
      canonicalUrl,
      ogImageUrl,
      seo,
      jsonLd,
      player,
    };
    return { status: 'ok', lesson: view };
  },
};
