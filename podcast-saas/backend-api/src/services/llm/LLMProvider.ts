import type { z } from 'zod';
import { logger } from '../../lib/logger.js';

export type TaskType =
  | 'structural_analysis'
  | 'script_draft'
  | 'script_rewrite'
  | 'content_moderation'
  | 'prompt_enhance'
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
  | 'podcast_memory'
  // Raise Your Hand (P3-B/A2.4) — a listener's question about the moment they are at.
  | 'listener_question';

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
  /**
   * The STABLE leading part of the system prompt, when the caller has one
   * (llm-pipeline-007).
   *
   * Prompt caching is a PREFIX match: only a byte-identical leading span is ever
   * read back. Pass the frozen head here and leave the per-call remainder in
   * `systemPrompt` — the two are concatenated in that order on the wire and only
   * this block is marked cacheable, so the volatile tail stops invalidating it.
   */
  systemPromptCachePrefix?: string;
  /**
   * Opt OUT of caching the system prompt. Default true, because several callers
   * deliberately build a byte-stable system prompt and re-send it (see
   * SimulationService.buildContextPrompt, whose entries are sorted precisely so
   * the bridge/guidance prompt caches across refinement turns) — those get real
   * cache reads and must keep them.
   *
   * Set false when the prompt is KNOWN to be unique per call. Caching one of
   * those pays the 1.25x cache-write premium on every request for an entry no
   * later request can ever read.
   */
  systemPromptCacheable?: boolean;
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
  /**
   * Absolute wall-clock deadline (ms) for the WHOLE logical call, stamped once by LLMService's
   * public entry point and reused by every retry. Providers never read it — LLMService converts it
   * into the signal they do read — but it must travel with the payload so a retry cannot silently
   * mint itself a fresh budget. See services/llm/deadline.ts.
   */
  deadlineAt?: number;
}

export interface LLMResponse {
  content: string;
  usage: TokenUsage;
  model: string;
  stopReason?: string;
}

/**
 * Cents per token (= $/1M tokens / 10,000), by model id.
 *
 * Exported so pricing.test.ts can assert it covers every model a provider
 * advertises: an admin-selectable model with no entry here silently stopped
 * being priced (llm-pipeline-008).
 */
export const MODEL_PRICING_CENTS_PER_TOKEN: Readonly<
  Record<string, { input: number; output: number; cached: number }>
> = {
    // Haiku 4.5 is $1/$5 per MTok. It was priced here at $0.80/$4.00 — the
    // Haiku 3.5 rate card — so every utility-tier row was 20% light
    // (llm-pipeline-008). Cache reads are 0.1x the input rate.
    'claude-haiku-4-5':          { input: 0.0001,   output: 0.0005,  cached: 0.00001  },
    'claude-haiku-4-5-20251001': { input: 0.0001,   output: 0.0005,  cached: 0.00001  },
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
    // An id nobody priced used to fall back to an INVENTED rate, which put a
    // confident, wrong number in the ledger with nothing to distinguish it from
    // a real one (llm-pipeline-008). Say so loudly and record 0 instead: an
    // explicit "we could not price this" is recoverable, a fabricated figure is
    // not. Routable models cannot reach this branch — pricing.test.ts
    // fails the build if any model a provider advertises is missing above.
    const p = MODEL_PRICING_CENTS_PER_TOKEN[model];
    if (!p) {
      logger.error(
        { event: 'llm_unpriced_model', model, inputTokens, outputTokens, cachedInputTokens },
        `No price on file for model "${model}" — recording this call at 0 cents. The cost ledger under-reports until it is added to LLMProvider's rate card.`,
      );
      return 0;
    }
    const nonCachedInput = inputTokens - cachedInputTokens;
    // Fractional cents (4 dp) — whole-cent rounding recorded every sub-cent
    // utility/Haiku call as 0 and made the moderation/enhance stream read as free.
    const cents = nonCachedInput * p.input + cachedInputTokens * p.cached + outputTokens * p.output;
    return Math.round(cents * 10_000) / 10_000;
  }
}
