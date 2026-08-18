/**
 * Drift guard for MODEL_PROVIDER (llm-pipeline-001).
 *
 * Routing now derives the provider from the configured model id, so the registry
 * IS the routing table. If someone adds a model to a provider's
 * getAvailableModels() — which is what the admin UI offers — without adding it
 * here, that model silently falls back to default_provider and the original
 * "Claude id posted to Google" bug is back. This test fails the moment the two
 * lists disagree.
 *
 * Providers are NOT mocked here (that is the point); they are constructed with a
 * null key, so no SDK client is created and no network call is possible.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/index.js', () => ({ db: { query: { admin_settings: { findFirst: vi.fn() } } } }));
vi.mock('../../../db/schema.js', () => ({
  admin_settings: {}, system_prompts: {}, api_keys: {}, token_usage: {},
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(), and: vi.fn(), gte: vi.fn(), notInArray: vi.fn(), sql: vi.fn(),
}));
vi.mock('../../secrets/ApiKeyService.js', () => ({ ApiKeyService: class {} }));
vi.mock('../../usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { MODEL_PROVIDER, providerForModel, isTruncatedStopReason } from '../LLMService.js';
import { ClaudeProvider } from '../ClaudeProvider.js';
import { OpenAIProvider } from '../OpenAIProvider.js';
import { GeminiProvider } from '../GeminiProvider.js';

const PROVIDERS = [
  ['claude', new ClaudeProvider(null)],
  ['openai', new OpenAIProvider(null)],
  ['gemini', new GeminiProvider(null)],
] as const;

describe('MODEL_PROVIDER registry', () => {
  for (const [name, provider] of PROVIDERS) {
    it(`covers every model ${name} advertises`, () => {
      for (const model of provider.getAvailableModels()) {
        expect(providerForModel(model)).toBe(name);
      }
    });
  }

  it('claims no model that no provider actually offers', () => {
    const advertised = new Set(PROVIDERS.flatMap(([, p]) => p.getAvailableModels()));
    for (const model of Object.keys(MODEL_PROVIDER)) {
      expect(advertised.has(model)).toBe(true);
    }
  });

  it('returns null for an id no provider claims (so default_provider still applies)', () => {
    expect(providerForModel('some-private-preview')).toBeNull();
    expect(providerForModel('')).toBeNull();
  });
});

describe('isTruncatedStopReason', () => {
  it('recognises the truncation signal of every wired provider', () => {
    expect(isTruncatedStopReason('max_tokens')).toBe(true);   // Claude
    expect(isTruncatedStopReason('length')).toBe(true);       // OpenAI
    expect(isTruncatedStopReason('MAX_TOKENS')).toBe(true);   // Gemini
  });

  it('does not fire on a normal completion or on an absent stop reason', () => {
    for (const s of ['end_turn', 'stop', 'STOP', 'stop_sequence', 'tool_use', 'refusal', '']) {
      expect(isTruncatedStopReason(s)).toBe(false);
    }
    expect(isTruncatedStopReason(undefined)).toBe(false);
  });
});
