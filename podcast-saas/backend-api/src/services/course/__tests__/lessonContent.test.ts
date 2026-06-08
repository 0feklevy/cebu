import { describe, it, expect } from 'vitest';
import { scriptBodyToText, assessLessonReadiness } from '../LessonContentService.js';
import { jsonbStringArray } from '../../../db/jsonb.js';

describe('scriptBodyToText', () => {
  it('extracts spoken text from nested turns/segments', () => {
    const body = { turns: [{ text: 'Hello there.' }, { line: 'Second line.' }, { utterance: 'Third.' }] };
    expect(scriptBodyToText(body)).toBe('Hello there. Second line. Third.');
  });
  it('handles arrays and nested children', () => {
    const body = [{ segments: [{ content: 'A' }, { content: 'B' }] }, { text: 'C' }];
    expect(scriptBodyToText(body)).toBe('A B C');
  });
  it('returns empty string for null/empty', () => {
    expect(scriptBodyToText(null)).toBe('');
    expect(scriptBodyToText({})).toBe('');
  });
});

describe('assessLessonReadiness — SEO thin-page flag', () => {
  const long = 'x'.repeat(200);
  it('ok when a real transcript exists', () => {
    expect(assessLessonReadiness({ transcript: long, summary: null }).ok).toBe(true);
  });
  it('ok when a substantive summary exists', () => {
    expect(assessLessonReadiness({ transcript: null, summary: 'A clear, sufficiently long lesson summary describing the content.' }).ok).toBe(true);
  });
  it('FLAGS thin lessons: no transcript and no/short summary', () => {
    expect(assessLessonReadiness({ transcript: null, summary: null }).ok).toBe(false);
    expect(assessLessonReadiness({ transcript: 'too short', summary: 'short' }).ok).toBe(false);
  });
});

describe('jsonbStringArray', () => {
  it('returns a SQL fragment for values and an empty-array literal otherwise', () => {
    // We assert it produces a SQL object (not a raw JS array, which postgres-js
    // would double-encode into a jsonb string).
    const withVals = jsonbStringArray(['a', 'b']);
    const empty = jsonbStringArray([]);
    expect(withVals).toHaveProperty('queryChunks');
    expect(empty).toHaveProperty('queryChunks');
    expect(Array.isArray(withVals)).toBe(false);
  });
});
