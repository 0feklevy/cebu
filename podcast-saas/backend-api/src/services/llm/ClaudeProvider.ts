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
    return [
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5',
      'claude-sonnet-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-fable-5',
    ];
  }

  /**
   * Newest Claude models (Opus 4.7/4.8, Fable 5) reject `temperature` and
   * `budget_tokens` with a 400 and use adaptive thinking + `output_config.effort`
   * instead. Everything older keeps the classic thinking-budget / temperature path.
   */
  private isAdaptiveOnly(model: string): boolean {
    return model === 'claude-opus-4-7' || model === 'claude-opus-4-8' || model === 'claude-fable-5';
  }

  async sendMessage(opts: LLMOptions): Promise<LLMResponse> {
    if (!this.client) throw new AppError(LLMErrorType.LLM_ERROR, 'Claude not configured', 500);

    const adaptiveOnly = this.isAdaptiveOnly(opts.model);
    const isFable = opts.model === 'claude-fable-5';
    const thinkingBudget = opts.thinkingBudgetTokens ?? 0;
    const useLegacyThinking = !adaptiveOnly && thinkingBudget > 0;

    // Adaptive-only models can't derive max_tokens from a budget; give a generous
    // ceiling (streamed, so no HTTP timeout) so thinking + a full script fit.
    const maxTokens = adaptiveOnly
      ? Math.max(opts.maxTokens ?? 8192, 16000)
      : useLegacyThinking
        ? Math.max(opts.maxTokens ?? 8192, thinkingBudget + 1000)
        : (opts.maxTokens ?? 8192);

    // Model-specific parameter block. On adaptive-only models we send NO temperature
    // and NO budget_tokens; adaptive thinking is explicit on Opus (omitting = no
    // thinking) and always-on (omit the field) on Fable. Effort rides in output_config.
    // These fields aren't in the installed SDK's types, so the block is built loosely
    // and passed through — the wire body carries them to the API verbatim.
    const modelParams: Record<string, unknown> = {};
    if (adaptiveOnly) {
      if (!isFable && opts.adaptiveThinking) {
        modelParams.thinking = { type: 'adaptive' };
      }
      if (isFable && opts.adaptiveThinking === false) {
        // Fable thinking is always on; an explicit disable would 400 — so never send it.
      }
      if (opts.effort) {
        modelParams.output_config = { effort: opts.effort };
      }
    } else if (useLegacyThinking) {
      modelParams.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
    } else {
      modelParams.temperature = opts.temperature ?? 0.7;
    }

    try {
      const chunks: string[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedTokens = 0;
      let stopReason = 'end_turn';

      // Build messages array — supports multi-turn conversation history
      const messages: Array<{ role: 'user' | 'assistant'; content: string }> = opts.previousMessages
        ? [
            ...opts.previousMessages,
            { role: 'user', content: opts.userPrompt },
          ]
        : [{ role: 'user', content: opts.userPrompt }];

      const body = {
        model: opts.model,
        max_tokens: maxTokens,
        ...modelParams,
        system: [
          {
            type: 'text',
            text: opts.systemPrompt,
            // Prompt caching: mark system prompt as ephemeral cache
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages,
      };

      const stream = await this.client.messages.stream(
        // Cast: `output_config` / adaptive `thinking` aren't in the installed SDK's
        // types but pass through on the wire.
        body as unknown as Parameters<typeof this.client.messages.stream>[0],
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
