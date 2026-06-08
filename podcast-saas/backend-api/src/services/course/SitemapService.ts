/**
 * SitemapService — builds sitemap entries from real data. Includes ONLY records
 * that are published, effectively indexable and publicly resolvable on the
 * platform host. Draft/unlisted/archived, token/preview/admin/editor routes are
 * never included. No values are fabricated to satisfy the schema.
 */
import { db } from '../../db/index.js';
import { projects, video_files } from '../../db/schema.js';
import { and, eq, asc } from 'drizzle-orm';
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

    for (const c of courses) {
      const lessons = await CourseLessonRepository.listByCourse(c.id);
      for (const l of lessons) {
        if (l.indexable === false) continue; // explicit lesson opt-out
        const project = await db.query.projects.findFirst({
          where: eq(projects.id, l.project_id),
          columns: { id: true, title: true, topic: true, thumbnail_url: true, created_at: true },
        });
        if (!project) continue;

        // First non-broll main video for real duration / date / content URL.
        const vids = await db.query.video_files.findMany({
          where: and(eq(video_files.project_id, l.project_id), eq(video_files.is_broll, false)),
          orderBy: [asc(video_files.created_at)],
        });
        const vid = vids[0];
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
    }
    return out;
  },
};
