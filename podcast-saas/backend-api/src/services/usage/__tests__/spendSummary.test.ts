/**
 * The arithmetic behind the admin spend page.
 *
 * One rule matters more than the rest and every other test here is downstream of it: NEVER SUM
 * ACROSS UNITS. `token_usage` holds characters, seconds, images, source-minutes and tokens in one
 * column. Adding 1,400 characters to 3 images gives 1,403 of nothing, and it renders exactly like
 * a real number — which is the failure that started this work. Not an absence of data: the risk of
 * a confident wrong total.
 */
import { describe, it, expect } from 'vitest';
import { summariseSpend, utcDay, type UsageRowLike } from '../spendSummary.js';

const row = (over: Partial<UsageRowLike> = {}): UsageRowLike => ({
  provider: 'elevenlabs',
  task: 'podcast_render',
  model: 'eleven_v3',
  cost_cents: 100,
  quantity: 1_000,
  unit: 'characters',
  occurred_at: '2026-08-22T14:57:00.000Z',
  ...over,
});

describe('money, which is the one thing that may be added across providers', () => {
  it('totals cost in dollars', () => {
    const s = summariseSpend([row({ cost_cents: 250 }), row({ cost_cents: 150, provider: 'groq' })]);
    expect(s.totalUsd).toBeCloseTo(4, 10);
  });

  it('orders providers by spend, because the page answers "what is costing me money"', () => {
    const s = summariseSpend([
      row({ provider: 'groq', cost_cents: 50 }),
      row({ provider: 'elevenlabs', cost_cents: 900 }),
      row({ provider: 'openai', cost_cents: 300 }),
    ]);
    expect(s.providers.map((p) => p.provider)).toEqual(['elevenlabs', 'openai', 'groq']);
  });

  it('treats a null or nonsense cost as zero rather than as NaN', () => {
    // One malformed row must not turn the whole page into "$NaN", which reads as broken software
    // rather than as one bad row.
    //
    // `null` alone does NOT prove the guard: `0 + null` is 0 in JavaScript, so a version with no
    // guard at all passes that case. The values below are the ones that actually poison a sum —
    // and a poisoned total is worse than a wrong one, because every figure on the page becomes
    // "NaN" at once and the reader learns nothing about which row was bad.
    for (const bad of [null, undefined, NaN, Infinity, 'lots'] as unknown[]) {
      const s = summariseSpend([row({ cost_cents: bad as number }), row({ cost_cents: 100 })]);
      expect(s.totalUsd, `cost_cents = ${String(bad)}`).toBeCloseTo(1, 10);
    }
  });
});

describe('quantities, which may NOT be added across units', () => {
  it('keeps each unit separate within a provider', () => {
    const s = summariseSpend([
      row({ quantity: 1_000, unit: 'characters' }),
      row({ quantity: 3, unit: 'images' }),
      row({ quantity: 500, unit: 'characters' }),
    ]);
    const el = s.providers.find((p) => p.provider === 'elevenlabs')!;
    expect(el.quantities).toEqual([
      { unit: 'characters', quantity: 1_500 },
      { unit: 'images', quantity: 3 },
    ]);
  });

  it('never produces one combined quantity number', () => {
    // The assertion the whole module exists for. If a `total quantity` ever appears, this fails.
    const s = summariseSpend([row({ unit: 'characters', quantity: 1_400 }), row({ unit: 'images', quantity: 3 })]);
    const el = s.providers[0]!;
    expect(el.quantities.length).toBe(2);
    expect(JSON.stringify(el)).not.toContain('1403');
  });

  it('counts rows with NO unit rather than folding them into one', () => {
    // LLM rows carry their amount in the token columns and have no unit. Counting them as zero
    // quantity would understate; guessing a unit would be worse.
    const s = summariseSpend([row({ unit: null, quantity: null }), row({ unit: 'characters', quantity: 100 })]);
    const el = s.providers[0]!;
    expect(el.untypedRows).toBe(1);
    expect(el.quantities).toEqual([{ unit: 'characters', quantity: 100 }]);
  });

  it('ignores a quantity that arrives without a unit', () => {
    // A number with no unit cannot be added to anything. Recording it under a guessed unit is how
    // a page starts lying quietly.
    const s = summariseSpend([row({ unit: null, quantity: 999 })]);
    expect(s.providers[0]!.quantities).toEqual([]);
    expect(s.providers[0]!.untypedRows).toBe(1);
  });
});

describe('the zero-cost count, which exists to invite a question', () => {
  it('counts rows priced at exactly zero', () => {
    // Zero is what a broken rate produces. A page that renders "$0.00" for a busy day without
    // saying how many rows were zero is the one wrong answer nobody questions.
    const s = summariseSpend([row({ cost_cents: 0 }), row({ cost_cents: 0 }), row({ cost_cents: 100 })]);
    expect(s.zeroCostRows).toBe(2);
    expect(s.rows).toBe(3);
  });
});

describe('grouping', () => {
  it('splits by task within a provider', () => {
    const s = summariseSpend([
      row({ task: 'podcast_render', cost_cents: 500 }),
      row({ task: 'podcast_preview', cost_cents: 20 }),
      row({ task: 'podcast_render', cost_cents: 300 }),
    ]);
    expect(s.byTask[0]).toMatchObject({ task: 'podcast_render', rows: 2 });
    expect(s.byTask[0]!.usd).toBeCloseTo(8, 10);
  });

  it('buckets by UTC day, not by the reader\'s timezone', () => {
    // An invoice's day boundary is UTC. A page that split days locally would disagree with the
    // bill by a few hours' spend at every boundary, which is exactly where reconciliation happens.
    expect(utcDay('2026-08-22T23:59:00.000Z')).toBe('2026-08-22');
    expect(utcDay('2026-08-23T00:01:00.000Z')).toBe('2026-08-23');
  });

  it('orders days forwards, so a burst reads as a shape', () => {
    const s = summariseSpend([
      row({ occurred_at: '2026-08-23T01:00:00Z', cost_cents: 100 }),
      row({ occurred_at: '2026-08-21T01:00:00Z', cost_cents: 200 }),
      row({ occurred_at: '2026-08-22T01:00:00Z', cost_cents: 300 }),
    ]);
    expect(s.byDay.map((d) => d.day)).toEqual(['2026-08-21', '2026-08-22', '2026-08-23']);
  });

  it('survives an unparseable timestamp without dropping the money', () => {
    // The row still cost something. Losing it from the total to protect a chart would be the wrong
    // trade — the total is what gets reconciled.
    const s = summariseSpend([row({ occurred_at: 'not-a-date', cost_cents: 500 })]);
    expect(s.totalUsd).toBeCloseTo(5, 10);
    expect(s.byDay[0]!.day).toBe('unknown');
  });
});

describe('an empty ledger', () => {
  it('reports zero without inventing structure', () => {
    const s = summariseSpend([]);
    expect(s).toMatchObject({ totalUsd: 0, providers: [], byTask: [], byDay: [], rows: 0, zeroCostRows: 0 });
  });
});
