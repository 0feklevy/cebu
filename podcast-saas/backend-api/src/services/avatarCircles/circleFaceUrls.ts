/**
 * The ONE definition of "an avatar-circle face image URL that must never be persisted",
 * plus the shape-preserving read/write pair the repair needs.
 *
 * WHY THIS FIELD NEEDS ITS OWN MODULE
 * `projects.avatar_config → avatarCircles.faces[].imageUrl` is the only browser-visible asset URL
 * a project owns that NO column names (ProjectDuplicationService says the same about the storage
 * namespace). It is written ABSOLUTE, exactly once, at upload time — `POST /avatar/circle-face`
 * returns the ADAPTER'S url, the client puts that string into the config, and `PUT /avatar/circles`
 * stores it verbatim — and it is never re-derived on read: `normalizeFaces`' carry() passes
 * imageUrl through untouched and `buildPlayerConfig` emits it into the public player config. So
 * whatever host was baked in at upload time is what every viewer's browser is told to fetch,
 * forever. A local-dev-era `http://localhost:8080/local-storage/…` therefore survives in
 * production as a mixed-content + CSP `img-src` failure that resolves to the VIEWER'S own machine.
 *
 * It also survived the 2026-07-16 URL repair, because `backfill-localhost-urls.ts` scans a fixed
 * list of table.COLUMN pairs and this URL lives inside a JSON document. Both ends of that gap are
 * closed here: the persist-time guard (`nonPublicCircleFaceUrls`, used by the write path) and the
 * typed path walk the backfill uses to find and repair the rows already written.
 *
 * Pure — no DB, no IO, no storage adapter — so both callers apply byte-identical rules and both
 * are unit-testable on their OUTPUT.
 */
import { isNonPublicUrl } from '../../config/publicOrigins.js';

/** One `faces[i].imageUrl` occurrence, located by index so a repair can address it precisely. */
export interface CircleFaceUrlSite {
  /** Index into `avatarCircles.faces`. */
  faceIndex: number;
  /** Stable JSON path for plans/reports/backups, e.g. `avatarCircles.faces[0].imageUrl`. */
  path: string;
  url: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** `avatarCircles` out of a parsed avatar_config document, or undefined. */
export function circlesOf(config: unknown): unknown {
  return isPlainObject(config) ? config.avatarCircles : undefined;
}

function facesOf(circles: unknown): unknown[] {
  if (!isPlainObject(circles)) return [];
  return Array.isArray(circles.faces) ? circles.faces : [];
}

/**
 * Every `faces[].imageUrl` in this circles config whose host is non-public (localhost, loopback,
 * or an internal Docker service name).
 *
 * A TYPED PATH WALK, deliberately — not a text scan of the document. `knowledge` is up to 40 kB of
 * the author's prose and `systemPrompt` 20 kB more; neither has any business being pattern-matched
 * for URLs, and a blind replace inside the blob is how a repair damages fields nobody audited.
 */
export function nonPublicCircleFaceUrls(circles: unknown): CircleFaceUrlSite[] {
  const out: CircleFaceUrlSite[] = [];
  facesOf(circles).forEach((face, faceIndex) => {
    if (!isPlainObject(face)) return;
    const url = face.imageUrl;
    if (typeof url === 'string' && isNonPublicUrl(url)) {
      out.push({ faceIndex, path: `avatarCircles.faces[${faceIndex}].imageUrl`, url });
    }
  });
  return out;
}

/**
 * The message a persist-time guard should reject with, or null when the config may be stored.
 *
 * `prod` is a parameter rather than a `isProd()` call so the rule is testable in both directions,
 * and because it must stay PROD-GATED: in local development `http://localhost:8080/local-storage/…`
 * is the CORRECT value for this field and saving it has to keep working.
 */
export function circleFaceUrlPersistError(circles: unknown, prod: boolean): string | null {
  if (!prod) return null;
  const [first] = nonPublicCircleFaceUrls(circles);
  if (!first) return null;
  return (
    `Avatar circle face image URL is not publicly reachable: ${first.url}. ` +
    'Re-upload the face image so it is stored under the public media origin.'
  );
}

/**
 * How `projects.avatar_config` was found in the column.
 *
 * Production stores it as a jsonb STRING (double-encoded JSON) on every non-null row — verified on
 * all four. A repair that writes back a jsonb OBJECT would "fix" the URL while changing the
 * column's shape, and `rewriteAvatarConfig` (duplication) behaves DIFFERENTLY across the two, so
 * an incidental shape change would silently alter duplication behaviour for that project. Whatever
 * shape a row is read in, it is written back in.
 */
export type AvatarConfigShape = 'object' | 'string';

export interface ParsedAvatarConfig {
  config: Record<string, unknown>;
  shape: AvatarConfigShape;
}

/** Parse the column value, remembering its shape. Returns null when it is not a JSON object. */
export function parseAvatarConfigColumn(raw: unknown): ParsedAvatarConfig | null {
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw) as unknown;
      return isPlainObject(v) ? { config: v, shape: 'string' } : null;
    } catch {
      return null;
    }
  }
  return isPlainObject(raw) ? { config: raw, shape: 'object' } : null;
}

/**
 * The literal jsonb text to write back, in the shape the row was read in.
 * `'string'` yields a JSON string LITERAL whose content is the document — i.e. what
 * `jsonb_typeof` reports as 'string' — so the round trip is shape-preserving.
 */
export function serializeAvatarConfigColumn(config: unknown, shape: AvatarConfigShape): string {
  const text = JSON.stringify(config);
  return shape === 'string' ? JSON.stringify(text) : text;
}

/**
 * A copy of the avatar_config document with the named faces' `imageUrl` replaced — or REMOVED
 * when the resolution is null (the object is gone, so the face keeps its slot, its speaker, its
 * side and its label, and loses only the picture).
 *
 * Only the touched path is rebuilt; every other value keeps its identity and every object keeps
 * its key order, so the re-serialized document differs from the original in exactly this field.
 */
export function withCircleFaceUrls(
  config: Record<string, unknown>,
  resolutions: ReadonlyMap<number, string | null>,
): Record<string, unknown> {
  const circles = config.avatarCircles;
  if (!isPlainObject(circles) || !Array.isArray(circles.faces)) return config;
  const faces = circles.faces.map((face, i) => {
    if (!resolutions.has(i) || !isPlainObject(face)) return face;
    const next = { ...face };
    const url = resolutions.get(i) ?? null;
    if (url === null) delete next.imageUrl;
    else next.imageUrl = url;
    return next;
  });
  return { ...config, avatarCircles: { ...circles, faces } };
}
