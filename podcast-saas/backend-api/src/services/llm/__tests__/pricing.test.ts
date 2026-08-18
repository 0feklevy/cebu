/**
 * Cost-ledger correctness for LLMProvider.estimateCostCents (llm-pipeline-008).
 *
 * Two separate defects live here:
 *   (a) Haiku 4.5 was priced at Haiku 3.5 rates ($0.80/$4.00 per MTok) while the
 *       model actually costs $1.00/$5.00 — every utility-tier row was 20% light.
 *   (b) An unlisted model silently fell back to an INVENTED price, so a model id
 *       nobody priced produced a confident, wrong number in the ledger.
 *
 * Rates are asserted in $/MTok (the unit Anthropic publishes) by feeding exactly
 * 1,000,000 tokens: cents-for-1M-tokens ÷ 100 == $/MTok.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logger } = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../lib/logger.js', () => ({ logger }));

import {
  LLMProvider,
  MODEL_PRICING_CENTS_PER_TOKEN,
  type LLMOptions,
  type LLMResponse,
} from '../LLMProvider.js';
import { ClaudeProvider } from '../ClaudeProvider.js';
import { OpenAIProvider } from '../OpenAIProvider.js';
import { GeminiProvider } from '../GeminiProvider.js';

/** Minimal concrete provider that exposes the protected pricing helper. */
class PricingProbe extends LLMProvider {
  readonly providerName = 'claude' as const;
  isConfigured(): boolean {
    return true;
  }
  getAvailableModels(): string[] {
    return [];
  }
  async sendMessage(_opts: LLMOptions): Promise<LLMResponse> {
    throw new Error('not used by these tests');
  }
  cost(model: string, input: number, output: number, cached = 0): number {
    return this.estimateCostCents(model, input, output, cached);
  }
}

const M = 1_000_000;
const probe = new PricingProbe();

/** cents charged for 1M tokens → dollars per MTok */
const perMTok = (cents: number) => cents / 100;

beforeEach(() => {
  logger.error.mockReset();
});

describe('estimateCostCents — Claude Haiku 4.5 rate card', () => {
  for (const model of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001']) {
    it(`${model} input is $1.00 / MTok (not Haiku 3.5's $0.80)`, () => {
      expect(perMTok(probe.cost(model, M, 0, 0))).toBeCloseTo(1.0, 6);
    });

    it(`${model} output is $5.00 / MTok (not Haiku 3.5's $4.00)`, () => {
      expect(perMTok(probe.cost(model, 0, M, 0))).toBeCloseTo(5.0, 6);
    });

    it(`${model} cache reads are 0.1x input`, () => {
      // cachedInput is a SUBSET of inputTokens, so pass both.
      expect(perMTok(probe.cost(model, M, 0, M))).toBeCloseTo(0.1, 6);
    });
  }
});

describe('estimateCostCents — every other listed model keeps its published rate', () => {
  const CASES: Array<[string, number, number]> = [
    // model,                 $/MTok in,  $/MTok out
    ['claude-sonnet-4-5', 3.0, 15.0],
    ['claude-sonnet-4-6', 3.0, 15.0],
    ['claude-opus-4-7', 5.0, 25.0],
    ['claude-opus-4-8', 5.0, 25.0],
    ['claude-fable-5', 10.0, 50.0],
  ];
  for (const [model, dIn, dOut] of CASES) {
    it(`${model} is $${dIn}/$${dOut} per MTok`, () => {
      expect(perMTok(probe.cost(model, M, 0, 0))).toBeCloseTo(dIn, 6);
      expect(perMTok(probe.cost(model, 0, M, 0))).toBeCloseTo(dOut, 6);
    });
  }
});

describe('estimateCostCents — an unpriced model does not get an invented price', () => {
  it('records 0 rather than a fabricated number', () => {
    // 0.0001 c/token was the old invented rate — 100c for 1M input tokens.
    expect(probe.cost('some-private-preview', M, M, 0)).toBe(0);
  });

  it('logs an error naming the model so the gap is visible, not silent', () => {
    probe.cost('some-private-preview', 10, 10, 0);
    expect(logger.error).toHaveBeenCalled();
    const [payload] = logger.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(payload.model).toBe('some-private-preview');
  });

  it('does not log for a model that IS priced', () => {
    probe.cost('claude-haiku-4-5', 10, 10, 0);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('rate-card coverage', () => {
  // Providers built with a null key: no SDK client, no network is possible.
  const ADVERTISED = [new ClaudeProvider(null), new OpenAIProvider(null), new GeminiProvider(null)]
    .flatMap((p) => p.getAvailableModels());

  /**
   * Advertised models that are KNOWN to have no rate on file. Every entry is a
   * real cost-ledger gap, not an exemption: an admin can select these in the LLM
   * config and their spend records as 0 (with an `llm_unpriced_model` error).
   * Delete an entry the moment its published rate is added to the rate card.
   */
  const KNOWN_UNPRICED = ['gpt-4.1'];

  it('the set of unpriced advertised models has not grown', () => {
    const unpriced = ADVERTISED.filter((m) => !MODEL_PRICING_CENTS_PER_TOKEN[m]);
    expect(unpriced.sort()).toEqual([...KNOWN_UNPRICED].sort());
  });

  it('prices every model the admin UI can offer, except the known gaps', () => {
    for (const model of ADVERTISED) {
      if (KNOWN_UNPRICED.includes(model)) continue;
      expect(MODEL_PRICING_CENTS_PER_TOKEN[model], `no rate for ${model}`).toBeDefined();
    }
  });

  it('quotes no rate for a model no provider offers', () => {
    for (const model of Object.keys(MODEL_PRICING_CENTS_PER_TOKEN)) {
      expect(ADVERTISED, `${model} is priced but unreachable`).toContain(model);
    }
  });
});
