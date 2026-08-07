/**
 * Poster identity and storage paths (Priority 5.1 / 5.5).
 *
 * A POSTER IS A PROMISE ABOUT A SPECIFIC PICTURE. It stands in for a live simulation during the
 * window where showing the live frame would be wrong (not yet acknowledged) or pointless (too
 * little section time left). That only works if the poster shows what the live frame WOULD have
 * shown — the same section, the same Minimal-UI state, the same hidden controls, the same initial
 * camera, the same aspect. A generic package screenshot fails all of those at once and is worse
 * than no poster: the user sees one picture, then a visibly different one, and reads the
 * difference as the product glitching.
 *
 * So the key is the full identity of the picture:
 *
 *     packageRevision + variantKey + configHash + aspectProfile + qualityProfile
 *
 * `configHash` already folds in Minimal-UI, hidden controls, auto-script, transparency and initial
 * state (simIdentity.ts), so aspect and quality are the only two axes that need naming separately
 * — and they do need it, because the SAME configuration is legitimately captured more than once at
 * different sizes and quality profiles.
 *
 * NOT YET IMMUTABLE. Priority 7 introduces immutable package revisions and atomic publication.
 * Until then `packageRevision` is derived (see simIdentity.derivePackageRevision) and a poster's
 * path therefore changes whenever the package's bridge changes — which is the correct invalidation
 * behaviour, just achieved by derivation rather than by publication. Nothing outside this module
 * parses a poster path, so the migration is a change to `posterStoragePath` alone.
 */

import type { ConfigHash, PackageRevision, SimAspectProfile, SimQualityProfile, VariantKey } from './simIdentity.js';

export interface PosterKey {
  packageRevision: PackageRevision;
  variantKey: VariantKey;
  configHash: ConfigHash;
  aspectProfile: SimAspectProfile;
  qualityProfile: SimQualityProfile;
}

/** Rendered pixel sizes captured for every poster identity. */
export type PosterSizeName = 'compact' | 'standard';

export interface PosterSize {
  name: PosterSizeName;
  width: number;
  height: number;
}

/**
 * Two sizes, not a ladder. `standard` covers a full-width player on a normal display; `compact`
 * covers the phone/portrait and picture-in-picture cases. A third intermediate size measurably
 * doubles canary time for a difference no one can see at these compression levels.
 */
export const POSTER_SIZES: Readonly<Record<SimAspectProfile, readonly PosterSize[]>> = {
  wide: [
    { name: 'standard', width: 1280, height: 720 },
    { name: 'compact', width: 640, height: 360 },
  ],
  standard: [
    { name: 'standard', width: 1024, height: 768 },
    { name: 'compact', width: 512, height: 384 },
  ],
  portrait: [
    { name: 'standard', width: 720, height: 1280 },
    { name: 'compact', width: 360, height: 640 },
  ],
  native: [
    { name: 'standard', width: 1280, height: 720 },
    { name: 'compact', width: 640, height: 360 },
  ],
};

/**
 * Encoded formats, in preference order. WebP is universally supported by every browser this
 * product runs in; AVIF is smaller but decodes slowly enough on weak devices that using it as the
 * FIRST choice for a cover that must appear instantly is the wrong trade. PNG is the fallback and
 * the ONLY format used when the poster needs real transparency, because a transparent WebP still
 * costs a decode that a small PNG does not.
 */
export type PosterFormat = 'webp' | 'avif' | 'png';

export const POSTER_FORMAT_ORDER: readonly PosterFormat[] = ['webp', 'avif', 'png'];

export const POSTER_CONTENT_TYPES: Readonly<Record<PosterFormat, string>> = {
  webp: 'image/webp',
  avif: 'image/avif',
  png: 'image/png',
};

/**
 * A transparent simulation renders over video. Its poster must therefore also be transparent, or
 * the cover paints an opaque rectangle over the video the section is supposed to sit on top of —
 * visually the exact "black box appears over the video" defect posters exist to prevent.
 */
export function formatsFor(transparent: boolean): readonly PosterFormat[] {
  return transparent ? ['png'] : POSTER_FORMAT_ORDER;
}

/**
 * The stable, collision-free identity string. Every component is already a bounded token
 * (revisions and hashes are hex, profiles are enums), except `variantKey`, which is a section id
 * and is therefore sanitised — a section id containing a slash would otherwise mint a poster in a
 * DIFFERENT storage directory, and a `..` would escape the prefix entirely.
 */
export function posterIdentityString(key: PosterKey): string {
  return [
    key.packageRevision,
    sanitizeVariant(key.variantKey),
    key.configHash,
    key.aspectProfile,
    key.qualityProfile,
  ].join('__');
}

/**
 * Section ids in this product are UUIDs, so this normally changes nothing. It is applied anyway
 * because the value reaches a storage path, and "the caller always passes a UUID" is an assumption
 * about every present and future caller rather than a property of this function.
 */
export function sanitizeVariant(variantKey: string): string {
  const cleaned = variantKey.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned.slice(0, 128) : '_';
}

/**
 * Deterministic storage path.
 *
 * Lives UNDER the simulation's own prefix so that deleting a simulation (which does a
 * `deleteWithPrefix` on `simulations/<projectId>/<simId>`) removes its posters with it. A separate
 * top-level `posters/` prefix would have left every poster of every deleted simulation orphaned
 * forever, with no owner to attribute them to.
 */
export function posterStoragePath(
  storagePrefix: string,
  key: PosterKey,
  size: PosterSizeName,
  format: PosterFormat,
): string {
  const prefix = storagePrefix.replace(/\/+$/, '');
  return `${prefix}/posters/${posterIdentityString(key)}/${size}.${format}`;
}

/** The directory holding every size/format of ONE poster identity. */
export function posterDirectory(storagePrefix: string, key: PosterKey): string {
  const prefix = storagePrefix.replace(/\/+$/, '');
  return `${prefix}/posters/${posterIdentityString(key)}`;
}

/** The directory holding every poster of a package. Used by the cleanup sweep. */
export function posterRootPrefix(storagePrefix: string): string {
  return `${storagePrefix.replace(/\/+$/, '')}/posters`;
}

/**
 * Recover the identity from a stored path. Cleanup needs this: the sweep lists what EXISTS in
 * storage and has to decide which entries no longer correspond to any live section configuration,
 * and that decision needs the identity back out of the path.
 *
 * Returns null for anything that is not a poster path, so an unrelated object that happens to live
 * under the prefix is skipped rather than parsed into a wrong identity and deleted.
 */
export function parsePosterPath(path: string): { identity: string; size: string; format: string } | null {
  const m = /\/posters\/([^/]+)\/([^/.]+)\.(webp|avif|png)$/.exec(path);
  if (!m) return null;
  return { identity: m[1], size: m[2], format: m[3] };
}

// ─── Records ──────────────────────────────────────────────────────────────────────────────────

export interface PosterVariantRecord {
  size: PosterSizeName;
  format: PosterFormat;
  path: string;
  /** sha256 of the encoded bytes — proves the object serving the path is the one that was captured. */
  checksum: string;
  contentType: string;
  width: number;
  height: number;
  bytes: number;
}

export interface PosterRecord {
  key: PosterKey;
  identity: string;
  /** Every encoded rendition of this identity. */
  variants: readonly PosterVariantRecord[];
  /** True when the capture had a transparent background. */
  transparent: boolean;
  /** ISO timestamp, stamped by the caller (this module never reads a clock). */
  capturedAt: string;
  /** The revision this poster is valid for. Rollback association. */
  packageRevision: PackageRevision;
}

/**
 * Is this poster still valid for the given identity? A poster is invalidated by ANY change to its
 * key, which is what makes invalidation automatic: a new configuration produces a new identity
 * string, so it simply has no poster yet rather than silently reusing a stale one.
 */
export function posterMatches(record: PosterRecord, key: PosterKey): boolean {
  return record.identity === posterIdentityString(key);
}

const POSTER_SIZE_NAMES: readonly PosterSizeName[] = ['compact', 'standard'];

/**
 * Read a stored `variants` blob back into records, dropping anything malformed.
 *
 * JSONB is `unknown` at the type level and genuinely unknown at runtime (rows predate schema
 * changes, and a hand-repaired row is a real thing). A malformed entry is dropped rather than
 * thrown on: one bad variant must not make an otherwise usable poster unreadable, and must not make
 * a whole player-config render fail because of one row.
 *
 * It lives here, next to the path grammar it validates against, because BOTH readers need it — the
 * poster service and the player-config builder — and a second, looser copy on the read path is how
 * an unvalidated `path` would reach a public URL.
 */
export function parsePosterVariants(raw: unknown): PosterVariantRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: PosterVariantRecord[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const v = entry as Record<string, unknown>;
    if (!POSTER_SIZE_NAMES.includes(v.size as PosterSizeName)) continue;
    if (!POSTER_FORMAT_ORDER.includes(v.format as PosterFormat)) continue;
    if (typeof v.path !== 'string' || v.path.length === 0) continue;
    if (typeof v.checksum !== 'string' || v.checksum.length === 0) continue;
    out.push({
      size: v.size as PosterSizeName,
      format: v.format as PosterFormat,
      path: v.path,
      checksum: v.checksum,
      contentType: typeof v.contentType === 'string' ? v.contentType : POSTER_CONTENT_TYPES[v.format as PosterFormat],
      width: typeof v.width === 'number' ? v.width : 0,
      height: typeof v.height === 'number' ? v.height : 0,
      bytes: typeof v.bytes === 'number' ? v.bytes : 0,
    });
  }
  return out;
}

/**
 * Pick the best rendition the viewer can decode, honouring the format preference order.
 *
 * Takes only the `variants` of a record: a caller reading straight from a database row has the
 * renditions but not a whole `PosterRecord`, and fabricating the other fields just to satisfy a
 * parameter type invites them to be fabricated WRONG.
 */
export function selectPosterVariant(
  record: Pick<PosterRecord, 'variants'>,
  size: PosterSizeName,
  supported: readonly PosterFormat[],
): PosterVariantRecord | null {
  for (const format of POSTER_FORMAT_ORDER) {
    if (!supported.includes(format)) continue;
    const hit = record.variants.find((v) => v.size === size && v.format === format);
    if (hit) return hit;
  }
  // Any rendition of the right size beats none — a poster in an unexpected format still shows the
  // right picture, and the browser either decodes it or falls through to the no-poster path.
  return record.variants.find((v) => v.size === size) ?? null;
}
