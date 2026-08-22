/**
 * Two claims pull in opposite directions here: the description must be USEFUL enough to replace the
 * raw dump it removes, and it must carry NO customer text at all. The first version of this module
 * tried to have both by keeping 120 redacted characters from each end, and the test at the bottom
 * of this file is what killed it — a fixture sentence about an acquisition price survived redaction
 * untouched, because it is confidential without being credential-shaped.
 *
 * So the safety tests below are written as "nothing from the input appears in the output", which is
 * a claim a redactor can never satisfy and a classifier satisfies by construction.
 */
import { describe, it, expect } from 'vitest';
import { describeUnparseable } from '../unparseableOutput.js';

describe('nothing the model wrote can reach the log', () => {
  it('carries no word from a confidential sentence — the case that killed the redaction design', () => {
    // Not credential-shaped, not an email, not a token. A redactor cannot see this and a
    // classifier cannot leak it.
    const raw = 'Sure! {"deal":"The acquisition price agreed with Northwind was fourteen million"';
    const serialised = JSON.stringify(describeUnparseable(raw));

    for (const word of ['acquisition', 'Northwind', 'fourteen', 'million', 'deal']) {
      expect(serialised, `"${word}" reached the log`).not.toContain(word);
    }
  });

  it('carries no credential even when one is the very first thing in the output', () => {
    const credential = ['sk', 'livekey0123456789abcdefghij'].join('-');
    const serialised = JSON.stringify(describeUnparseable(`${credential} then prose`));
    expect(serialised).not.toContain(credential);
    expect(serialised).not.toContain('livekey');
  });

  it('emits only values that CANNOT hold text: counts, booleans, single characters, a fixed enum', () => {
    // The structural guarantee, asserted rather than assumed. If a future field adds an excerpt
    // back, this fails — which is the only way a rule like this survives contact with a hurry.
    const KINDS = ['empty', 'fenced', 'json-object', 'json-array', 'markup', 'refusal', 'prose', 'other'];
    const d = describeUnparseable('Some long model answer about a private matter {"a":1');

    for (const [key, value] of Object.entries(d)) {
      if (typeof value === 'number' || typeof value === 'boolean') continue;
      if (key === 'kind') { expect(KINDS).toContain(value); continue; }
      expect(String(value).length, `${key} is longer than one character`).toBeLessThanOrEqual(1);
    }
  });
});

describe('what actually diagnoses a parse failure', () => {
  it('reports the token-ceiling signature: unbalanced braces on a long response', () => {
    // The commonest real cause. An answer that stops mid-object has more `{` than `}`, and that one
    // number separates "the model misunderstood" from "the model ran out of room".
    const d = describeUnparseable('{"sections":[{"title":"Flocking","body":"Birds follow three rules');
    expect(d.braceBalance).toBe(2);
    expect(d.bracketBalance).toBe(1);
    expect(d.unbalancedQuotes).toBe(true);
    expect(d.endsWith).not.toBe('}');
  });

  it('does NOT count braces inside strings', () => {
    // Counting blind reports "truncated" about a complete response whose title contains a brace,
    // sending someone to raise a token limit for a problem that is not there.
    const d = describeUnparseable('{"title":"Chapter {1} of [2]","ok":true}');
    expect(d.braceBalance).toBe(0);
    expect(d.bracketBalance).toBe(0);
    expect(d.unbalancedQuotes).toBe(false);
  });

  it('handles an escaped quote inside a string without losing the count', () => {
    const d = describeUnparseable('{"quote":"she said \\"hello\\"","n":1}');
    expect(d.unbalancedQuotes).toBe(false);
    expect(d.braceBalance).toBe(0);
  });

  it('separates the causes that lead to different actions', () => {
    expect(describeUnparseable('```json\n{"a":1}\n```').kind).toBe('fenced');
    expect(describeUnparseable('  {"a":1}').kind).toBe('json-object');
    expect(describeUnparseable('[{"a":1}]').kind).toBe('json-array');
    expect(describeUnparseable('<response><a>1</a></response>').kind).toBe('markup');
    expect(describeUnparseable('Sure! Here is the JSON:').kind).toBe('prose');
    expect(describeUnparseable('   \n ').kind).toBe('empty');
    expect(describeUnparseable('42').kind).toBe('other');
  });

  it('calls a refusal a refusal, because its fix is somewhere else entirely', () => {
    // A refusal IS prose. Bucketing it as prose sends someone to the JSON extractor when the
    // problem is the prompt or the moderation policy.
    for (const opening of [
      "I'm sorry, I can't help with that.",
      'I cannot produce that content.',
      'I am unable to comply with this request.',
      'Unfortunately, that is not something I can do.',
      "Sorry, I won't do that.",
    ]) {
      expect(describeUnparseable(opening).kind, opening).toBe('refusal');
    }
  });

  it('does not call an ordinary sentence a refusal just because it starts with "I"', () => {
    expect(describeUnparseable('I have produced the following three sections.').kind).toBe('prose');
  });

  it('reports the ORIGINAL length, not the trimmed one', () => {
    // Length is half the token-ceiling signal; anything else would be a constant.
    expect(describeUnparseable(`  ${'x'.repeat(5000)}  `).len).toBe(5004);
  });

  it('reports zero quotes on a long non-JSON answer, which is not the same as malformed JSON', () => {
    const d = describeUnparseable('The model wrote several sentences and never opened an object.');
    expect(d.quoteCount).toBe(0);
    expect(d.braceBalance).toBe(0);
  });

  it('distinguishes an empty response from a malformed one', () => {
    // Different causes, different fixes, and a repair loop reports them identically.
    const empty = describeUnparseable('   \n  ');
    expect(empty.kind).toBe('empty');
    expect(empty.startsWith).toBe('');
    expect(empty.endsWith).toBe('');
  });

  it('never throws, because it runs on the failure path', () => {
    // A describer that can fail turns a diagnosable 422 into an unhandled error inside the error
    // handler, and the original cause is lost.
    for (const input of [undefined, null, 123, {}, []] as unknown[]) {
      expect(() => describeUnparseable(input as string)).not.toThrow();
    }
  });
});
