import { z } from 'zod';
import type { ZodSchema } from 'zod';
import JSON5 from 'json5';
import { LLMProvider, type TaskType, type TokenUsage } from './LLMProvider.js';
import { ClaudeProvider } from './ClaudeProvider.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import { GeminiProvider } from './GeminiProvider.js';
import { ApiKeyService } from '../secrets/ApiKeyService.js';
import { UsageTrackingService } from '../usage/UsageTrackingService.js';
import { db } from '../../db/index.js';
import { admin_settings, system_prompts, api_keys } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { AppError, LLMErrorType } from 'shared';
import { logger } from '../../lib/logger.js';

export interface SendStructuredOpts<T> {
  task: TaskType;
  systemPrompt: string;
  userPrompt: string;
  schema: ZodSchema<T>;
  userId: string;
  projectId: string;
  onTokenChunk?: (chunk: string) => void;
  abortSignal: AbortSignal;
  retryCount?: number;
}

export interface SendStructuredResult<T> {
  data: T;
  usage: TokenUsage;
  provider: string;
  model: string;
}

const TASK_TIER: Record<TaskType, 'utility' | 'generation' | 'complex'> = {
  content_moderation: 'utility',
  structural_analysis: 'complex',
  script_draft: 'generation',
  script_rewrite: 'generation', // needs Sonnet-level instruction-following for large JSON output
  single_turn_regen: 'generation',
};

export class LLMService {
  private providerCache: Map<string, LLMProvider> = new Map();

  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly usageTracking: UsageTrackingService,
  ) {}

  async sendStructured<T>(opts: SendStructuredOpts<T>): Promise<SendStructuredResult<T>> {
    const MAX_PARSE_RETRIES = 2;
    let lastError: AppError | undefined;

    for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
      try {
        return await this._sendStructuredOnce(opts, attempt);
      } catch (err) {
        if (err instanceof AppError && err.error_type === LLMErrorType.PARSING_ERROR) {
          lastError = err;
          logger.warn({ task: opts.task, attempt }, 'JSON parse failed, retrying');
          continue;
        }
        throw err;
      }
    }
    throw lastError!;
  }

  private async _sendStructuredOnce<T>(
    opts: SendStructuredOpts<T>,
    attempt: number,
  ): Promise<SendStructuredResult<T>> {
    const settings = await db.query.admin_settings.findFirst();
    if (!settings) throw new AppError(LLMErrorType.LLM_ERROR, 'Admin settings not found', 500);

    if (settings.generation_paused && opts.task !== 'content_moderation') {
      throw new AppError(
        LLMErrorType.GENERATION_PAUSED,
        settings.generation_paused_message ?? 'Generation is paused',
        503,
      );
    }

    const { provider, model } = await this.resolveProviderAndModel(
      opts.userId,
      opts.task,
      settings,
      (opts.retryCount ?? 0) + attempt,
    );

    const thinkingBudget =
      settings.extended_thinking_enabled &&
      TASK_TIER[opts.task] === 'complex' &&
      provider.providerName === 'claude'
        ? settings.thinking_budget_tokens
        : undefined;

    // On retry, reinforce the JSON-only instruction
    const userPrompt =
      attempt > 0
        ? `${opts.userPrompt}\n\nIMPORTANT: Your previous response could not be parsed as JSON. Output ONLY a raw JSON object — no explanation, no markdown, no code fences. Start with { and end with }.`
        : opts.userPrompt;

    logger.debug(
      { task: opts.task, provider: provider.providerName, model, attempt },
      'LLM call starting',
    );

    const response = await provider.sendMessage({
      model,
      systemPrompt: opts.systemPrompt,
      userPrompt,
      maxTokens: settings.max_tokens,
      temperature: settings.temperature,
      thinkingBudgetTokens: thinkingBudget,
      onTokenChunk: opts.onTokenChunk,
      abortSignal: opts.abortSignal,
    });

    // Record usage
    await this.usageTracking.record({
      userId: opts.userId,
      projectId: opts.projectId,
      provider: provider.providerName,
      model,
      task: opts.task,
      inputTokens: response.usage.input,
      cachedInputTokens: response.usage.cached_input,
      outputTokens: response.usage.output,
      costCents: response.usage.cost_cents,
      usedPersonalKey: false,
    });

    // Parse and validate
    const parsed = this.parseAndRepair(response.content, opts.schema);

    return {
      data: parsed,
      usage: response.usage,
      provider: provider.providerName,
      model,
    };
  }

  private async resolveProviderAndModel(
    userId: string,
    task: TaskType,
    settings: typeof admin_settings.$inferSelect,
    retryCount: number,
  ): Promise<{ provider: LLMProvider; model: string }> {
    const tier = TASK_TIER[task];

    // Escalate to complex tier on retries
    const effectiveTier =
      retryCount >= (settings.complex_min_retries ?? 2) ? 'complex' : tier;

    const providerName = settings.default_provider;
    const provider = await this.getProvider(providerName);

    let model: string;
    switch (effectiveTier) {
      case 'utility':
        model = settings.utility_model;
        break;
      case 'complex':
        model = settings.complex_model;
        break;
      default:
        model = settings.generation_model;
    }

    return { provider, model };
  }

  private async getProvider(name: string): Promise<LLMProvider> {
    if (this.providerCache.has(name)) return this.providerCache.get(name)!;

    const apiKey = await this.apiKeyService.getSystemKey(
      name as 'claude' | 'openai' | 'gemini',
    );

    let provider: LLMProvider;
    switch (name) {
      case 'claude':
        provider = new ClaudeProvider(apiKey ?? process.env.ANTHROPIC_API_KEY ?? null);
        break;
      case 'openai':
        provider = new OpenAIProvider(apiKey ?? process.env.OPENAI_API_KEY ?? null);
        break;
      case 'gemini':
        provider = new GeminiProvider(
          apiKey ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? null,
        );
        break;
      default:
        throw new AppError(LLMErrorType.LLM_ERROR, `Unknown provider: ${name}`, 500);
    }

    this.providerCache.set(name, provider);
    return provider;
  }

  invalidateProviderCache(providerName?: string): void {
    if (providerName) {
      this.providerCache.delete(providerName);
    } else {
      this.providerCache.clear();
    }
  }

  private parseAndRepair<T>(raw: string, schema: ZodSchema<T>): T {
    const stripped = this.stripCodeFences(raw);
    const normalized = this.normalizePythonLiterals(stripped);
    const noTrailingComma = this.stripTrailingCommas(normalized);

    // Attempt to extract JSON object from text that has preamble/postamble
    const extractObject = (s: string) => {
      const start = s.indexOf('{');
      const end = s.lastIndexOf('}');
      if (start !== -1 && end > start) return s.slice(start, end + 1);
      throw new Error('no object found');
    };

    const repairs = [
      () => JSON.parse(raw),
      () => JSON.parse(stripped),
      () => JSON.parse(normalized),
      () => JSON.parse(noTrailingComma),
      () => JSON5.parse(stripped),
      () => JSON.parse(extractObject(raw)),
      () => JSON5.parse(extractObject(normalized)),
    ];

    let lastSchemaError: AppError | undefined;

    for (const repair of repairs) {
      try {
        const obj = repair();
        const result = schema.safeParse(obj);
        if (result.success) return result.data;
        // JSON parsed but schema failed
        const schemaIssues = result.error.errors.slice(0, 5);
        logger.warn({ schemaIssues, rawPreview: raw.slice(0, 300) }, 'Schema validation failed after JSON parse');
        lastSchemaError = new AppError(
          LLMErrorType.PARSING_ERROR,
          `Schema validation failed: ${JSON.stringify(schemaIssues)}`,
          422,
        );
      } catch (e) {
        if (e instanceof AppError) throw e;
        // JSON parse failed — try next repair
      }
    }

    // If schema validation was the closest we got, surface that error
    if (lastSchemaError) throw lastSchemaError;

    logger.error({ rawLen: raw.length, rawPreview: raw.slice(0, 800) }, 'All JSON repair attempts failed — raw LLM output shown');
    throw new AppError(
      LLMErrorType.PARSING_ERROR,
      'Failed to parse LLM response as valid JSON after all repair attempts',
      422,
    );
  }

  private stripCodeFences(s: string): string {
    return s.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  }

  private normalizePythonLiterals(s: string): string {
    return s.replace(/\bFalse\b/g, 'false').replace(/\bTrue\b/g, 'true').replace(/\bNone\b/g, 'null');
  }

  private stripTrailingCommas(s: string): string {
    return s.replace(/,\s*([\]}])/g, '$1');
  }
}
