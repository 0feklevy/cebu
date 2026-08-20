/**
 * permalinkService — creator-controlled public permalinks (migration 043).
 *
 * A public project or playlist can be reached at {PUBLIC_SITE_URL}/{slug}
 * (WordPress/base44-style, e.g. https://science-of-awe.com/my-video). The
 * random share_token links (/v/:token, /pl/:token) remain the unlisted links.
 *
 * Slugs share ONE namespace across projects, playlists and live library shares
 * (migration 065) — all three resolve at the site root — so every check here
 * spans all three tables. Same-table races are caught by the partial unique
 * indexes (043, 065); the public resolver breaks a theoretical cross-table tie
 * deterministically (project wins).
 */

import { db } from '../db/index.js';
import { projects, playlists, library_shares } from '../db/schema.js';
import { and, eq, isNull, like, ne, or, type SQL } from 'drizzle-orm';
import { slugify, dedupeSlug } from './seo/SlugService.js';
import { platformBaseUrl } from './course/CanonicalUrlService.js';

/**
 * Root paths the app already owns (client-web/app top-level routes + platform
 * names we may need later). A permalink must never shadow one — Next.js static
 * routes win over the /[slug] catch-all, so a reserved slug would be unreachable.
 */
export const RESERVED_SLUGS = new Set([
  // Existing client-web/app top-level routes & metadata files
  'api', 'c', 'v', 'pl', 'new', 'projects', 'playlists', 'podcasts', 'podcast', 'unlock',
  'icon', 'favicon', 'robots', 'llms', 'sitemap', 'sitemap-courses', 'sitemap-videos',
  // Platform / future routes
  'admin', 'login', 'logout', 'signup', 'signin', 'register', 'auth', 'account',
  'settings', 'dashboard', 'profile', 'home', 'about', 'contact', 'pricing',
  'terms', 'privacy', 'legal', 'help', 'support', 'docs', 'blog', 'news',
  'search', 'embed', 'share', 'watch', 'video', 'videos', 'playlist', 'project',
  'course', 'courses', 'creator', 'creators', 'studio', 'app', 'www', 'static',
  'assets', 'public', 'images', 'media', 'files', 'downloads', 'feed', 'rss',
  'next', 'null', 'undefined', 'index',
  // Library mini-site (migration 065). `app/[slug]/library/` is a static child of an existing
  // dynamic segment, so it needs no reservation to FUNCTION — these are defensive. Without them a
  // creator could claim the permalink `library`, which makes `/library/library` a real page and
  // permanently blocks any future top-level `/library`.
  'library', 'libraries', 'simulation', 'simulations', 'sound', 'sounds', 'sim',
]);

export type SlugRejection = 'invalid' | 'reserved' | 'taken';

export function rejectionMessage(reason: SlugRejection): string {
  switch (reason) {
    case 'invalid':  return 'Permalink must contain at least one letter or number (letters, numbers and hyphens only).';
    case 'reserved': return 'This permalink is reserved by the platform — please pick another.';
    case 'taken':    return 'This permalink is already in use — please pick another.';
  }
}

/** Public site origin the permalink lives under (PUBLIC_SITE_URL, no trailing slash). */
export function permalinkBaseUrl(): string {
  return platformBaseUrl();
}

export function permalinkUrl(slug: string): string {
  return `${platformBaseUrl()}/${encodeURIComponent(slug)}`;
}

/** Normalise author input to a kebab slug ('' when nothing usable remains). */
export function normalizePermalinkSlug(input: string | null | undefined): string {
  return slugify(input);
}

export interface SlugExclude {
  type: 'project' | 'playlist';
  id: string;
}

/**
 * True when `slug` is held by any project, playlist OR live library share other than the excluded
 * row.
 *
 * Library shares join this namespace because they resolve at the same root: a library slug is the
 * first path segment of `/{slug}/library`. If a creator could claim a permalink identical to a live
 * library slug, `/{x}/library` would have two possible meanings — the permalinked project's library
 * and the share's — and which one won would depend on resolution order rather than on intent.
 * Revoked shares are excluded: their slug is dead, and holding it hostage forever would be a
 * namespace leak with no owner.
 */
export async function permalinkSlugTaken(slug: string, exclude?: SlugExclude): Promise<boolean> {
  const projectWhere: SQL | undefined = exclude?.type === 'project'
    ? and(eq(projects.slug, slug), ne(projects.id, exclude.id))
    : eq(projects.slug, slug);
  const playlistWhere: SQL | undefined = exclude?.type === 'playlist'
    ? and(eq(playlists.slug, slug), ne(playlists.id, exclude.id))
    : eq(playlists.slug, slug);

  const [proj, pl, lib] = await Promise.all([
    db.query.projects.findFirst({ where: projectWhere, columns: { id: true } }),
    db.query.playlists.findFirst({ where: playlistWhere, columns: { id: true } }),
    db.query.library_shares.findFirst({
      where: and(eq(library_shares.slug, slug), isNull(library_shares.revoked_at)),
      columns: { id: true },
    }),
  ]);
  return Boolean(proj || pl || lib);
}

/** Full usability check. Returns null when the slug can be used, else the reason. */
export async function rejectPermalinkSlug(slug: string, exclude?: SlugExclude): Promise<SlugRejection | null> {
  if (!slug) return 'invalid';
  if (RESERVED_SLUGS.has(slug)) return 'reserved';
  if (await permalinkSlugTaken(slug, exclude)) return 'taken';
  return null;
}

/**
 * Suggest a free slug from a title (prefill for the permalink editor).
 * Returns null when the title yields nothing slug-able.
 */
export async function suggestPermalinkSlug(
  title: string | null | undefined,
  exclude?: SlugExclude,
): Promise<string | null> {
  const base = slugify(title);
  if (!base) return null;

  // Collect existing slugs that could collide with base / base-2 / base-3 …
  // `base` only contains [a-z0-9-], so it is safe inside a LIKE pattern.
  const pattern = `${base}%`;
  const projectWhere = exclude?.type === 'project'
    ? and(or(eq(projects.slug, base), like(projects.slug, pattern)), ne(projects.id, exclude.id))
    : or(eq(projects.slug, base), like(projects.slug, pattern));
  const playlistWhere = exclude?.type === 'playlist'
    ? and(or(eq(playlists.slug, base), like(playlists.slug, pattern)), ne(playlists.id, exclude.id))
    : or(eq(playlists.slug, base), like(playlists.slug, pattern));

  const [projRows, plRows] = await Promise.all([
    db.query.projects.findMany({ where: projectWhere, columns: { slug: true } }),
    db.query.playlists.findMany({ where: playlistWhere, columns: { slug: true } }),
  ]);

  const taken = new Set<string>();
  for (const r of [...projRows, ...plRows]) if (r.slug) taken.add(r.slug);
  // Reserved names count as taken so the suggestion never lands on one.
  if (RESERVED_SLUGS.has(base)) taken.add(base);

  return dedupeSlug(base, taken).slug;
}
