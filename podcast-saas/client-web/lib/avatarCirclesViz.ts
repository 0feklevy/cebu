// Pure math for the avatar-circle radial visualizer (no DOM / canvas), so it can
// be unit-tested. computeBars maps an AnalyserNode frequency snapshot to an array
// of bar heights (in the config's px space); the canvas renderer scales + draws.

export interface VizConfig {
  numberOfBars?: number;
  sensitivity?: number;     // 0..1 — response boost
  minHeight?: number;       // px floor per bar
  maxHeight?: number;       // px ceiling per bar
  lowFreqCutPct?: number;   // 0..100 — ignore bins below this fraction
  highFreqCutPct?: number;  // 0..100 — ignore bins above this fraction
  smoothness?: number;      // 0..1 — temporal blend with previous frame
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * @param freq   AnalyserNode frequency data (0..255 per bin)
 * @param cfg    visualizer config
 * @param prev   previous frame's bar heights (for temporal smoothing), or null
 * @param level  0..1 overall scale — used to damp the non-speaking circle
 * @returns      array of `numberOfBars` heights in px
 */
export function computeBars(freq: Uint8Array | number[], cfg: VizConfig, prev: number[] | null, level = 1): number[] {
  const bins = freq.length || 1;
  const n = Math.round(clamp(cfg.numberOfBars ?? 240, 1, 1024));
  const lowCut = Math.floor(clamp(cfg.lowFreqCutPct ?? 0, 0, 100) / 100 * bins);
  const highCut = Math.ceil(clamp(cfg.highFreqCutPct ?? 100, 0, 100) / 100 * bins);
  const usable = Math.max(1, highCut - lowCut);
  const sens = clamp(cfg.sensitivity ?? 0.2, 0, 1);
  const minH = cfg.minHeight ?? 5;
  const maxH = Math.max(minH, cfg.maxHeight ?? 180);
  const smooth = clamp(cfg.smoothness ?? 0.72, 0, 0.98);
  const lvl = clamp(level, 0, 1);

  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const startBin = lowCut + Math.floor((i / n) * usable);
    const endBin = Math.max(startBin + 1, lowCut + Math.floor(((i + 1) / n) * usable));
    let sum = 0, cnt = 0;
    for (let b = startBin; b < endBin && b < bins; b++) { sum += freq[b] ?? 0; cnt++; }
    const norm = cnt ? (sum / cnt) / 255 : 0;            // 0..1
    const boosted = clamp(norm * (1 + sens * 4), 0, 1);   // sensitivity boost
    const target = minH + boosted * (maxH - minH) * lvl;
    // Rise fast, fall smooth (typical visualizer feel).
    let h = target;
    if (prev && prev[i] != null) {
      h = target > prev[i] ? prev[i] * (1 - 0.6) + target * 0.6 : prev[i] * smooth + target * (1 - smooth);
    }
    out[i] = h;
  }
  return out;
}

/**
 * A lively "fake audio" frequency spectrum for previews (no real sound) — a few
 * moving formant-like peaks plus a falloff, so the bars dance convincingly.
 * @param phase advancing time value (e.g. seconds)
 * @param bins  number of frequency bins to fill
 */
export function syntheticSpectrum(phase: number, bins = 512, out?: Uint8Array): Uint8Array {
  const a = out && out.length === bins ? out : new Uint8Array(bins);
  const peaks = [
    { c: 0.06, w: 0.05, s: 3.1 },
    { c: 0.18, w: 0.08, s: 2.0 },
    { c: 0.34, w: 0.10, s: 1.3 },
  ];
  for (let i = 0; i < bins; i++) {
    const x = i / bins;
    let v = 0;
    for (const p of peaks) {
      const env = Math.exp(-((x - p.c) ** 2) / (2 * p.w * p.w));
      const mod = 0.55 + 0.45 * Math.sin(phase * p.s + p.c * 30);
      v += env * mod;
    }
    v *= Math.exp(-x * 2.2);           // high-frequency falloff
    a[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  return a;
}

/** Resolve which circle "side" should be active (full level) given the speaker timeline. */
export interface SpeakerSpan { speaker: string; start_sec: number; end_sec: number; }
export function activeSpeakerAt(timeline: SpeakerSpan[] | undefined, t: number): string | null {
  if (!timeline || timeline.length === 0) return null;
  for (const s of timeline) {
    if (t >= s.start_sec && t < s.end_sec) return s.speaker;
  }
  return null;
}
