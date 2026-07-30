// FFT/pitch-based speaker separation for the avatar circles (pure math — no DOM,
// no Web Audio objects — so it is fully unit-testable).
//
// Why: manually-built projects have no scenes-derived speaker_timeline, so the
// viewer can't know which host is talking. When the two circle characters have
// different voice bands (one male, one female — the product's canonical pairing),
// the fundamental frequency (F0) of the mixed audio identifies the active speaker:
// adult male speech sits ~85–155 Hz, adult female ~165–320 Hz. We estimate F0 per
// frame via normalized autocorrelation on the analyser's time-domain snapshot,
// then classify with hysteresis + a hold window so the wave doesn't flicker
// between words. This is a FALLBACK — an explicit speaker_timeline always wins.

export type VoiceBand = 'male' | 'female';

export interface PitchFrame {
  /** Estimated fundamental frequency in Hz, or null when the frame is silent/unvoiced. */
  f0: number | null;
  /** Normalized autocorrelation peak (0..1) — how periodic/voiced the frame is. */
  clarity: number;
  /** Root-mean-square level of the frame (0..1). */
  rms: number;
}

// Search range for F0 (Hz). 70 covers deep male voices; 340 caps above typical female F0.
const F0_MIN_HZ = 70;
const F0_MAX_HZ = 340;
// Below this RMS the frame is treated as silence.
const SILENCE_RMS = 0.015;
// Minimum normalized autocorrelation to accept a frame as voiced speech.
const MIN_CLARITY = 0.5;

/**
 * Estimate the fundamental frequency of one analyser time-domain snapshot
 * (AnalyserNode.getByteTimeDomainData bytes: 128 = zero) via normalized
 * autocorrelation, picking the SHORTEST lag within 90% of the best peak to
 * avoid octave-down errors.
 */
export function estimatePitch(td: Uint8Array | number[], sampleRate: number): PitchFrame {
  const n = td.length;
  if (n < 256 || !Number.isFinite(sampleRate) || sampleRate <= 0) return { f0: null, clarity: 0, rms: 0 };

  // Center + RMS
  const x = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = (td[i] - 128) / 128; x[i] = v; sum += v * v; }
  const rms = Math.sqrt(sum / n);
  if (rms < SILENCE_RMS) return { f0: null, clarity: 0, rms };

  const minLag = Math.max(2, Math.floor(sampleRate / F0_MAX_HZ));
  const maxLag = Math.min(n - 64, Math.ceil(sampleRate / F0_MIN_HZ));
  if (maxLag <= minLag) return { f0: null, clarity: 0, rms };

  // Normalized autocorrelation r(lag) = Σ x[i]·x[i+lag] / sqrt(Σx[i]² · Σx[i+lag]²)
  let bestLag = -1;
  let bestR = 0;
  const r = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0, e0 = 0, e1 = 0;
    const m = n - lag;
    for (let i = 0; i < m; i++) { num += x[i] * x[i + lag]; e0 += x[i] * x[i]; e1 += x[i + lag] * x[i + lag]; }
    const denom = Math.sqrt(e0 * e1);
    const v = denom > 1e-9 ? num / denom : 0;
    r[lag] = v;
    if (v > bestR) { bestR = v; bestLag = lag; }
  }
  if (bestLag < 0 || bestR < MIN_CLARITY) return { f0: null, clarity: Math.max(0, bestR), rms };

  // Octave-error guard: prefer the SHORTEST lag that is a local peak within 90% of the max.
  let chosen = bestLag;
  for (let lag = minLag + 1; lag < bestLag; lag++) {
    if (r[lag] >= bestR * 0.9 && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) { chosen = lag; break; }
  }

  // Parabolic interpolation around the chosen peak for sub-sample lag precision.
  let lagF = chosen;
  if (chosen > minLag && chosen < maxLag) {
    const y0 = r[chosen - 1], y1 = r[chosen], y2 = r[chosen + 1];
    const d = y0 - 2 * y1 + y2;
    if (Math.abs(d) > 1e-9) lagF = chosen + 0.5 * (y0 - y2) / d;
  }

  return { f0: sampleRate / lagF, clarity: bestR, rms };
}

// Classification boundaries with hysteresis: an ACTIVE band only flips once F0
// crosses well into the other band, so brief pitch excursions don't swap circles.
const MALE_MAX_HZ = 160;
const FEMALE_MIN_HZ = 180;
// How long (ms) the last attribution persists through unvoiced frames (gaps between
// words) before the tracker reports "nobody" again.
const HOLD_MS = 900;
// Consecutive voiced frames agreeing on the OTHER band required to switch speaker.
const SWITCH_FRAMES = 3;

/**
 * Stateful voice-band tracker: feed per-frame pitch estimates, read back which
 * band (male/female) is currently speaking, or null when nobody has spoken for
 * a while. Pure state machine — timestamps come from the caller.
 */
export class VoiceBandTracker {
  private active: VoiceBand | null = null;
  private lastVoicedAt = -Infinity;
  private pendingBand: VoiceBand | null = null;
  private pendingCount = 0;

  sample(frame: PitchFrame, nowMs: number): VoiceBand | null {
    const band = frame.f0 == null ? null : frame.f0 <= MALE_MAX_HZ ? 'male' : frame.f0 >= FEMALE_MIN_HZ ? 'female' : null;

    if (band != null) {
      this.lastVoicedAt = nowMs;
      if (this.active == null || band === this.active) {
        this.active = band;
        this.pendingBand = null;
        this.pendingCount = 0;
      } else {
        // Other band detected — require SWITCH_FRAMES consecutive agreements to flip.
        if (this.pendingBand === band) this.pendingCount++;
        else { this.pendingBand = band; this.pendingCount = 1; }
        if (this.pendingCount >= SWITCH_FRAMES) {
          this.active = band;
          this.pendingBand = null;
          this.pendingCount = 0;
        }
      }
    } else if (frame.f0 != null) {
      // Voiced but ambiguous (between the bands): keeps the hold window alive.
      this.lastVoicedAt = nowMs;
    }

    if (nowMs - this.lastVoicedAt > HOLD_MS) {
      this.active = null;
      this.pendingBand = null;
      this.pendingCount = 0;
    }
    return this.active;
  }

  reset(): void {
    this.active = null;
    this.lastVoicedAt = -Infinity;
    this.pendingBand = null;
    this.pendingCount = 0;
  }
}
