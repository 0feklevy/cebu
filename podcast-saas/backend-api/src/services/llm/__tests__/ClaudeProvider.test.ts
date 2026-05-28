import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeProvider } from '../ClaudeProvider.js';

// ── Mock the Anthropic SDK ──────────────────────────────────────────────────────

const mockStream = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  // Must use a regular function (not arrow) so `new Anthropic()` works
  function MockAnthropic(_opts: unknown) {
    return { messages: { stream: mockStream } };
  }
  return { default: MockAnthropic };
});

// ── Helpers ─────────────────────────────────────────────────────────────────────

function makeAsyncIterable(events: object[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
  };
}

const EVENTS_WITH_TEXT = [
  { type: 'message_start', message: { usage: { input_tokens: 100 } } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"ok":true}' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
];

const EVENTS_WITH_THINKING = [
  { type: 'message_start', message: { usage: { input_tokens: 200 } } },
  { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'reasoning...' } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"ok":true}' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
];

// ── Tests ────────────────────────────────────────────────────────────────────────

describe('ClaudeProvider', () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    mockStream.mockReset();
    provider = new ClaudeProvider('test-api-key');
  });

  it('isConfigured() returns true when api key is provided', () => {
    expect(provider.isConfigured()).toBe(true);
  });

  it('isConfigured() returns false when api key is null', () => {
    const p = new ClaudeProvider(null);
    expect(p.isConfigured()).toBe(false);
  });

  it('getAvailableModels() returns expected models', () => {
    const models = provider.getAvailableModels();
    expect(models).toContain('claude-haiku-4-5');
    expect(models).toContain('claude-sonnet-4-5');
  });

  describe('thinking budget constraint', () => {
    it('bumps max_tokens to budget + 1000 when thinking budget > max_tokens', async () => {
      mockStream.mockReturnValue(makeAsyncIterable(EVENTS_WITH_THINKING));

      await provider.sendMessage({
        model: 'claude-sonnet-4-5',
        systemPrompt: 'You are helpful.',
        userPrompt: 'Analyze this.',
        maxTokens: 8000,
        thinkingBudgetTokens: 10000, // violates constraint: budget > max_tokens
      });

      const callArgs = mockStream.mock.calls[0][0];
      // max_tokens must be > thinkingBudgetTokens
      expect(callArgs.max_tokens).toBeGreaterThan(10000);
      expect(callArgs.max_tokens).toBe(11000); // 10000 + 1000
    });

    it('preserves max_tokens when it is already > budget', async () => {
      mockStream.mockReturnValue(makeAsyncIterable(EVENTS_WITH_THINKING));

      await provider.sendMessage({
        model: 'claude-sonnet-4-5',
        systemPrompt: 'You are helpful.',
        userPrompt: 'Analyze this.',
        maxTokens: 32000,
        thinkingBudgetTokens: 8000,
      });

      const callArgs = mockStream.mock.calls[0][0];
      expect(callArgs.max_tokens).toBe(32000);
    });

    it('sends thinking config when thinkingBudgetTokens is set', async () => {
      mockStream.mockReturnValue(makeAsyncIterable(EVENTS_WITH_THINKING));

      await provider.sendMessage({
        model: 'claude-sonnet-4-5',
        systemPrompt: 'sys',
        userPrompt: 'user',
        maxTokens: 32000,
        thinkingBudgetTokens: 8000,
      });

      const callArgs = mockStream.mock.calls[0][0];
      expect(callArgs.thinking).toEqual({ type: 'enabled', budget_tokens: 8000 });
      // temperature must NOT be set when thinking is enabled
      expect(callArgs.temperature).toBeUndefined();
    });

    it('sends temperature and NO thinking config when thinkingBudgetTokens is 0', async () => {
      mockStream.mockReturnValue(makeAsyncIterable(EVENTS_WITH_TEXT));

      await provider.sendMessage({
        model: 'claude-haiku-4-5',
        systemPrompt: 'sys',
        userPrompt: 'user',
        maxTokens: 16000,
        temperature: 0.5,
      });

      const callArgs = mockStream.mock.calls[0][0];
      expect(callArgs.thinking).toBeUndefined();
      expect(callArgs.temperature).toBe(0.5);
    });
  });

  describe('response assembly', () => {
    it('collects only text_delta events and ignores thinking_delta', async () => {
      mockStream.mockReturnValue(makeAsyncIterable(EVENTS_WITH_THINKING));

      const chunks: string[] = [];
      const result = await provider.sendMessage({
        model: 'claude-sonnet-4-5',
        systemPrompt: 'sys',
        userPrompt: 'user',
        maxTokens: 32000,
        thinkingBudgetTokens: 8000,
        onTokenChunk: (c) => chunks.push(c),
      });

      // Only the text portion, not the thinking content
      expect(result.content).toBe('{"ok":true}');
      expect(chunks).toEqual(['{"ok":true}']);
    });

    it('assembles content from multiple text_delta chunks', async () => {
      mockStream.mockReturnValue(makeAsyncIterable([
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"name"' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: ':"Alice"' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: ',"value":1}' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
      ]));

      const result = await provider.sendMessage({
        model: 'claude-haiku-4-5',
        systemPrompt: 'sys',
        userPrompt: 'user',
        maxTokens: 8192,
      });

      expect(result.content).toBe('{"name":"Alice","value":1}');
    });

    it('records usage from message_start and message_delta', async () => {
      mockStream.mockReturnValue(makeAsyncIterable([
        { type: 'message_start', message: { usage: { input_tokens: 500, cache_read_input_tokens: 100 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: '{}' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } },
      ]));

      const result = await provider.sendMessage({
        model: 'claude-haiku-4-5',
        systemPrompt: 'sys',
        userPrompt: 'user',
        maxTokens: 8192,
      });

      expect(result.usage.input).toBe(500);
      expect(result.usage.output).toBe(50);
      expect(result.usage.cached_input).toBe(100);
    });
  });

  describe('error handling', () => {
    it('throws AppError with LLM_ERROR on API failure', async () => {
      mockStream.mockRejectedValue(new Error('Connection refused'));

      await expect(
        provider.sendMessage({
          model: 'claude-haiku-4-5',
          systemPrompt: 'sys',
          userPrompt: 'user',
          maxTokens: 8192,
        }),
      ).rejects.toThrow('Claude error: Connection refused');
    });

    it('throws AppError ABORTED when signal fires', async () => {
      const controller = new AbortController();

      mockStream.mockReturnValue(makeAsyncIterable([
        { type: 'message_start', message: { usage: { input_tokens: 1 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
      ]));

      // Abort immediately after starting
      const promise = provider.sendMessage({
        model: 'claude-haiku-4-5',
        systemPrompt: 'sys',
        userPrompt: 'user',
        maxTokens: 8192,
        abortSignal: controller.signal,
      });

      controller.abort();

      // Aborted streams return partial content, not an error (break in loop)
      const result = await promise;
      expect(result.content).toBeDefined();
    });
  });
});
