/**
 * Dubbing language codes — the one place a language tag is validated or displayed.
 *
 * THE TWO SURFACES SPECIFY DIFFERENT STANDARDS, verbatim from the vendor's OpenAPI document:
 * the classic create endpoint documents `source_lang`/`target_lang` as "iso639-1 or iso639-3",
 * the classic transcripts route says "ISO-693" (a typo for ISO-639 in the published spec), and
 * the v2 project surface says "BCP-47 language tag". For every code this product ships the three
 * agree, so no mapping table is needed — but the codes are pinned here rather than inlined so a
 * fourth language is added in one place and validated the same way everywhere.
 *
 * Two rules from the vendor's supported-dialect table that will otherwise bite:
 *   • a REGION-QUALIFIED tag must be one of the listed dialects. Sending an unsupported region
 *     subtag is an error, not a silent fallback to the base language — `es-419` in particular is
 *     NOT supported and `es-MX` is the code for Latin American Spanish;
 *   • Hebrew has no dialects. `he-IL` will not match and must never be sent.
 *
 * On `source_language` the vendor ignores any region or script subtag ("transcription is
 * per-language"), so `en-GB` as a SOURCE is silently treated as `en`.
 */

/** A language the product offers as a dubbing target. */
export interface DubbingLanguage {
  /** The BCP-47 base code — also the public URL suffix, 1:1. */
  code: string;
  /** English name, for logs and the creator UI's fallback rendering. */
  name: string;
  /** The language's own name, which is what a viewer picking it should see. */
  endonym: string;
  /** Right-to-left script — the viewer needs this to set `dir` on the caption overlay. */
  rtl: boolean;
  /**
   * Region-qualified dialects the vendor accepts for this language. An empty array means the
   * language has NO dialects and only the base code may be sent.
   */
  dialects: readonly string[];
}

/**
 * The languages this product ships. Deliberately a small, curated set rather than the vendor's
 * full 90+: every entry here is a language someone has agreed to support in the UI (name, endonym
 * and text direction), and an unlisted code is rejected before any money is spent.
 */
export const DUBBING_LANGUAGES: readonly DubbingLanguage[] = [
  { code: 'en', name: 'English', endonym: 'English',  rtl: false, dialects: ['en-AU', 'en-CA', 'en-GB', 'en-US'] },
  { code: 'es', name: 'Spanish', endonym: 'Español',  rtl: false, dialects: ['es-AR', 'es-CL', 'es-ES', 'es-MX'] },
  { code: 'he', name: 'Hebrew',  endonym: 'עברית',    rtl: true,  dialects: [] },
];

const BY_CODE = new Map<string, DubbingLanguage>();
for (const lang of DUBBING_LANGUAGES) {
  BY_CODE.set(lang.code, lang);
  for (const dialect of lang.dialects) BY_CODE.set(dialect, lang);
}

/**
 * The same shape `courses.language` and `video_dubs.target_language` enforce in the database.
 * Checking it here as well means a malformed tag is refused with a readable message instead of a
 * constraint violation at insert time.
 */
export const LANGUAGE_TAG_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

/** The language a tag names, or null when the product does not offer it. */
export function findDubbingLanguage(tag: string): DubbingLanguage | null {
  return BY_CODE.get(tag.trim()) ?? null;
}

/** Whether a tag is one this product will dub into — base code or supported dialect. */
export function isSupportedDubbingLanguage(tag: string): boolean {
  return findDubbingLanguage(tag) !== null;
}

/**
 * Normalise a caller-supplied tag to what actually goes in the database and the URL.
 *
 * A dialect collapses to its base code, because the language axis of this product is the base
 * language: `/es` is one page, and `es-MX` and `es-ES` are two ways of asking for it. The dialect
 * is still meaningful to the VENDOR (it selects an accent), which is why `vendorTargetLanguage`
 * below keeps it — these two functions deliberately answer different questions.
 */
export function normalizeDubbingLanguage(tag: string): string | null {
  return findDubbingLanguage(tag)?.code ?? null;
}

/**
 * The exact string to send as the vendor's `target_language`.
 *
 * A supported dialect is passed through unchanged (it selects the accent); anything else is
 * reduced to the base code. Returns null for a language the product does not offer, so a bad tag
 * cannot reach a billable call.
 */
export function vendorTargetLanguage(tag: string): string | null {
  const trimmed = tag.trim();
  const lang = findDubbingLanguage(trimmed);
  if (!lang) return null;
  return lang.dialects.includes(trimmed) ? trimmed : lang.code;
}

/**
 * Reduce a tag for use as a SOURCE language.
 *
 * The vendor ignores region and script subtags on `source_language`, so sending one is at best
 * noise. Collapsing here keeps the request honest about what it actually asks for. Unlike the
 * target helpers this accepts any well-formed tag, because the source language is whatever the
 * media happens to be — not something the product has to offer as a dubbing target.
 */
export function sourceLanguageTag(tag: string | null | undefined): string | null {
  const trimmed = tag?.trim();
  if (!trimmed || !LANGUAGE_TAG_PATTERN.test(trimmed)) return null;
  return trimmed.split('-')[0]!.toLowerCase();
}
