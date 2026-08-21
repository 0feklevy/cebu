/**
 * What a dub costs, and where every number in that answer comes from.
 *
 * Dubbing is by a wide margin the most expensive per-unit operation in this product, and it is
 * billed PER MINUTE OF SOURCE MEDIA, PER TARGET LANGUAGE — dubbing a 10-minute video into Hebrew
 * and Spanish is two 10-minute charges, not one. That multiplication is the number a creator most
 * needs to see BEFORE a job runs, which is why this module is pure: the same function produces the
 * estimate shown in the UI and the figure written to the usage ledger, so the two cannot disagree.
 *
 * ── The credit table (vendor pricing page) ────────────────────────────────────────────────────
 *   Automatic, WITH watermark      2,000 credits/min
 *   Automatic, WITHOUT watermark   3,000 credits/min
 *   Dubbing Studio, with           5,000 credits/min
 *   Dubbing Studio, without       10,000 credits/min
 *
 * Two traps live in that table. The API's DEFAULT is `watermark: false`, which is the 1.5x row —
 * the expensive option is what you get by not thinking about it. And `dubbing_studio: true` costs
 * 2.5x–3.3x the automatic equivalent; this product never sets it, because nothing here edits a dub
 * by hand and paying for an editable resource nobody edits is pure waste.
 *
 * ── The dollar figure ─────────────────────────────────────────────────────────────────────────
 * The vendor's headline is "Dubbing v2 starting at $2.20 per minute". That is the WORST case — a
 * per-credit rate falls on higher plans, and third-party analyses put the effective range at
 * roughly $0.33–$2.20/min. This module therefore defaults to the headline $2.20 rather than a
 * flattering guess: an estimate that comes in under the invoice is a bug, an estimate that comes
 * in over it is a pleasant surprise. `DUBBING_USD_PER_CREDIT` overrides it once the account's real
 * per-credit rate is known, and the estimate the UI shows moves with it.
 */

/** Credits per source-minute, per language, at the settings this product actually sends. */
export const CREDITS_PER_MINUTE_AUTOMATIC_WATERMARKED = 2_000;
export const CREDITS_PER_MINUTE_AUTOMATIC_CLEAN = 3_000;

/**
 * USD per credit implied by the vendor's own "$2.20 per minute" headline at the clean-automatic
 * rate of 3,000 credits/min. Kept as a per-credit rate rather than a per-minute one so that
 * changing the plan (which changes the credit price, not the credit count) is one number.
 */
export const DEFAULT_USD_PER_CREDIT = 2.20 / CREDITS_PER_MINUTE_AUTOMATIC_CLEAN;

export interface DubbingCostInput {
  /** Source media length in seconds. Billing is per minute OF SOURCE, whatever the dub's length. */
  durationSec: number;
  /** How many target languages this run covers. Each one is billed the full source duration. */
  languageCount: number;
  /** Whether the output carries the vendor watermark — the cheaper rate, and unshippable. */
  watermarked: boolean;
  /** Overrides the headline rate once the account's real per-credit price is known. */
  usdPerCredit?: number;
}

export interface DubbingCostEstimate {
  /** Source minutes, unrounded — the figure reconciled against the vendor invoice. */
  minutes: number;
  /** Credits per source-minute per language, from the table above. */
  creditsPerMinute: number;
  /** Total credits across every language in this run. */
  credits: number;
  /** Total cost in fractional cents, matching `token_usage.cost_cents`. */
  costCents: number;
  /** Total cost in USD, for display. */
  usd: number;
}

/**
 * Price a dubbing run. Pure — no clock, no config read, no I/O.
 *
 * A non-finite or negative duration prices as zero rather than throwing: this function is called
 * on the read path to render an estimate, and a video whose duration has not been probed yet
 * should show "no estimate", never take down the settings page.
 */
export function estimateDubbingCost(input: DubbingCostInput): DubbingCostEstimate {
  const { durationSec, languageCount, watermarked, usdPerCredit = DEFAULT_USD_PER_CREDIT } = input;

  const safeSeconds = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const safeLanguages = Number.isFinite(languageCount) && languageCount > 0 ? Math.floor(languageCount) : 0;

  const minutes = safeSeconds / 60;
  const creditsPerMinute = watermarked
    ? CREDITS_PER_MINUTE_AUTOMATIC_WATERMARKED
    : CREDITS_PER_MINUTE_AUTOMATIC_CLEAN;

  const credits = minutes * creditsPerMinute * safeLanguages;
  const usd = credits * usdPerCredit;

  return { minutes, creditsPerMinute, credits, costCents: usd * 100, usd };
}

/**
 * The per-source-minute price for ONE language, which is the figure the creator UI leads with.
 *
 * Separated from the total because "$2.20 per minute, per language" is the sentence a creator can
 * actually reason about, and deriving it from a total would divide by zero for a video whose
 * duration is still unknown.
 */
export function usdPerMinutePerLanguage(
  watermarked: boolean,
  usdPerCredit: number = DEFAULT_USD_PER_CREDIT,
): number {
  const creditsPerMinute = watermarked
    ? CREDITS_PER_MINUTE_AUTOMATIC_WATERMARKED
    : CREDITS_PER_MINUTE_AUTOMATIC_CLEAN;
  return creditsPerMinute * usdPerCredit;
}
