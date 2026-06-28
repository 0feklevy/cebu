/**
 * "Same with minor changes?" detection for the Replace flow.
 *
 * When a video is replaced with a new file, we don't want to waste effort re-running
 * captions and smart-crop if the new video is essentially the same (a re-encode, a small
 * quality bump, a trivial trim). We decide that from two signals we ALREADY compute during
 * transcode — total duration and the 200-bucket audio waveform — which together are a
 * strong, cheap proxy for "same content". (A genuinely different video has a different
 * audio track and/or length.)
 */

/** Parse the stored `waveform_peaks` JSON into a number[] (or null if absent/malformed). */
export function parsePeaks(json: string | null | undefined): number[] | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) && v.every((n) => typeof n === 'number') ? (v as number[]) : null;
  } catch {
    return null;
  }
}

/** Mean absolute difference threshold for normalized [0,1] waveforms to count as "same". */
const WAVEFORM_MAD_THRESHOLD = 0.08;

/**
 * True when NEW media is "the same with minor changes" as OLD media, so the caller may
 * skip re-running captions/crop. Returns false when there is no prior media (a first
 * upload → always process fresh).
 */
export function isSimilarMedia(
  oldDurationSec: number | null | undefined,
  oldPeaks: number[] | null,
  newDurationSec: number,
  newPeaks: number[],
): boolean {
  if (oldDurationSec == null || !oldPeaks || oldPeaks.length === 0) return false;

  // Duration within ±0.5s or ±2%, whichever is larger.
  const durTol = Math.max(0.5, oldDurationSec * 0.02);
  if (Math.abs(oldDurationSec - newDurationSec) > durTol) return false;

  // Waveforms are fixed-length (200) normalized peaks; compare element-wise.
  if (oldPeaks.length !== newPeaks.length) return false;
  let sum = 0;
  for (let i = 0; i < newPeaks.length; i++) sum += Math.abs((oldPeaks[i] ?? 0) - (newPeaks[i] ?? 0));
  return sum / newPeaks.length < WAVEFORM_MAD_THRESHOLD;
}
