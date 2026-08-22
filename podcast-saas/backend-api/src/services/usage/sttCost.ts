/**
 * What a transcription costs — priced on a duration the VENDOR measured, not one we guessed.
 *
 * ── WHY THIS ONE IS BETTER GROUNDED THAN THE OTHERS ───────────────────────────────────────────
 * The TTS estimator counts characters we sent; the sound-effect estimator assumes a ceiling when
 * the caller does not specify a length. This one has something neither of those does: Groq's
 * `verbose_json` response carries `duration`, the length of audio it actually processed. That is
 * the quantity the invoice is computed from, reported by the party doing the charging.
 *
 * So the usual worry — "is the number being multiplied even right" — does not apply here. Only the
 * rate is an estimate, and a rate is one constant to correct.
 *
 * ── WHY IT MATTERS MORE THAN ITS SIZE SUGGESTS ────────────────────────────────────────────────
 * Corpus ingest runs a transcription and now sits on a durable queue with a retry (#96). A failure
 * anywhere after the transcription — a storage write, a database blip — buys a SECOND
 * transcription on the retry. That is the one path in this product where an ordinary infrastructure
 * hiccup translates directly into a vendor charge, and until this module existed neither charge was
 * recorded.
 */

/**
 * USD per HOUR of audio, worst case.
 *
 * Groq publishes whisper-large-v3 per hour of audio processed. The default here is deliberately
 * above the published figure rather than at it: an estimate under the invoice is a bug, one over
 * it is a pleasant surprise. `GROQ_USD_PER_AUDIO_HOUR` sets the account's real rate.
 */
export const DEFAULT_USD_PER_AUDIO_HOUR = 0.15;

export interface SttCostInput {
  /** Seconds of audio the vendor reported processing. */
  durationSec: number;
  usdPerHour?: number;
}

export interface SttCostEstimate {
  seconds: number;
  costCents: number;
  usd: number;
}

/** Price one transcription. Pure — no clock, no config read, no I/O. Never throws. */
export function estimateSttCost(input: SttCostInput): SttCostEstimate {
  const { durationSec, usdPerHour = DEFAULT_USD_PER_AUDIO_HOUR } = input;
  const seconds = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const usd = (seconds / 3600) * usdPerHour;
  return { seconds, costCents: usd * 100, usd };
}

/** The account's per-hour rate, from the environment, falling back to the pessimistic default. */
export function usdPerAudioHourFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GROQ_USD_PER_AUDIO_HOUR?.trim();
  if (!raw) return DEFAULT_USD_PER_AUDIO_HOUR;
  const n = Number(raw);
  // Zero and nonsense fall back. A zero rate prices every transcription as free, which is the one
  // wrong answer that looks like good news and so is never questioned.
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_USD_PER_AUDIO_HOUR;
}

/**
 * The duration a `verbose_json` transcription reported, or null when it did not report one.
 *
 * NULL RATHER THAN ZERO, and the distinction is the point. A response without a duration means the
 * quantity is UNKNOWN — an older API shape, a different `response_format`, a mocked client. Zero
 * would mean "this transcription was free", and the caller would write a row saying so. The caller
 * has to decide what to do about not knowing, and it cannot decide if the two look identical.
 */
export function reportedDurationSec(transcription: unknown): number | null {
  const d = (transcription as { duration?: unknown } | null)?.duration;
  if (typeof d === 'number' && Number.isFinite(d) && d >= 0) return d;
  // Some shapes report it as a numeric string.
  if (typeof d === 'string') {
    const n = Number(d);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}
