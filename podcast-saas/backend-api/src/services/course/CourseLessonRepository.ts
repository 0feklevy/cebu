/**
 * CourseLessonRepository — thin Drizzle data access for `course_lessons`.
 */
import { db } from '../../db/index.js';
import { course_lessons, type CourseLesson, type NewCourseLesson } from '../../db/schema.js';
import { and, eq, asc, sql } from 'drizzle-orm';

export const CourseLessonRepository = {
  listByCourse(courseId: string): Promise<CourseLesson[]> {
    return db.query.course_lessons.findMany({
      where: eq(course_lessons.course_id, courseId),
      orderBy: [asc(course_lessons.position)],
    });
  },

  findByCourseAndSlug(courseId: string, slug: string): Promise<CourseLesson | undefined> {
    return db.query.course_lessons.findFirst({
      where: and(eq(course_lessons.course_id, courseId), eq(course_lessons.slug, slug)),
    });
  },

  findById(id: string): Promise<CourseLesson | undefined> {
    return db.query.course_lessons.findFirst({ where: eq(course_lessons.id, id) });
  },

  async create(values: NewCourseLesson): Promise<CourseLesson> {
    const [row] = await db.insert(course_lessons).values(values).returning();
    return row;
  },

  async update(id: string, patch: Partial<NewCourseLesson>): Promise<CourseLesson | undefined> {
    const [row] = await db
      .update(course_lessons)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(course_lessons.id, id))
      .returning();
    return row;
  },

  async remove(id: string): Promise<void> {
    await db.delete(course_lessons).where(eq(course_lessons.id, id));
  },

  async slugTaken(courseId: string, slug: string, excludeId?: string): Promise<boolean> {
    const rows = await db.query.course_lessons.findMany({
      where: and(eq(course_lessons.course_id, courseId), eq(course_lessons.slug, slug)),
      columns: { id: true },
    });
    return rows.some((r) => r.id !== excludeId);
  },

  async maxPosition(courseId: string): Promise<number> {
    const rows = await db.query.course_lessons.findMany({
      where: eq(course_lessons.course_id, courseId),
      columns: { position: true },
    });
    return rows.reduce((m, r) => Math.max(m, r.position), -1);
  },
};
