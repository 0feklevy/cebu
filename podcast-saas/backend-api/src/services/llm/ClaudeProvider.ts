import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider, type LLMOptions, type LLMResponse } from './LLMProvider.js';
import { AppError, LLMErrorType } from 'shared';

export class ClaudeProvider extends LLMProvider {
  readonly providerName = 'claude' as const;
  private client: Anthropic | null = null;

  constructor(private readonly apiKey: string | null) {
    super();
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  getAvailableModels(): string[] {
    return ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-7'];
  }

  async sendMessage(opts: LLMOptions): Promise<LLMResponse> {
    if (!this.client) throw new AppError(LLMErrorType.LLM_ERROR, 'Claude not configured', 500);

    const thinkingBudget = opts.thinkingBudgetTokens ?? 0;
    const useThinking = thinkingBudget > 0;
    // Claude requires max_tokens > budget_tokens
    const maxTokens = useThinking
      ? Math.max(opts.maxTokens ?? 8192, thinkingBudget + 1000)
      : (opts.maxTokens ?? 8192);

    try {
      const chunks: string[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedTokens = 0;
      let stopReason = 'end_turn';

      const stream = await this.client.messages.stream(
        {
          model: opts.model,
          max_tokens: maxTokens,
          ...(useThinking
            ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } }
            : { temperature: opts.temperature ?? 0.7 }),
          system: [
            {
              type: 'text',
              text: opts.systemPrompt,
              // Prompt caching: mark system prompt as ephemeral cache
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: opts.userPrompt }],
        },
        { signal: opts.abortSignal },
      );

      for await (const event of stream) {
        if (opts.abortSignal?.aborted) break;

        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            chunks.push(event.delta.text);
            opts.onTokenChunk?.(event.delta.text);
          }
        }
        if (event.type === 'message_delta') {
          stopReason = event.delta.stop_reason ?? stopReason;
        }
        if (event.type === 'message_start') {
          inputTokens = event.message.usage.input_tokens;
          cachedTokens =
            (event.message.usage as { cache_read_input_tokens?: number })
              .cache_read_input_tokens ?? 0;
        }
        if (event.type === 'message_delta') {
          outputTokens = event.usage.output_tokens;
        }
      }

      const content = chunks.join('');

      return {
        content,
        model: opts.model,
        stopReason,
        usage: {
          input: inputTokens,
          output: outputTokens,
          cached_input: cachedTokens,
          cost_cents: this.estimateCostCents(opts.model, inputTokens, outputTokens, cachedTokens),
        },
      };
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw new AppError(LLMErrorType.ABORTED, 'Request aborted', 499);
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new AppError(LLMErrorType.LLM_ERROR, `Claude error: ${msg}`, 502);
    }
  }
}
