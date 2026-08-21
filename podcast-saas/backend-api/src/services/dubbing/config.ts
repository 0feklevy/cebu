/**
 * Dubbing configuration — the facts about the vendor ACCOUNT that code must not guess at.
 *
 * ── Why the watermark is config and not a response field ──────────────────────────────────────
 * The vendor documents dubbing as available on every plan "including the free plan", but dubs
 * generated on free plans are automatically watermarked, and a watermarked dub is not shippable to
 * a viewer. The v2 project surface exposes NO watermark field — not on the create call, not on the
 * language resource — so this cannot be read back off any response. It is a property of the plan
 * the API key belongs to.
 *
 * That leaves two honest options: infer it (guessing, and guessing wrong means publishing a
 * watermarked dub to viewers), or make it a declared fact. This module makes it declared. The
 * owner sets it once when the plan is known; changing plan is a config change, never a code change.
 *
 * The DEFAULT IS `true` — assume watermarked until told otherwise. That is deliberately the
 * inconvenient default: an unset variable then blocks publication and someone notices, whereas
 * defaulting to `false` would silently ship watermarked video to real viewers, which is the
 * failure nobody detects until a customer complains.
 */

/** How the account's plan treats watermarking, and what that means for publication. */
export interface DubbingWatermarkPolicy {
  /** Whether dubs produced by this account carry the vendor watermark. */
  watermarked: boolean;
  /** Whether the operator has explicitly declared the plan, or we are on the safe default. */
  declared: boolean;
  /** Why a watermarked dub is withheld, phrased for the creator UI. */
  reason: string | null;
}

export const WATERMARK_UNSHIPPABLE_REASON =
  'This account\'s ElevenLabs plan watermarks dubbed audio, and a watermarked dub is not published ' +
  'to viewers. Set ELEVENLABS_DUBBING_WATERMARKED=false once the workspace is on a paid plan.';

function readBool(raw: string | undefined): boolean | null {
  const value = raw?.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  return null;
}

/**
 * Resolve the account's watermark policy.
 *
 * `env` is a parameter rather than a direct `process.env` read so the policy can be exercised in
 * both states by a test without mutating global process state.
 */
export function dubbingWatermarkPolicy(env: NodeJS.ProcessEnv = process.env): DubbingWatermarkPolicy {
  const declared = readBool(env.ELEVENLABS_DUBBING_WATERMARKED);
  if (declared === false) return { watermarked: false, declared: true, reason: null };
  return {
    watermarked: true,
    declared: declared === true,
    reason: WATERMARK_UNSHIPPABLE_REASON,
  };
}

/**
 * USD per ElevenLabs credit for this account, or the vendor's headline rate.
 *
 * The headline "$2.20 per minute" is the WORST case; higher plans buy credits more cheaply. An
 * account that knows its real rate sets this and every estimate in the product moves with it. A
 * malformed or non-positive value falls back rather than producing a zero-cost estimate, because
 * an estimate of "$0.00" for the most expensive operation in the product is worse than a high one.
 */
export function dubbingUsdPerCredit(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.DUBBING_USD_PER_CREDIT?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * How many source speakers to declare. The vendor's default is 0 (auto-detect, max 32).
 *
 * For this product's single-presenter lesson videos an explicit `1` removes an entire class of
 * diarization failure and is strictly better than auto-detect. It stays configurable because a
 * multi-speaker interview genuinely needs auto-detect, and the right answer is a property of the
 * content, not of the code.
 */
export function dubbingNumSpeakers(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.DUBBING_NUM_SPEAKERS?.trim() ?? '1');
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 32) return 1;
  return Math.floor(parsed);
}
