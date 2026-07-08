import type { z } from 'zod';

export type TaskType =
  | 'structural_analysis'
  | 'script_draft'
  | 'script_rewrite'
  | 'content_moderation'
  | 'single_turn_regen'
  | 'bridge_plan'
  | 'guidance_plan'
  // Podcast Studio writers' room (migration 044) — 'creative' tier.
  | 'podcast_architect'
  | 'podcast_materials'
  | 'podcast_playwright'
  | 'podcast_review'
  | 'podcast_rewrite'
  | 'podcast_compile'
  | 'podcast_delivery'
  | 'podcast_turn_regen'
  | 'podcast_memory';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface TokenUsage {
  input: number;
  output: number;
  cached_input: number;
  cost_cents: number;
}

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMOptions {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  previousMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
  thinkingBudgetTokens?: number;
  /** Adaptive-thinking + effort controls for the newest Claude models (opus-4.7+/fable-5). */
  effort?: EffortLevel;
  adaptiveThinking?: boolean;
  onTokenChunk?: (chunk: string) => void;
  abortSignal?: AbortSignal;
}

export interface LLMResponse {
  content: string;
  usage: TokenUsage;
  model: string;
  stopReason?: string;
}

export abstract class LLMProvider {
  abstract readonly providerName: 'claude' | 'openai' | 'gemini';

  abstract isConfigured(): boolean;

  abstract sendMessage(opts: LLMOptions): Promise<LLMResponse>;

  abstract getAvailableModels(): string[];

  protected estimateCostCents(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number,
  ): number {
    // Cents per token (= $/1M tokens ÷ 10,000)
    const pricing: Record<string, { input: number; output: number; cached: number }> = {
      'claude-haiku-4-5':          { input: 0.00008,  output: 0.0004,  cached: 0.000008 },
      'claude-haiku-4-5-20251001': { input: 0.00008,  output: 0.0004,  cached: 0.000008 },
      'claude-sonnet-4-5':         { input: 0.0003,   output: 0.0015,  cached: 0.00003  },
      'claude-sonnet-4-6':         { input: 0.0003,   output: 0.0015,  cached: 0.00003  },
      // Opus 4.7/4.8 are $5/$25 per MTok (cents-per-token = $/1M ÷ 10,000).
      'claude-opus-4-7':           { input: 0.0005,   output: 0.0025,  cached: 0.00005  },
      'claude-opus-4-8':           { input: 0.0005,   output: 0.0025,  cached: 0.00005  },
      // Fable 5 is $10/$50 per MTok.
      'claude-fable-5':            { input: 0.001,    output: 0.005,   cached: 0.0001   },
      'gpt-4o':            { input: 0.00025,    output: 0.001,    cached: 0.0000125 },
      'gpt-4o-mini':       { input: 0.000015,   output: 0.00006,  cached: 0.0000075 },
      'gemini-2.5-pro':    { input: 0.000125,   output: 0.0005,   cached: 0.0000313 },
      'gemini-2.5-flash':  { input: 0.0000375,  output: 0.00015,  cached: 0.0000094 },
      'gemini-2.0-flash':  { input: 0.00001,    output: 0.00004,  cached: 0.0000025 },
      'gemini-1.5-flash':  { input: 0.0000075,  output: 0.00003,  cached: 0.0000019 },
    };

    const p = pricing[model] ?? { input: 0.0001, output: 0.0001, cached: 0.00001 };
    const nonCachedInput = inputTokens - cachedInputTokens;
    return Math.round(
      nonCachedInput * p.input + cachedInputTokens * p.cached + outputTokens * p.output,
    );
  }
}
