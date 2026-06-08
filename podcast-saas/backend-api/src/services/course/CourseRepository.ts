/**
 * CourseRepository — thin Drizzle data access for `courses`. Keeps DB queries out
 * of route components and higher-level services.
 */
import { db } from '../../db/index.js';
import { courses, type Course, type NewCourse } from '../../db/schema.js';
import { and, eq, isNull, sql } from 'drizzle-orm';

export const CourseRepository = {
  findById(id: string): Promise<Course | undefined> {
    return db.query.courses.findFirst({ where: eq(courses.id, id) });
  },

  /** Find a course by slug on the platform default host (canonical_host IS NULL). */
  findByPlatformSlug(slug: string): Promise<Course | undefined> {
    return db.query.courses.findFirst({
      where: and(eq(courses.slug, slug), isNull(courses.canonical_host)),
    });
  },

  findByLegacyPlaylistId(playlistId: string): Promise<Course | undefined> {
    return db.query.courses.findFirst({ where: eq(courses.legacy_playlist_id, playlistId) });
  },

  /** Published courses (optionally only indexable) for sitemaps/discovery. */
  listPublished(opts: { indexableOnly: boolean }): Promise<Course[]> {
    const where = opts.indexableOnly
      ? and(eq(courses.publish_state, 'published'), eq(courses.indexable, true))
      : eq(courses.publish_state, 'published');
    return db.query.courses.findMany({ where });
  },

  listByOrg(orgId: string): Promise<Course[]> {
    return db.query.courses.findMany({ where: eq(courses.org_id, orgId) });
  },

  async create(values: NewCourse): Promise<Course> {
    const [row] = await db.insert(courses).values(values).returning();
    return row;
  },

  async update(id: string, patch: Partial<NewCourse>): Promise<Course | undefined> {
    const [row] = await db
      .update(courses)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(courses.id, id))
      .returning();
    return row;
  },

  async slugTaken(slug: string, canonicalHost: string | null, excludeId?: string): Promise<boolean> {
    const rows = await db.query.courses.findMany({
      where: canonicalHost === null
        ? and(eq(courses.slug, slug), isNull(courses.canonical_host))
        : and(eq(courses.slug, slug), eq(courses.canonical_host, canonicalHost)),
      columns: { id: true },
    });
    return rows.some((r) => r.id !== excludeId);
  },
};
