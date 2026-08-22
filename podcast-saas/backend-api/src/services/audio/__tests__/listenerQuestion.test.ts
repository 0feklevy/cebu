/**
 * P3-B / A2.4 — Raise Your Hand, the rules that decide what a listener costs.
 *
 * The asking surface is public and the project owner pays for every answer, so this file is really
 * about one question: can an anonymous stranger spend someone else's money here? Every refusal
 * below is a way they could, and every allowance is a way the feature stays usable for the person
 * it was built for — who is driving, and cannot look at the screen.
 */
import { describe, it, expect } from 'vitest';
import {
  contextAround,
  decideSpend,
  fallbackIntent,
  MAX_CONTEXT_CHARS,
  MAX_QUESTION_CHARS,
  parseVtt,
  type Cue,
} from '../listenerQuestion.js';

const cue = (startMs: number, endMs: number, text: string): Cue => ({ startMs, endMs, text });

describe('reading a caption file that came from anywhere', () => {
  it('parses the plain shape', () => {
    expect(parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello there.\n')).toEqual([
      { startMs: 1000, endMs: 3000, text: 'Hello there.' },
    ]);
  });

  it('tolerates cue identifiers, NOTE blocks, settings and CRLF', () => {
    // A parser that accepts only the shape WE write fails on the first file from anywhere else —
    // and fails by producing an EMPTY transcript, so the answer is confidently ungrounded rather
    // than an error anyone sees.
    const vtt = [
      'WEBVTT - from a tool',
      '',
      'NOTE this is a comment',
      '',
      'cue-1',
      '00:00:01.000 --> 00:00:03.000 line:0 position:50%',
      'First line.',
      'Continued.',
      '',
      '00:00:04,500 --> 00:00:06,000',
      'Comma separator.',
      '',
    ].join('\r\n');
    expect(parseVtt(vtt)).toEqual([
      { startMs: 1000, endMs: 3000, text: 'First line. Continued.' },
      { startMs: 4500, endMs: 6000, text: 'Comma separator.' },
    ]);
  });

  it('skips a cue with no text rather than storing an empty one', () => {
    // An empty cue takes a slot in the context window and contributes nothing to the answer.
    expect(parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n00:00:03.000 --> 00:00:04.000\nReal.\n'))
      .toEqual([{ startMs: 3000, endMs: 4000, text: 'Real.' }]);
  });

  it('returns nothing for an empty or garbage file', () => {
    expect(parseVtt('')).toEqual([]);
    expect(parseVtt('not a caption file at all')).toEqual([]);
  });

  it('handles hours', () => {
    expect(parseVtt('WEBVTT\n\n01:02:03.400 --> 01:02:05.000\nLate.\n')[0].startMs).toBe(3_723_400);
  });
});

describe('the transcript a question is answered from', () => {
  const lesson = Array.from({ length: 40 }, (_, i) => cue(i * 10_000, i * 10_000 + 9_000, `Sentence ${i}.`));

  it('takes more from BEFORE the question than after', () => {
    // A listener asks about something they just heard. Symmetric context doubles the prompt for
    // material the question cannot be about — and on a per-answer budget, prompt size IS the cost.
    const ctx = contextAround(lesson, 200_000);
    expect(ctx).toContain('Sentence 12.');   // 80s before
    expect(ctx).toContain('Sentence 22.');   // 20s after
    expect(ctx).not.toContain('Sentence 25.'); // 50s after — outside the window
  });

  it('keeps chronological order', () => {
    const ctx = contextAround(lesson, 200_000);
    expect(ctx.indexOf('Sentence 18.')).toBeLessThan(ctx.indexOf('Sentence 20.'));
  });

  it('drops the OLDEST material when the budget runs out, never the newest', () => {
    // Trimming from the end would discard exactly the sentence the listener is asking about,
    // producing a confident answer to a question about something not in the context.
    const wordy = Array.from({ length: 60 }, (_, i) => cue(i * 1000, i * 1000 + 900, `${'x'.repeat(200)} marker${i}`));
    const ctx = contextAround(wordy, 59_000);
    expect(ctx.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS + 200);
    expect(ctx, 'the cue nearest the question was trimmed').toContain('marker59');
    expect(ctx, 'the oldest cue survived a budget overflow').not.toContain('marker0 ');
  });

  it('returns nothing when the lesson has no captions', () => {
    // A question against a project with no transcript must produce an EMPTY context, so the
    // caller can refuse rather than ask a model to answer from nothing.
    expect(contextAround([], 5_000)).toBe('');
  });

  it('includes a cue that straddles the question moment', () => {
    expect(contextAround([cue(0, 300_000, 'One very long cue.')], 150_000)).toContain('One very long cue.');
  });
});

describe('may this question be paid for?', () => {
  const base = { intent: 'answer' as const, question: 'Why does the ledger win?', answeredToday: 0, dailyCap: 50, enabled: true };

  it('allows a normal question under the cap', () => {
    expect(decideSpend(base)).toMatchObject({ allowed: true, code: 'ok' });
  });

  it('refuses once the daily cap is reached', () => {
    // Without this, a public endpoint that calls an LLM is a way for a stranger to spend the
    // owner's money by holding down a button.
    const d = decideSpend({ ...base, answeredToday: 50 });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('daily_cap');
  });

  it('does not reveal the size of the cap', () => {
    // A cap that announces its own number is one someone can plan around.
    const d = decideSpend({ ...base, answeredToday: 50 });
    expect(d.reason).not.toMatch(/\d/);
  });

  it('refuses an over-long question', () => {
    // The question is attacker-controlled text that goes into a prompt the owner pays for, so its
    // length is a cost lever anyone can pull.
    const d = decideSpend({ ...base, question: 'a'.repeat(MAX_QUESTION_CHARS + 1) });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('too_long');
  });

  it('accepts a question of exactly the maximum length', () => {
    expect(decideSpend({ ...base, question: 'a'.repeat(MAX_QUESTION_CHARS) }).allowed).toBe(true);
  });

  it('refuses an empty or whitespace-only question', () => {
    for (const q of ['', '   ', '\n']) {
      expect(decideSpend({ ...base, question: q }).code, `accepted ${JSON.stringify(q)}`).toBe('empty');
    }
  });

  it('refuses when the creator has the feature off', () => {
    expect(decideSpend({ ...base, enabled: false }).code).toBe('disabled');
  });
});

describe('saving costs nothing, so it is almost never refused', () => {
  const save = { intent: 'save' as const, question: 'What was that?', answeredToday: 999, dailyCap: 50, enabled: false };

  it('is allowed even with the cap exhausted AND the feature disabled', () => {
    // A saved question costs nothing. Refusing to RECORD one because the answer budget is spent
    // takes away the driver's only hands-free option for the reason least to do with them.
    expect(decideSpend(save)).toMatchObject({ allowed: true, code: 'ok' });
  });

  it('is still refused when it is empty or absurdly long', () => {
    // Free does not mean unbounded: an empty marker is useless, and a megabyte of text is storage
    // someone else pays for.
    expect(decideSpend({ ...save, question: '' }).allowed).toBe(false);
    expect(decideSpend({ ...save, question: 'a'.repeat(MAX_QUESTION_CHARS + 1) }).allowed).toBe(false);
  });
});

describe('what happens to a question the cap refused', () => {
  it('a capped question is SAVED, not discarded', () => {
    // The listener asked something real, and the creator wants to know what their listeners are
    // confused about. Throwing it away to enforce a spending limit loses exactly the data the
    // limit exists to protect the budget for — and it is the demand signal A2.5 waits on.
    expect(fallbackIntent(decideSpend({ intent: 'answer', question: 'Why?', answeredToday: 50, dailyCap: 50, enabled: true })))
      .toBe('save');
  });

  it('a disabled-feature question is saved too', () => {
    expect(fallbackIntent(decideSpend({ intent: 'answer', question: 'Why?', answeredToday: 0, dailyCap: 50, enabled: false })))
      .toBe('save');
  });

  it('a MALFORMED question is not saved — there is nothing to save', () => {
    expect(fallbackIntent(decideSpend({ intent: 'answer', question: '', answeredToday: 0, dailyCap: 50, enabled: true })))
      .toBeNull();
    expect(fallbackIntent(decideSpend({ intent: 'answer', question: 'a'.repeat(999), answeredToday: 0, dailyCap: 50, enabled: true })))
      .toBeNull();
  });

  it('an allowed question has no fallback', () => {
    expect(fallbackIntent(decideSpend({ intent: 'answer', question: 'Why?', answeredToday: 0, dailyCap: 50, enabled: true })))
      .toBeNull();
  });
});
