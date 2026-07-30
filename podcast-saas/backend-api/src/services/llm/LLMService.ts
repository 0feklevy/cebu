import { z } from 'zod';
import type { ZodSchema } from 'zod';
import JSON5 from 'json5';
import { LLMProvider, type TaskType, type TokenUsage, type EffortLevel } from './LLMProvider.js';
import { ClaudeProvider } from './ClaudeProvider.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import { GeminiProvider } from './GeminiProvider.js';
import { ApiKeyService } from '../secrets/ApiKeyService.js';
import { UsageTrackingService } from '../usage/UsageTrackingService.js';
import { db } from '../../db/index.js';
import { admin_settings, system_prompts, api_keys, token_usage } from '../../db/schema.js';
import { eq, and, gte, notInArray, sql } from 'drizzle-orm';
import { AppError, LLMErrorType } from 'shared';
import { logger } from '../../lib/logger.js';

export interface SendStructuredOpts<T> {
  task: TaskType;
  systemPrompt: string;
  userPrompt: string;
  previousMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  schema: ZodSchema<T>;
  userId: string | null;      // null when there is no resolved user
  projectId: string | null;   // null for non-project work (e.g. Podcast Studio)
  onTokenChunk?: (chunk: string) => void;
  abortSignal: AbortSignal;
  retryCount?: number;
}

export type SendTextOpts = Omit<SendStructuredOpts<unknown>, 'schema'>;

export interface SendStructuredResult<T> {
  data: T;
  usage: TokenUsage;
  provider: string;
  model: string;
}

type Tier = 'utility' | 'generation' | 'complex' | 'creative';

const ADAPTIVE_MODELS = new Set(['claude-opus-4-7', 'claude-opus-4-8', 'claude-fable-5']);

// Tasks recorded for cost visibility but exempt from the per-user rolling-24h
// generation cap: the moderation pre-screen and cheap automatic background work
// (post-transcode metadata, SEO summaries, ingestion captions, prompt utilities)
// must not silently erode a user's interactive quota.
export const QUOTA_EXEMPT_TASKS = [
  'content_moderation',
  'prompt_enhance',
  'video_metadata',
  'seo_summary',
  'image_caption',
];

const TASK_TIER: Record<TaskType, Tier> = {
  content_moderation: 'utility',
  prompt_enhance: 'utility',
  structural_analysis: 'complex',
  script_draft: 'generation',
  script_rewrite: 'generation', // needs Sonnet-level instruction-following for large JSON output
  single_turn_regen: 'generation',
  bridge_plan: 'complex',       // benefits from strongest model + extended thinking
  guidance_plan: 'complex',     // deep code analysis + structured cue generation
  // Podcast Studio writers' room — highest tier, admin-selected model + effort.
  podcast_architect: 'creative',
  podcast_materials: 'creative',
  podcast_playwright: 'creative',
  podcast_review: 'creative',
  podcast_rewrite: 'creative',
  podcast_compile: 'creative',
  podcast_delivery: 'creative',
  podcast_turn_regen: 'creative',
  podcast_memory: 'creative',
};

export class LLMService {
  // Cached per provider WITH the key it was built from — when ApiKeyService starts
  // returning a rotated key (its cache has a TTL), the provider is rebuilt instead
  // of serving the stale key until restart.
  private providerCache: Map<string, { key: string | null; provider: LLMProvider }> = new Map();

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
        // Creative-tier safety refusal → one transparent retry on Opus 4.8, unless
        // it was already the model that refused.
        if (
          err instanceof AppError &&
          err.details?.refusal === true &&
          TASK_TIER[opts.task] === 'creative' &&
          err.details?.model !== 'claude-opus-4-8'
        ) {
          logger.warn({ task: opts.task, refusedModel: err.details?.model }, 'Creative refusal — retrying on Opus 4.8');
          return await this._sendStructuredOnce(opts, 0, 'claude-opus-4-8');
        }
        throw err;
      }
    }
    throw lastError!;
  }

  private async _sendStructuredOnce<T>(
    opts: SendStructuredOpts<T>,
    attempt: number,
    forceModel?: string,
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

    // Per-user generation quota — OFF by default (generation_limit_enabled=false => unlimited).
    // When an admin enables it, cap a user at generation_daily_limit billable LLM calls per
    // rolling 24h (security-101 cost-DoS guard). content_moderation is a utility pre-screen and
    // is neither blocked nor counted. Only enforced on the first attempt so retries of an
    // already-admitted call aren't double-charged against the cap.
    if (
      settings.generation_limit_enabled &&
      opts.userId &&
      attempt === 0 &&
      opts.task !== 'content_moderation'
    ) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [usage] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(token_usage)
        .where(and(
          eq(token_usage.user_id, opts.userId),
          gte(token_usage.occurred_at, since),
          notInArray(token_usage.task, QUOTA_EXEMPT_TASKS),
        ));
      if ((usage?.count ?? 0) >= settings.generation_daily_limit) {
        throw new AppError(
          LLMErrorType.LIMIT_EXCEEDED,
          'You have reached the generation limit for now. Please try again later.',
          429,
        );
      }
    }

    const { provider, model } = await this.resolveProviderAndModel(
      opts.userId,
      opts.task,
      settings,
      (opts.retryCount ?? 0) + attempt,
      forceModel,
    );

    const tier = TASK_TIER[opts.task];
    const isClaude = provider.providerName === 'claude';
    const isAdaptiveModel = ADAPTIVE_MODELS.has(model);
    // Thinking is wanted for complex + creative work on Claude. On adaptive-only
    // models we signal adaptive thinking (no token budget); on older Claude models
    // we pass the classic thinking budget.
    // Bridge/guidance (complex) is reasoning-heavy code generation — always think on Claude so it
    // runs "high-level" (adaptive thinking on Opus/Fable, classic budget on older Claude),
    // independent of the global toggle. Podcast (creative) thinking stays admin-gated.
    const wantThinking =
      isClaude && (
        tier === 'complex' ||
        (tier === 'creative' && settings.extended_thinking_enabled)
      );
    const thinkingBudget = wantThinking && !isAdaptiveModel ? settings.thinking_budget_tokens : undefined;
    const adaptiveThinking = wantThinking && isAdaptiveModel ? true : undefined;
    // creative → admin-selected effort; complex (bridge/guidance code generation) → high on
    // effort-capable Claude models so simulation bridge scripts get the strongest reasoning
    // (was implicitly the API default; make it explicit and independent of provider defaults).
    const effort: EffortLevel | undefined =
      tier === 'creative' ? (settings.podcast_effort as EffortLevel)
      : (tier === 'complex' && isAdaptiveModel) ? 'high'
      : undefined;
    // Give creative passes generous headroom (streamed) so thinking + a full script fit.
    const maxTokens = tier === 'creative' ? Math.max(settings.max_tokens, 64000) : settings.max_tokens;

    // On retry, reinforce the JSON-only instruction
    const userPrompt =
      attempt > 0
        ? `${opts.userPrompt}\n\nIMPORTANT: Your previous response could not be parsed as JSON. Output ONLY a raw JSON object — no explanation, no markdown, no code fences. Start with { and end with }.`
        : opts.userPrompt;

    logger.debug(
      { task: opts.task, provider: provider.providerName, model, attempt, effort, adaptiveThinking },
      'LLM call starting',
    );

    const response = await provider.sendMessage({
      model,
      systemPrompt: opts.systemPrompt,
      userPrompt,
      previousMessages: opts.previousMessages,
      maxTokens,
      temperature: settings.temperature,
      thinkingBudgetTokens: thinkingBudget,
      effort,
      adaptiveThinking,
      onTokenChunk: opts.onTokenChunk,
      abortSignal: opts.abortSignal,
    });

    // Record usage first — a refused call is still billed, so it must be tracked
    // for cost/quota accuracy before we branch on the refusal. Fail-open: a bad
    // ledger row (e.g. FK violation) must not 500 an already-paid-for response.
    try {
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
    } catch (recordErr) {
      logger.error({ err: recordErr, task: opts.task }, 'usage record failed (continuing)');
    }

    // Safety refusal (Fable/Opus classifiers): surface as a distinct, non-parsing
    // error so it is NOT misdiagnosed as a JSON failure (which would waste parse
    // retries and escalate). sendStructured may retry a creative refusal on Opus.
    if (response.stopReason === 'refusal') {
      throw new AppError(
        LLMErrorType.LLM_ERROR,
        'The model declined this request (safety refusal).',
        502,
        { refusal: true, model },
      );
    }

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
    userId: string | null,
    task: TaskType,
    settings: typeof admin_settings.$inferSelect,
    retryCount: number,
    forceModel?: string,
  ): Promise<{ provider: LLMProvider; model: string }> {
    const tier = TASK_TIER[task];

    // Creative tier (podcast writers' room) always runs on Claude with the
    // admin-selected model — never falls back to the default provider, and is
    // NOT escalated to complex (which would silently swap in a flash model and
    // collapse quality). A refusal fallback may force a specific model.
    if (tier === 'creative') {
      const provider = await this.getProvider('claude');
      return { provider, model: forceModel ?? settings.podcast_model };
    }

    if (forceModel) {
      return { provider: await this.getProvider('claude'), model: forceModel };
    }

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
    const systemKey = await this.apiKeyService.getSystemKey(
      name as 'claude' | 'openai' | 'gemini',
    );

    const envFallback =
      name === 'claude'
        ? process.env.ANTHROPIC_API_KEY
        : name === 'openai'
          ? process.env.OPENAI_API_KEY
          : process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const apiKey = systemKey ?? envFallback ?? null;

    const cached = this.providerCache.get(name);
    if (cached && cached.key === apiKey) return cached.provider;

    let provider: LLMProvider;
    switch (name) {
      case 'claude':
        provider = new ClaudeProvider(apiKey);
        break;
      case 'openai':
        provider = new OpenAIProvider(apiKey);
        break;
      case 'gemini':
        provider = new GeminiProvider(apiKey);
        break;
      default:
        throw new AppError(LLMErrorType.LLM_ERROR, `Unknown provider: ${name}`, 500);
    }

    this.providerCache.set(name, { key: apiKey, provider });
    return provider;
  }

  async sendText(opts: SendTextOpts): Promise<{
    text: string;
    usage: TokenUsage;
    provider: string;
    model: string;
  }> {
    const settings = await db.query.admin_settings.findFirst();
    if (!settings) throw new AppError(LLMErrorType.LLM_ERROR, 'Admin settings not found', 500);

    // Same platform pause switch as the structured path — only the moderation
    // pre-screen itself is exempt (it must keep running to gate other requests).
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
      opts.retryCount ?? 0,
    );

    const response = await provider.sendMessage({
      model,
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      previousMessages: opts.previousMessages,
      maxTokens: settings.max_tokens,
      temperature: settings.temperature,
      onTokenChunk: opts.onTokenChunk,
      abortSignal: opts.abortSignal,
    });

    try {
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
    } catch (recordErr) {
      logger.error({ err: recordErr, task: opts.task }, 'usage record failed (continuing)');
    }

    return { text: response.content, usage: response.usage, provider: provider.providerName, model };
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
    // Convert bare Python literals True/False/None → JSON true/false/null, but ONLY outside of
    // string values. A blanket global replace also rewrote these tokens inside string contents
    // (e.g. a generated bridge's `mainBody` JS source, or any comment/label), silently
    // corrupting the saved script (backend-003). This walks the text tracking string context so
    // only structural literals are touched.
    let out = '';
    let inString = false;
    let quote = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        out += ch;
        if (ch === '\\') {                       // copy the escaped char verbatim
          if (i + 1 < s.length) { out += s[i + 1]; i++; }
          continue;
        }
        if (ch === quote) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; continue; }
      // Outside a string: replace a bare literal only when it isn't part of a longer identifier.
      const prevAlnum = i > 0 && /[A-Za-z0-9_]/.test(s[i - 1]);
      const m = !prevAlnum ? /^(True|False|None)\b/.exec(s.slice(i)) : null;
      if (m) {
        out += m[1] === 'True' ? 'true' : m[1] === 'False' ? 'false' : 'null';
        i += m[1].length - 1;
        continue;
      }
      out += ch;
    }
    return out;
  }

  private stripTrailingCommas(s: string): string {
    return s.replace(/,\s*([\]}])/g, '$1');
  }
}
