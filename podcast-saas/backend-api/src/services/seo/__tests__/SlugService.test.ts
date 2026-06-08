import { describe, it, expect } from 'vitest';
import { slugify, makeSlugBase, dedupeSlug, allocateSlug, transliterate, normalizeAuthorSlug } from '../SlugService.js';

// Mirrors the DB CHECK constraint / shared SlugSchema (kept local so the test
// has no cross-package resolution dependency).
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('slugify', () => {
  it('kebab-cases and lowercases', () => {
    expect(slugify('Quantum Mechanics 101')).toBe('quantum-mechanics-101');
  });
  it('strips accents and punctuation', () => {
    expect(slugify('Café & Crème: Brûlée!')).toBe('cafe-creme-brulee');
  });
  it('collapses separators and trims hyphens', () => {
    expect(slugify('  --Hello___World--  ')).toBe('hello-world');
  });
  it('returns empty string when nothing is slug-able', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify(null)).toBe('');
  });
  it('always produces a value matching the DB slug constraint', () => {
    for (const s of ['Hello World', 'A/B Testing 2.0', 'naïve—approach']) {
      expect(slugify(s)).toMatch(SLUG_PATTERN);
    }
  });
});

describe('transliteration (Hebrew → Latin)', () => {
  it('deterministically transliterates Hebrew titles to readable ASCII slugs', () => {
    // שלום עולם ("hello world"), vowelless transliteration is stable.
    expect(slugify('שלום עולם')).toBe('shlvm-vlm');
    expect(slugify('מבוא לפיזיקה')).toBe('mbv-lpyzykh');
  });
  it('strips niqqud (vowel points) before mapping', () => {
    expect(slugify('שָׁלוֹם')).toBe(slugify('שלום'));
  });
  it('handles mixed Hebrew + Latin + digits', () => {
    expect(slugify('ABC שלום 123')).toBe('abc-shlvm-123');
  });
  it('is idempotent and always matches the slug constraint', () => {
    for (const s of ['שלום עולם', 'מבוא לפיזיקה', 'תורת היחסות']) {
      const once = slugify(s);
      expect(once).toMatch(SLUG_PATTERN);
      expect(slugify(once)).toBe(once);
    }
  });
  it('transliterate() passes Latin text through unchanged', () => {
    expect(transliterate('Hello World')).toBe('Hello World');
  });
});

describe('makeSlugBase', () => {
  it('uses the title when available', () => {
    expect(makeSlugBase('My Course', 'seed-id')).toBe('my-course');
  });
  it('transliterates a Hebrew title rather than falling back to an id', () => {
    expect(makeSlugBase('שלום', 'abcdef12-3456', 'c')).toBe('shlvm');
  });
  it('prefers an author-entered slug over the title', () => {
    expect(makeSlugBase('שלום', 'seed', 'c', 'My Custom Slug')).toBe('my-custom-slug');
  });
  it('falls back to an id-derived token only when nothing else is usable', () => {
    const slug = makeSlugBase('!!!', 'abcdef12-3456', 'c');
    expect(slug).toBe('c-abcdef12');
    expect(slug).toMatch(SLUG_PATTERN);
    expect(slug).not.toContain('untitled');
  });
});

describe('normalizeAuthorSlug', () => {
  it('normalises a messy or non-Latin author slug to a valid token', () => {
    expect(normalizeAuthorSlug('  My Cool Course!! ')).toBe('my-cool-course');
    expect(normalizeAuthorSlug('שלום')).toBe('shlvm');
    expect(normalizeAuthorSlug('!!!')).toBe('');
  });
});

describe('dedupeSlug', () => {
  it('returns the base when free', () => {
    expect(dedupeSlug('intro', new Set())).toEqual({ slug: 'intro', collided: false });
  });
  it('suffixes deterministically on collision', () => {
    expect(dedupeSlug('intro', new Set(['intro']))).toEqual({ slug: 'intro-2', collided: true });
    expect(dedupeSlug('intro', new Set(['intro', 'intro-2']))).toEqual({ slug: 'intro-3', collided: true });
  });
});

describe('allocateSlug', () => {
  it('accumulates uniqueness across calls and mutates the taken set', () => {
    const taken = new Set<string>();
    expect(allocateSlug('Same', 's1', taken).slug).toBe('same');
    expect(allocateSlug('Same', 's2', taken).slug).toBe('same-2');
    expect(allocateSlug('Same', 's3', taken).slug).toBe('same-3');
    expect(taken).toEqual(new Set(['same', 'same-2', 'same-3']));
  });
});
