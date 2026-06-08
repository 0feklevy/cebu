import { z } from 'zod';

// ── Publishing enums (mirror DB enums in migration 030) ────────────────────────

export const PublishStateSchema = z.enum(['draft', 'unlisted', 'published', 'archived']);
export type PublishState = z.infer<typeof PublishStateSchema>;

export const CourseKindSchema = z.enum(['single', 'playlist']);
export type CourseKind = z.infer<typeof CourseKindSchema>;

// How an archived course should later resolve over HTTP:
//   temporary → temporarily unpublished (later 404; may return)
//   permanent → permanently removed     (later 410 Gone)
//   redirect  → archived with a valid replacement (later 301 → replacementUrl)
export const ArchiveDispositionSchema = z.enum(['temporary', 'permanent', 'redirect']);
export type ArchiveDisposition = z.infer<typeof ArchiveDispositionSchema>;

// Shared slug rule — lowercase kebab token. Mirrors the DB CHECK constraint.
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SlugSchema = z.string().regex(SLUG_PATTERN, 'must be a lowercase kebab-case slug');

// BCP-47-ish language tag. Mirrors the DB CHECK constraint.
export const LANGUAGE_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;
export const LanguageSchema = z.string().regex(LANGUAGE_PATTERN);

// ── SEO override blocks (overrides only — nullable; resolved at render time) ────

export const CourseSeoOverridesSchema = z.object({
  seoTitle:       z.string().nullable(),
  seoDescription: z.string().nullable(),
  canonicalHost:  z.string().nullable(),
  canonicalUrl:   z.string().nullable(),
  ogTitle:        z.string().nullable(),
  ogDescription:  z.string().nullable(),
  ogImageUrl:     z.string().nullable(),
  language:       LanguageSchema,
  indexable:      z.boolean(),
});
export type CourseSeoOverrides = z.infer<typeof CourseSeoOverridesSchema>;

export const LessonSeoOverridesSchema = z.object({
  seoTitle:       z.string().nullable(),
  seoDescription: z.string().nullable(),
  ogTitle:        z.string().nullable(),
  ogDescription:  z.string().nullable(),
  ogImageUrl:     z.string().nullable(),
  language:       LanguageSchema.nullable(), // null = inherit course
  indexable:      z.boolean().nullable(),    // null = inherit course
});
export type LessonSeoOverrides = z.infer<typeof LessonSeoOverridesSchema>;

// ── Domain entities (Phase 1 — data model shapes shared across packages) ───────

export const CourseSchema = z.object({
  id:         z.string().uuid(),
  orgId:      z.string().uuid(),
  createdBy:  z.string().uuid().nullable(),
  kind:       CourseKindSchema,

  title:               z.string().nullable(),
  subtitle:            z.string().nullable(),
  description:         z.string().nullable(),
  learningOutcomes:    z.array(z.string()).nullable(),
  instructorName:      z.string().nullable(),
  instructorBio:       z.string().nullable(),
  instructorAvatarUrl: z.string().nullable(),
  coverImageUrl:       z.string().nullable(),

  publishState:           PublishStateSchema,
  publishedAt:            z.string().datetime().nullable(),
  archivedAt:             z.string().datetime().nullable(),
  archiveDisposition:     ArchiveDispositionSchema.nullable(),
  archivedReplacementUrl: z.string().nullable(),

  slug: SlugSchema,
  seo:  CourseSeoOverridesSchema,

  legacyPlaylistId: z.string().uuid().nullable(),
  legacyProjectId:  z.string().uuid().nullable(),
  viewCount:        z.number().int(),
});
export type Course = z.infer<typeof CourseSchema>;

export const CourseLessonSchema = z.object({
  id:        z.string().uuid(),
  courseId:  z.string().uuid(),
  projectId: z.string().uuid(),
  position:  z.number().int().nonnegative(),
  slug:      SlugSchema,
  title:     z.string().nullable(),
  summary:   z.string().nullable(),
  seo:       LessonSeoOverridesSchema,
});
export type CourseLesson = z.infer<typeof CourseLessonSchema>;
