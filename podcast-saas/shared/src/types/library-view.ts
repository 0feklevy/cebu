import { z } from 'zod';

/**
 * The render-ready view model for the public library mini-site, mirroring `course-view.ts`.
 *
 * This is a PUBLIC-ONLY model, and that is the whole point of it existing as a named shape rather
 * than as "the asset row, minus a few fields". Everything a visitor is allowed to see is declared
 * here; anything not declared here cannot reach the page, because `buildLibraryView` constructs
 * these objects field by field rather than spreading a database row. No storage key, no share
 * code, no `project_id`, no `org_id`, no `created_by`, no bridge functions, no guidance, no canary
 * report — the same discipline `PublicCourseQueryService` keeps, and the backend suite asserts it
 * over the whole serialized response rather than field by field.
 *
 * The zod schemas are not decoration: `client-web/lib/libraryApi.ts` validates the backend body
 * against them at the Server-Component boundary, exactly as `courseApi.ts` validates
 * `CourseViewSchema`. A body that does not parse is a 404, never half a page.
 */

export const LibraryMaterialTypeSchema = z.enum(['simulation', 'image', 'video', 'audio']);
export type LibraryMaterialType = z.infer<typeof LibraryMaterialTypeSchema>;

/** Every material type, in the order the filter pills present them. */
export const LIBRARY_MATERIAL_TYPES: readonly LibraryMaterialType[] = [
  'simulation', 'image', 'video', 'audio',
] as const;

/** Stored crop, as fractions of the original image (0–1). Applied as a CSS transform. */
export const LibraryCropSchema = z.object({
  x: z.number(), y: z.number(), w: z.number(), h: z.number(),
});
export type LibraryCrop = z.infer<typeof LibraryCropSchema>;

export const LibraryMaterialSchema = z.object({
  /** The asset row id. Not a storage key, and not the project it belongs to. */
  id: z.string(),
  type: LibraryMaterialTypeSchema,
  name: z.string(),
  /** Already-public, already-resolved. Nothing on the page mints or signs a URL. */
  url: z.string(),
  /**
   * A still picture for the tile, when a stored one already exists: a simulation's poster
   * rendition, or the project's video-derived thumbnail. Never captured at request time —
   * `buildLibraryView` only re-emits artifacts other pipelines already wrote. Optional AND
   * nullable so payloads cached before this field existed keep parsing.
   */
  bannerUrl: z.string().nullable().optional(),
  durationSec: z.number().nullable().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  crop: LibraryCropSchema.nullable().optional(),
  captionsUrl: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type LibraryMaterial = z.infer<typeof LibraryMaterialSchema>;

export const LibraryCountsSchema = z.object({
  simulation: z.number().int(),
  image: z.number().int(),
  video: z.number().int(),
  audio: z.number().int(),
});
export type LibraryCounts = z.infer<typeof LibraryCountsSchema>;

export const LibraryViewSchema = z.object({
  title: z.string(),
  /**
   * Reading direction of the title's script. Phase 1 emits 'ltr' unconditionally — the contract is
   * declared now so the RTL work is a value change rather than a shape change.
   */
  direction: z.enum(['ltr', 'rtl']),
  /**
   * Counts over ALL FOUR buckets, always — including the ones the current filter excludes, so the
   * pills can show real totals without a second fetch. Types excluded from the share's scope are
   * genuinely zero here, because scope is enforced in the query, not in the response.
   */
  counts: LibraryCountsSchema,
  materials: z.array(LibraryMaterialSchema),
  canonicalUrl: z.string(),
  /** Phase 1 is noindex. Literal `false`, so flipping it is a deliberate schema change. */
  indexable: z.literal(false),
});
export type LibraryView = z.infer<typeof LibraryViewSchema>;

/** The owner-facing state of a project's link. All-nulls when the project has no live share. */
export const LibraryShareStateSchema = z.object({
  slug: z.string().min(1).nullable(),
  url: z.string().min(1).nullable(),
  /** The code-free `/{permalink}/library` form, when the project is public with a permalink. */
  cleanUrl: z.string().min(1).nullable(),
  includeTypes: z.array(LibraryMaterialTypeSchema).nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  /**
   * The project's title, so the dialog can name what is being shared. Present even when there is
   * no live link — the project has a title either way, and the editor never holds one to pass
   * down (`VideoEditor` receives only `projectId`).
   */
  title: z.string().nullable(),
});
export type LibraryShareState = z.infer<typeof LibraryShareStateSchema>;

/**
 * Canonical sub-route names — the owner's own words: `simulation` singular, the rest plural.
 * Anything in `LIBRARY_TYPE_ALIASES` 308s to the canonical form; anything else 404s.
 */
export const LIBRARY_TYPE_SEGMENTS: Readonly<Record<string, LibraryMaterialType>> = {
  simulation: 'simulation',
  images: 'image',
  videos: 'video',
  sounds: 'audio',
};

export const LIBRARY_TYPE_ALIASES: Readonly<Record<string, string>> = {
  simulations: 'simulation',
  sims: 'simulation',
  sim: 'simulation',
  image: 'images',
  video: 'videos',
  sound: 'sounds',
  audio: 'sounds',
};

/** The canonical segment for a material type — the inverse of `LIBRARY_TYPE_SEGMENTS`. */
export function librarySegmentFor(type: LibraryMaterialType): string {
  switch (type) {
    case 'simulation': return 'simulation';
    case 'image':      return 'images';
    case 'video':      return 'videos';
    case 'audio':      return 'sounds';
  }
}

/** Plural human label for a bucket, used by the pills and the empty states. */
export function libraryTypeLabel(type: LibraryMaterialType): string {
  switch (type) {
    case 'simulation': return 'Simulations';
    case 'image':      return 'Images';
    case 'video':      return 'Videos';
    case 'audio':      return 'Sounds';
  }
}
