import { describe, it, expect } from 'vitest';
import { estimatePitch, VoiceBandTracker } from '../lib/voicePitch';

const SR = 48000;
const N = 1024;

/** Synthesize an analyser-style byte time-domain frame: a sine (+harmonics) at f0 Hz. */
function toneFrame(f0: number, amp = 0.5, phase = 0): Uint8Array {
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const t = (i / SR) * 2 * Math.PI * f0 + phase;
    // Fundamental + a couple of harmonics — closer to a voiced speech spectrum.
    const v = amp * (Math.sin(t) + 0.4 * Math.sin(2 * t) + 0.2 * Math.sin(3 * t)) / 1.6;
    out[i] = Math.max(0, Math.min(255, Math.round(128 + v * 127)));
  }
  return out;
}

const silenceFrame = () => new Uint8Array(N).fill(128);

describe('estimatePitch — autocorrelation F0', () => {
  it('finds a male-range fundamental (120 Hz) within tolerance', () => {
    const { f0, clarity } = estimatePitch(toneFrame(120), SR);
    expect(f0).not.toBeNull();
    expect(Math.abs((f0 as number) - 120)).toBeLessThan(6);
    expect(clarity).toBeGreaterThan(0.5);
  });

  it('finds a female-range fundamental (220 Hz) within tolerance', () => {
    const { f0 } = estimatePitch(toneFrame(220), SR);
    expect(f0).not.toBeNull();
    expect(Math.abs((f0 as number) - 220)).toBeLessThan(8);
  });

  it('does not octave-down a 220 Hz tone to 110 Hz', () => {
    const { f0 } = estimatePitch(toneFrame(220), SR);
    expect(f0 as number).toBeGreaterThan(180);
  });

  it('returns null for silence', () => {
    expect(estimatePitch(silenceFrame(), SR).f0).toBeNull();
  });

  it('returns null for a very quiet frame (below the silence gate)', () => {
    expect(estimatePitch(toneFrame(150, 0.005), SR).f0).toBeNull();
  });
});

describe('VoiceBandTracker — hysteresis + hold', () => {
  it('attributes a male tone to male and a female tone to female', () => {
    const tr = new VoiceBandTracker();
    expect(tr.sample(estimatePitch(toneFrame(120), SR), 0)).toBe('male');
    tr.reset();
    expect(tr.sample(estimatePitch(toneFrame(230), SR), 0)).toBe('female');
  });

  it('requires consecutive frames to switch speakers (no single-frame flicker)', () => {
    const tr = new VoiceBandTracker();
    let t = 0;
    for (let i = 0; i < 5; i++) tr.sample(estimatePitch(toneFrame(120), SR), (t += 30));
    // One stray female-band frame must NOT flip the active speaker…
    expect(tr.sample(estimatePitch(toneFrame(230), SR), (t += 30))).toBe('male');
    // …but a sustained female voice must.
    let band: ReturnType<VoiceBandTracker['sample']> = null;
    for (let i = 0; i < 4; i++) band = tr.sample(estimatePitch(toneFrame(230), SR), (t += 30));
    expect(band).toBe('female');
  });

  it('holds the last speaker through short unvoiced gaps, then releases to null', () => {
    const tr = new VoiceBandTracker();
    let t = 0;
    for (let i = 0; i < 3; i++) tr.sample(estimatePitch(toneFrame(120), SR), (t += 30));
    // 300ms gap between words — still attributed to the male circle.
    expect(tr.sample(estimatePitch(silenceFrame(), SR), t + 300)).toBe('male');
    // Long silence — nobody is speaking.
    expect(tr.sample(estimatePitch(silenceFrame(), SR), t + 3000)).toBeNull();
  });
});
