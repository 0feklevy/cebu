/**
 * ── Why dubbing needs a ceiling and the rest of the pipeline does not ─────────────────────────
 *
 * Dubbing is the most expensive per-unit operation in this product: roughly $2.20 per source
 * minute PER TARGET LANGUAGE, billed by the vendor on job creation. A ten-minute lesson into five
 * languages is ~$110 from one button press, and nothing about pressing it five times in a row is
 * unusual creator behaviour.
 *
 * The cost is already metered (`video_dubs.cost_cents`) and shown before the run
 * (`estimateProjectDubCost`), but showing a price is not a limit. This module is the limit.
 *
 * TWO PROPERTIES MATTER, and they are the reason this is a separate check rather than a clause
 * inside the controller:
 *
 *   1. It refuses BEFORE the vendor is called. A ceiling enforced after `POST /v1/dubbing/project`
 *      has already been billed is not a ceiling, it is a report. The controller calls this ahead
 *      of `requestProjectDub`, and the test asserts the provider was never invoked.
 *   2. It counts what was SPENT, not what succeeded. A failed dub still cost money — the vendor
 *      bills on creation, and `video_dubs` keeps the row with its `cost_cents`. Excluding failures
 *      would let a user with a broken source file spend without bound.
 *
 * The window is the calendar month in UTC. Not a rolling 30 days: a creator asking "how much have
 * I spent this month" means the month on the calendar, and a rolling window makes a refusal
 * impossible to reason about ("it worked yesterday" is true and unhelpful).
 */

import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { projects, video_dubs, video_files } from '../../db/schema.js';

/** Default ceiling when unset: generous for a real creator, ruinous for nobody. */
export const DEFAULT_DUBBING_MONTHLY_BUDGET_CENTS = 5000;

export interface DubbingBudgetVerdict {
  /** Whether the run may proceed. */
  allowed: boolean;
  /** Fractional cents already spent this calendar month by this user. */
  spentCents: number;
  /** The ceiling in force. */
  budgetCents: number;
  /** What this run is estimated to add. */
  estimateCents: number;
  /** True when the user is exempt — the ceiling is not evaluated at all. */
  exempt: boolean;
  /** Creator-facing explanation, set only on refusal. */
  reason: string | null;
}

export function dubbingMonthlyBudgetCents(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DUBBING_MONTHLY_BUDGET_CENTS?.trim();
  if (!raw) return DEFAULT_DUBBING_MONTHLY_BUDGET_CENTS;
  const parsed = Number(raw);
  // A zero or negative ceiling would silently disable dubbing for everyone, which is a
  // configuration mistake rather than an intent — fall back rather than lock the product.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DUBBING_MONTHLY_BUDGET_CENTS;
}

/** Users the ceiling never applies to — the operator's own account while dubbing is owner-only. */
export function dubbingBudgetExemptUserIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.DUBBING_BUDGET_EXEMPT_USER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** First instant of the current calendar month, UTC. */
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * Fractional cents this user has spent on dubbing since the start of the UTC month.
 *
 * Ownership is `projects.created_by` — the account that will be invoiced — reached through
 * `video_files`, because `video_dubs` hangs off a video and not off a project directly.
 */
export async function dubbingSpentThisMonth(userId: string, now = new Date()): Promise<number> {
  const owned = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.created_by, userId));
  if (owned.length === 0) return 0;

  const videos = await db
    .select({ id: video_files.id })
    .from(video_files)
    .where(inArray(video_files.project_id, owned.map((p) => p.id)));
  if (videos.length === 0) return 0;

  const [row] = await db
    .select({ total: sql<string | null>`COALESCE(SUM(${video_dubs.cost_cents}), 0)` })
    .from(video_dubs)
    .where(
      and(
        inArray(video_dubs.video_file_id, videos.map((v) => v.id)),
        gte(video_dubs.created_at, monthStartUtc(now)),
      ),
    );

  const total = Number(row?.total ?? 0);
  return Number.isFinite(total) ? total : 0;
}

/**
 * Decide whether a run may proceed. Pure arithmetic over the two inputs, so the policy is
 * testable without a database and the refusal copy has exactly one source.
 */
export function judgeDubbingBudget(input: {
  userId: string;
  spentCents: number;
  estimateCents: number;
  env?: NodeJS.ProcessEnv;
}): DubbingBudgetVerdict {
  const env = input.env ?? process.env;
  const budgetCents = dubbingMonthlyBudgetCents(env);
  const exempt = dubbingBudgetExemptUserIds(env).has(input.userId);
  const spentCents = Math.max(0, input.spentCents);
  const estimateCents = Math.max(0, input.estimateCents);

  if (exempt) {
    return { allowed: true, spentCents, budgetCents, estimateCents, exempt: true, reason: null };
  }

  const projected = spentCents + estimateCents;
  if (projected <= budgetCents) {
    return { allowed: true, spentCents, budgetCents, estimateCents, exempt: false, reason: null };
  }

  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const remaining = Math.max(0, budgetCents - spentCents);
  return {
    allowed: false,
    spentCents,
    budgetCents,
    estimateCents,
    exempt: false,
    reason:
      `Dubbing this project would cost about ${usd(estimateCents)}, and only ${usd(remaining)} of ` +
      `your ${usd(budgetCents)} monthly dubbing budget is left (${usd(spentCents)} used). ` +
      `The budget resets at the start of next month.`,
  };
}

/** The database-backed check the controller calls before anything billable happens. */
export async function checkDubbingBudget(input: {
  userId: string;
  estimateCents: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<DubbingBudgetVerdict> {
  const env = input.env ?? process.env;
  // An exempt user is not worth three queries — decide before touching the database.
  if (dubbingBudgetExemptUserIds(env).has(input.userId)) {
    return judgeDubbingBudget({ ...input, spentCents: 0, env });
  }
  const spentCents = await dubbingSpentThisMonth(input.userId, input.now ?? new Date());
  return judgeDubbingBudget({ ...input, spentCents, env });
}
