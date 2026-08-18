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
