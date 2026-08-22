/**
 * The renderer's spend accounting, tested by BEHAVIOUR rather than by the shape of the source.
 *
 * ── WHY THIS EXISTS ALONGSIDE THE SPEND CONTRACT ──────────────────────────────────────────────
 * `spendContract.test.ts` asks whether a module that reaches a paid vendor also mentions the usage
 * recorder. That is the right question for a ratchet over thirteen modules, and it is a TEXT match:
 * mutation-testing it showed that deleting the recorder's import, and separately deleting the call
 * in `finally`, both left it green. A module can satisfy it by importing without calling.
 *
 * That is the same failure as a mask that masks nothing — a guard matching text instead of
 * behaviour, reporting success through the hole. The contract keeps its job of catching a NEW
 * unmetered module; this file makes the claim the contract cannot: that a render actually records
 * what it spent.
 *
 * ── WHAT IS FAKED, AND WHAT IS NOT ────────────────────────────────────────────────────────────
 * The vendor and the recorder are fakes; the counting is the real code. Every assertion below is
 * about arithmetic that decides an invoice line, so faking that would leave nothing under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const record = vi.fn(async () => {});
vi.mock('../../../usage/UsageTrackingService.js', () => ({
  UsageTrackingService: class { record = record; },
}));
vi.mock('../../../../db/index.js', () => ({ db: {} }));
vi.mock('../../../../db/schema.js', () => ({}));

import { PodcastRenderer } from '../PodcastRenderer.js';
import { estimateTtsCost, DEFAULT_USD_PER_CREDIT } from '../../../usage/ttsCost.js';

/** Reaches the two private members that carry the money. They are the subject, not an accident. */
interface Internals {
  el: { synthesize: (p: unknown) => Promise<unknown> };
  charactersSpent: number;
  meteredSynthesize: (p: { inputs: Array<{ text?: string | null }> }) => Promise<unknown>;
  recordSpend: (a: { userId: string | null; episodeId: string; renderId: string }) => Promise<void>;
}

function renderer(): { r: PodcastRenderer; i: Internals; calls: number } {
  const r = new PodcastRenderer();
  const i = r as unknown as Internals;
  const state = { calls: 0 };
  i.el = { synthesize: async () => { state.calls++; return { audioBase64: '', voiceSegments: [] }; } };
  i.charactersSpent = 0;
  return { r, i, get calls() { return state.calls; } };
}

beforeEach(() => { record.mockClear(); });

describe('every synthesis is counted, including the ones that were thrown away', () => {
  it('adds up the characters across calls', async () => {
    const { i } = renderer();
    await i.meteredSynthesize({ inputs: [{ text: 'hello' }, { text: ' world' }] });
    await i.meteredSynthesize({ inputs: [{ text: '!' }] });
    expect(i.charactersSpent).toBe(12);
  });

  it('counts a RETRY as a second charge, because the vendor does', async () => {
    // `render()` retries a chunk with a different seed when the first result is unusable. The text
    // still arrived, so the failed attempt is billed and not refunded. Counting only the accepted
    // result would under-report exactly when things go wrong — which is when the number matters.
    const { i } = renderer();
    const chunk = { inputs: [{ text: 'a stubborn line' }] };
    await i.meteredSynthesize(chunk);
    await i.meteredSynthesize(chunk);   // the retry
    expect(i.charactersSpent).toBe('a stubborn line'.length * 2);
  });

  it('still reaches the vendor — the meter must not swallow the call', async () => {
    const h = renderer();
    await h.i.meteredSynthesize({ inputs: [{ text: 'x' }] });
    expect(h.calls).toBe(1);
  });
});

describe('what gets written down', () => {
  it('records the characters, in characters — not as tokens', async () => {
    // The whole reason migration 073 exists. "1,400 tokens" and "1,400 characters" render
    // identically and sum together happily, and the total means nothing.
    const { i } = renderer();
    i.charactersSpent = 1_400;
    await i.recordSpend({ userId: 'user-1', episodeId: 'ep-1', renderId: 'r-1' });

    expect(record).toHaveBeenCalledTimes(1);
    const row = record.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.unit).toBe('characters');
    expect(row.quantity).toBe(1_400);
    expect(row.inputTokens).toBe(0);
    expect(row.outputTokens).toBe(0);
  });

  it('prices it with the real cost model, not a number of its own', async () => {
    const { i } = renderer();
    i.charactersSpent = 36_000;
    await i.recordSpend({ userId: 'u', episodeId: 'e', renderId: 'r' });

    const row = record.mock.calls[0]![0] as { costCents: number };
    expect(row.costCents).toBeCloseTo(estimateTtsCost({ characters: 36_000, usdPerCredit: DEFAULT_USD_PER_CREDIT }).costCents, 6);
    expect(row.costCents).toBeGreaterThan(0);
  });

  it('attributes the spend to the show owner', async () => {
    // A spend surface that cannot say WHO spent is a total, not an account.
    const { i } = renderer();
    i.charactersSpent = 10;
    await i.recordSpend({ userId: 'owner-7', episodeId: 'e', renderId: 'r' });
    expect((record.mock.calls[0]![0] as { userId: string }).userId).toBe('owner-7');
  });

  it('writes nothing when nothing was synthesised', async () => {
    // A render that failed before its first chunk spent no money, and a zero row would put a
    // meaningless entry in every per-day total.
    const { i } = renderer();
    i.charactersSpent = 0;
    await i.recordSpend({ userId: 'u', episodeId: 'e', renderId: 'r' });
    expect(record).not.toHaveBeenCalled();
  });

  it('never lets a metering failure take down a finished render', async () => {
    // It runs after the audio is made and paid for. A missing row is a reporting gap; a throw here
    // would be a lost episode the customer is waiting for.
    record.mockRejectedValueOnce(new Error('database is down'));
    const { i } = renderer();
    i.charactersSpent = 500;
    await expect(i.recordSpend({ userId: 'u', episodeId: 'e', renderId: 'r' })).resolves.toBeUndefined();
  });
});
