/**
 * Wire-contract tests for ClaudeProvider.
 *
 *   llm-pipeline-014  an ABORTED stream must FAIL, not return its partial text
 *                     as a successful, complete-looking response.
 *   llm-pipeline-009  which models are "adaptive-only" (reject temperature and
 *                     budget_tokens) must not be a hardcoded three-model list.
 *   llm-pipeline-007  cache_control must be writable only where it can actually
 *                     be read back — without dropping the caches that DO hit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError, LLMErrorType } from 'shared';

const mockStream = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  function MockAnthropic(_opts: unknown) {
    return { messages: { stream: mockStream } };
  }
  return { default: MockAnthropic };
});

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ClaudeProvider } from '../ClaudeProvider.js';
import { isAdaptiveOnlyClaudeModel } from '../claudeModels.js';

function iterable(events: object[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
  };
}

/** Yields events, aborting `controller` after the Nth one has been consumed. */
function abortingIterable(events: object[], controller: AbortController, after: number) {
  return {
    [Symbol.asyncIterator]: async function* () {
      let seen = 0;
      for (const e of events) {
        yield e;
        if (++seen === after) controller.abort();
      }
    },
  };
}

const OK_EVENTS = [
  { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 0 } } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"ok":true}' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
];

let provider: ClaudeProvider;
beforeEach(() => {
  mockStream.mockReset();
  provider = new ClaudeProvider('test-api-key');
});

// ── llm-pipeline-014 ─────────────────────────────────────────────────────────

describe('aborted stream (llm-pipeline-014)', () => {
  it('throws ABORTED instead of returning the partial text as a success', async () => {
    const controller = new AbortController();
    mockStream.mockReturnValue(
      abortingIterable(
        [
          { type: 'message_start', message: { usage: { input_tokens: 400, cache_read_input_tokens: 40 } } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'first half ' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'second half' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
        ],
        controller,
        2, // abort after the first text chunk has been consumed
      ),
    );

    const err = await provider
      .sendMessage({
        model: 'claude-haiku-4-5',
        systemPrompt: 'sys',
        userPrompt: 'user',
        maxTokens: 8192,
        abortSignal: controller.signal,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).error_type).toBe(LLMErrorType.ABORTED);
  });

  it('attaches the partial usage to the error so the attempt is still metered', async () => {
    const controller = new AbortController();
    mockStream.mockReturnValue(
      abortingIterable(
        [
          { type: 'message_start', message: { usage: { input_tokens: 400, cache_read_input_tokens: 40 } } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: ' more' } },
        ],
        controller,
        2,
      ),
    );

    const err = (await provider
      .sendMessage({
        model: 'claude-haiku-4-5',
        systemPrompt: 'sys',
        userPrompt: 'user',
        maxTokens: 8192,
        abortSignal: controller.signal,
      })
      .catch((e: unknown) => e)) as AppError;

    const usage = err.details?.usage as { input: number; cached_input: number } | undefined;
    expect(usage).toBeDefined();
    expect(usage!.input).toBe(400);
    expect(usage!.cached_input).toBe(40);
  });

  it('still returns normally when the stream completes and nothing aborted', async () => {
    mockStream.mockReturnValue(iterable(OK_EVENTS));
    const res = await provider.sendMessage({
      model: 'claude-haiku-4-5',
      systemPrompt: 'sys',
      userPrompt: 'user',
      maxTokens: 8192,
      abortSignal: new AbortController().signal,
    });
    expect(res.content).toBe('{"ok":true}');
    expect(res.stopReason).toBe('end_turn');
  });
});

// ── llm-pipeline-009 ─────────────────────────────────────────────────────────

describe('isAdaptiveOnlyClaudeModel (llm-pipeline-009)', () => {
  it('is true for the models that reject temperature / budget_tokens today', () => {
    for (const m of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-fable-5']) {
      expect(isAdaptiveOnlyClaudeModel(m)).toBe(true);
    }
  });

  it('is false for the legacy models that still accept them', () => {
    for (const m of [
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5',
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-opus-4-5',
    ]) {
      expect(isAdaptiveOnlyClaudeModel(m)).toBe(false);
    }
  });

  it('defaults an UNKNOWN claude id to adaptive-only (the non-400 direction)', () => {
    // Sending temperature/budget_tokens to a model that rejects them is a hard
    // 400; omitting them from a model that accepts them just uses server
    // defaults. Unknown ids therefore default to the safe side.
    for (const m of ['claude-opus-5', 'claude-sonnet-5', 'claude-mythos-5', 'claude-opus-4-9']) {
      expect(isAdaptiveOnlyClaudeModel(m)).toBe(true);
    }
  });

  it('is false for a non-claude id', () => {
    expect(isAdaptiveOnlyClaudeModel('gpt-4o')).toBe(false);
    expect(isAdaptiveOnlyClaudeModel('')).toBe(false);
  });
});

describe('adaptive-only models never receive rejected params', () => {
  it('omits temperature and budget_tokens for a newer model id the list never knew about', async () => {
    mockStream.mockReturnValue(iterable(OK_EVENTS));

    await provider.sendMessage({
      model: 'claude-opus-5',
      systemPrompt: 'sys',
      userPrompt: 'user',
      maxTokens: 8192,
      temperature: 0.7,
      thinkingBudgetTokens: 4096, // a stale caller may still pass one
      adaptiveThinking: true,
      effort: 'high',
    });

    const body = mockStream.mock.calls[0][0];
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
  });

  it('agrees with the predicate for every model the provider advertises', async () => {
    for (const model of provider.getAvailableModels()) {
      mockStream.mockReset();
      mockStream.mockReturnValue(iterable(OK_EVENTS));
      await provider.sendMessage({
        model,
        systemPrompt: 'sys',
        userPrompt: 'user',
        maxTokens: 8192,
        temperature: 0.5,
      });
      const body = mockStream.mock.calls[0][0];
      const sentTemperature = body.temperature !== undefined;
      expect(sentTemperature).toBe(!isAdaptiveOnlyClaudeModel(model));
    }
  });
});

// ── llm-pipeline-007 ─────────────────────────────────────────────────────────

describe('prompt caching (llm-pipeline-007)', () => {
  it('keeps caching the whole system prompt by default', async () => {
    // SimulationService.buildContextPrompt sorts its source entries
    // deterministically *so that* the bridge/guidance system prompt is
    // byte-stable and caches across refinement turns. Dropping cache_control by
    // default would regress a working, valuable cache.
    mockStream.mockReturnValue(iterable(OK_EVENTS));

    await provider.sendMessage({
      model: 'claude-opus-4-8',
      systemPrompt: 'stable simulation context',
      userPrompt: 'user',
      maxTokens: 8192,
    });

    const body = mockStream.mock.calls[0][0];
    expect(body.system).toHaveLength(1);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('marks nothing when the caller says the prompt is unique per call', async () => {
    mockStream.mockReturnValue(iterable(OK_EVENTS));

    await provider.sendMessage({
      model: 'claude-opus-4-8',
      // A podcast pass: the system prompt embeds this call's draft turns, so a
      // cache entry written here can never be read by any later request.
      systemPrompt: 'TEMPLATE HEAD\n\nDRAFT_TURNS: [{"id":"t1"}]',
      systemPromptCacheable: false,
      userPrompt: 'user',
      maxTokens: 8192,
    });

    const body = mockStream.mock.calls[0][0];
    expect(body.system).toHaveLength(1);
    expect(body.system[0].cache_control).toBeUndefined();
    expect(body.system[0].text).toContain('DRAFT_TURNS');
  });

  it('caches ONLY the declared stable prefix, leaving the volatile tail uncached', async () => {
    mockStream.mockReturnValue(iterable(OK_EVENTS));

    await provider.sendMessage({
      model: 'claude-opus-4-8',
      systemPromptCachePrefix: 'TEMPLATE HEAD',
      systemPrompt: 'DRAFT_TURNS: [{"id":"t1"}]',
      userPrompt: 'user',
      maxTokens: 8192,
    });

    const body = mockStream.mock.calls[0][0];
    expect(body.system).toHaveLength(2);
    expect(body.system[0].text).toBe('TEMPLATE HEAD');
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[1].text).toBe('DRAFT_TURNS: [{"id":"t1"}]');
    expect(body.system[1].cache_control).toBeUndefined();
  });

  it('ignores a blank prefix rather than emitting an empty cached block', async () => {
    mockStream.mockReturnValue(iterable(OK_EVENTS));

    await provider.sendMessage({
      model: 'claude-opus-4-8',
      systemPromptCachePrefix: '   ',
      systemPrompt: 'sys',
      userPrompt: 'user',
      maxTokens: 8192,
    });

    const body = mockStream.mock.calls[0][0];
    expect(body.system).toHaveLength(1);
    expect(body.system[0].text).toBe('sys');
  });

  it('opt-out wins over a declared prefix', async () => {
    mockStream.mockReturnValue(iterable(OK_EVENTS));

    await provider.sendMessage({
      model: 'claude-opus-4-8',
      systemPromptCachePrefix: 'TEMPLATE HEAD',
      systemPromptCacheable: false,
      systemPrompt: 'volatile',
      userPrompt: 'user',
      maxTokens: 8192,
    });

    const body = mockStream.mock.calls[0][0];
    expect(body.system.some((b: { cache_control?: unknown }) => b.cache_control)).toBe(false);
  });
});
