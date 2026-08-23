/**
 * The account-wide spend ceiling, and the two ways a ceiling does damage.
 *
 * It can fail to stop a runaway — the thing it exists for. And it can stop legitimate work, which
 * on this product means a creator's render dying at three in the morning over a default nobody
 * chose. The tests below are mostly about the second, because that is the failure a new ceiling is
 * far more likely to cause in its first month.
 */
import { describe, it, expect } from 'vitest';
import { judgeSpendCeiling, spendCeilingMode, ceilingForProvider } from '../spendCeiling.js';

const judge = (over: Partial<Parameters<typeof judgeSpendCeiling>[0]> = {}) =>
  judgeSpendCeiling({ mode: 'enforce', provider: 'elevenlabs', spentCents: 0, ceilingCents: 5_000, ...over });

describe('the mode, which decides whether it can hurt anyone', () => {
  it('defaults to SHADOW, not enforce', () => {
    // A ceiling introduced tonight has no history behind its number. The first thing anyone needs
    // from it is to learn whether the figure is even right — not to have it start refusing work.
    expect(spendCeilingMode({})).toBe('shadow');
    expect(spendCeilingMode({ SPEND_CEILING_MODE: 'nonsense' })).toBe('shadow');
  });

  it('takes enforce and off when asked explicitly', () => {
    expect(spendCeilingMode({ SPEND_CEILING_MODE: 'enforce' })).toBe('enforce');
    expect(spendCeilingMode({ SPEND_CEILING_MODE: 'off' })).toBe('off');
  });

  it('never refuses in shadow, but reports what it WOULD have done', () => {
    // The whole point of the mode: the signal without the blast radius.
    const v = judge({ mode: 'shadow', spentCents: 9_000 });
    expect(v.refuse).toBe(false);
    expect(v.wouldRefuse).toBe(true);
    expect(v.reason).toMatch(/ceiling/);
  });

  it('never refuses when off, and says nothing at all', () => {
    const v = judge({ mode: 'off', spentCents: 9_000 });
    expect(v.refuse).toBe(false);
    expect(v.wouldRefuse).toBe(false);
    expect(v.reason).toBeNull();
  });
});

describe('the ceiling itself', () => {
  it('reads a per-provider figure', () => {
    expect(ceilingForProvider('elevenlabs', { SPEND_CEILING_ELEVENLABS_CENTS: '5000' })).toBe(5_000);
    expect(ceilingForProvider('groq', { SPEND_CEILING_GROQ_CENTS: '250' })).toBe(250);
  });

  it('is NULL when unset — which is not the same as zero', () => {
    // Zero means "refuse everything", which an operator might genuinely want and must be able to
    // say. Conflating the two would make an unset variable the most aggressive setting available.
    expect(ceilingForProvider('elevenlabs', {})).toBeNull();
    expect(ceilingForProvider('elevenlabs', { SPEND_CEILING_ELEVENLABS_CENTS: '0' })).toBe(0);
  });

  it('treats a malformed value as NO ceiling, never as zero', () => {
    // Reading "abc" as "refuse everything" would take the product down over a typo.
    for (const raw of ['abc', '-100', 'NaN', 'Infinity']) {
      expect(ceilingForProvider('elevenlabs', { SPEND_CEILING_ELEVENLABS_CENTS: raw }), raw).toBeNull();
    }
  });

  it('does nothing when no ceiling is configured, whatever the mode', () => {
    const v = judge({ ceilingCents: null, spentCents: 1_000_000 });
    expect(v.refuse).toBe(false);
    expect(v.wouldRefuse).toBe(false);
  });

  it('honours an explicit zero ceiling', () => {
    expect(judge({ ceilingCents: 0, spentCents: 1 }).refuse).toBe(true);
  });
});

describe('the arithmetic', () => {
  it('lets spend under the ceiling through', () => {
    expect(judge({ spentCents: 4_999 }).refuse).toBe(false);
  });

  it('counts what is ABOUT to be spent, not only history', () => {
    // A ceiling checked against history alone lets the single largest call through every time —
    // and the largest call is the one worth stopping.
    expect(judge({ spentCents: 4_500, aboutToSpendCents: 100 }).refuse).toBe(false);
    expect(judge({ spentCents: 4_500, aboutToSpendCents: 600 }).refuse).toBe(true);
  });

  it('treats an unknown forthcoming cost as zero rather than refusing on a guess', () => {
    // Several call sites cannot know what a call will cost until it returns. "We do not know yet"
    // must not read as "assume the worst and block".
    expect(judge({ spentCents: 4_999, aboutToSpendCents: undefined }).refuse).toBe(false);
    expect(judge({ spentCents: 4_999, aboutToSpendCents: NaN }).refuse).toBe(false);
  });

  it('does not refuse exactly AT the ceiling', () => {
    // The ceiling is a limit, not a fence one short of it. Off-by-one here means refusing the last
    // legitimate call of every month.
    expect(judge({ spentCents: 5_000 }).refuse).toBe(false);
    expect(judge({ spentCents: 5_001 }).refuse).toBe(true);
  });

  it('survives a nonsense spend figure without refusing everything', () => {
    // A broken query returning NaN must not turn into an account-wide outage.
    for (const bad of [NaN, -50, Infinity]) {
      expect(judge({ spentCents: bad }).refuse, String(bad)).toBe(false);
    }
  });
});

describe('the refusal message', () => {
  it('names the amount, the ceiling and the variable that sets it', () => {
    // An operator reading this at speed needs to know what to change, not merely that something
    // was blocked.
    const v = judge({ spentCents: 6_000 });
    expect(v.reason).toMatch(/\$60\.00/);
    expect(v.reason).toMatch(/\$50\.00/);
    expect(v.reason).toMatch(/SPEND_CEILING_ELEVENLABS_CENTS/);
  });

  it('says nothing when nothing is wrong', () => {
    expect(judge({ spentCents: 10 }).reason).toBeNull();
  });
});
