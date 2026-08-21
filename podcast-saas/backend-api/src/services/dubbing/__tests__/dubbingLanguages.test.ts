/**
 * The language table, and the two invariants that cost money or break URLs when they slip.
 */
import { describe, expect, it } from 'vitest';
import {
  DUBBING_LANGUAGES, dubbingLanguageRank, findDubbingLanguage, isSupportedDubbingLanguage,
  normalizeDubbingLanguage, POPULAR_DUBBING_LANGUAGES, vendorTargetLanguage,
} from '../languages.js';
import { PERMALINK_LANGUAGE_SUFFIXES, RESERVED_SLUGS } from '../../permalinkService.js';

describe('the table itself', () => {
  it('ships the vendor set rather than a token three', () => {
    expect(DUBBING_LANGUAGES.length).toBeGreaterThan(80);
  });

  it('has no duplicate codes — a duplicate would silently shadow a language', () => {
    const codes = DUBBING_LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('gives every language a name, an endonym and a direction', () => {
    for (const l of DUBBING_LANGUAGES) {
      expect(l.name.trim()).not.toBe('');
      expect(l.endonym.trim()).not.toBe('');
      expect(typeof l.rtl).toBe('boolean');
    }
  });

  it('marks the right-to-left scripts, because a caption overlay renders them backwards otherwise', () => {
    for (const code of ['ar', 'he', 'fa', 'ur']) {
      expect(findDubbingLanguage(code)?.rtl, code).toBe(true);
    }
    for (const code of ['en', 'es', 'ja']) {
      expect(findDubbingLanguage(code)?.rtl, code).toBe(false);
    }
  });
});

describe('the default ordering', () => {
  it('only names languages the product actually offers', () => {
    // Not a formality. A code here that is not in the table ranks a row that can never appear,
    // and reads as support for a language this product does not have — 'bn' was exactly that.
    for (const code of POPULAR_DUBBING_LANGUAGES) {
      expect(isSupportedDubbingLanguage(code), code).toBe(true);
    }
  });

  it('has no duplicates, which would make one language outrank itself', () => {
    expect(new Set(POPULAR_DUBBING_LANGUAGES).size).toBe(POPULAR_DUBBING_LANGUAGES.length);
  });

  it('ranks every language uniquely, so the list has one stable order and not a set of ties', () => {
    const ranks = DUBBING_LANGUAGES.map((l) => dubbingLanguageRank(l.code));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('puts the languages people actually dub into ahead of an accident of English spelling', () => {
    // The defect this exists to fix: alphabetical by English NAME put Spanish 76 rows below
    // Afrikaans, in a list of ninety-four.
    expect(dubbingLanguageRank('es')).toBeLessThan(dubbingLanguageRank('af'));
    expect(dubbingLanguageRank('en')).toBeLessThan(dubbingLanguageRank('ak'));
    expect(dubbingLanguageRank('he')).toBeLessThan(dubbingLanguageRank('as'));
  });

  it('keeps the unranked tail alphabetical rather than collapsing it into one tie', () => {
    const tail = DUBBING_LANGUAGES
      .filter((l) => !POPULAR_DUBBING_LANGUAGES.includes(l.code))
      .map((l) => l.code);
    for (let i = 1; i < tail.length; i += 1) {
      expect(dubbingLanguageRank(tail[i]!)).toBeGreaterThan(dubbingLanguageRank(tail[i - 1]!));
    }
  });
});

describe('codes as URL segments', () => {
  it('every code is a legal path segment', () => {
    for (const l of DUBBING_LANGUAGES) expect(l.code).toMatch(/^[a-z]{2,3}$/);
  });

  it('no code collides with a page that lives at the same depth', () => {
    // `/{slug}/{lang}` and `/{slug}/library` are the same shape. A language code equal to a page
    // name would make one of them unreachable, and which one would depend on route ordering.
    const pages = ['library', 'simulation', 'simulations', 'images', 'videos', 'sounds', 'audio', 'og', 'embed'];
    for (const l of DUBBING_LANGUAGES) expect(pages).not.toContain(l.code);
  });

  it('MAY collide with a reserved top-level slug, because they live at different depths', () => {
    // Polish is `pl` and `/pl` is the playlist route. That is fine and deliberate: a language code
    // is only ever a SECOND segment, so `/{slug}/pl` and `/pl` can never be the same URL. Asserting
    // the opposite would be asserting an invariant this system does not have — and would force
    // Polish out of the product to protect a collision that cannot occur.
    expect(RESERVED_SLUGS.has('pl')).toBe(true);
    expect(DUBBING_LANGUAGES.some((l) => l.code === 'pl')).toBe(true);
  });

  it('the permalink suffix set is DERIVED from the table, not a second copy of it', () => {
    // Two hand-maintained lists of the same thing is the drift that bit the migration registries.
    expect(PERMALINK_LANGUAGE_SUFFIXES.size).toBe(DUBBING_LANGUAGES.length);
    for (const l of DUBBING_LANGUAGES) expect(PERMALINK_LANGUAGE_SUFFIXES.has(l.code)).toBe(true);
  });
});

describe('what reaches the vendor', () => {
  it('accepts a listed dialect and passes it through — it selects the accent', () => {
    expect(isSupportedDubbingLanguage('es-MX')).toBe(true);
    expect(vendorTargetLanguage('es-MX')).toBe('es-MX');
  });

  it('collapses a dialect to its base for the product axis — /es is one page', () => {
    expect(normalizeDubbingLanguage('es-MX')).toBe('es');
    expect(normalizeDubbingLanguage('en-GB')).toBe('en');
  });

  it('refuses an unlisted region subtag instead of silently falling back', () => {
    // The vendor errors on these; better to refuse before any money is committed.
    expect(isSupportedDubbingLanguage('es-419')).toBe(false);
    expect(vendorTargetLanguage('es-419')).toBeNull();
  });

  it('refuses he-IL — Hebrew has no dialects and the tag will not match', () => {
    expect(isSupportedDubbingLanguage('he-IL')).toBe(false);
  });

  it('refuses a language the product does not offer', () => {
    expect(vendorTargetLanguage('xx')).toBeNull();
    expect(normalizeDubbingLanguage('klingon')).toBeNull();
  });
});
