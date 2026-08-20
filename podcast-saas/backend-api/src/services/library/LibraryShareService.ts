/**
 * LibraryShareService — the lifecycle of the one link that opens a project's materials page.
 *
 * Three facts about the slug, each of which is a decision rather than a detail:
 *
 *   1. It is `slugify(title) + '-' + code13`. The title half makes the URL read as the video's
 *      name; the code half is 64 bits of entropy and IS the capability. Nothing else gates the
 *      public page.
 *   2. The code lives in the PATH, not in `?k=`. One URL form means one ISR cache key per share,
 *      so revoking a link is a complete purge instead of a purge plus a hope that no token-bearing
 *      copy was cached under the same path.
 *   3. The slug is frozen at mint. It does not track later title edits — a link already sent must
 *      keep working — which is why the dialog says so and why re-minting is an explicit action.
 *
 * Every URL here is built through `config/publicOrigins.ts`, never through the inline
 * `process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'` that `share.controller.ts` uses in
 * three places. That fallback is the exact shape of the incident `publicOrigins` was written to
 * prevent: in production it emits a loopback URL to a real browser. `siteUrl()` throws instead.
 */
import { randomBytes } from 'crypto';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { library_shares, projects } from '../../db/schema.js';
import { siteUrl } from '../../config/publicOrigins.js';
import { slugify } from '../seo/SlugService.js';
import { RESERVED_SLUGS } from '../permalinkService.js';
import { logger } from '../../lib/logger.js';
import type { LibraryMaterialType } from 'shared';

/** Crockford-ish lowercase base32, minus nothing — 32 symbols, 5 bits each. */
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * `MAX_SLUG_LENGTH` in SlugService is 80 and the DB CHECK repeats it. The code costs 14 characters
 * ('-' + 13), so the title base gets 66 and `base + '-' + code` can never overflow.
 */
const MAX_TITLE_BASE = 66;
const CODE_LENGTH = 13;
const MINT_ATTEMPTS = 3;

export type LibraryShareRow = typeof library_shares.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;

/** 13 lowercase base32 characters over 8 random bytes (~64 bits). */
export function generateLibraryCode(): string {
  const bytes = randomBytes(8);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out = BASE32[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
}

/**
 * The title half of the slug.
 *
 * A null or unsluggable title falls back to `lib-{first 8 hex of the project id}` — deterministic,
 * never a human placeholder like "untitled", matching `makeSlugBase`'s precedence. A base that
 * collides with a RESERVED_SLUGS entry is prefixed rather than rejected: the reservation exists so
 * a creator cannot claim `library` as a PERMALINK, and refusing to mint a share for a project
 * honestly called "Media" would be the reservation leaking into the wrong decision.
 */
export function libraryTitleBase(title: string | null | undefined, projectId: string): string {
  const fromTitle = slugify(title).slice(0, MAX_TITLE_BASE).replace(/-+$/g, '');
  if (!fromTitle) return `lib-${projectId.replace(/-/g, '').slice(0, 8)}`;
  return RESERVED_SLUGS.has(fromTitle) ? `lib-${fromTitle}` : fromTitle;
}

/** The public URL of a share, through `publicOrigins` — never an inline env fallback. */
export function libraryShareUrl(share: Pick<LibraryShareRow, 'slug'>): string {
  return `${siteUrl()}/${share.slug}/library`;
}

/**
 * The code-free alias, when it applies. It is an ALIAS resolved through the same share row, not a
 * second access path, so clearing the permalink degrades this form back to the coded one instead
 * of breaking anything.
 */
export function libraryCleanUrl(project: Pick<ProjectRow, 'slug' | 'visibility'>): string | null {
  if (!project.slug || project.visibility !== 'public') return null;
  return `${siteUrl()}/${project.slug}/library`;
}

/** The live share for a project, or null. Live = not revoked and not past its expiry. */
export async function liveShareForProject(projectId: string): Promise<LibraryShareRow | null> {
  const row = await db.query.library_shares.findFirst({
    where: and(
      eq(library_shares.project_id, projectId),
      isNull(library_shares.revoked_at),
      or(isNull(library_shares.expires_at), gt(library_shares.expires_at, new Date())),
    ),
    orderBy: [desc(library_shares.created_at)],
  });
  return row ?? null;
}

/**
 * Mint the project's link — IDEMPOTENT. A second POST returns the existing live row rather than a
 * second link, which is what keeps `uniq_library_shares_live` from ever being the thing the user
 * meets.
 *
 * On a `23505` the CODE is re-rolled, not the title base. Mutating the base would quietly hand the
 * owner a URL that no longer reads as their video's title to solve a collision that 64 bits makes
 * astronomically unlikely in the first place; re-rolling the half that exists to be random is the
 * proportionate answer. Three attempts, then the error surfaces.
 */
export async function mintShare(
  project: Pick<ProjectRow, 'id' | 'title'>,
  userId: string | null,
  includeTypes: LibraryMaterialType[] = ['simulation', 'image', 'video', 'audio'],
  /**
   * The code source. Injectable for exactly one reason: a genuine 64-bit collision cannot be
   * provoked, so the retry loop below would otherwise be untestable — and an untested retry loop
   * is indistinguishable from one that loops forever.
   */
  makeCode: () => string = generateLibraryCode,
): Promise<LibraryShareRow> {
  const existing = await liveShareForProject(project.id);
  if (existing) return existing;

  const base = libraryTitleBase(project.title, project.id);
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
    const code = makeCode();
    try {
      const [row] = await db.insert(library_shares).values({
        project_id: project.id,
        slug: `${base}-${code}`,
        code,
        include_types: includeTypes,
        created_by: userId,
      }).returning();
      return row;
    } catch (err) {
      // 23505 is unique_violation. Either the slug collided (re-roll the code) or another request
      // won the race for this project's live row (adopt it — that is the idempotent answer).
      if ((err as { code?: string })?.code !== '23505') throw err;
      lastError = err;
      const raced = await liveShareForProject(project.id);
      if (raced) return raced;
      logger.warn({ projectId: project.id, attempt }, 'library share slug collided — re-minting the code');
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Could not mint a library share link after repeated slug collisions.');
}

export interface ResolvedShare {
  share: LibraryShareRow;
  project: ProjectRow;
}

/**
 * Resolve a public path segment to a live share.
 *
 * Order: (1) the share's own slug — the capability form, which works regardless of the project's
 * visibility because the code IS the grant; (2) `projects.slug` joined to a live share, and ONLY
 * when the project is already `visibility='public'` — the clean alias, which is a convenience over
 * the same row and never an independent grant.
 *
 * Returns `null` for every miss and never a reason. Unknown, revoked and expired must be
 * indistinguishable from outside, or the 404 becomes an oracle.
 */
export async function resolveShare(slug: string): Promise<ResolvedShare | null> {
  const live = and(
    isNull(library_shares.revoked_at),
    or(isNull(library_shares.expires_at), gt(library_shares.expires_at, new Date())),
  );

  const direct = await db.query.library_shares.findFirst({
    where: and(eq(library_shares.slug, slug), live),
  });
  if (direct) {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, direct.project_id) });
    return project ? { share: direct, project } : null;
  }

  const project = await db.query.projects.findFirst({ where: eq(projects.slug, slug) });
  if (!project || project.visibility !== 'public') return null;

  const share = await db.query.library_shares.findFirst({
    where: and(eq(library_shares.project_id, project.id), live),
    orderBy: [desc(library_shares.created_at)],
  });
  return share ? { share, project } : null;
}

/** Stamp `revoked_at`. Returns the revoked row, or null when there was nothing live to revoke. */
export async function revokeShare(projectId: string): Promise<LibraryShareRow | null> {
  const now = new Date();
  const [row] = await db.update(library_shares)
    .set({ revoked_at: now, updated_at: now })
    .where(and(eq(library_shares.project_id, projectId), isNull(library_shares.revoked_at)))
    .returning();
  return row ?? null;
}

/**
 * Bump the cache-miss counter. Fire-and-forget and deliberately unawaited by the caller: it is at
 * most one write per path per 60 seconds behind ISR, and a failure to count must never fail a page.
 */
export function bumpRenderCount(shareId: string): void {
  db.update(library_shares)
    .set({ render_count: sql`${library_shares.render_count} + 1`, updated_at: new Date() })
    .where(eq(library_shares.id, shareId))
    .catch((err) => logger.warn({ err, shareId }, 'library share render_count bump failed'));
}
