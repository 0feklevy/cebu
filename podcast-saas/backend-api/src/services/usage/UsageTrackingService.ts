import { db } from '../../db/index.js';
import { token_usage } from '../../db/schema.js';

export interface RecordUsageOpts {
  userId: string | null;      // null when the caller has no resolved user
  projectId: string | null;   // null for non-project work (e.g. Podcast Studio)
  provider: string;
  model: string;
  task: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
  usedPersonalKey: boolean;
  /**
   * How much was bought, in `unit` — for the vendors that do not sell tokens.
   *
   * TTS bills per CHARACTER, dubbing per SOURCE-MINUTE, avatars per SESSION-MINUTE. Recording
   * those as `inputTokens` would let the admin surface add characters to tokens and print a total
   * that means nothing, which is a worse failure than the invisibility it replaces: a number gets
   * believed. Omit both for an LLM call — its amount is already in the token columns.
   */
  quantity?: number;
  unit?: UsageUnit;
}

/** The units this product actually buys in. `tokens` is implicit for LLM rows and left unset. */
export type UsageUnit = 'characters' | 'source_minutes' | 'session_minutes' | 'images' | 'tokens';

export class UsageTrackingService {
  async record(opts: RecordUsageOpts): Promise<void> {
    await db.insert(token_usage).values({
      user_id: opts.userId || null,   // '' / null → NULL (avoids invalid-uuid inserts)
      project_id: opts.projectId ?? null,
      provider: opts.provider,
      model: opts.model,
      task: opts.task,
      input_tokens: opts.inputTokens,
      cached_input_tokens: opts.cachedInputTokens,
      output_tokens: opts.outputTokens,
      cost_cents: opts.costCents,
      used_personal_key: opts.usedPersonalKey,
      quantity: opts.quantity ?? null,
      unit: opts.unit ?? null,
    });
  }
}
