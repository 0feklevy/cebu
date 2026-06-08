/**
 * LegacyRedirectResolver — decides whether a legacy /v/<token> or /pl/<token>
 * link should permanently redirect to a /c/ URL. Every check is at request time;
 * a redirect target is only honoured when its destination is genuinely public.
 *
 * Returns an absolute /c/ URL (always on the platform host, never a token/preview
 * URL → no chains, no loops) or null (caller keeps the existing token viewer).
 */
import { db } from '../../db/index.js';
import { projects, playlists, project_redirect_targets, course_lessons } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { CourseRepository } from './CourseRepository.js';
import { effectiveIndexable } from './SeoResolver.js';
import * as Canonical from './CanonicalUrlService.js';

export const LegacyRedirectResolver = {
  /**
   * /v/<shareToken> → canonical lesson URL, only when ALL hold:
   *   token resolves to a project; a redirect target exists; the target lesson
   *   references the SAME project; its course is published + effectively indexable;
   *   the lesson is itself effectively indexable.
   */
  async resolveProject(shareToken: string): Promise<string | null> {
    const project = await db.query.projects.findFirst({
      where: eq(projects.share_token, shareToken),
      columns: { id: true, share_token: true },
    });
    if (!project || !project.share_token) return null;

    const target = await db.query.project_redirect_targets.findFirst({
      where: eq(project_redirect_targets.project_id, project.id),
    });
    if (!target) return null;

    const lesson = await db.query.course_lessons.findFirst({
      where: eq(course_lessons.id, target.course_lesson_id),
    });
    if (!lesson || lesson.project_id !== project.id) return null; // mismatch → no redirect

    const course = await CourseRepository.findById(lesson.course_id);
    if (!course || course.publish_state !== 'published') return null;
    if (!effectiveIndexable(course.publish_state, course.indexable)) return null;
    const lessonIndexable = lesson.indexable === null ? course.indexable : lesson.indexable;
    if (!effectiveIndexable(course.publish_state, course.indexable && lessonIndexable)) return null;

    return Canonical.lessonUrl(course.slug, lesson.slug);
  },

  /**
   * /pl/<shareToken> → canonical course URL, only when the legacy playlist's
   * course is published + effectively indexable.
   */
  async resolvePlaylist(shareToken: string): Promise<string | null> {
    const playlist = await db.query.playlists.findFirst({
      where: eq(playlists.share_token, shareToken),
      columns: { id: true, share_token: true },
    });
    if (!playlist || !playlist.share_token) return null;

    const course = await CourseRepository.findByLegacyPlaylistId(playlist.id);
    if (!course || course.publish_state !== 'published') return null;
    if (!effectiveIndexable(course.publish_state, course.indexable)) return null;

    return Canonical.courseUrl(course.slug);
  },
};
