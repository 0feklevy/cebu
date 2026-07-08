'use client';

/**
 * Web-Audio playback engine for the Audio Studio. Schedules every clip on one
 * AudioContext clock using the SAME `layoutMix` the server export uses, so what
 * you hear is what you get. Schedule-all-at-play (≤ a few hundred short sources)
 * — no lookahead machinery needed at this scale.
 */

import { layoutMix, type MixTimeline, type MixPlacement } from 'shared';

export interface LoadedClip {
  id: string;
  buffer: AudioBuffer;
  durationMs: number;
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

type PlayState = 'stopped' | 'playing';

export class MixPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private state: PlayState = 'stopped';
  private startCtxTime = 0;   // ctx.currentTime when playback began
  private startOffsetMs = 0;  // timeline position playback began from
  private raf = 0;

  constructor(
    private getTimeline: () => MixTimeline,
    private getDurMs: (id: string) => number,        // ALL clips (layout/total) — even undecoded
    private getLane: (turnId: string) => string,
    private getBuffer: (id: string) => AudioBuffer | undefined, // only decoded clips play
    private onTick: (positionMs: number, playing: boolean) => void,
  ) {}

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  get playing(): boolean { return this.state === 'playing'; }

  /** Total timeline length (ms) from the current draft + clip durations. */
  totalMs(): number {
    return layoutMix(this.getTimeline(), this.getDurMs, this.getLane).totalMs;
  }

  private clearSources(): void {
    for (const s of this.sources) { try { s.onended = null; s.stop(); } catch { /* already stopped */ } }
    this.sources = [];
  }

  async play(fromMs?: number): Promise<void> {
    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    this.stopSourcesOnly();

    const startAt = fromMs ?? this.startOffsetMs;
    const { placements, totalMs } = layoutMix(this.getTimeline(), this.getDurMs, this.getLane);
    if (totalMs <= startAt + 5) { this.onTick(0, false); this.startOffsetMs = 0; return; }

    this.startCtxTime = ctx.currentTime + 0.05; // tiny lead so the first clip isn't clipped
    this.startOffsetMs = startAt;
    this.state = 'playing';

    for (const p of placements) {
      if (p.muted) continue;
      const buffer = this.getBuffer(p.clipId);
      if (!buffer) continue;
      this.scheduleOne(ctx, p, buffer, startAt);
    }
    this.loop();
  }

  private scheduleOne(ctx: AudioContext, p: MixPlacement, buffer: AudioBuffer, fromMs: number): void {
    const clipEndMs = p.startMs + (p.outMs - p.inMs);
    if (clipEndMs <= fromMs) return; // fully in the past

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = dbToGain(p.gainDb);
    src.connect(g).connect(this.master!);

    // If playback starts mid-clip, offset both the schedule time and the buffer read.
    const startInsideMs = Math.max(0, fromMs - p.startMs);
    const whenSec = this.startCtxTime + Math.max(0, p.startMs - fromMs) / 1000;
    const offsetSec = (p.inMs + startInsideMs) / 1000;
    const durSec = (p.outMs - p.inMs - startInsideMs) / 1000;
    if (durSec <= 0.005) return;
    try {
      src.start(whenSec, offsetSec, durSec);
      this.sources.push(src);
    } catch { /* invalid range — skip */ }
  }

  private loop = (): void => {
    if (this.state !== 'playing' || !this.ctx) return;
    const posMs = this.startOffsetMs + (this.ctx.currentTime - this.startCtxTime) * 1000;
    const total = this.totalMs();
    if (posMs >= total) { this.onTick(total, false); this.stop(); this.startOffsetMs = 0; this.onTick(0, false); return; }
    this.onTick(Math.max(0, posMs), true);
    this.raf = requestAnimationFrame(this.loop);
  };

  private stopSourcesOnly(): void {
    cancelAnimationFrame(this.raf);
    this.clearSources();
  }

  pause(): void {
    if (this.state !== 'playing' || !this.ctx) return;
    const posMs = this.startOffsetMs + (this.ctx.currentTime - this.startCtxTime) * 1000;
    this.stopSourcesOnly();
    this.state = 'stopped';
    this.startOffsetMs = Math.max(0, Math.min(posMs, this.totalMs()));
    this.onTick(this.startOffsetMs, false);
  }

  stop(): void {
    this.stopSourcesOnly();
    this.state = 'stopped';
  }

  /** Move the playhead without playing. If currently playing, re-schedule from here. */
  seek(ms: number): void {
    const clamped = Math.max(0, Math.min(ms, this.totalMs()));
    this.startOffsetMs = clamped;
    if (this.state === 'playing') void this.play(clamped);
    else this.onTick(clamped, false);
  }

  setMasterGain(db: number): void {
    if (this.master) this.master.gain.value = dbToGain(db);
  }

  dispose(): void {
    this.stopSourcesOnly();
    this.state = 'stopped';
    if (this.ctx) { void this.ctx.close(); this.ctx = null; this.master = null; }
  }
}
