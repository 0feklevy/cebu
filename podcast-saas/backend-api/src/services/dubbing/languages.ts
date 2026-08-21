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
 * The languages this product ships — the vendor's full Dubbing v2 set, verified against their
 * published language table rather than assumed. Every entry carries the three things the product
 * needs and the vendor does not give us: an English name for logs, the language's own endonym
 * (what a viewer picking it should actually see), and text direction, without which a caption
 * overlay renders Arabic and Hebrew backwards.
 *
 * An unlisted code is still rejected before any money is spent — the list is a gate, not a hint.
 * Dialects are only listed where the vendor accepts them; sending an unlisted region subtag is an
 * error rather than a silent fallback, which is why they are enumerated instead of pattern-matched.
 */
export const DUBBING_LANGUAGES: readonly DubbingLanguage[] = [
  { code: 'af',   name: 'Afrikaans',           endonym: 'Afrikaans',     rtl: false, dialects: [] },
  { code: 'ak',   name: 'Akan',                endonym: 'Akan',          rtl: false, dialects: [] },
  { code: 'sq',   name: 'Albanian',            endonym: 'Shqip',         rtl: false, dialects: [] },
  { code: 'am',   name: 'Amharic',             endonym: 'አማርኛ',          rtl: false, dialects: [] },
  { code: 'ar',   name: 'Arabic',              endonym: 'العربية',       rtl: true,  dialects: ['ar-EG'] },
  { code: 'hy',   name: 'Armenian',            endonym: 'Հայերեն',       rtl: false, dialects: [] },
  { code: 'as',   name: 'Assamese',            endonym: 'অসমীয়া',       rtl: false, dialects: [] },
  { code: 'az',   name: 'Azerbaijani',         endonym: 'Azərbaycanca',  rtl: false, dialects: [] },
  { code: 'eu',   name: 'Basque',              endonym: 'Euskara',       rtl: false, dialects: [] },
  { code: 'be',   name: 'Belarusian',          endonym: 'Беларуская',    rtl: false, dialects: [] },
  { code: 'bs',   name: 'Bosnian',             endonym: 'Bosanski',      rtl: false, dialects: [] },
  { code: 'bg',   name: 'Bulgarian',           endonym: 'Български',     rtl: false, dialects: [] },
  { code: 'my',   name: 'Burmese',             endonym: 'မြန်မာ',        rtl: false, dialects: [] },
  { code: 'yue',  name: 'Cantonese',           endonym: '粵語',            rtl: false, dialects: [] },
  { code: 'ca',   name: 'Catalan',             endonym: 'Català',        rtl: false, dialects: [] },
  { code: 'ceb',  name: 'Cebuano',             endonym: 'Cebuano',       rtl: false, dialects: [] },
  { code: 'zh',   name: 'Chinese',             endonym: '中文',            rtl: false, dialects: ['zh-TW'] },
  { code: 'hr',   name: 'Croatian',            endonym: 'Hrvatski',      rtl: false, dialects: [] },
  { code: 'cs',   name: 'Czech',               endonym: 'Čeština',       rtl: false, dialects: [] },
  { code: 'da',   name: 'Danish',              endonym: 'Dansk',         rtl: false, dialects: [] },
  { code: 'dgo',  name: 'Dogri',               endonym: 'डोगरी',         rtl: false, dialects: [] },
  { code: 'nl',   name: 'Dutch',               endonym: 'Nederlands',    rtl: false, dialects: [] },
  { code: 'en',   name: 'English',             endonym: 'English',       rtl: false, dialects: ['en-AU', 'en-CA', 'en-GB', 'en-US'] },
  { code: 'et',   name: 'Estonian',            endonym: 'Eesti',         rtl: false, dialects: [] },
  { code: 'fil',  name: 'Filipino',            endonym: 'Filipino',      rtl: false, dialects: [] },
  { code: 'fi',   name: 'Finnish',             endonym: 'Suomi',         rtl: false, dialects: [] },
  { code: 'fr',   name: 'French',              endonym: 'Français',      rtl: false, dialects: ['fr-CA', 'fr-FR'] },
  { code: 'gl',   name: 'Galician',            endonym: 'Galego',        rtl: false, dialects: [] },
  { code: 'ka',   name: 'Georgian',            endonym: 'ქართული',       rtl: false, dialects: [] },
  { code: 'de',   name: 'German',              endonym: 'Deutsch',       rtl: false, dialects: [] },
  { code: 'el',   name: 'Greek',               endonym: 'Ελληνικά',      rtl: false, dialects: [] },
  { code: 'gu',   name: 'Gujarati',            endonym: 'ગુજરાતી',       rtl: false, dialects: [] },
  { code: 'ha',   name: 'Hausa',               endonym: 'Hausa',         rtl: false, dialects: [] },
  { code: 'he',   name: 'Hebrew',              endonym: 'עברית',         rtl: true,  dialects: [] },
  { code: 'hi',   name: 'Hindi',               endonym: 'हिन्दी',        rtl: false, dialects: [] },
  { code: 'hu',   name: 'Hungarian',           endonym: 'Magyar',        rtl: false, dialects: [] },
  { code: 'is',   name: 'Icelandic',           endonym: 'Íslenska',      rtl: false, dialects: [] },
  { code: 'id',   name: 'Indonesian',          endonym: 'Bahasa Indonesia', rtl: false, dialects: [] },
  { code: 'it',   name: 'Italian',             endonym: 'Italiano',      rtl: false, dialects: [] },
  { code: 'ja',   name: 'Japanese',            endonym: '日本語',           rtl: false, dialects: [] },
  { code: 'jv',   name: 'Javanese',            endonym: 'Basa Jawa',     rtl: false, dialects: [] },
  { code: 'kn',   name: 'Kannada',             endonym: 'ಕನ್ನಡ',         rtl: false, dialects: [] },
  { code: 'kk',   name: 'Kazakh',              endonym: 'Қазақша',       rtl: false, dialects: [] },
  { code: 'ki',   name: 'Kikuyu',              endonym: 'Gĩkũyũ',        rtl: false, dialects: [] },
  { code: 'rw',   name: 'Kinyarwanda',         endonym: 'Ikinyarwanda',  rtl: false, dialects: [] },
  { code: 'rn',   name: 'Kirundi',             endonym: 'Ikirundi',      rtl: false, dialects: [] },
  { code: 'ko',   name: 'Korean',              endonym: '한국어',           rtl: false, dialects: [] },
  { code: 'ky',   name: 'Kyrgyz',              endonym: 'Кыргызча',      rtl: false, dialects: [] },
  { code: 'lv',   name: 'Latvian',             endonym: 'Latviešu',      rtl: false, dialects: [] },
  { code: 'lt',   name: 'Lithuanian',          endonym: 'Lietuvių',      rtl: false, dialects: [] },
  { code: 'lg',   name: 'Luganda',             endonym: 'Luganda',       rtl: false, dialects: [] },
  { code: 'mk',   name: 'Macedonian',          endonym: 'Македонски',    rtl: false, dialects: [] },
  { code: 'ms',   name: 'Malay',               endonym: 'Bahasa Melayu', rtl: false, dialects: [] },
  { code: 'ml',   name: 'Malayalam',           endonym: 'മലയാളം',        rtl: false, dialects: [] },
  { code: 'cmn',  name: 'Mandarin Chinese',    endonym: '普通话',           rtl: false, dialects: [] },
  { code: 'mr',   name: 'Marathi',             endonym: 'मराठी',         rtl: false, dialects: [] },
  { code: 'mn',   name: 'Mongolian',           endonym: 'Монгол',        rtl: false, dialects: [] },
  { code: 'ne',   name: 'Nepali',              endonym: 'नेपाली',        rtl: false, dialects: [] },
  { code: 'no',   name: 'Norwegian',           endonym: 'Norsk',         rtl: false, dialects: [] },
  { code: 'fa',   name: 'Persian',             endonym: 'فارسی',         rtl: true,  dialects: [] },
  { code: 'pl',   name: 'Polish',              endonym: 'Polski',        rtl: false, dialects: [] },
  { code: 'pt',   name: 'Portuguese',          endonym: 'Português',     rtl: false, dialects: ['pt-BR', 'pt-PT'] },
  { code: 'pa',   name: 'Punjabi',             endonym: 'ਪੰਜਾਬੀ',        rtl: false, dialects: [] },
  { code: 'ro',   name: 'Romanian',            endonym: 'Română',        rtl: false, dialects: [] },
  { code: 'ru',   name: 'Russian',             endonym: 'Русский',       rtl: false, dialects: [] },
  { code: 'nso',  name: 'Sepedi',              endonym: 'Sepedi',        rtl: false, dialects: [] },
  { code: 'st',   name: 'Sesotho',             endonym: 'Sesotho',       rtl: false, dialects: [] },
  { code: 'sd',   name: 'Sindhi',              endonym: 'سنڌي',          rtl: true,  dialects: [] },
  { code: 'sk',   name: 'Slovak',              endonym: 'Slovenčina',    rtl: false, dialects: [] },
  { code: 'sl',   name: 'Slovenian',           endonym: 'Slovenščina',   rtl: false, dialects: [] },
  { code: 'es',   name: 'Spanish',             endonym: 'Español',       rtl: false, dialects: ['es-AR', 'es-CL', 'es-ES', 'es-MX'] },
  { code: 'su',   name: 'Sundanese',           endonym: 'Basa Sunda',    rtl: false, dialects: [] },
  { code: 'sw',   name: 'Swahili',             endonym: 'Kiswahili',     rtl: false, dialects: [] },
  { code: 'ss',   name: 'Swati',               endonym: 'siSwati',       rtl: false, dialects: [] },
  { code: 'sv',   name: 'Swedish',             endonym: 'Svenska',       rtl: false, dialects: [] },
  { code: 'tg',   name: 'Tajik',               endonym: 'Тоҷикӣ',        rtl: false, dialects: [] },
  { code: 'ta',   name: 'Tamil',               endonym: 'தமிழ்',         rtl: false, dialects: [] },
  { code: 'te',   name: 'Telugu',              endonym: 'తెలుగు',        rtl: false, dialects: [] },
  { code: 'th',   name: 'Thai',                endonym: 'ไทย',           rtl: false, dialects: [] },
  { code: 'bo',   name: 'Tibetan',             endonym: 'བོད་སྐད',       rtl: false, dialects: [] },
  { code: 'ts',   name: 'Tsonga',              endonym: 'Xitsonga',      rtl: false, dialects: [] },
  { code: 'tn',   name: 'Tswana',              endonym: 'Setswana',      rtl: false, dialects: [] },
  { code: 'tr',   name: 'Turkish',             endonym: 'Türkçe',        rtl: false, dialects: [] },
  { code: 'uk',   name: 'Ukrainian',           endonym: 'Українська',    rtl: false, dialects: [] },
  { code: 'ur',   name: 'Urdu',                endonym: 'اردو',          rtl: true,  dialects: [] },
  { code: 'ug',   name: 'Uyghur',              endonym: 'ئۇيغۇرچە',      rtl: true,  dialects: [] },
  { code: 'uz',   name: 'Uzbek',               endonym: 'Oʻzbekcha',     rtl: false, dialects: [] },
  { code: 've',   name: 'Venda',               endonym: 'Tshivenḓa',     rtl: false, dialects: [] },
  { code: 'vi',   name: 'Vietnamese',          endonym: 'Tiếng Việt',    rtl: false, dialects: [] },
  { code: 'war',  name: 'Waray',               endonym: 'Waray',         rtl: false, dialects: [] },
  { code: 'cy',   name: 'Welsh',               endonym: 'Cymraeg',       rtl: false, dialects: [] },
  { code: 'wo',   name: 'Wolof',               endonym: 'Wolof',         rtl: false, dialects: [] },
  { code: 'yo',   name: 'Yoruba',              endonym: 'Yorùbá',        rtl: false, dialects: [] },
  { code: 'zu',   name: 'Zulu',                endonym: 'isiZulu',       rtl: false, dialects: [] },
];

const BY_CODE = new Map<string, DubbingLanguage>();
for (const lang of DUBBING_LANGUAGES) {
  BY_CODE.set(lang.code, lang);
  for (const dialect of lang.dialects) BY_CODE.set(dialect, lang);
}

/**
 * The order the language picker offers by default.
 *
 * WHY AN ORDER EXISTS AT ALL: the list is 94 long and was rendered alphabetically by English name,
 * which put Spanish seventy-six rows below Afrikaans. Alphabetical is not neutral — it is an
 * ordering by an accident of English spelling, and on a list this long it means every creator
 * scrolls past eighty languages to reach one of the six they actually wanted.
 *
 * WHAT THE ORDER IS: rough global demand for dubbed video — speaker population weighted toward the
 * languages online course catalogues are actually translated into. It is a heuristic and it is
 * meant to be one; it decides what appears first, never what is possible, and the search box and
 * the A–Z sort are both one interaction away.
 *
 * Anything not listed here keeps its position in `DUBBING_LANGUAGES`, which is alphabetical by
 * English name — so the tail is still ordered, just ordered second.
 */
export const POPULAR_DUBBING_LANGUAGES: readonly string[] = [
  'en', 'es', 'pt', 'fr', 'de', 'hi', 'ar', 'zh', 'ja', 'ko',
  'it', 'ru', 'id', 'tr', 'vi', 'pl', 'nl', 'th', 'he', 'sv',
  'uk', 'fa', 'ms', 'ta', 'ro', 'cs', 'el', 'hu', 'da', 'fi',
  'no', 'bg', 'fil', 'sw', 'ur', 'te', 'mr', 'yue', 'sk',
];

const POPULARITY = new Map(POPULAR_DUBBING_LANGUAGES.map((code, i) => [code, i]));

/**
 * A sort key for the default ordering: lower is offered sooner.
 *
 * Unlisted languages get a rank past the end of the popular list, offset by their position in
 * `DUBBING_LANGUAGES`, so the tail stays alphabetical instead of collapsing into one tie the
 * client would break arbitrarily.
 */
export function dubbingLanguageRank(code: string): number {
  const popular = POPULARITY.get(code);
  if (popular !== undefined) return popular;
  const alphabetical = DUBBING_LANGUAGES.findIndex((l) => l.code === code);
  return POPULAR_DUBBING_LANGUAGES.length + (alphabetical < 0 ? DUBBING_LANGUAGES.length : alphabetical);
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
