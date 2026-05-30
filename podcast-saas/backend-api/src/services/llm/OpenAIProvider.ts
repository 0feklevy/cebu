import OpenAI from 'openai';
import { LLMProvider, type LLMOptions, type LLMResponse } from './LLMProvider.js';
import { AppError, LLMErrorType } from 'shared';

export class OpenAIProvider extends LLMProvider {
  readonly providerName = 'openai' as const;
  private client: OpenAI | null = null;

  constructor(private readonly apiKey: string | null) {
    super();
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  getAvailableModels(): string[] {
    return ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'];
  }

  async sendMessage(opts: LLMOptions): Promise<LLMResponse> {
    if (!this.client) throw new AppError(LLMErrorType.LLM_ERROR, 'OpenAI not configured', 500);

    try {
      const chunks: string[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedTokens = 0;
      let stopReason = 'stop';

      // Build full message array supporting multi-turn conversation history
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: 'system', content: opts.systemPrompt },
        ...(opts.previousMessages ?? []).map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        { role: 'user', content: opts.userPrompt },
      ];

      const stream = await this.client.chat.completions.create(
        {
          model: opts.model,
          max_tokens: opts.maxTokens ?? 8192,
          temperature: opts.temperature ?? 0.7,
          messages,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: opts.abortSignal },
      );

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? '';
        if (delta) {
          chunks.push(delta);
          opts.onTokenChunk?.(delta);
        }
        if (chunk.choices[0]?.finish_reason) {
          stopReason = chunk.choices[0].finish_reason;
        }
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens;
          outputTokens = chunk.usage.completion_tokens;
          cachedTokens =
            (chunk.usage as { prompt_tokens_details?: { cached_tokens?: number } })
              .prompt_tokens_details?.cached_tokens ?? 0;
        }
      }

      return {
        content: chunks.join(''),
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
      throw new AppError(LLMErrorType.LLM_ERROR, `OpenAI error: ${msg}`, 502);
    }
  }
}
