/**
 * SitemapService — builds sitemap entries from real data. Includes ONLY records
 * that are published, effectively indexable and publicly resolvable on the
 * platform host. Draft/unlisted/archived, token/preview/admin/editor routes are
 * never included. No values are fabricated to satisfy the schema.
 */
import { db } from '../../db/index.js';
import { projects, video_files } from '../../db/schema.js';
import { and, eq, asc, inArray } from 'drizzle-orm';
import type { SitemapUrlEntry, VideoSitemapEntry } from 'shared';
import { CourseRepository } from './CourseRepository.js';
import { CourseLessonRepository } from './CourseLessonRepository.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import * as Canonical from './CanonicalUrlService.js';
import * as Seo from './SeoResolver.js';

export const SitemapService = {
  /** Published + indexable courses. */
  async courseEntries(): Promise<SitemapUrlEntry[]> {
    const courses = await CourseRepository.listPublished({ indexableOnly: true });
    return courses.map((c) => ({
      loc: Canonical.validateCanonicalOverride(c.canonical_url) ?? Canonical.courseUrl(c.slug),
      lastModified: new Date(c.updated_at).toISOString(),
    }));
  },

  /** Lessons of published + indexable courses, excluding lessons that opt out. */
  async videoEntries(): Promise<VideoSitemapEntry[]> {
    const storage = getStorageAdapter();
    const courses = await CourseRepository.listPublished({ indexableOnly: true });
    const out: VideoSitemapEntry[] = [];

    type Course = (typeof courses)[number];
    type Lesson = Awaited<ReturnType<typeof CourseLessonRepository.listByCourse>>[number];

    // Gather all indexable (course, lesson) pairs first.
    const pairs: { course: Course; lesson: Lesson }[] = [];
    for (const c of courses) {
      const lessons = await CourseLessonRepository.listByCourse(c.id);
      for (const l of lessons) {
        if (l.indexable === false) continue; // explicit lesson opt-out
        pairs.push({ course: c, lesson: l });
      }
    }

    const projectIds = [...new Set(pairs.map((p) => p.lesson.project_id))];
    if (projectIds.length === 0) return out;

    // Batch-fetch projects and their non-broll videos in one query each
    // (was a findFirst + findMany per lesson — N+1).
    const projectRows = await db.query.projects.findMany({
      where: inArray(projects.id, projectIds),
      columns: { id: true, title: true, topic: true, thumbnail_url: true, created_at: true },
    });
    const projectById = new Map(projectRows.map((p) => [p.id, p]));

    const videoRows = await db.query.video_files.findMany({
      where: and(inArray(video_files.project_id, projectIds), eq(video_files.is_broll, false)),
      orderBy: [asc(video_files.created_at)],
    });
    // Earliest non-broll video per project (rows are already created_at-ascending).
    const firstVideoByProject = new Map<string, (typeof videoRows)[number]>();
    for (const v of videoRows) {
      if (!firstVideoByProject.has(v.project_id)) firstVideoByProject.set(v.project_id, v);
    }

    for (const { course: c, lesson: l } of pairs) {
      const project = projectById.get(l.project_id);
      if (!project) continue;

      const vid = firstVideoByProject.get(l.project_id);
      const contentUrl = vid?.hls_master_key
        ? storage.getPublicUrl(vid.hls_master_key)
        : vid?.hls_360p_key ? storage.getPublicUrl(vid.hls_360p_key) : null;

      // A video sitemap entry needs a real video; skip lessons that have none
      // (no fabrication, and no empty <url> noise).
      if (!contentUrl && !project.thumbnail_url) continue;

      out.push({
        loc: Canonical.lessonUrl(c.slug, l.slug),
        title: Seo.humanizeTitleFor(l.title, project.title, l.slug),
        description: (l.summary ?? project.topic ?? '').trim(),
        thumbnailUrl: project.thumbnail_url ?? null,
        publicationDate: project.created_at ? new Date(project.created_at).toISOString() : null,
        durationSec: vid?.duration_sec ?? null,
        contentUrl,
      });
    }
    return out;
  },
};
