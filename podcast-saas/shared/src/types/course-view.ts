import { z } from 'zod';
import { PublishStateSchema } from './course.js';

/**
 * Render-ready view models for the public course/lesson pages. The backend
 * computes these (effective SEO, canonical URL, JSON-LD all resolved server-side)
 * so the Next routes stay thin and there is a single implementation. These models
 * expose ONLY public fields — never share tokens, storage keys or org secrets.
 */

// ── Effective SEO (resolved; never placeholders) ───────────────────────────────
export const EffectiveSeoSchema = z.object({
  title: z.string(),
  description: z.string(),
  canonicalUrl: z.string(),
  ogTitle: z.string(),
  ogDescription: z.string(),
  ogImageUrl: z.string(),
  language: z.string(),
  indexable: z.boolean(),
  // Fully-resolved robots directive string, e.g. "index, follow" / "noindex, nofollow".
  robots: z.string(),
});
export type EffectiveSeo = z.infer<typeof EffectiveSeoSchema>;

export const BreadcrumbSchema = z.object({ name: z.string(), url: z.string() });
export type Breadcrumb = z.infer<typeof BreadcrumbSchema>;

// ── Course view ────────────────────────────────────────────────────────────────
export const CourseLessonLinkSchema = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  position: z.number().int(),
  durationSec: z.number().nullable(),
  thumbnailUrl: z.string().nullable(),
  href: z.string(),
});
export type CourseLessonLink = z.infer<typeof CourseLessonLinkSchema>;

export const InstructorSchema = z.object({
  name: z.string(),
  bio: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});

export const CourseViewSchema = z.object({
  slug: z.string(),
  kind: z.enum(['single', 'playlist']),
  title: z.string(),
  subtitle: z.string().nullable(),
  description: z.string().nullable(),
  coverImageUrl: z.string().nullable(),
  language: z.string(),
  instructor: InstructorSchema.nullable(),
  learningOutcomes: z.array(z.string()),
  lessons: z.array(CourseLessonLinkSchema),
  breadcrumbs: z.array(BreadcrumbSchema),
  canonicalUrl: z.string(),
  ogImageUrl: z.string(),
  seo: EffectiveSeoSchema,
  jsonLd: z.array(z.record(z.string(), z.unknown())),
  publishState: PublishStateSchema,
});
export type CourseView = z.infer<typeof CourseViewSchema>;

// ── Lesson view ─────────────────────────────────────────────────────────────────
export const LessonChapterSchema = z.object({
  label: z.string(),
  startSec: z.number(),
  endSec: z.number(),
});
export type LessonChapter = z.infer<typeof LessonChapterSchema>;

export const LessonNavSchema = z.object({ slug: z.string(), title: z.string(), href: z.string() });

export const LessonViewSchema = z.object({
  courseSlug: z.string(),
  courseTitle: z.string(),
  courseHref: z.string(),
  slug: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  language: z.string(),
  position: z.number().int(),
  transcriptText: z.string().nullable(),
  transcriptSource: z.enum(['scenes', 'script', 'captions', 'corpus']).nullable(),
  topics: z.string().nullable(),
  learningOutcomes: z.array(z.string()),
  interactiveElements: z.array(z.object({ label: z.string(), description: z.string() })),
  chapters: z.array(LessonChapterSchema),
  prev: LessonNavSchema.nullable(),
  next: LessonNavSchema.nullable(),
  breadcrumbs: z.array(BreadcrumbSchema),
  canonicalUrl: z.string(),
  ogImageUrl: z.string(),
  seo: EffectiveSeoSchema,
  jsonLd: z.array(z.record(z.string(), z.unknown())),
  // The sanitized interactive player payload (same shape the share endpoint returns).
  player: z.unknown(),
});
export type LessonView = z.infer<typeof LessonViewSchema>;

// ── Public query result envelope (drives HTTP status in the route) ─────────────
export type PublicResultStatus = 'ok' | 'not_found' | 'gone' | 'redirect';

export interface PublicCourseResult {
  status: PublicResultStatus;
  course?: CourseView;
  redirectUrl?: string;   // for archived 'redirect' disposition
}
export interface PublicLessonResult {
  status: PublicResultStatus;
  lesson?: LessonView;
  redirectUrl?: string;
}

// ── Sitemap entries ─────────────────────────────────────────────────────────────
export interface SitemapUrlEntry {
  loc: string;
  lastModified: string;   // ISO
}
export interface VideoSitemapEntry {
  loc: string;            // page URL
  title: string;
  description: string;
  thumbnailUrl: string | null;
  publicationDate: string | null;  // ISO
  durationSec: number | null;
  contentUrl: string | null;       // player/content location
}
