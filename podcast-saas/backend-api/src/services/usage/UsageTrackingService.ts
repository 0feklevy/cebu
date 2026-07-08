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
}

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
    });
  }
}
