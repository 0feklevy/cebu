/**
 * Global head localization for static-camera podcasts.
 *
 * Per-frame peak picking is jittery and tends to collapse both heads toward
 * centre. Two structural priors make face-free localization reliable:
 *
 *   1. Static camera  → the speakers occupy fixed horizontal positions for the
 *      whole take, so we localise once from profiles summed over all frames.
 *   2. Two-shot layout → exactly one speaker sits left-of-centre and one
 *      right-of-centre. We therefore take the strongest "person energy" peak in
 *      each half of the frame, which guarantees two well-separated heads instead
 *      of two peaks piled up near the middle.
 *
 * Person energy is scored two ways, depending on what the audio track allows:
 *
 *   • AUDIO-BLIND (no audio / silent track): skin ×2 + saliency ×0.6 + motion ×1.0.
 *     Every term here answers "is a person HERE". None answers "is this person SPEAKING",
 *     and skin is the heaviest, so a big well-lit static face outscores whoever is
 *     actually talking. That is the owner-reported D-16 symptom — "if the woman talks and
 *     there are 2 people in the frame, it shows the man and not the woman" — in its
 *     permanent form: when the two-shot gate then misses, `dominantColumn` pins ONE column
 *     for the whole shot and the entire video sits on the wrong person.
 *
 *   • SPEECH-AWARE (the normal case — the crop pass decodes the full audio track): the
 *     dominant term becomes motion correlated with the speech envelope
 *     (`speechCorrelatedMotion`), which is the only available signal that distinguishes a
 *     talker from a listener. Skin drops to a supporting prior, which is also what stops a
 *     deep skin tone from scoring ~0 on the 1990s RGB rule and losing the frame outright.
 *
 * The audio-blind weights are kept verbatim so a video whose audio fails to decode gets
 * exactly the behaviour it got before, rather than an untested third one.
 */

import { PROFILE_COLS } from './sceneAnalyzer.js';

const HEAD_WINDOW = 0.09;       // ± window (norm.) used to pool per-head motion
const SECOND_HEAD_MIN = 0.28;   // 2nd head must reach this fraction of the 1st to count
const MIN_SEPARATION = 0.20;    // two heads must be at least this far apart (norm.)
const VALLEY_RATIO = 0.88;      // dip between heads must fall below this × weaker peak

/** Person-energy weights when no usable speech signal exists (unchanged legacy behaviour). */
const AUDIO_BLIND = { skin: 2.0, saliency: 0.6, motion: 1.0, speech: 0 };
/** Person-energy weights when motion can be correlated against the speech envelope. */
const SPEECH_AWARE = { skin: 1.0, saliency: 0.5, motion: 0.4, speech: 2.2 };
/** Same split for the single-dominant-column fallback (saliency there is person-gated). */
const DOMINANT_AUDIO_BLIND = { skin: 2.0, saliency: 0.6, motion: 1.2, speech: 0 };
const DOMINANT_SPEECH_AWARE = { skin: 1.0, saliency: 0.5, motion: 0.5, speech: 2.5 };
/** A column with at least this much normalised speech-correlated motion counts as a person. */
const SPEECH_PERSON_GATE = 0.20;

export interface HeadModel {
  heads: number[];              // 0..2 stable head centres, sorted left→right (0..1)
  isTwoShot: boolean;
}

export function locateHeads(
  skinSum: Float64Array,
  salSum: Float64Array,
  actSum: Float64Array,
  speechSum?: Float64Array,
): HeadModel {
  const n = PROFILE_COLS;
  const sk = normCopy(skinSum), sa = normCopy(salSum), ac = normCopy(actSum);
  // `speechCorrelatedMotion` returns all-zero for a silent/undecodable/too-short track,
  // which is the signal that there is nothing to weigh — fall back to the legacy weights.
  const sp = speechSum && hasEnergy(speechSum) ? normCopy(speechSum) : null;
  const w = sp ? SPEECH_AWARE : AUDIO_BLIND;
  const profile = new Float64Array(n);
  for (let x = 0; x < n; x++) {
    profile[x] = sk[x] * w.skin + sa[x] * w.saliency + ac[x] * w.motion + (sp ? sp[x] * w.speech : 0);
  }
  const smoothed = boxBlur(profile, Math.max(2, Math.floor(n * 0.04)));

  // Strongest peak in each half (exclude the dead-centre column gap).
  const mid = Math.floor(n / 2);
  const left = argmaxRange(smoothed, Math.floor(n * 0.10), Math.floor(n * 0.46));
  const right = argmaxRange(smoothed, Math.ceil(n * 0.54), Math.floor(n * 0.90));

  if (left.idx < 0 && right.idx < 0) return { heads: [], isTwoShot: false };

  const globalMax = Math.max(left.val, right.val);
  const lx = left.idx / (n - 1);
  const rx = right.idx / (n - 1);

  // Genuine two-shot test: both peaks strong, well separated, AND a real valley
  // between them (two people have a gap; a single centred face does not). This
  // gate is what stops animations / single speakers from being split in two.
  const bothStrong = left.val >= globalMax * SECOND_HEAD_MIN && right.val >= globalMax * SECOND_HEAD_MIN;
  const separated = rx - lx >= MIN_SEPARATION;
  let valleyOk = false;
  if (bothStrong && separated) {
    let valley = Infinity;
    for (let x = left.idx + 1; x < right.idx; x++) if (smoothed[x] < valley) valley = smoothed[x];
    valleyOk = valley <= Math.min(left.val, right.val) * VALLEY_RATIO;
  }

  if (bothStrong && separated && valleyOk) {
    return { heads: [lx, rx], isTwoShot: true };
  }

  // Single dominant person → pick the strongest person-energy column across the WHOLE frame.
  // The two side-bands above miss a centred or off-band subject, and the raw profile lets on-
  // screen text/graphics (high saliency, no skin) hijack the crop. dominantColumn gates saliency
  // by skin and up-weights motion, so with several candidates the MOVING / speaking subject wins
  // and static captions are discounted. (backend-102 — the fix for "crop lands on the wrong thing".)
  void left; void right; void mid;
  const only = dominantColumn(sk, sa, ac, sp, n);
  return { heads: only >= 0 ? [only / (n - 1)] : [], isTwoShot: false };
}

/**
 * Strongest single "person energy" column across the full usable frame width. This is the
 * value that gets held for an ENTIRE shot when the two-shot gate does not fire, so getting
 * it wrong is not a wobble — it is a whole video framed on the wrong person.
 *
 *   • the person gate discounts high-saliency / low-skin columns → on-screen text &
 *     graphics. It accepts speech-correlated motion as evidence of a person too, so a
 *     speaker whose skin tone the RGB rule scores ~0 on is no longer gated out.
 *   • with audio, speech-correlated motion is the heaviest term: the person TALKING wins
 *     over a bystander who merely moves, and over a larger, better-lit static face.
 */
function dominantColumn(
  sk: Float64Array, sa: Float64Array, ac: Float64Array, sp: Float64Array | null, n: number,
): number {
  const w = sp ? DOMINANT_SPEECH_AWARE : DOMINANT_AUDIO_BLIND;
  const energy = new Float64Array(n);
  for (let x = 0; x < n; x++) {
    const personGate = (sk[x] > 0.15 || (sp !== null && sp[x] > SPEECH_PERSON_GATE)) ? 1 : 0.35;
    energy[x] = sk[x] * w.skin + sa[x] * w.saliency * personGate + ac[x] * w.motion + (sp ? sp[x] * w.speech : 0);
  }
  const smoothed = boxBlur(energy, Math.max(2, Math.floor(n * 0.05)));
  // Exclude the extreme edges — the crop window can't centre there anyway.
  const { idx } = argmaxRange(smoothed, Math.floor(n * 0.06), Math.floor(n * 0.94));
  return idx;
}

/** Index of the head with the most motion energy in this frame (or null). */
export function activeHeadIndex(motion: Float64Array, heads: number[]): number | null {
  if (heads.length === 0) return null;
  const n = motion.length;
  const win = Math.max(1, Math.floor(HEAD_WINDOW * n));
  let bestIdx = 0, bestE = -1;
  for (let h = 0; h < heads.length; h++) {
    const c = Math.round(heads[h] * (n - 1));
    let e = 0;
    for (let x = Math.max(0, c - win); x <= Math.min(n - 1, c + win); x++) e += motion[x];
    if (e > bestE) { bestE = e; bestIdx = h; }
  }
  return bestE > 1e-6 ? bestIdx : null;
}

// ── helpers ────────────────────────────────────────────────────────────────────

function argmaxRange(a: Float64Array, lo: number, hi: number): { idx: number; val: number } {
  let idx = -1, val = -Infinity;
  for (let x = lo; x <= hi && x < a.length; x++) if (a[x] > val) { val = a[x]; idx = x; }
  return { idx, val: idx >= 0 ? val : 0 };
}

function hasEnergy(a: Float64Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] > 0) return true;
  return false;
}

function normCopy(a: Float64Array): Float64Array {
  const out = a.slice();
  let m = 0;
  for (let i = 0; i < out.length; i++) if (out[i] > m) m = out[i];
  if (m > 1e-9) for (let i = 0; i < out.length; i++) out[i] /= m;
  return out;
}

function boxBlur(a: Float64Array, radius: number): Float64Array {
  const n = a.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      s += a[j]; c++;
    }
    out[i] = s / Math.max(1, c);
  }
  return out;
}
