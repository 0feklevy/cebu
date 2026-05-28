import { db } from '../../db/index.js';
import { token_usage } from '../../db/schema.js';
import { eq, and, gte, sql } from 'drizzle-orm';

const DEFAULT_WEEKLY_LIMIT = 100_000;
const DEFAULT_MONTHLY_LIMIT = 500_000;

export class RateLimitService {
  async checkTokenBudget(
    userId: string,
    weeklyLimit?: number | null,
    monthlyLimit?: number | null,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [weekly] = await db
      .select({ total: sql<number>`coalesce(sum(input_tokens + output_tokens), 0)` })
      .from(token_usage)
      .where(and(eq(token_usage.user_id, userId), gte(token_usage.occurred_at, weekAgo)));

    const [monthly] = await db
      .select({ total: sql<number>`coalesce(sum(input_tokens + output_tokens), 0)` })
      .from(token_usage)
      .where(and(eq(token_usage.user_id, userId), gte(token_usage.occurred_at, monthAgo)));

    const wLimit = weeklyLimit ?? DEFAULT_WEEKLY_LIMIT;
    const mLimit = monthlyLimit ?? DEFAULT_MONTHLY_LIMIT;

    if ((weekly?.total ?? 0) >= wLimit) {
      return { allowed: false, reason: 'Weekly token limit exceeded' };
    }
    if ((monthly?.total ?? 0) >= mLimit) {
      return { allowed: false, reason: 'Monthly token limit exceeded' };
    }

    return { allowed: true };
  }
}
