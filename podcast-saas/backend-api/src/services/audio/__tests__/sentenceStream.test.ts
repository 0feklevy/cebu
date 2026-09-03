/**
 * Sentences out of tokens: boundaries at . ! ? … and newlines, never inside "e.g." or "3.5",
 * short fragments wait for the next boundary, and a run with no punctuation is cut anyway.
 */
import { describe, it, expect } from 'vitest';
import { SentenceSplitter, splitSentences } from '../sentenceStream.js';

describe('SentenceSplitter', () => {
  it('emits a sentence only once something follows its boundary, and the rest on flush', () => {
    const s = new SentenceSplitter({ minChars: 8 });
    expect(s.push('The sky is blue because')).toEqual([]);
    expect(s.push(' shorter light scatters more.')).toEqual([]);            // boundary at the very end: wait
    expect(s.push(' Red passes')).toEqual(['The sky is blue because shorter light scatters more.']);
    expect(s.push(' straight through')).toEqual([]);
    expect(s.flush()).toEqual(['Red passes straight through']);
    expect(s.flush()).toEqual([]);
  });

  it('does not cut inside e.g., i.e., or a decimal number', () => {
    expect(splitSentences('Use a small value, e.g. 0.5 metres. Then stop.', { minChars: 4 })).toEqual([
      'Use a small value, e.g. 0.5 metres.', 'Then stop.',
    ]);
  });

  it('a fragment shorter than minChars waits for the next boundary', () => {
    expect(splitSentences('Yes. It does, because the entry outranks the crate. Fine.', { minChars: 10 })).toEqual([
      'Yes. It does, because the entry outranks the crate.', 'Fine.',
    ]);
  });

  it('a newline is a boundary on its own', () => {
    expect(splitSentences('First line of the answer\nSecond line here', { minChars: 4 })).toEqual(['First line of the answer', 'Second line here']);
  });

  it('a long run with no punctuation is cut at a space near maxChars', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const out = splitSentences(words, { minChars: 10, maxChars: 120 });
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((s) => s.length <= 120)).toBe(true);
    expect(out.join(' ')).toBe(words);
  });

  it('exclamation, question and ellipsis boundaries — and a lowercase continuation is not one', () => {
    expect(splitSentences('Really? Yes! Well… maybe not. Okay', { minChars: 4 })).toEqual(['Really?', 'Yes!', 'Well… maybe not.', 'Okay']);
    // With a larger minimum, the short ones ride along with the next.
    expect(splitSentences('Really? Yes! Well… maybe not. Okay', { minChars: 12 })).toEqual(['Really? Yes!', 'Well… maybe not.', 'Okay']);
    // The mark is inside the phrase: no seam there.
    expect(splitSentences('It scatters! blue light most of all. Done', { minChars: 4 })).toEqual(['It scatters! blue light most of all.', 'Done']);
  });
});
