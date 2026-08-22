/**
 * What a generated sound effect costs — and an honest account of how well that is known.
 *
 * ── THE UNCERTAINTY IS THE POINT OF THIS COMMENT ──────────────────────────────────────────────
 * ElevenLabs bills sound generation by the DURATION of the audio it produces, not by the length of
 * the prompt. The exact credits-per-second figure is a published number I do not have in front of
 * me, and the rest of this file is built so that not knowing it is survivable rather than hidden.
 *
 * Two things follow from that, and they matter more than the rate itself:
 *
 *   1. The QUANTITY recorded — seconds of audio requested — is measured, not estimated. It comes
 *      from the request. Whatever the rate turns out to be, the usage row will support recomputing
 *      the cost correctly, because the thing being multiplied is right.
 *   2. The RATE is a single overridable constant with a deliberately PESSIMISTIC default. An
 *      estimate that comes in under the invoice is a bug; one that comes in over it is a pleasant
 *      surprise. Same posture as the dubbing and TTS estimators, for the same reason.
 *
 * When the account's real rate is known, set `ELEVENLABS_USD_PER_SFX_SECOND` and every future row
 * prices correctly. The recorded seconds mean the past can be recomputed too — which is the whole
 * reason `quantity` and `unit` exist on the row rather than a bare `cost_cents`.
 */

/**
 * USD per second of generated audio, worst case.
 *
 * Chosen ABOVE the plausible range rather than inside it. A sound effect is a few seconds long, so
 * a generous rate overstates a single generation by pennies — while an optimistic one would let a
 * loop of generations look free, which is the failure mode that goes unnoticed.
 */
export const DEFAULT_USD_PER_SFX_SECOND = 0.01;

/**
 * What the vendor charges for when the caller does not ask for a length.
 *
 * The request schema allows 0.5–22 seconds and makes it optional; unspecified means the vendor
 * picks. Pricing an unspecified request at zero would make exactly the laziest call shape free, so
 * it is priced at the ceiling the API allows. Overstating an unknown is the safe direction.
 */
export const UNSPECIFIED_SFX_SECONDS = 22;

export interface SfxCostInput {
  /** Seconds requested, or null/undefined when the caller let the vendor choose. */
  durationSeconds?: number | null;
  usdPerSecond?: number;
}

export interface SfxCostEstimate {
  seconds: number;
  costCents: number;
  usd: number;
  /** True when the length was not specified and the ceiling was assumed. */
  assumedDuration: boolean;
}

/** Price one sound generation. Pure — no clock, no config read, no I/O. Never throws. */
export function estimateSfxCost(input: SfxCostInput = {}): SfxCostEstimate {
  const { durationSeconds, usdPerSecond = DEFAULT_USD_PER_SFX_SECOND } = input;
  const specified = typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0;
  const seconds = specified ? durationSeconds : UNSPECIFIED_SFX_SECONDS;
  const usd = seconds * usdPerSecond;
  return { seconds, costCents: usd * 100, usd, assumedDuration: !specified };
}

/** Reads the account's per-second rate from the environment, falling back to the pessimistic one. */
export function usdPerSfxSecondFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ELEVENLABS_USD_PER_SFX_SECOND?.trim();
  if (!raw) return DEFAULT_USD_PER_SFX_SECOND;
  const n = Number(raw);
  // Zero and nonsense fall back rather than pricing every generation at nothing. A zero rate makes
  // the whole line read "free", which is the one wrong answer nobody questions.
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_USD_PER_SFX_SECOND;
}
