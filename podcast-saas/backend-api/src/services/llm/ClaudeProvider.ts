import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider, type LLMOptions, type LLMResponse } from './LLMProvider.js';
import { AppError, LLMErrorType } from 'shared';
import { isAdaptiveOnlyClaudeModel } from './claudeModels.js';

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

  async sendMessage(opts: LLMOptions): Promise<LLMResponse> {
    if (!this.client) throw new AppError(LLMErrorType.LLM_ERROR, 'Claude not configured', 500);

    // Adaptive-only models reject `temperature` and `budget_tokens` with a 400.
    // The classification is shared with LLMService so the two cannot drift
    // (llm-pipeline-009).
    const adaptiveOnly = isAdaptiveOnlyClaudeModel(opts.model);
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

      // Prompt caching is a PREFIX match — only a byte-identical leading span is
      // ever read back (llm-pipeline-007). Three shapes:
      //
      //   prefix declared  → cache the frozen head, leave the per-call tail out
      //                      of the cached span so it stops invalidating it;
      //   cacheable:false  → mark nothing. For a prompt that is unique per call
      //                      (the podcast passes embed the draft's turns) the
      //                      old blanket cache_control bought a 1.25x
      //                      cache-write premium on every request for an entry
      //                      no later request could read;
      //   default          → cache the whole system prompt, as before. Callers
      //                      like SimulationService.buildContextPrompt sort
      //                      their sources deterministically *so that* this
      //                      caches across refinement turns; silently dropping
      //                      it would regress a working, valuable cache.
      const ephemeral = { type: 'ephemeral' } as const;
      const cachePrefix = opts.systemPromptCachePrefix?.trim() ? opts.systemPromptCachePrefix : null;
      const cacheable = opts.systemPromptCacheable !== false;
      const system = !cacheable
        ? [{ type: 'text', text: opts.systemPrompt }]
        : cachePrefix
          ? [
              { type: 'text', text: cachePrefix, cache_control: ephemeral },
              { type: 'text', text: opts.systemPrompt },
            ]
          : [{ type: 'text', text: opts.systemPrompt, cache_control: ephemeral }];

      const body = {
        model: opts.model,
        max_tokens: maxTokens,
        ...modelParams,
        system,
        messages,
      };

      const stream = await this.client.messages.stream(
        // Cast: `output_config` / adaptive `thinking` aren't in the installed SDK's
        // types but pass through on the wire.
        body as unknown as Parameters<typeof this.client.messages.stream>[0],
        { signal: opts.abortSignal },
      );

      let abortedMidStream = false;
      for await (const event of stream) {
        if (opts.abortSignal?.aborted) {
          abortedMidStream = true;
          break;
        }

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
      const usage = {
        input: inputTokens,
        output: outputTokens,
        cached_input: cachedTokens,
        cost_cents: this.estimateCostCents(opts.model, inputTokens, outputTokens, cachedTokens),
      };

      // Breaking out of the stream leaves `chunks` holding HALF AN ANSWER. This
      // used to be returned as a normal success with stopReason 'end_turn', so a
      // truncated script was indistinguishable from a complete one downstream —
      // it passed assertNotTruncated, parsed as JSON, and was written
      // (llm-pipeline-014). Fail instead, and carry the partial usage on the
      // error so LLMService.usageFromError still meters the attempt.
      if (abortedMidStream) {
        throw new AppError(LLMErrorType.ABORTED, 'Request aborted mid-stream', 499, {
          usage,
          model: opts.model,
          partialChars: content.length,
        });
      }

      return {
        content,
        model: opts.model,
        stopReason,
        usage,
      };
    } catch (err: unknown) {
      // Already classified (the mid-stream abort above) — do not re-wrap it as a
      // generic provider error, which would hide ABORTED and drop the usage.
      if (err instanceof AppError) throw err;
      if ((err as { name?: string }).name === 'AbortError') {
        throw new AppError(LLMErrorType.ABORTED, 'Request aborted', 499);
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new AppError(LLMErrorType.LLM_ERROR, `Claude error: ${msg}`, 502);
    }
  }
}
