/**
 * Deterministic duration model for Podcast Studio scripts.
 *
 * The user's target is a CEILING ("up to N minutes"), not a bullseye: a great
 * 4-minute episode beats a padded 5-minute one. The writers' room aims the word
 * budget at ~85% of the ceiling and the deterministic guard rejects drafts that
 * would overshoot it.
 *
 * Model: final audio minutes ≈ spoken words / SPOKEN_WPM + inter-turn gap time.
 * Overlap backchannels ride on top of other clips, so they add ~0 to the runtime.
 * Audio [tags] are performance directions, not spoken words — stripped before
 * counting (they do add a little time for laughs/pauses, which the per-turn
 * TAG_SECONDS fudge covers).
 */

export interface DurationTurn {
  text: string;
  overlap: boolean;
}

/**
 * Words per FINISHED minute for ElevenLabs v3 English dialogue at stability 0.5:
 * ~700–900 chars/min ≈ 130–165 WPM, netting ≈140 raw — then the final mix gets a
 * gentle ~1.06 pitch-preserving tempo lift (PODCAST_TEMPO in ffmpegAudio), so a
 * finished minute carries ≈148 words. Keep this in sync with PODCAST_TEMPO.
 */
export const SPOKEN_WPM = 148;

/** Average inter-turn gap the stitcher inserts (seconds; Stivers et al.: median ~100ms, mean ~208ms). */
const GAP_SECONDS = 0.15;

/** Per-tag allowance — [laughs]/[pause] etc. take real time to perform (~0.5s each). */
const TAG_SECONDS = 0.5;

/** Land the script in this window of the ceiling (midpoint 0.875 → words ≈ 122·X). */
export const BUDGET_LOW = 0.8;
export const BUDGET_HIGH = 0.95;

const TAG_RE = /\[[^\]]*\]/g;

/** Count spoken words in a turn (audio [tags] are directions, not words). */
export function countSpokenWords(text: string): number {
  const clean = text.replace(TAG_RE, ' ');
  return clean.split(/\s+/).filter(Boolean).length;
}

/** Estimated final-audio minutes for a script (deterministic, matches the stitcher's model). */
export function estimateMinutes(turns: DurationTurn[]): number {
  let words = 0;
  let tags = 0;
  let seqTurns = 0;
  for (const t of turns) {
    if (t.overlap) continue; // backchannels overlap other clips — no added runtime
    words += countSpokenWords(t.text);
    tags += (t.text.match(TAG_RE) ?? []).length;
    seqTurns++;
  }
  const speechSec = (words / SPOKEN_WPM) * 60;
  const gapSec = Math.max(0, seqTurns - 1) * GAP_SECONDS;
  return (speechSec + gapSec + tags * TAG_SECONDS) / 60;
}

/**
 * Word budget for an "up to maxMinutes" ceiling. `targetWords` aims the middle of
 * the landing window; `hardCapWords` is the count above which the deterministic
 * guard forces a trim.
 */
export function wordBudget(maxMinutes: number): { targetWords: number; hardCapWords: number } {
  const mid = (BUDGET_LOW + BUDGET_HIGH) / 2;
  return {
    targetWords: Math.round(maxMinutes * mid * SPOKEN_WPM),
    hardCapWords: Math.round(maxMinutes * SPOKEN_WPM * 0.97), // leave gap/tag headroom
  };
}
