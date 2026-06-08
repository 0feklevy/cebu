/**
 * SlugService — pure, deterministic slug generation and collision resolution.
 *
 * Required by the course backfill (and the slug tests). No DB access; callers
 * supply the set of already-taken slugs so the same inputs always produce the
 * same output (important for a rerunnable backfill).
 *
 * Slug strategy (single rule shared by the DB CHECK, the shared zod SlugSchema,
 * this service and the tests):
 *   1. An author-entered slug, normalised, always wins (kept stable thereafter).
 *   2. Otherwise the title is deterministically transliterated to Latin
 *      (Hebrew supported) and kebab-cased.
 *   3. Only when that yields nothing do we fall back to an id-derived token.
 *
 * Output always matches: ^[a-z0-9]+(?:-[a-z0-9]+)*$
 */

const MAX_SLUG_LENGTH = 80;

// Deterministic Hebrew → Latin transliteration. Without niqqud some letters are
// ambiguous (ב=b/v, etc.); we pick the most common reading so results are stable.
const HEBREW_MAP: Record<string, string> = {
  'א': '',  'ב': 'b', 'ג': 'g',  'ד': 'd', 'ה': 'h', 'ו': 'v', 'ז': 'z',
  'ח': 'ch', 'ט': 't', 'י': 'y', 'כ': 'k', 'ך': 'k', 'ל': 'l', 'מ': 'm',
  'ם': 'm', 'נ': 'n', 'ן': 'n', 'ס': 's', 'ע': '',  'פ': 'p', 'ף': 'f',
  'צ': 'tz', 'ץ': 'tz', 'ק': 'k', 'ר': 'r', 'ש': 'sh', 'ת': 't',
  '־': '-', // Hebrew maqaf → hyphen
};

// Hebrew niqqud (vowel points) and cantillation marks — stripped before mapping.
const HEBREW_DIACRITICS = /[֑-ׇ]/g;
// Hebrew punctuation we drop outright (geresh, gershayim).
const HEBREW_PUNCT = /[׀׃׳״]/g;

/** Transliterate supported non-Latin scripts to Latin. Latin text passes through. */
export function transliterate(input: string): string {
  const out = input.replace(HEBREW_DIACRITICS, '').replace(HEBREW_PUNCT, '');
  let mapped = '';
  for (const ch of out) mapped += ch in HEBREW_MAP ? HEBREW_MAP[ch] : ch;
  return mapped;
}

/**
 * Normalise arbitrary text into a kebab-case slug fragment. Transliterates first,
 * then strips diacritics and anything non-alphanumeric. Returns '' when nothing
 * slug-able remains (caller decides on a fallback).
 */
export function slugify(input: string | null | undefined): string {
  if (!input) return '';
  return transliterate(input)
    .normalize('NFKD')               // split accented Latin chars into base + diacritic
    .replace(/[̀-ͯ]/g, '') // drop combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')     // non-alphanumeric runs → single hyphen
    .replace(/^-+|-+$/g, '')         // trim leading/trailing hyphens
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');            // re-trim if slice landed on a hyphen
}

/**
 * Normalise an author-entered slug. Same rule as slugify (so a Hebrew or messy
 * author slug becomes a valid token). Returns '' if the author input is unusable.
 */
export function normalizeAuthorSlug(input: string | null | undefined): string {
  return slugify(input);
}

/**
 * Produce a non-empty base slug from (optional author slug, title). Falls back to
 * a deterministic, id-derived token (never a human placeholder like "untitled")
 * only when neither the author slug nor the transliterated title yields anything.
 * `prefix` distinguishes courses ('c') from lessons ('l').
 */
export function makeSlugBase(
  title: string | null | undefined,
  fallbackSeed: string,
  prefix = 'c',
  authorSlug?: string | null,
): string {
  const fromAuthor = normalizeAuthorSlug(authorSlug);
  if (fromAuthor) return fromAuthor;
  const fromTitle = slugify(title);
  if (fromTitle) return fromTitle;
  const seed = slugify(fallbackSeed).replace(/-/g, '').slice(0, 8) || 'x';
  return `${prefix}-${seed}`;
}

/**
 * Resolve `base` against a set of taken slugs by appending -2, -3, … until free.
 * Deterministic given the same `taken` set. Does NOT mutate `taken`.
 */
export function dedupeSlug(base: string, taken: ReadonlySet<string>): { slug: string; collided: boolean } {
  if (!taken.has(base)) return { slug: base, collided: false };
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const trimmedBase = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/g, '');
    const candidate = `${trimmedBase}${suffix}`;
    if (!taken.has(candidate)) return { slug: candidate, collided: true };
  }
}

/**
 * Convenience: generate a unique slug from (author slug, title) and add it to
 * `taken` so a loop over many entities accumulates uniqueness. Mutates `taken`.
 */
export function allocateSlug(
  title: string | null | undefined,
  fallbackSeed: string,
  taken: Set<string>,
  prefix = 'c',
  authorSlug?: string | null,
): { slug: string; collided: boolean } {
  const result = dedupeSlug(makeSlugBase(title, fallbackSeed, prefix, authorSlug), taken);
  taken.add(result.slug);
  return result;
}
