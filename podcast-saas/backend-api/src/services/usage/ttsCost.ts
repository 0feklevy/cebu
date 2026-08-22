/**
 * What a speech-synthesis call costs — the arithmetic, with no I/O in it.
 *
 * ── WHY THIS IS NOT `dubbing/cost.ts` ─────────────────────────────────────────────────────────
 * They price different things. Dubbing bills per source-MINUTE per target language, so a
 * seven-minute video costs the same whether the speaker says forty words or four hundred. TTS bills
 * per CHARACTER of the text handed to it, so the same seven minutes costs whatever was written.
 * One module cannot express both without a flag that means "ignore half these fields", and a
 * flagged calculator is how the wrong branch gets used for a year.
 *
 * ── WHY THE CHARACTER COUNT IS THE REQUEST'S, NOT THE SCRIPT'S ────────────────────────────────
 * The vendor charges for what it receives. A turn that is chunked into four requests is billed on
 * the sum of those four, and a retry after a 500 is billed again — the failed attempt is not
 * refunded because the text still arrived. Counting from the script instead would under-report
 * exactly when things go wrong, which is when the number matters most.
 *
 * ── THE RATE ──────────────────────────────────────────────────────────────────────────────────
 * ElevenLabs sells credits; one credit is one character on the standard models. The dollar price
 * of a credit falls with the plan, so the default here is the WORST case and the account's real
 * rate overrides it. An estimate that comes in under the invoice is a bug; one that comes in over
 * it is a pleasant surprise. Same posture as the dubbing estimator, for the same reason.
 */

/** Credits consumed per character. One-to-one on the models this product uses. */
export const CREDITS_PER_CHARACTER = 1;

/**
 * USD per credit, worst case.
 *
 * The Creator tier is $22 for 100,000 credits, which is $0.00022 a credit — the least favourable
 * per-credit price among the paid tiers, and therefore the right default for an estimate nobody
 * has configured yet. `ELEVENLABS_USD_PER_CREDIT` overrides it once the account's real rate is
 * known, exactly as `DUBBING_USD_PER_CREDIT` does on the other path.
 */
export const DEFAULT_USD_PER_CREDIT = 22 / 100_000;

export interface TtsCostInput {
  /** Characters actually sent to the vendor, summed across chunks and across retries. */
  characters: number;
  /** Overrides the headline rate once the account's real per-credit price is known. */
  usdPerCredit?: number;
}

export interface TtsCostEstimate {
  characters: number;
  credits: number;
  /** Fractional cents, matching `token_usage.cost_cents` — sub-cent calls must not round to free. */
  costCents: number;
  usd: number;
}

/**
 * Price a synthesis. Pure — no clock, no config read, no I/O.
 *
 * A non-finite or negative count prices as zero rather than throwing. This runs on the path that
 * RECORDS a call that has already happened and already cost money; a calculator that can throw
 * would turn a metering bug into a failed render, which is the opposite of the trade this makes.
 */
export function estimateTtsCost(input: TtsCostInput): TtsCostEstimate {
  const { characters, usdPerCredit = DEFAULT_USD_PER_CREDIT } = input;
  const safe = Number.isFinite(characters) && characters > 0 ? Math.round(characters) : 0;
  const credits = safe * CREDITS_PER_CHARACTER;
  const usd = credits * usdPerCredit;
  return { characters: safe, credits, costCents: usd * 100, usd };
}

/** Reads the account's per-credit rate from the environment, falling back to the headline. */
export function usdPerCreditFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ELEVENLABS_USD_PER_CREDIT?.trim();
  if (!raw) return DEFAULT_USD_PER_CREDIT;
  const n = Number(raw);
  // A malformed or nonsensical value falls back rather than pricing everything at zero. A zero
  // rate would make the whole spend surface read "free", which is the one wrong answer that looks
  // like good news and therefore never gets questioned.
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_USD_PER_CREDIT;
}

/**
 * Characters in one dialogue request, counted the way the vendor counts them.
 *
 * Only the spoken text. Audio tags like `[laughs]` are part of the payload and are billed, so they
 * are included — excluding them would under-report, and this number exists to be reconciled
 * against an invoice rather than to flatter anybody.
 */
export function charactersIn(inputs: ReadonlyArray<{ text?: string | null }>): number {
  return inputs.reduce((sum, i) => sum + (i.text?.length ?? 0), 0);
}
