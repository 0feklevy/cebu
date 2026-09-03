/**
 * Playlist → Publish as course (owner ruling 2026-09-03, priority 6 — "deliberately narrow").
 *
 * The course schema (migration 030/032) and the whole authoring API existed with no live rows and
 * no creator UI. V1 is one flow, built on what is there: a playlist of projects becomes a course
 * whose lessons ARE the playlist's items, in the playlist's order; publishing runs the existing
 * readiness check and the existing publish; reordering the playlist reorders the course. No
 * course-management product — the playlist editor gains one section.
 *
 * The link is `courses.legacy_playlist_id`. It was backfill provenance (one course per legacy
 * source, unique); from here on it is the LIVE link between a playlist and its course, which is
 * exactly what its uniqueness already enforced.
 */
import { asc, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { courses, playlist_items, playlists, projects, type Course } from '../../db/schema.js';
import { CoursePublishingService, CourseAuthzError, type AuthUser } from './CoursePublishingService.js';
import { CourseLessonRepository } from './CourseLessonRepository.js';
import { CourseRepository } from './CourseRepository.js';

export interface PlaylistCourseState {
  course: {
    id: string;
    slug: string;
    publish_state: string;
    published_at: string | null;
    lesson_count: number;
    /** The public path, `/c/<slug>`; the page renders only while published. */
    public_path: string;
  } | null;
  /** How many playlist items would become lessons. */
  item_count: number;
  readiness: { ready: boolean; thinLessons: Array<{ lessonSlug: string; reason: string }> } | null;
}

async function ownedPlaylist(playlistId: string, user: AuthUser) {
  const playlist = await db.query.playlists.findFirst({ where: eq(playlists.id, playlistId) });
  if (!playlist) throw new CourseAuthzError(404, 'Playlist not found');
  if (playlist.org_id !== user.orgId) throw new CourseAuthzError(403, 'Not authorized for this playlist');
  return playlist;
}

async function courseForPlaylist(playlistId: string): Promise<Course | null> {
  return (await db.query.courses.findFirst({ where: eq(courses.legacy_playlist_id, playlistId) })) ?? null;
}

async function orderedProjectIds(playlistId: string): Promise<string[]> {
  const items = await db.query.playlist_items.findMany({ where: eq(playlist_items.playlist_id, playlistId), orderBy: [asc(playlist_items.position)] });
  return items.map((i) => i.project_id);
}

function toState(course: Course | null, lessonCount: number, itemCount: number, readiness: PlaylistCourseState['readiness']): PlaylistCourseState {
  return {
    course: course ? {
      id: course.id, slug: course.slug, publish_state: course.publish_state,
      published_at: course.published_at ? new Date(course.published_at as unknown as string).toISOString() : null,
      lesson_count: lessonCount, public_path: `/c/${course.slug}`,
    } : null,
    item_count: itemCount,
    readiness,
  };
}

/**
 * Make the course's lessons equal the playlist's items, in order: add the missing, remove the
 * extra, reorder the rest. Idempotent — a second call changes nothing.
 */
export async function syncLessonsFromPlaylist(user: AuthUser, course: Course, playlistId: string): Promise<number> {
  const wanted = await orderedProjectIds(playlistId);
  const existing = await CourseLessonRepository.listByCourse(course.id);
  const byProject = new Map(existing.map((l) => [l.project_id, l]));
  for (const projectId of wanted) {
    if (!byProject.has(projectId)) {
      const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId), columns: { id: true, title: true } });
      await CoursePublishingService.addLesson(user, course.id, projectId, { title: project?.title ?? null });
    }
  }
  for (const lesson of existing) {
    if (!wanted.includes(lesson.project_id)) await CoursePublishingService.removeLesson(user, lesson.id);
  }
  const after = await CourseLessonRepository.listByCourse(course.id);
  const order = wanted.map((pid) => after.find((l) => l.project_id === pid)?.id).filter((id): id is string => Boolean(id));
  if (order.length > 1) await CoursePublishingService.reorderLessons(user, course.id, order);
  return order.length;
}

export const PlaylistCourseService = {
  async state(user: AuthUser, playlistId: string): Promise<PlaylistCourseState> {
    await ownedPlaylist(playlistId, user);
    const [course, itemIds] = await Promise.all([courseForPlaylist(playlistId), orderedProjectIds(playlistId)]);
    if (!course) return toState(null, 0, itemIds.length, null);
    const [lessons, readiness] = await Promise.all([
      CourseLessonRepository.listByCourse(course.id),
      CoursePublishingService.assessReadiness(user, course.id).catch(() => null),
    ]);
    return toState(course, lessons.length, itemIds.length, readiness);
  },

  /**
   * Create the course if the playlist has none (kind 'playlist', its title, description and
   * banner), sync the lessons, and publish when asked. The readiness refusal (422 with the thin
   * lessons) comes from the existing publish and is passed through untouched.
   */
  async publish(user: AuthUser, playlistId: string, opts: { publish: boolean; force?: boolean; slug?: string | null }): Promise<PlaylistCourseState> {
    const playlist = await ownedPlaylist(playlistId, user);
    const itemIds = await orderedProjectIds(playlistId);
    if (itemIds.length === 0) throw new CourseAuthzError(422, 'Add at least one video to the playlist before publishing it as a course.');

    let course = await courseForPlaylist(playlistId);
    if (!course) {
      const created = await CoursePublishingService.createCourse(user, {
        title: playlist.title ?? 'Untitled course', description: playlist.description ?? null, kind: 'playlist',
        slug: opts.slug?.trim() || null,
      });
      course = (await CourseRepository.update(created.id, { legacy_playlist_id: playlistId, cover_image_url: playlist.banner_url ?? null })) ?? created;
    } else if (course.cover_image_url !== (playlist.banner_url ?? null) || course.title !== (playlist.title ?? course.title)) {
      course = (await CourseRepository.update(course.id, { cover_image_url: playlist.banner_url ?? null, title: playlist.title ?? course.title })) ?? course;
    }

    // A chosen address: on an existing course it is a rename (409 when taken, 400 when invalid —
    // the course service's own answers, passed through).
    const wantedSlug = opts.slug?.trim();
    if (wantedSlug && wantedSlug !== course.slug) course = await CoursePublishingService.changeSlug(user, course.id, wantedSlug);

    const lessonCount = await syncLessonsFromPlaylist(user, course, playlistId);
    if (opts.publish) course = await CoursePublishingService.publish(user, course.id, { force: opts.force });
    const readiness = await CoursePublishingService.assessReadiness(user, course.id).catch(() => null);
    return toState(course, lessonCount, itemIds.length, readiness);
  },

  async unpublish(user: AuthUser, playlistId: string): Promise<PlaylistCourseState> {
    await ownedPlaylist(playlistId, user);
    const course = await courseForPlaylist(playlistId);
    if (!course) throw new CourseAuthzError(404, 'This playlist has no course');
    const updated = await CoursePublishingService.unpublish(user, course.id);
    const lessons = await CourseLessonRepository.listByCourse(course.id);
    return toState(updated, lessons.length, (await orderedProjectIds(playlistId)).length, null);
  },

  /** After the playlist's items change: a course that exists follows them. No course, nothing. */
  async syncIfCourse(user: AuthUser, playlistId: string): Promise<void> {
    const course = await courseForPlaylist(playlistId);
    if (!course) return;
    await syncLessonsFromPlaylist(user, course, playlistId);
  },
};

/** The AuthUser the course services want, from the request's dbUser — null when the user has no org. */
export function courseAuthUserOf(dbUser: { id: string; default_org_id?: string | null } | undefined): AuthUser | null {
  if (!dbUser?.default_org_id) return null;
  return { id: dbUser.id, orgId: dbUser.default_org_id };
}
