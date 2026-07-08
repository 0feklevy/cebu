import { describe, it, expect } from 'vitest';
import { layoutMix, MIN_CLIP_MS, type MixTimeline, type MixClip } from 'shared';

const DUR: Record<string, number> = { a: 2000, b: 1500, c: 800, m: 400 };
const durOf = (id: string) => DUR[id] ?? 0;

function clip(p: Partial<MixClip> & Pick<MixClip, 'clipId' | 'turnId'>): MixClip {
  return { partIndex: 0, role: 'speech', gapBeforeMs: 0, trimStartMs: 0, trimEndMs: 0, gainDb: 0, muted: false, ...p };
}
const tl = (clips: MixClip[]): MixTimeline => ({ version: 1, clips });
const laneTl = (clips: MixClip[]): MixTimeline => ({ version: 1, layout: 'lanes', clips });
const laneOf = (turnId: string) => turnId.startsWith('l') ? 'learner' : 'teacher';

describe('layoutMix', () => {
  it('chains speech clips by gapBeforeMs', () => {
    const { placements, totalMs } = layoutMix(tl([
      clip({ clipId: 'a', turnId: 't1', gapBeforeMs: 0 }),
      clip({ clipId: 'b', turnId: 't2', gapBeforeMs: 120 }),
    ]), durOf);
    expect(placements[0].startMs).toBe(0);
    expect(placements[1].startMs).toBe(2000 + 120);
    expect(totalMs).toBe(2120 + 1500);
  });

  it('ripples: changing one gap shifts everything downstream', () => {
    const base = [
      clip({ clipId: 'a', turnId: 't1' }),
      clip({ clipId: 'b', turnId: 't2', gapBeforeMs: 100 }),
      clip({ clipId: 'c', turnId: 't3', gapBeforeMs: 100 }),
    ];
    const before = layoutMix(tl(base), durOf);
    const after = layoutMix(tl([base[0], { ...base[1], gapBeforeMs: 600 }, base[2]]), durOf);
    expect(after.placements[1].startMs - before.placements[1].startMs).toBe(500);
    expect(after.placements[2].startMs - before.placements[2].startMs).toBe(500); // rippled
  });

  it('lane mode ripples only within the same speaker lane', () => {
    const base = [
      clip({ clipId: 'a', turnId: 't1', lane: 'teacher' }),
      clip({ clipId: 'b', turnId: 'l1', lane: 'learner' }),
      clip({ clipId: 'c', turnId: 't2', lane: 'teacher', gapBeforeMs: 100 }),
    ];
    const before = layoutMix(laneTl(base), durOf, laneOf);
    const after = layoutMix(laneTl([base[0], { ...base[1], gapBeforeMs: 600 }, base[2]]), durOf, laneOf);

    expect(after.placements[1].startMs - before.placements[1].startMs).toBe(600);
    expect(after.placements[2].startMs).toBe(before.placements[2].startMs);
  });

  it('clamps negative gaps so clips never overlap', () => {
    const { placements } = layoutMix(tl([
      clip({ clipId: 'a', turnId: 't1', gapBeforeMs: -500 }),   // first clip → clamp to 0
      clip({ clipId: 'b', turnId: 't2', gapBeforeMs: -300 }),   // legacy negative gap → clamp to 0
    ]), durOf);
    expect(placements[0].startMs).toBe(0);
    expect(placements[1].startMs).toBe(2000);
  });

  it('murmurs advance the chain like normal audio blocks', () => {
    const { placements } = layoutMix(tl([
      clip({ clipId: 'a', turnId: 't1' }),
      clip({ clipId: 'm', turnId: 'bc1', role: 'murmur', gapBeforeMs: -350 }),
      clip({ clipId: 'b', turnId: 't2', gapBeforeMs: 150 }),
    ]), durOf);
    expect(placements[1].startMs).toBe(2000);         // legacy negative gap clamps to flush
    expect(placements[2].startMs).toBe(2000 + 400 + 150);
  });

  it('trims shorten the audible span and downstream chain', () => {
    const { placements } = layoutMix(tl([
      clip({ clipId: 'a', turnId: 't1', trimStartMs: 200, trimEndMs: 300 }),
      clip({ clipId: 'b', turnId: 't2', gapBeforeMs: 100 }),
    ]), durOf);
    expect(placements[0].inMs).toBe(200);
    expect(placements[0].outMs).toBe(1700);
    expect(placements[1].startMs).toBe(1500 + 100); // eff 1500ms + gap
  });

  it('never trims a clip below MIN_CLIP_MS', () => {
    const { placements } = layoutMix(tl([
      clip({ clipId: 'c', turnId: 't1', trimStartMs: 700, trimEndMs: 700 }), // 800ms source
    ]), durOf);
    const p = placements[0];
    expect(p.outMs - p.inMs).toBeGreaterThanOrEqual(MIN_CLIP_MS);
  });

  it('split parts share a take and sit flush at zero gap', () => {
    const { placements } = layoutMix(tl([
      clip({ clipId: 'a', turnId: 't1', partIndex: 0, trimEndMs: 1200 }),           // 0..800
      clip({ clipId: 'a', turnId: 't1', partIndex: 1, trimStartMs: 800, gapBeforeMs: 0 }), // 800..2000
    ]), durOf);
    expect(placements[0].outMs).toBe(800);
    expect(placements[1].inMs).toBe(800);
    expect(placements[1].startMs).toBe(placements[0].startMs + 800); // seamless
  });

  it('muted clips keep their slot (ripple stability) but do not extend totalMs', () => {
    const withMute = layoutMix(tl([
      clip({ clipId: 'a', turnId: 't1' }),
      clip({ clipId: 'b', turnId: 't2', gapBeforeMs: 100, muted: true }),
      clip({ clipId: 'c', turnId: 't3', gapBeforeMs: 100 }),
    ]), durOf);
    expect(withMute.placements[2].startMs).toBe(2000 + 100 + 1500 + 100); // slot kept
    const lastEnd = withMute.placements[2].startMs + 800;
    expect(withMute.totalMs).toBe(lastEnd);
  });

  it('handles unknown clip ids without throwing (0-duration source)', () => {
    const { placements } = layoutMix(tl([clip({ clipId: 'missing', turnId: 't1' })]), durOf);
    expect(placements[0].startMs).toBe(0);
  });
});
