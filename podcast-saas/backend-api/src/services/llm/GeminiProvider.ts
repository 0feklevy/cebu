import { GoogleGenAI } from '@google/genai';
import { LLMProvider, type LLMOptions, type LLMResponse } from './LLMProvider.js';
import { AppError, LLMErrorType } from 'shared';

export class GeminiProvider extends LLMProvider {
  readonly providerName = 'gemini' as const;
  private client: GoogleGenAI | null = null;

  constructor(private readonly apiKey: string | null) {
    super();
    if (apiKey) {
      this.client = new GoogleGenAI({ apiKey });
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  getAvailableModels(): string[] {
    return ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  }

  async sendMessage(opts: LLMOptions): Promise<LLMResponse> {
    if (!this.client) throw new AppError(LLMErrorType.LLM_ERROR, 'Gemini not configured', 500);

    try {
      const chunks: string[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason = 'STOP';

      // Build multi-turn contents; use systemInstruction for system prompt
      // Gemini uses 'model' instead of 'assistant' for role names
      const historyContents = (opts.previousMessages ?? []).map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
      const contents = [
        ...historyContents,
        { role: 'user', parts: [{ text: opts.userPrompt }] },
      ];

      const response = await this.client.models.generateContentStream({
        model: opts.model,
        contents,
        config: {
          systemInstruction: opts.systemPrompt,
          maxOutputTokens: opts.maxTokens ?? 8192,
          temperature: opts.temperature ?? 0.7,
          ...(opts.thinkingBudgetTokens
            ? { thinkingConfig: { thinkingBudget: opts.thinkingBudgetTokens } }
            : {}),
        },
      });

      for await (const chunk of response) {
        if (opts.abortSignal?.aborted) break;
        const text = chunk.text ?? '';
        if (text) {
          chunks.push(text);
          opts.onTokenChunk?.(text);
        }
        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount ?? 0;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
        }
        if (chunk.candidates?.[0]?.finishReason) {
          stopReason = chunk.candidates[0].finishReason;
        }
      }

      return {
        content: chunks.join(''),
        model: opts.model,
        stopReason,
        usage: {
          input: inputTokens,
          output: outputTokens,
          cached_input: 0,
          cost_cents: this.estimateCostCents(opts.model, inputTokens, outputTokens, 0),
        },
      };
    } catch (err: unknown) {
      if (opts.abortSignal?.aborted) {
        throw new AppError(LLMErrorType.ABORTED, 'Request aborted', 499);
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new AppError(LLMErrorType.LLM_ERROR, `Gemini error: ${msg}`, 502);
    }
  }
}
