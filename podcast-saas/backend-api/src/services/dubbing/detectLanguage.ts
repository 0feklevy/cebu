/**
 * Offline language identification for the SOURCE of a video — no vendor call, no model, no tokens.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────────────────────
 * Migration 068 gave a project a `source_language` and the dubbing routes refuse to dub a video
 * into the language it is already in. Both were correct and both were useless, because nothing
 * ever WROTE that column: it is null for every project that exists, so the refusal never fires and
 * an English video is offered "English" as a target. This module is the missing half.
 *
 * ── Why it is written here rather than installed ──────────────────────────────────────────────
 * The input is not arbitrary prose. It is a WebVTT transcript this product already produced and
 * already stores — typically thousands of words of clean, punctuated speech in ONE language. That
 * is the easiest input language identification has, and it is answered to high accuracy by two
 * signals that need no model at all: which script the letters are in, and how often the language's
 * function words appear. A dependency would buy accuracy on the hard cases (a tweet, a mixed-script
 * fragment) that this input never presents, at the cost of a package in the audit surface of a
 * repository that keeps one deliberately small.
 *
 * ── The rule that matters most ────────────────────────────────────────────────────────────────
 * A WRONG ANSWER COSTS MORE THAN NO ANSWER. A false positive silently removes a language the
 * creator wanted and gives them no way to understand why; a null merely asks them to pick. So
 * every path here either clears `CONFIDENT` — the threshold at which the product will act on the
 * guess by itself — or returns a number below it and lets a human decide. Ambiguity is reported,
 * never resolved by coin-flip.
 */

/** The confidence at or above which the product acts on a guess without asking anyone. */
export const CONFIDENT = 0.8;

export interface LanguageGuess {
  /** A base language code from `DUBBING_LANGUAGES` — never a dialect. */
  code: string;
  /** 0–1. Only `>= CONFIDENT` may be acted on unattended. */
  confidence: number;
  /** How the guess was reached, for logs and for the UI's explanation. */
  basis: 'script' | 'stopwords';
}

/**
 * Strip WebVTT down to the words that were spoken.
 *
 * Everything removed here would otherwise poison the count: cue timestamps are digits and arrows,
 * `NOTE` blocks are English regardless of the speech, and voice tags (`<v Ofek>`) are names. A
 * Hebrew transcript whose header and cue numbering survived would still be mostly Hebrew — but an
 * eight-second clip's would not, and short transcripts are exactly where the margin is thin.
 */
export function captionsToPlainText(vtt: string | null | undefined): string {
  if (!vtt) return '';
  const out: string[] = [];
  let inNote = false;
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') { inNote = false; continue; }
    if (inNote) continue;
    if (/^NOTE\b/.test(line)) { inNote = true; continue; }
    if (/^(WEBVTT|STYLE|REGION)\b/.test(line)) { inNote = true; continue; }
    if (line.includes('-->')) continue;
    // A bare cue identifier: a number, or a token with no spaces on the line before a timestamp.
    if (/^\d+$/.test(line)) continue;
    out.push(
      line
        .replace(/<[^>]*>/g, ' ')      // <v Speaker>, <i>, <00:00:01.000>
        .replace(/^-\s+/, ' ')          // the dash convention for a second speaker
        .replace(/&[a-z]+;/gi, ' '),
    );
  }
  return out.join(' ');
}

// ── Scripts ───────────────────────────────────────────────────────────────────────────────────
//
// A script is a far stronger signal than any word list: Hebrew text is Hebrew, and no amount of
// vocabulary overlap can make it Spanish. Where a script is shared by several languages this
// product offers, the script narrows the field and the stopwords below decide between them.

interface ScriptRange {
  /** Codes this script can mean, in the order to fall back through. */
  readonly candidates: readonly string[];
  readonly test: RegExp;
}

const SCRIPTS: readonly ScriptRange[] = [
  { candidates: ['he'],                          test: /[\u0590-\u05ff]/ },
  { candidates: ['ar', 'fa', 'ur', 'ug', 'sd'],  test: /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff]/ },
  { candidates: ['ru', 'uk', 'bg', 'mk', 'be', 'kk', 'ky', 'tg', 'mn'], test: /[\u0400-\u04ff]/ },
  { candidates: ['el'],                          test: /[\u0370-\u03ff\u1f00-\u1fff]/ },
  { candidates: ['hi', 'mr', 'ne'],              test: /[\u0900-\u097f]/ },
  { candidates: ['as'],                          test: /[\u0980-\u09ff]/ },
  { candidates: ['pa'],                          test: /[\u0a00-\u0a7f]/ },
  { candidates: ['gu'],                          test: /[\u0a80-\u0aff]/ },
  { candidates: ['ta'],                          test: /[\u0b80-\u0bff]/ },
  { candidates: ['te'],                          test: /[\u0c00-\u0c7f]/ },
  { candidates: ['kn'],                          test: /[\u0c80-\u0cff]/ },
  { candidates: ['ml'],                          test: /[\u0d00-\u0d7f]/ },
  { candidates: ['th'],                          test: /[\u0e00-\u0e7f]/ },
  { candidates: ['my'],                          test: /[\u1000-\u109f]/ },
  { candidates: ['ka'],                          test: /[\u10a0-\u10ff\u1c90-\u1cbf]/ },
  { candidates: ['hy'],                          test: /[\u0530-\u058f]/ },
  { candidates: ['am'],                          test: /[\u1200-\u137f]/ },
  { candidates: ['bo'],                          test: /[\u0f00-\u0fff]/ },
  { candidates: ['ko'],                          test: /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/ },
  { candidates: ['ja'],                          test: /[\u3040-\u309f\u30a0-\u30ff]/ },
  { candidates: ['zh', 'yue', 'cmn'],            test: /[\u4e00-\u9fff\u3400-\u4dbf]/ },
];

const LATIN = /[A-Za-z\u00c0-\u024f]/;

/**
 * Scripts whose candidate list has exactly one member are decided outright.
 *
 * The confidence is not 1.0 because a transcript is a transcript, not a proof — a bilingual
 * lesson exists — but it is comfortably above `CONFIDENT`, which is the honest reading of "these
 * characters can only be this language among the ones we offer".
 */
const UNAMBIGUOUS_SCRIPT_CONFIDENCE = 0.97;

/** A shared script narrowed by stopwords: strong, but one rung down from an exclusive script. */
const NARROWED_SCRIPT_CONFIDENCE = 0.9;

/**
 * A shared script with NO stopword agreement — Cyrillic that matches neither Russian nor Ukrainian
 * nor Bulgarian. Deliberately BELOW `CONFIDENT`: the script is certain, the language is not, and
 * guessing "Russian because it is the biggest" is exactly the silent wrong answer this module
 * exists to avoid.
 */
const AMBIGUOUS_SCRIPT_CONFIDENCE = 0.55;

// ── Stopword profiles ─────────────────────────────────────────────────────────────────────────
//
// High-frequency function words: articles, pronouns, prepositions, auxiliaries. They are what a
// language uses constantly and a related language uses differently, which is why they separate
// Spanish from Portuguese where content words do not. Each list is short on purpose — adding rare
// words adds noise, not signal, because the score is a RATE over the transcript's tokens.
//
// Words shared by two profiles are kept where they are genuinely frequent in both: the winner is
// decided by margin over the whole list, so an overlap costs both candidates equally.

const STOPWORDS: Readonly<Record<string, readonly string[]>> = {
  en: ['the', 'and', 'that', 'you', 'this', 'with', 'for', 'have', 'not', 'are', 'but', 'what', 'they', 'from', 'was', 'can', 'about', 'just', 'were', 'which', 'would', 'there'],
  es: ['que', 'de', 'la', 'el', 'en', 'los', 'las', 'una', 'por', 'con', 'para', 'como', 'pero', 'esto', 'esta', 'muy', 'todo', 'porque', 'cuando', 'hay'],
  pt: ['que', 'de', 'nao', 'uma', 'para', 'com', 'como', 'mas', 'isso', 'esta', 'muito', 'voce', 'entao', 'ele', 'ela', 'porque', 'quando', 'tem', 'ser', 'pelo'],
  fr: ['les', 'des', 'que', 'est', 'une', 'dans', 'pour', 'pas', 'qui', 'sur', 'avec', 'plus', 'nous', 'vous', 'cette', 'mais', 'tout', 'comme', 'sont', 'aussi'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'zu', 'mit', 'auf', 'fur', 'sich', 'auch', 'aber', 'wir', 'dass', 'wenn', 'wie', 'sind'],
  it: ['che', 'di', 'il', 'la', 'per', 'con', 'una', 'non', 'sono', 'come', 'questo', 'questa', 'anche', 'piu', 'nel', 'della', 'perche', 'quando', 'gli', 'ma'],
  nl: ['de', 'het', 'een', 'van', 'dat', 'niet', 'en', 'is', 'op', 'voor', 'met', 'zijn', 'maar', 'ook', 'aan', 'dan', 'wat', 'als', 'deze', 'kan'],
  pl: ['nie', 'sie', 'jest', 'ale', 'tak', 'jak', 'tego', 'przez', 'oraz', 'czy', 'tym', 'ktore', 'bardzo', 'wiec', 'juz', 'moze', 'ktory', 'jeszcze'],
  tr: ['bir', 'bu', 've', 'icin', 'daha', 'ile', 'olarak', 'gibi', 'ama', 'çok', 'ne', 'var', 'kadar', 'sonra', 'yani', 'hem', 'ise', 'ancak'],
  id: ['yang', 'dan', 'di', 'ini', 'itu', 'untuk', 'dengan', 'tidak', 'dari', 'ada', 'kita', 'saya', 'akan', 'bisa', 'juga', 'pada', 'sudah', 'karena'],
  ms: ['yang', 'dan', 'ini', 'itu', 'untuk', 'dengan', 'tidak', 'dari', 'ada', 'kita', 'saya', 'akan', 'boleh', 'juga', 'pada', 'sudah', 'kerana', 'adalah'],
  vi: ['va', 'la', 'cua', 'co', 'khong', 'nhung', 'duoc', 'trong', 'nay', 'cho', 'mot', 'nguoi', 'ban', 'the', 'voi', 'den', 'thi', 'cung'],
  sv: ['och', 'att', 'det', 'som', 'har', 'inte', 'med', 'for', 'den', 'pa', 'av', 'men', 'vi', 'kan', 'ar', 'om', 'sa', 'till'],
  da: ['og', 'at', 'det', 'som', 'har', 'ikke', 'med', 'for', 'den', 'pa', 'af', 'men', 'vi', 'kan', 'er', 'om', 'sa', 'til'],
  no: ['og', 'at', 'det', 'som', 'har', 'ikke', 'med', 'for', 'den', 'pa', 'av', 'men', 'vi', 'kan', 'er', 'om', 'til', 'jeg'],
  fi: ['ja', 'on', 'ei', 'etta', 'se', 'ovat', 'mutta', 'niin', 'kun', 'voi', 'myos', 'sitten', 'tama', 'ollut', 'joka', 'kuin'],
  cs: ['a', 'je', 'na', 'se', 'to', 'ze', 'ale', 'jak', 'tak', 'nebo', 'jsem', 'jsou', 'pro', 'kdyz', 'take', 'byl', 'muze'],
  sk: ['a', 'je', 'na', 'sa', 'to', 'ze', 'ale', 'ako', 'tak', 'alebo', 'som', 'su', 'pre', 'ked', 'tiez', 'bol', 'moze'],
  ro: ['si', 'de', 'la', 'in', 'un', 'este', 'nu', 'cu', 'pentru', 'care', 'sa', 'mai', 'dar', 'ca', 'din', 'lui', 'foarte'],
  hu: ['a', 'az', 'es', 'hogy', 'nem', 'egy', 'is', 'de', 'meg', 'csak', 'ez', 'mint', 'volt', 'ha', 'vagy', 'ami', 'ezt'],
  hr: ['i', 'je', 'se', 'na', 'da', 'su', 'za', 'sto', 'ali', 'kao', 'ovo', 'ili', 'kada', 'vrlo', 'nije', 'moze'],
  bs: ['i', 'je', 'se', 'na', 'da', 'su', 'za', 'sto', 'ali', 'kao', 'ovo', 'ili', 'kada', 'jako', 'nije', 'moze'],
  sl: ['in', 'je', 'se', 'na', 'da', 'za', 'ki', 'so', 'ali', 'kot', 'to', 'pa', 'lahko', 'ne', 'bi', 'kaj'],
  lt: ['ir', 'kad', 'yra', 'bet', 'kaip', 'tai', 'su', 'del', 'nes', 'jis', 'ji', 'buvo', 'gali', 'labai'],
  lv: ['un', 'ka', 'ir', 'bet', 'ka', 'to', 'ar', 'no', 'lai', 'vai', 'bija', 'var', 'loti', 'tas'],
  et: ['ja', 'on', 'ei', 'et', 'see', 'kui', 'aga', 'siis', 'ka', 'oli', 'saab', 'vaga', 'ning', 'mis'],
  ca: ['que', 'de', 'la', 'el', 'els', 'les', 'amb', 'per', 'una', 'com', 'aixo', 'aquesta', 'pero', 'molt', 'quan', 'tot'],
  gl: ['que', 'de', 'da', 'do', 'os', 'as', 'unha', 'para', 'con', 'como', 'isto', 'pero', 'moi', 'cando', 'todo', 'non'],
  af: ['die', 'en', 'van', 'is', 'nie', 'dat', 'met', 'wat', 'vir', 'ons', 'hulle', 'maar', 'ook', 'kan', 'om', 'te'],
  sw: ['na', 'ya', 'kwa', 'ni', 'wa', 'katika', 'hii', 'kama', 'lakini', 'hiyo', 'sasa', 'wale', 'kuwa', 'zaidi'],
  fil: ['ang', 'ng', 'sa', 'na', 'ay', 'mga', 'para', 'ito', 'hindi', 'may', 'kung', 'siya', 'natin', 'lang'],
  ceb: ['ang', 'sa', 'og', 'nga', 'kini', 'ni', 'ug', 'mga', 'kay', 'siya', 'dili', 'karon', 'para', 'unya'],
  eu: ['eta', 'da', 'ez', 'du', 'bat', 'hori', 'baina', 'dira', 'edo', 'oso', 'zen', 'baten', 'egin', 'dela'],
  is: ['og', 'ad', 'er', 'sem', 'ekki', 'thad', 'med', 'fyrir', 'en', 'thegar', 'hann', 'hun', 'their', 'var'],
  sq: ['dhe', 'per', 'nga', 'nje', 'eshte', 'ne', 'te', 'me', 'por', 'sepse', 'kur', 'shume', 'kete', 'ka'],
  cy: ['yn', 'ac', 'ar', 'gyda', 'mae', 'ond', 'wedi', 'hyn', 'fel', 'am', 'bod', 'nid', 'oedd', 'iawn'],
  // Non-Latin profiles: used ONLY to narrow a shared script, never to pick a script.
  ru: ['и', 'в', 'не', 'на', 'что', 'это', 'как', 'но', 'для', 'мы', 'вы', 'они', 'если', 'очень', 'уже', 'его'],
  uk: ['і', 'в', 'не', 'на', 'що', 'це', 'як', 'але', 'для', 'ми', 'ви', 'вони', 'якщо', 'дуже', 'вже', 'його', 'та', 'з'],
  bg: ['и', 'на', 'да', 'в', 'за', 'не', 'се', 'че', 'като', 'но', 'от', 'по', 'това', 'много', 'има'],
  mk: ['и', 'на', 'да', 'се', 'во', 'што', 'не', 'за', 'од', 'ова', 'но', 'како', 'многу', 'има'],
  be: ['і', 'у', 'на', 'не', 'што', 'гэта', 'як', 'але', 'для', 'мы', 'вы', 'яны', 'вельмі', 'ужо'],
  kk: ['және', 'бұл', 'үшін', 'бір', 'олар', 'емес', 'деп', 'бар', 'болып', 'сол', 'бірақ'],
  ky: ['жана', 'бул', 'үчүн', 'бир', 'алар', 'эмес', 'деп', 'бар', 'болуп', 'ошол', 'бирок'],
  mn: ['ба', 'энэ', 'байна', 'бол', 'тэр', 'гэж', 'бид', 'юм', 'болон', 'хийх'],
  tg: ['ва', 'дар', 'ин', 'аз', 'ба', 'бо', 'ки', 'аст', 'барои', 'ҳам', 'он'],
  ar: ['في', 'من', 'على', 'أن', 'إلى', 'هذا', 'التي', 'مع', 'عن', 'ما', 'لا', 'كان', 'هذه', 'كل'],
  fa: ['و', 'در', 'به', 'این', 'که', 'است', 'را', 'با', 'از', 'برای', 'می', 'ما', 'شما', 'آن'],
  ur: ['کے', 'کی', 'ہے', 'اور', 'میں', 'سے', 'کو', 'یہ', 'ہیں', 'کا', 'پر', 'نہیں', 'ہم', 'آپ'],
  ug: ['ۋە', 'بۇ', 'ئۈچۈن', 'بىلەن', 'ئەمما', 'بار', 'قىلىش', 'ئۇلار'],
  sd: ['۽', 'جي', 'آهي', '۾', 'کي', 'هن', 'لاءِ', 'جو', 'آهن'],
  hi: ['का', 'की', 'के', 'है', 'और', 'में', 'को', 'से', 'यह', 'हैं', 'नहीं', 'कि', 'पर', 'हम'],
  mr: ['आहे', 'आणि', 'च्या', 'ला', 'हे', 'मध्ये', 'नाही', 'तो', 'ती', 'आहेत', 'साठी', 'पण'],
  ne: ['छ', 'र', 'मा', 'को', 'गर्न', 'यो', 'हो', 'लाई', 'भने', 'छन्', 'तर', 'हामी'],
  zh: ['的', '是', '不', '了', '在', '我们', '这个', '可以', '因为', '所以', '就是', '什么'],
  yue: ['嘅', '係', '唔', '咗', '喺', '我哋', '呢個', '可以', '因為', '所以', '就係', '乜嘢'],
};

/**
 * Latin-script tokenisation with diacritics folded away.
 *
 * Folding is what lets one profile match both a properly accented transcript and the unaccented
 * one a hurried caption editor produces — `porque` and `porqué` are the same evidence. The profiles
 * above are therefore written unaccented, and this is the function that makes them comparable.
 */
function latinTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z\u00df-\u00ff]+/)
    .filter((t) => t.length > 0);
}

/** Tokens for a non-Latin script, where folding would destroy the letters themselves. */
function rawTokens(text: string): string[] {
  return text.toLowerCase().split(/[\s.,!?;:()"'،؟、。，]+/).filter(Boolean);
}

interface Scored { code: string; rate: number; }

/** Score every candidate profile as the share of the transcript's tokens it accounts for. */
function scoreProfiles(tokens: string[], candidates: readonly string[], fold: boolean): Scored[] {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  const total = tokens.length;
  return candidates
    .map((code) => {
      const words = STOPWORDS[code];
      if (!words) return { code, rate: 0 };
      let hits = 0;
      for (const w of words) {
        const key = fold ? w.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : w;
        hits += counts.get(key) ?? 0;
      }
      return { code, rate: total > 0 ? hits / total : 0 };
    })
    .sort((a, b) => b.rate - a.rate);
}

/**
 * Which profiles describe LATIN-script languages.
 *
 * Kept as an explicit set rather than inferred from the profile's own characters: the non-Latin
 * profiles exist only to narrow a script that has already been identified, and letting one of them
 * compete in the Latin round would let a transliterated word decide a language.
 */
const LATIN_PROFILES: ReadonlySet<string> = new Set([
  'en', 'es', 'pt', 'fr', 'de', 'it', 'nl', 'pl', 'tr', 'id', 'ms', 'vi', 'sv', 'da', 'no', 'fi',
  'cs', 'sk', 'ro', 'hu', 'hr', 'bs', 'sl', 'lt', 'lv', 'et', 'ca', 'gl', 'af', 'sw', 'fil', 'ceb',
  'eu', 'is', 'sq', 'cy',
]);

/**
 * The shortest transcript worth an opinion.
 *
 * Below this the stopword RATE is dominated by whichever few words the speaker happened to use,
 * and the margin test stops meaning anything. Sixty tokens is roughly twenty seconds of speech.
 */
const MIN_TOKENS = 60;

/** A profile must account for at least this share of tokens before it is believable at all. */
const MIN_RATE = 0.05;

/** …and must beat the runner-up by this factor, or the two are reported as indistinguishable. */
const MIN_MARGIN = 1.4;

/**
 * Identify the language of a block of transcript text.
 *
 * Returns null when there is not enough text to have an opinion — which is a different answer from
 * a low-confidence guess, and both are different from a wrong one.
 */
export function detectLanguage(text: string): LanguageGuess | null {
  const trimmed = (text ?? '').trim();
  if (trimmed.length < 20) return null;

  // 1. Which script is the text actually in? Counted over letters only, so punctuation, digits and
  //    the odd Latin brand name in an otherwise Hebrew transcript cannot swing it.
  let latinLetters = 0;
  const scriptHits = new Map<ScriptRange, number>();
  for (const ch of trimmed) {
    if (LATIN.test(ch)) { latinLetters += 1; continue; }
    for (const s of SCRIPTS) {
      if (s.test.test(ch)) { scriptHits.set(s, (scriptHits.get(s) ?? 0) + 1); break; }
    }
  }
  const totalLetters = latinLetters + [...scriptHits.values()].reduce((a, b) => a + b, 0);
  if (totalLetters === 0) return null;

  let dominant: ScriptRange | null = null;
  let dominantCount = 0;
  for (const [script, count] of scriptHits) {
    if (count > dominantCount) { dominant = script; dominantCount = count; }
  }

  // A non-Latin script only has to be the plurality, not the majority: a Hebrew lesson about
  // JavaScript is full of Latin identifiers and is still Hebrew.
  if (dominant && dominantCount >= latinLetters && dominantCount / totalLetters >= 0.2) {
    if (dominant.candidates.length === 1) {
      return { code: dominant.candidates[0]!, confidence: UNAMBIGUOUS_SCRIPT_CONFIDENCE, basis: 'script' };
    }
    // Japanese is decided by kana ALONE and never reaches here; Chinese text that contains no kana
    // falls through to its own profile below.
    const scored = scoreProfiles(rawTokens(trimmed), dominant.candidates, false);
    const [best, second] = scored;
    if (best && best.rate >= 0.01 && (!second || second.rate === 0 || best.rate >= second.rate * MIN_MARGIN)) {
      return { code: best.code, confidence: NARROWED_SCRIPT_CONFIDENCE, basis: 'stopwords' };
    }
    // The script is certain and the language is not. Report the biggest candidate BELOW the acting
    // threshold, so the UI can prefill a sensible default that a human still has to confirm.
    return { code: dominant.candidates[0]!, confidence: AMBIGUOUS_SCRIPT_CONFIDENCE, basis: 'script' };
  }

  // 2. Latin script: the profiles do all the work.
  const tokens = latinTokens(trimmed);
  if (tokens.length < MIN_TOKENS) return null;

    const scored = scoreProfiles(tokens, [...LATIN_PROFILES], true);
  const [best, second] = scored;
  if (!best || best.rate < MIN_RATE) return null;
  if (second && second.rate > 0 && best.rate < second.rate * MIN_MARGIN) {
    // Two profiles fit equally well — Spanish and Galician on a short clip, say. Saying so is the
    // correct answer; picking one is the failure mode this module was written to prevent.
    return { code: best.code, confidence: Math.min(0.7, best.rate * 4), basis: 'stopwords' };
  }
  // A clean win. The confidence rises with how much of the transcript the profile explains and is
  // capped below certainty, because a stopword rate is evidence and not proof.
  const confidence = Math.min(0.95, 0.6 + (best.rate - MIN_RATE) * 3);
  return { code: best.code, confidence, basis: 'stopwords' };
}
