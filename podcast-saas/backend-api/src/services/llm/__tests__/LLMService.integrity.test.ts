/**
 * LLMService integrity tests for three night-audit findings:
 *
 *   llm-pipeline-001 — tier model ids and default_provider were stored
 *     independently, and NO shipped default was self-consistent: migration 001
 *     seeds default_provider='gemini' with utility_model='claude-haiku-4-5',
 *     and migration 047 sets complex_model='claude-opus-4-8' on every install
 *     while leaving default_provider alone. Both tiers therefore posted an
 *     Anthropic model id to Google's API on a stock deploy.
 *
 *   llm-pipeline-004 — a response truncated at max_tokens was accepted as a
 *     complete answer. Each wired provider spells it differently: Claude
 *     'max_tokens', OpenAI 'length', Gemini 'MAX_TOKENS'. LLMService only ever
 *     compared stopReason to 'refusal'.
 *
 *   llm-pipeline-005 — usage was recorded only on the success path, so a failed
 *     or aborted provider call left no ledger row at all. The rolling-24h cap is
 *     a count(*) over token_usage, so anything that reliably fails was free of
 *     charge against the cap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { AppError, LLMErrorType } from 'shared';

const mocks = vi.hoisted(() => ({
  adminFindFirst: vi.fn(),
  sendMessage: vi.fn(),
  record: vi.fn(),
  selectWhere: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: { admin_settings: { findFirst: mocks.adminFindFirst } },
    select: () => ({ from: () => ({ where: mocks.selectWhere }) }),
  },
}));

vi.mock('../../../db/schema.js', () => ({
  admin_settings: {},
  system_prompts: { key: 'key' },
  api_keys: {},
  token_usage: { user_id: 'user_id', occurred_at: 'occurred_at', task: 'task' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })),
  and: vi.fn(() => ({ type: 'and' })),
  gte: vi.fn(() => ({ type: 'gte' })),
  notInArray: vi.fn(() => ({ type: 'notInArray' })),
  sql: vi.fn(() => ({ type: 'sql' })),
}));

vi.mock('../../secrets/ApiKeyService.js', () => ({ ApiKeyService: class {} }));
vi.mock('../../usage/UsageTrackingService.js', () => ({ UsageTrackingService: class {} }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: mocks.info, warn: mocks.warn, error: mocks.error, debug: mocks.debug },
}));

// Fake providers that report their real names but never make a network call.
function fakeProvider(name: 'claude' | 'openai' | 'gemini') {
  return class {
    readonly providerName = name;
    isConfigured() { return true; }
    getAvailableModels() { return []; }
    sendMessage = mocks.sendMessage;
  };
}
vi.mock('../ClaudeProvider.js', () => ({ ClaudeProvider: fakeProvider('claude') }));
vi.mock('../OpenAIProvider.js', () => ({ OpenAIProvider: fakeProvider('openai') }));
vi.mock('../GeminiProvider.js', () => ({ GeminiProvider: fakeProvider('gemini') }));

import { LLMService } from '../LLMService.js';

// The shipped defaults, copied verbatim from db/schema.ts + migrations 001/044/047.
const SHIPPED_DEFAULTS = {
  generation_paused: false,
  generation_paused_message: null,
  generation_limit_enabled: false,
  generation_daily_limit: 50,
  default_provider: 'gemini',
  temperature: 0.7,
  max_tokens: 32000,
  extended_thinking_enabled: true,
  thinking_budget_tokens: 8000,
  utility_model: 'claude-haiku-4-5',
  generation_model: 'gemini-2.0-flash',
  complex_model: 'claude-opus-4-8',
  complex_min_corpus_tokens: 50000,
  complex_min_retries: 2,
  podcast_model: 'claude-opus-4-8',
  podcast_effort: 'max',
};

const OK_USAGE = { input: 100, output: 20, cached_input: 0, cost_cents: 0.5 };

function okResponse(content = '{"answer":"ok"}', stopReason = 'end_turn') {
  return { content, model: 'm', stopReason, usage: OK_USAGE };
}

const SimpleSchema = z.object({ answer: z.string() });

function makeSvc() {
  return new LLMService(
    { getSystemKey: vi.fn(async () => 'system-key') } as never,
    { record: mocks.record } as never,
  );
}

const STRUCTURED_OPTS = {
  systemPrompt: 'sys',
  userPrompt: 'prompt',
  schema: SimpleSchema,
  userId: 'u1',
  projectId: 'p1',
  abortSignal: new AbortController().signal,
};

const TEXT_OPTS = {
  systemPrompt: 'sys',
  userPrompt: 'prompt',
  userId: 'u1',
  projectId: 'p1',
  abortSignal: new AbortController().signal,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adminFindFirst.mockResolvedValue({ ...SHIPPED_DEFAULTS });
  mocks.selectWhere.mockResolvedValue([{ count: 0 }]);
  mocks.record.mockResolvedValue(undefined);
  mocks.sendMessage.mockResolvedValue(okResponse());
});

// ── llm-pipeline-001 ─────────────────────────────────────────────────────────

describe('provider/model consistency (llm-pipeline-001)', () => {
  it('sends the SHIPPED utility model (a Claude id) to Claude, not to the default gemini provider', async () => {
    const res = await makeSvc().sendText({ ...TEXT_OPTS, task: 'content_moderation' });
    expect(res.model).toBe('claude-haiku-4-5');
    expect(res.provider).toBe('claude');
  });

  it('sends the SHIPPED complex model (migration 047 Opus) to Claude, not to gemini', async () => {
    const res = await makeSvc().sendStructured({ ...STRUCTURED_OPTS, task: 'bridge_plan' });
    expect(res.model).toBe('claude-opus-4-8');
    expect(res.provider).toBe('claude');
  });

  it('leaves an ALREADY-consistent pairing alone', async () => {
    const res = await makeSvc().sendStructured({ ...STRUCTURED_OPTS, task: 'script_draft' });
    expect(res.model).toBe('gemini-2.0-flash');
    expect(res.provider).toBe('gemini');
  });

  it('routes an OpenAI model to OpenAI even when default_provider is gemini', async () => {
    mocks.adminFindFirst.mockResolvedValue({ ...SHIPPED_DEFAULTS, generation_model: 'gpt-4o-mini' });
    const res = await makeSvc().sendStructured({ ...STRUCTURED_OPTS, task: 'script_draft' });
    expect(res.provider).toBe('openai');
  });

  it('warns (once) so the misconfiguration is visible rather than silent', async () => {
    await makeSvc().sendText({ ...TEXT_OPTS, task: 'content_moderation' });
    const warned = mocks.warn.mock.calls.map((c) => JSON.stringify(c));
    expect(warned.some((w) => w.includes('llm_config_mismatch'))).toBe(true);
  });

  it('falls back to default_provider for a model no provider claims (custom/preview ids)', async () => {
    mocks.adminFindFirst.mockResolvedValue({ ...SHIPPED_DEFAULTS, generation_model: 'some-private-preview' });
    const res = await makeSvc().sendStructured({ ...STRUCTURED_OPTS, task: 'script_draft' });
    expect(res.provider).toBe('gemini');
  });
});

// ── llm-pipeline-004 ─────────────────────────────────────────────────────────

describe('truncated output detection (llm-pipeline-004)', () => {
  const cases: Array<[string, string]> = [
    ['claude', 'max_tokens'],
    ['openai', 'length'],
    ['gemini', 'MAX_TOKENS'],
  ];

  for (const [provider, stopReason] of cases) {
    it(`rejects a ${provider}-style truncation (stopReason "${stopReason}") instead of storing a partial answer`, async () => {
      mocks.sendMessage.mockResolvedValue(okResponse('{"answer":"ok"}', stopReason));
      const err = await makeSvc()
        .sendStructured({ ...STRUCTURED_OPTS, task: 'script_draft' })
        .catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).details?.truncated).toBe(true);
    });
  }

  it('rejects a truncated sendText response too (it used to be returned as complete text)', async () => {
    mocks.sendMessage.mockResolvedValue({
      content: 'half an analysis doc…',
      model: 'm',
      stopReason: 'max_tokens',
      usage: OK_USAGE,
    });
    const err = await makeSvc().sendText({ ...TEXT_OPTS, task: 'guidance_plan' }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).details?.truncated).toBe(true);
  });

  it('does NOT burn parse retries on a truncation (it is not a JSON problem)', async () => {
    mocks.sendMessage.mockResolvedValue(okResponse('{"answer":"ok"}', 'max_tokens'));
    await makeSvc().sendStructured({ ...STRUCTURED_OPTS, task: 'script_draft' }).catch(() => {});
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('still meters a truncated call — the tokens were spent', async () => {
    mocks.sendMessage.mockResolvedValue(okResponse('{"answer":"ok"}', 'max_tokens'));
    await makeSvc().sendStructured({ ...STRUCTURED_OPTS, task: 'script_draft' }).catch(() => {});
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });

  it('does not false-positive on the normal stop reasons of any provider', async () => {
    for (const stop of ['end_turn', 'stop', 'STOP', 'stop_sequence', 'tool_use']) {
      mocks.sendMessage.mockResolvedValue(okResponse('{"answer":"ok"}', stop));
      await expect(makeSvc().sendStructured({ ...STRUCTURED_OPTS, task: 'script_draft' }))
        .resolves.toMatchObject({ data: { answer: 'ok' } });
    }
  });
});

// ── llm-pipeline-005 ─────────────────────────────────────────────────────────

describe('metering of failed and aborted calls (llm-pipeline-005)', () => {
  it('records a ledger row when the provider call throws', async () => {
    mocks.sendMessage.mockRejectedValue(new AppError(LLMErrorType.LLM_ERROR, 'Claude error: 529', 502));
    await makeSvc().sendStructured({ ...STRUCTURED_OPTS, task: 'script_draft' }).catch(() => {});
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.record.mock.calls[0][0]).toMatchObject({ task: 'script_draft', userId: 'u1' });
  });

  it('records a ledger row when the call is ABORTED (the cheapest way to make a call fail)', async () => {
    mocks.sendMessage.mockRejectedValue(new AppError(LLMErrorType.ABORTED, 'Request aborted', 499));
    await makeSvc().sendStructured({ ...STRUCTURED_OPTS, task: 'script_draft' }).catch(() => {});
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });

  it('records a failed sendText call as well', async () => {
    mocks.sendMessage.mockRejectedValue(new AppError(LLMErrorType.LLM_ERROR, 'Gemini error', 502));
    await makeSvc().sendText({ ...TEXT_OPTS, task: 'prompt_enhance' }).catch(() => {});
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });

  it('still surfaces the ORIGINAL provider error, not a metering error', async () => {
    mocks.sendMessage.mockRejectedValue(new AppError(LLMErrorType.LLM_ERROR, 'Claude error: 529', 502));
    mocks.record.mockRejectedValue(new Error('ledger insert failed'));
    const err = await makeSvc()
      .sendStructured({ ...STRUCTURED_OPTS, task: 'script_draft' })
      .catch((e) => e);
    expect((err as AppError).message).toContain('529');
  });

  it('records whatever partial usage the failure carries', async () => {
    mocks.sendMessage.mockRejectedValue(
      new AppError(LLMErrorType.ABORTED, 'Request aborted', 499, {
        usage: { input: 900, output: 40, cached_input: 0, cost_cents: 1.25 },
      }),
    );
    await makeSvc().sendStructured({ ...STRUCTURED_OPTS, task: 'script_draft' }).catch(() => {});
    expect(mocks.record.mock.calls[0][0]).toMatchObject({
      inputTokens: 900,
      outputTokens: 40,
      costCents: 1.25,
    });
  });

  it('each of the 3 parse retries is metered, so retries cost cap as well as money', async () => {
    mocks.sendMessage.mockResolvedValue(okResponse('not json at all'));
    await makeSvc().sendStructured({ ...STRUCTURED_OPTS, task: 'script_draft' }).catch(() => {});
    expect(mocks.record).toHaveBeenCalledTimes(3);
  });
});

// ── llm-pipeline-011 ─────────────────────────────────────────────────────────

/**
 * `sendText` had neither of the two things `_sendStructuredOnce` had: the per-user generation
 * quota, and any reasoning controls at all. Its payload carried only
 * model/systemPrompt/userPrompt/maxTokens/temperature.
 *
 * That mattered most for `guidance_plan` — GuidanceService's pass-1 deep analysis. It is tier
 * `complex`, whose table comment says it "benefits from strongest model + extended thinking", and
 * it goes through `sendText`. So the product's deepest reasoning call ran with thinking OFF and
 * un-metered against the user's daily cap, while every structured call of the same tier did not.
 */
describe('sendText reasoning and quota (llm-pipeline-011)', () => {
  it('sends thinking controls for a tier-complex task — it used to send none', async () => {
    await makeSvc().sendText({ ...TEXT_OPTS, task: 'guidance_plan' });

    const payload = mocks.sendMessage.mock.calls[0]![0] as Record<string, unknown>;
    // THINKING SPECIFICALLY, not "any reasoning field is set". A mutation check caught the looser
    // version: `effort: 'high'` is set for complex on an adaptive model whether or not thinking is
    // on, so a disjunction that included `effort` stayed green with thinking disabled entirely.
    const thinks = payload.adaptiveThinking === true || typeof payload.thinkingBudgetTokens === 'number';
    expect(thinks, 'guidance_plan is tier complex and must THINK, not merely carry an effort').toBe(true);
  });

  it('matches what the structured path sends for the SAME task', async () => {
    // The point is parity: one decision, two entry points. If these drift again, the deepest
    // reasoning task silently gets weaker treatment through one door than the other.
    await makeSvc().sendText({ ...TEXT_OPTS, task: 'guidance_plan' });
    const viaText = mocks.sendMessage.mock.calls[0]![0] as Record<string, unknown>;

    mocks.sendMessage.mockClear();
    mocks.sendMessage.mockResolvedValue(okResponse());
    await makeSvc().sendStructured({ ...STRUCTURED_OPTS, task: 'guidance_plan' });
    const viaStructured = mocks.sendMessage.mock.calls[0]![0] as Record<string, unknown>;

    expect(viaText.adaptiveThinking).toEqual(viaStructured.adaptiveThinking);
    expect(viaText.thinkingBudgetTokens).toEqual(viaStructured.thinkingBudgetTokens);
    expect(viaText.effort).toEqual(viaStructured.effort);
    expect(viaText.maxTokens).toEqual(viaStructured.maxTokens);
  });

  it('does NOT send thinking for a utility task', async () => {
    await makeSvc().sendText({ ...TEXT_OPTS, task: 'prompt_enhance' });
    const payload = mocks.sendMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.adaptiveThinking).toBeUndefined();
    expect(payload.thinkingBudgetTokens).toBeUndefined();
  });

  it('ENFORCES the daily cap on sendText — it used to be un-metered', async () => {
    mocks.adminFindFirst.mockResolvedValue({
      ...SHIPPED_DEFAULTS, generation_limit_enabled: true, generation_daily_limit: 5,
    });
    mocks.selectWhere.mockResolvedValue([{ count: 5 }]);

    await expect(makeSvc().sendText({ ...TEXT_OPTS, task: 'guidance_plan' }))
      .rejects.toMatchObject({ error_type: LLMErrorType.LIMIT_EXCEEDED });
    expect(mocks.sendMessage, 'the provider must never be reached past the cap').not.toHaveBeenCalled();
  });

  it('lets a user under the cap through', async () => {
    mocks.adminFindFirst.mockResolvedValue({
      ...SHIPPED_DEFAULTS, generation_limit_enabled: true, generation_daily_limit: 5,
    });
    mocks.selectWhere.mockResolvedValue([{ count: 4 }]);

    await expect(makeSvc().sendText({ ...TEXT_OPTS, task: 'guidance_plan' })).resolves.toBeDefined();
  });

  it('never blocks content_moderation, which gates other requests', async () => {
    mocks.adminFindFirst.mockResolvedValue({
      ...SHIPPED_DEFAULTS, generation_limit_enabled: true, generation_daily_limit: 1,
    });
    mocks.selectWhere.mockResolvedValue([{ count: 999 }]);

    await expect(makeSvc().sendText({ ...TEXT_OPTS, task: 'content_moderation' })).resolves.toBeDefined();
  });

  it('does NOT re-charge the cap on a retry of an already-admitted call', async () => {
    // The structured path enforces only on attempt 0 for exactly this reason. A retry that is
    // re-counted charges one user action twice against their daily limit — and a mutation check
    // showed nothing was pinning it.
    mocks.adminFindFirst.mockResolvedValue({
      ...SHIPPED_DEFAULTS, generation_limit_enabled: true, generation_daily_limit: 5,
    });
    mocks.selectWhere.mockResolvedValue([{ count: 999 }]);

    await expect(makeSvc().sendText({ ...TEXT_OPTS, task: 'guidance_plan', retryCount: 1 }))
      .resolves.toBeDefined();
  });

  it('does not count the cap against an anonymous call', async () => {
    mocks.adminFindFirst.mockResolvedValue({
      ...SHIPPED_DEFAULTS, generation_limit_enabled: true, generation_daily_limit: 1,
    });
    mocks.selectWhere.mockResolvedValue([{ count: 999 }]);

    await expect(makeSvc().sendText({ ...TEXT_OPTS, userId: undefined, task: 'guidance_plan' }))
      .resolves.toBeDefined();
  });
});

// ── llm-pipeline-007 ─────────────────────────────────────────────────────────

/**
 * `ClaudeProvider` has honoured `systemPromptCacheable`/`systemPromptCachePrefix` since it was
 * written — but nothing could REACH it. The fields were absent from `SendStructuredOpts`/
 * `SendTextOpts` and from the payload the service builds, so every Claude call took the default
 * branch and cache-wrote its entire system prompt.
 *
 * That is only wasteful for a prompt that can never be read back — and ScriptRoom's passes are
 * exactly that, embedding `JSON.stringify(draft.turns)` INTO the system prompt, so each call pays
 * a 1.25x cache-write premium for an entry with a structural hit rate of zero.
 */
describe('system-prompt caching reaches the provider (llm-pipeline-007)', () => {
  it('forwards an opt-OUT through sendStructured', async () => {
    await makeSvc().sendStructured({
      ...STRUCTURED_OPTS, task: 'podcast_compile', systemPromptCacheable: false,
    });
    const payload = mocks.sendMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.systemPromptCacheable).toBe(false);
  });

  it('forwards a stable PREFIX through sendStructured', async () => {
    await makeSvc().sendStructured({
      ...STRUCTURED_OPTS, task: 'podcast_compile', systemPromptCachePrefix: 'FROZEN HEAD',
    });
    const payload = mocks.sendMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.systemPromptCachePrefix).toBe('FROZEN HEAD');
  });

  it('forwards both through sendText too', async () => {
    await makeSvc().sendText({
      ...TEXT_OPTS, task: 'guidance_plan', systemPromptCacheable: false, systemPromptCachePrefix: 'HEAD',
    });
    const payload = mocks.sendMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.systemPromptCacheable).toBe(false);
    expect(payload.systemPromptCachePrefix).toBe('HEAD');
  });

  it('leaves callers that say nothing on the caching DEFAULT', async () => {
    // The default must stay on: several callers build a byte-stable system prompt deliberately
    // (SimulationService.buildContextPrompt sorts its sources precisely so the prompt caches
    // across refinement turns) and those get real cache reads.
    await makeSvc().sendStructured({ ...STRUCTURED_OPTS, task: 'bridge_plan' });
    const payload = mocks.sendMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.systemPromptCacheable).toBeUndefined();
    expect(payload.systemPromptCachePrefix).toBeUndefined();
  });
});
