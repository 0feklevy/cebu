'use client';

import { useEffect, useRef, useState } from 'react';
import { layoutMix, type MixTimeline } from 'shared';
import type { LoadedClip } from './mixEngine';

const RATE = 8000;       // waveform-only render rate — cheap
const BUCKETS = 1600;

/**
 * Render the live COMBINED waveform of the current edit via OfflineAudioContext:
 * lay every clip on a silent buffer exactly as playback does, render offline, then
 * reduce to per-bucket peaks. Debounced; a generation counter drops stale renders.
 */
export function useMixWaveform(
  timeline: MixTimeline | null,
  clips: Map<string, LoadedClip>,
  totalMs: number,
  laneOf: (turnId: string) => string,
): number[] {
  const [peaks, setPeaks] = useState<number[]>([]);
  const genRef = useRef(0);

  useEffect(() => {
    if (!timeline || totalMs <= 0) { setPeaks([]); return; }
    const gen = ++genRef.current;
    const handle = setTimeout(() => {
      void render(timeline, clips, totalMs, laneOf).then((p) => {
        if (gen === genRef.current) setPeaks(p);
      });
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, clips, totalMs, laneOf]);

  return peaks;
}

async function render(timeline: MixTimeline, clips: Map<string, LoadedClip>, totalMs: number, laneOf: (turnId: string) => string): Promise<number[]> {
  const OfflineCtx = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!OfflineCtx) return [];
  const frames = Math.max(1, Math.ceil((totalMs / 1000) * RATE));
  const ctx = new OfflineCtx(1, frames, RATE);
  const { placements } = layoutMix(timeline, (id) => clips.get(id)?.durationMs ?? 0, laneOf);

  for (const p of placements) {
    if (p.muted) continue;
    const clip = clips.get(p.clipId);
    if (!clip) continue;
    const src = ctx.createBufferSource();
    src.buffer = clip.buffer;
    const g = ctx.createGain();
    g.gain.value = Math.pow(10, p.gainDb / 20);
    src.connect(g).connect(ctx.destination);
    const dur = (p.outMs - p.inMs) / 1000;
    if (dur <= 0.005) continue;
    try { src.start(p.startMs / 1000, p.inMs / 1000, dur); } catch { /* skip */ }
  }

  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);
  const block = Math.max(1, Math.floor(data.length / BUCKETS));
  const out: number[] = [];
  let max = 0;
  for (let i = 0; i < data.length; i += block) {
    let peak = 0;
    for (let j = i; j < Math.min(i + block, data.length); j++) { const a = Math.abs(data[j]); if (a > peak) peak = a; }
    out.push(peak);
    if (peak > max) max = peak;
  }
  const norm = max || 1;
  return out.map((p) => Number((p / norm).toFixed(3)));
}
