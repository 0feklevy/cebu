/**
 * Playlist → course: the course is created once and linked by legacy_playlist_id, lessons follow
 * the playlist's items in order (add / remove / reorder, idempotent), publish goes through the
 * existing readiness-gated publish, and ownership is the playlist's org.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  playlist: null as Record<string, unknown> | null,
  course: null as Record<string, unknown> | null,
  items: [] as Array<{ project_id: string; position: number }>,
  lessons: [] as Array<{ id: string; project_id: string; slug: string; position: number }>,
  calls: [] as string[],
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      playlists: { findFirst: async () => state.playlist },
      courses: { findFirst: async () => state.course },
      playlist_items: { findMany: async () => [...state.items].sort((a, b) => a.position - b.position) },
      projects: { findFirst: async (args: { where: { val?: string } }) => ({ id: args.where.val, title: `Title of ${args.where.val}` }) },
    },
  },
}));
vi.mock('../../../db/schema.js', () => ({
  courses: { legacy_playlist_id: 'courses.legacy_playlist_id' },
  course_lessons: {},
  playlist_items: { playlist_id: 'playlist_items.playlist_id', position: 'playlist_items.position' },
  playlists: { id: 'playlists.id' },
  projects: { id: 'projects.id' },
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  asc: vi.fn(() => ({})),
}));
vi.mock('../CoursePublishingService.js', () => {
  class CourseAuthzError extends Error { constructor(public statusCode: number, message: string) { super(message); } }
  return {
    CourseAuthzError,
    CoursePublishingService: {
      createCourse: async (_u: unknown, input: { title?: string | null; slug?: string | null }) => { state.calls.push(`create:${input.title}${input.slug ? ':' + input.slug : ''}`); state.course = { id: 'c1', slug: input.slug ?? 'my-course', publish_state: 'draft', published_at: null, title: input.title, cover_image_url: null }; return state.course; },
      changeSlug: async (_u: unknown, id: string, slug: string) => { state.calls.push(`slug:${id}:${slug}`); state.course = { ...state.course!, slug }; return state.course; },
      addLesson: async (_u: unknown, courseId: string, projectId: string, input: { title?: string | null }) => {
        state.calls.push(`add:${projectId}:${input.title}`);
        state.lessons.push({ id: `l-${projectId}`, project_id: projectId, slug: `l-${projectId}`, position: state.lessons.length + 1 });
      },
      removeLesson: async (_u: unknown, lessonId: string) => { state.calls.push(`remove:${lessonId}`); state.lessons = state.lessons.filter((l) => l.id !== lessonId); },
      reorderLessons: async (_u: unknown, _c: string, ids: string[]) => { state.calls.push(`reorder:${ids.join(',')}`); },
      assessReadiness: async () => ({ ready: state.lessons.length > 0, thinLessons: state.lessons.length ? [] : [{ lessonSlug: '-', reason: 'no lessons' }] }),
      publish: async (_u: unknown, id: string, opts: { force?: boolean }) => { state.calls.push(`publish:${id}:${opts.force ? 'force' : ''}`); state.course = { ...state.course!, publish_state: 'published', published_at: new Date('2026-09-03T12:00:00Z') }; return state.course; },
      unpublish: async (_u: unknown, id: string) => { state.calls.push(`unpublish:${id}`); state.course = { ...state.course!, publish_state: 'draft', published_at: null }; return state.course; },
    },
  };
});
vi.mock('../CourseLessonRepository.js', () => ({
  CourseLessonRepository: { listByCourse: async () => [...state.lessons] },
}));
vi.mock('../CourseRepository.js', () => ({
  CourseRepository: { update: async (id: string, patch: Record<string, unknown>) => { state.calls.push(`update:${Object.keys(patch).sort().join('+')}`); state.course = { ...state.course!, ...patch }; return state.course; } },
}));

import { PlaylistCourseService, syncLessonsFromPlaylist, courseAuthUserOf } from '../PlaylistCourseService.js';

const USER = { id: 'u1', orgId: 'org-1' };

beforeEach(() => {
  state.playlist = { id: 'pl-1', org_id: 'org-1', title: 'Chaos, in five parts', description: 'A series', banner_url: 'https://cdn/banner.png' };
  state.course = null;
  state.items = [{ project_id: 'p1', position: 0 }, { project_id: 'p2', position: 1 }];
  state.lessons = [];
  state.calls = [];
});

describe('PlaylistCourseService.publish', () => {
  it('creates the course once from the playlist, links it, syncs the lessons in order, and publishes', async () => {
    const s = await PlaylistCourseService.publish(USER, 'pl-1', { publish: true });
    expect(state.calls).toEqual([
      'create:Chaos, in five parts', 'update:cover_image_url+legacy_playlist_id',
      'add:p1:Title of p1', 'add:p2:Title of p2', 'reorder:l-p1,l-p2', 'publish:c1:',
    ]);
    expect(s.course).toMatchObject({ id: 'c1', slug: 'my-course', publish_state: 'published', lesson_count: 2, public_path: '/c/my-course' });
    expect(s.item_count).toBe(2);
    expect(s.readiness?.ready).toBe(true);
  });

  it('a second publish reuses the course and changes nothing about the lessons', async () => {
    await PlaylistCourseService.publish(USER, 'pl-1', { publish: true });
    state.calls = [];
    await PlaylistCourseService.publish(USER, 'pl-1', { publish: true });
    expect(state.calls.filter((c) => c.startsWith('create'))).toEqual([]);
    expect(state.calls.filter((c) => c.startsWith('add') || c.startsWith('remove'))).toEqual([]);
  });

  it('refuses an empty playlist, and the org gate is the playlist’s', async () => {
    state.items = [];
    await expect(PlaylistCourseService.publish(USER, 'pl-1', { publish: true })).rejects.toThrow(/at least one video/);
    await expect(PlaylistCourseService.publish({ id: 'u2', orgId: 'other' }, 'pl-1', { publish: true })).rejects.toThrow(/Not authorized/);
    state.playlist = null;
    await expect(PlaylistCourseService.state(USER, 'pl-1')).rejects.toThrow(/Playlist not found/);
  });

  it('a chosen address is used on create, and renames an existing course only when it differs', async () => {
    const s = await PlaylistCourseService.publish(USER, 'pl-1', { publish: false, slug: 'chaos-course' });
    expect(state.calls[0]).toBe('create:Chaos, in five parts:chaos-course');
    expect(s.course?.public_path).toBe('/c/chaos-course');
    state.calls = [];
    await PlaylistCourseService.publish(USER, 'pl-1', { publish: false, slug: 'chaos-course' });
    expect(state.calls.some((c) => c.startsWith('slug:'))).toBe(false);
    const renamed = await PlaylistCourseService.publish(USER, 'pl-1', { publish: false, slug: ' chaos-2 ' });
    expect(state.calls).toContain('slug:c1:chaos-2');
    expect(renamed.course?.slug).toBe('chaos-2');
  });

  it('publish: false creates and syncs a draft without publishing', async () => {
    const s = await PlaylistCourseService.publish(USER, 'pl-1', { publish: false });
    expect(s.course?.publish_state).toBe('draft');
    expect(state.calls.some((c) => c.startsWith('publish'))).toBe(false);
  });
});

describe('syncLessonsFromPlaylist', () => {
  it('adds the missing, removes the extra, reorders to the playlist — idempotently', async () => {
    state.course = { id: 'c1', slug: 's', publish_state: 'draft', published_at: null, title: 't', cover_image_url: null };
    state.lessons = [{ id: 'l-p2', project_id: 'p2', slug: 'l-p2', position: 1 }, { id: 'l-gone', project_id: 'p9', slug: 'l-gone', position: 2 }];
    const n = await syncLessonsFromPlaylist(USER, state.course as never, 'pl-1');
    expect(n).toBe(2);
    expect(state.calls).toEqual(['add:p1:Title of p1', 'remove:l-gone', 'reorder:l-p1,l-p2']);
    state.calls = [];
    await syncLessonsFromPlaylist(USER, state.course as never, 'pl-1');
    expect(state.calls).toEqual(['reorder:l-p1,l-p2']);
  });
});

describe('state, unpublish, syncIfCourse, courseAuthUserOf', () => {
  it('state without a course reports only the item count; with one, the lessons and readiness', async () => {
    expect(await PlaylistCourseService.state(USER, 'pl-1')).toEqual({ course: null, item_count: 2, readiness: null });
    await PlaylistCourseService.publish(USER, 'pl-1', { publish: false });
    const s = await PlaylistCourseService.state(USER, 'pl-1');
    expect(s.course?.lesson_count).toBe(2);
    expect(s.readiness?.ready).toBe(true);
  });

  it('unpublish goes through the course service; without a course it is 404', async () => {
    await expect(PlaylistCourseService.unpublish(USER, 'pl-1')).rejects.toThrow(/no course/);
    await PlaylistCourseService.publish(USER, 'pl-1', { publish: true });
    const s = await PlaylistCourseService.unpublish(USER, 'pl-1');
    expect(s.course?.publish_state).toBe('draft');
    expect(state.calls).toContain('unpublish:c1');
  });

  it('syncIfCourse is a no-op without a course, and a sync with one', async () => {
    await PlaylistCourseService.syncIfCourse(USER, 'pl-1');
    expect(state.calls).toEqual([]);
    await PlaylistCourseService.publish(USER, 'pl-1', { publish: false });
    state.items = [{ project_id: 'p2', position: 0 }];
    state.calls = [];
    await PlaylistCourseService.syncIfCourse(USER, 'pl-1');
    expect(state.calls).toEqual(['remove:l-p1']);
  });

  it('courseAuthUserOf needs an org', () => {
    expect(courseAuthUserOf({ id: 'u1', default_org_id: 'org-1' })).toEqual({ id: 'u1', orgId: 'org-1' });
    expect(courseAuthUserOf({ id: 'u1', default_org_id: null })).toBeNull();
    expect(courseAuthUserOf(undefined)).toBeNull();
  });
});
