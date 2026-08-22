import { describe, it, expect } from 'vitest';
import { sanitizeDbText, MAX_DB_TEXT } from '../sanitizeDbText.js';

const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const DEL = String.fromCharCode(127);

describe('sanitizeDbText', () => {
  it('removes the NUL byte Postgres cannot store at all', () => {
    expect(sanitizeDbText(`boom ${NUL} happened`)).toBe('boom  happened');
    expect(sanitizeDbText(NUL)).toBe('');
  });

  it('keeps tab, newline and carriage return, because a stack trace is the point', () => {
    const trace = 'Error: nope\n    at run (a.ts:1:1)\r\n\tat main (b.ts:2:2)';
    expect(sanitizeDbText(trace)).toBe(trace);
  });

  it('strips the other C0 controls and DEL', () => {
    expect(sanitizeDbText(`a${BEL}b${DEL}c`)).toBe('abc');
  });

  it('leaves ordinary text — including non-Latin scripts and emoji — untouched', () => {
    for (const text of ['plain', 'שלום עולם', '你好', 'ok 🎉', 'café']) {
      expect(sanitizeDbText(text)).toBe(text);
    }
  });

  it('caps runaway payloads and SAYS it truncated rather than ending mid-sentence', () => {
    const out = sanitizeDbText('x'.repeat(MAX_DB_TEXT + 500));
    expect(out.length).toBeLessThan(MAX_DB_TEXT + 40);
    expect(out.endsWith('… [truncated]')).toBe(true);
  });

  it('does not append the truncation marker to text that fits exactly', () => {
    const exact = 'y'.repeat(MAX_DB_TEXT);
    expect(sanitizeDbText(exact)).toBe(exact);
  });

  it('counts length AFTER stripping, so control characters cannot force a false truncation', () => {
    const padded = NUL.repeat(1000) + 'z'.repeat(MAX_DB_TEXT);
    expect(sanitizeDbText(padded).endsWith('[truncated]')).toBe(false);
  });
});
