/**
 * A spend ceiling that covers every provider, not only dubbing.
 *
 * ── WHY THE EXISTING ONE IS NOT ENOUGH ────────────────────────────────────────────────────────
 * `dubbing/budget.ts` sums `video_dubs.cost_cents`. It is a good guard and it can only see dubs.
 * On 22 August the money went out through speech synthesis, which that guard cannot observe at
 * all — and Auto Top-Up meant there was no natural stop either. Every path records to
 * `token_usage` now, so a ceiling can finally be asked the whole question.
 *
 * ── WHY IT SHIPS IN SHADOW MODE ───────────────────────────────────────────────────────────────
 * A ceiling that blocks is a ceiling that can take the product down at three in the morning on a
 * default nobody chose. The dubbing guard is per-user and was consented to; an account-wide one
 * introduced tonight has no such history, and the first thing anybody needs from it is to know
 * whether the number is even right.
 *
 * So `shadow` is the default: it evaluates, logs, and lets the work through. `enforce` turns it
 * into a refusal once the owner has watched it for a while and set a figure they believe. `off`
 * exists for the same reason every kill switch does.
 *
 * This mirrors `AVATAR_BUDGET_MODE`, which is still in shadow for exactly this reason — and
 * copying that posture deliberately is better than inventing a second one.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { token_usage } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';

export type SpendCeilingMode = 'off' | 'shadow' | 'enforce';

export interface SpendCeilingVerdict {
  mode: SpendCeilingMode;
  /** Whether the work should be refused. Only ever true in `enforce`. */
  refuse: boolean;
  /** True when the ceiling WOULD have refused — the signal shadow mode exists to produce. */
  wouldRefuse: boolean;
  spentCents: number;
  ceilingCents: number;
  /** Human-readable, for a log line in shadow and for the caller's error in enforce. */
  reason: string | null;
}

/** Off by default in the sense that matters: nothing is refused until somebody opts in. */
export function spendCeilingMode(env: NodeJS.ProcessEnv = process.env): SpendCeilingMode {
  const raw = env.SPEND_CEILING_MODE?.trim().toLowerCase();
  return raw === 'enforce' || raw === 'off' ? raw : 'shadow';
}

/**
 * The ceiling for one provider, in cents, or null when none is configured.
 *
 * Per provider rather than one global number, because the providers are not interchangeable: a
 * month of LLM calls and a month of speech synthesis have completely different shapes, and one
 * combined figure would be set for whichever dominates and would never bind on the other.
 *
 * NULL MEANS NO CEILING, and that is deliberately distinct from zero. Zero would mean "refuse
 * everything", which is a thing an operator might genuinely want and must be able to say.
 */
export function ceilingForProvider(provider: string, env: NodeJS.ProcessEnv = process.env): number | null {
  const key = `SPEND_CEILING_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CENTS`;
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  // A malformed value means NO ceiling rather than a zero one: reading "abc" as "refuse
  // everything" would take the product down over a typo.
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Decide. Pure arithmetic over the inputs, so the policy is testable without a database and the
 * refusal wording has exactly one source.
 *
 * The comparison includes what is ABOUT to be spent, because a ceiling checked only against
 * history lets the single largest call through every time — and the largest call is the one worth
 * stopping. An unknown forthcoming cost counts as zero, which is the honest reading of "we do not
 * know yet" and keeps this from refusing on a guess.
 */
export function judgeSpendCeiling(input: {
  mode: SpendCeilingMode;
  provider: string;
  spentCents: number;
  ceilingCents: number | null;
  aboutToSpendCents?: number;
}): SpendCeilingVerdict {
  const { mode, provider, ceilingCents } = input;
  const spentCents = Number.isFinite(input.spentCents) && input.spentCents > 0 ? input.spentCents : 0;
  const pending = Number.isFinite(input.aboutToSpendCents) && (input.aboutToSpendCents ?? 0) > 0
    ? input.aboutToSpendCents!
    : 0;

  if (mode === 'off' || ceilingCents === null) {
    return { mode, refuse: false, wouldRefuse: false, spentCents, ceilingCents: ceilingCents ?? 0, reason: null };
  }

  const projected = spentCents + pending;
  const over = projected > ceilingCents;
  const reason = over
    ? `${provider} spend this month would reach $${(projected / 100).toFixed(2)}, over the ` +
      `$${(ceilingCents / 100).toFixed(2)} ceiling (SPEND_CEILING_${provider.toUpperCase()}_CENTS).`
    : null;

  return {
    mode,
    // Only `enforce` refuses. Shadow reports and lets the work through — see the header.
    refuse: mode === 'enforce' && over,
    wouldRefuse: over,
    spentCents,
    ceilingCents,
    reason,
  };
}

/**
 * What one provider has cost this calendar month, in cents, across every path.
 *
 * ACCOUNT-WIDE, not per user. The dubbing guard is per user because a dub is something a person
 * asks for and should be answerable for. This one exists for the failure the per-user guard cannot
 * see: an automated loop spending on nobody's behalf, which is what Auto Top-Up turns into an
 * unbounded bill. A per-user sum would show every individual comfortably inside their limit while
 * the account drained.
 *
 * Reads `token_usage`, which every paid path now writes to.
 */
export async function providerSpentThisMonthCents(provider: string, now = new Date()): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({ total: sql<string | null>`COALESCE(SUM(${token_usage.cost_cents}), 0)` })
    .from(token_usage)
    .where(and(eq(token_usage.provider, provider), gte(token_usage.occurred_at, monthStart)));

  const total = Number(row?.total ?? 0);
  // A broken query must not read as "spent nothing" OR as a refusal. Zero is the safe answer here
  // because the mode above decides what to do with it, and shadow is the default.
  return Number.isFinite(total) && total > 0 ? total : 0;
}

/**
 * Evaluate the ceiling for a provider, ready to log or to refuse on.
 *
 * Never throws: it runs in front of work the caller is about to do, and a ceiling that can fail the
 * request it was meant to protect is worse than no ceiling. A failure reads as "no opinion".
 */
export async function evaluateSpendCeiling(args: {
  provider: string;
  aboutToSpendCents?: number;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<SpendCeilingVerdict> {
  const env = args.env ?? process.env;
  const mode = spendCeilingMode(env);
  const ceilingCents = ceilingForProvider(args.provider, env);
  if (mode === 'off' || ceilingCents === null) {
    return { mode, refuse: false, wouldRefuse: false, spentCents: 0, ceilingCents: ceilingCents ?? 0, reason: null };
  }

  // No initializer on purpose: every path below either assigns it or returns, and a `= 0`
  // default here is exactly the kind of value that leaks into a verdict if the try is ever
  // restructured. Let the compiler prove assignment instead.
  let spentCents: number;
  try {
    spentCents = await providerSpentThisMonthCents(args.provider, args.now);
  } catch (err) {
    logger.warn(
      { provider: args.provider, err: (err as Error).message?.slice(0, 160) },
      '[usage] spend ceiling could not read the ledger — proceeding without an opinion',
    );
    return { mode, refuse: false, wouldRefuse: false, spentCents: 0, ceilingCents, reason: null };
  }

  const verdict = judgeSpendCeiling({ mode, provider: args.provider, spentCents, ceilingCents, aboutToSpendCents: args.aboutToSpendCents });
  if (verdict.wouldRefuse) {
    logger.warn(
      { provider: args.provider, spentCents, ceilingCents, mode, enforced: verdict.refuse },
      verdict.refuse
        ? '[usage] spend ceiling REFUSED this work'
        : '[usage] spend ceiling would have refused this work (shadow mode)',
    );
  }
  return verdict;
}
