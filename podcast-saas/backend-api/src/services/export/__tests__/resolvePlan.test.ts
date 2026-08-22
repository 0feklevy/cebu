/**
 * translateContractPlan — pure, always runs.
 *
 * The contract plan is LAYERED (base video windows + overlapping section windows,
 * mirroring the viewer's stack); the splice graph needs contiguous windows. These
 * tests pin the flattening semantics:
 *   - overlays cut holes in the base; the base RESUMES at absolute time (it keeps
 *     playing underneath, exactly like the viewer);
 *   - stacking order poster/sim > image > clip > base;
 *   - null-poster fallbacks drop away (base shows through); uncovered stretches
 *     (post-roll tails) become bounded black;
 *   - every boundary frame-snapped, total exactly the plan's totalDurationSec;
 *   - audio: gain→dB mapping, clamping, dropped windows with warnings.
 */

import { describe, it, expect } from 'vitest';

import { translateContractPlan, gainToDb, ExportPlanShapeError } from '../resolvePlan.js';
import type {
  ClipWindow, ExportAudioWindow, ExportPlan, ExportWindow, ImageWindow,
  PosterFallbackWindow, SimCaptureWindow, VideoWindow,
} from '../types.js';

const GRID = { w: 1920, h: 1080, fps: 30 };

const base = (over: Partial<VideoWindow> = {}): VideoWindow => ({
  kind: 'video', sectionId: null, label: 'main.mp4',
  startSec: 0, endSec: 10, videoFileId: 'v1', storageKey: 'videos/main.mp4',
  sourceInSec: 0, sourceOutSec: 10, ...over,
});

const clip = (over: Partial<ClipWindow> = {}): ClipWindow => ({
  kind: 'clip', sectionId: 'sec-clip', label: 'clip',
  startSec: 2, endSec: 4, sourceVideoFileId: 'v2', storageKey: 'videos/clip.mp4',
  sourceInSec: 1, sourceOutSec: 3, sourceRole: 'clip', ...over,
});

const image = (over: Partial<ImageWindow> = {}): ImageWindow => ({
  kind: 'image', sectionId: 'sec-img', label: 'img',
  startSec: 3, endSec: 5, imageFileId: 'i1', storageKey: 'images/a.png',
  crop: { x: 0, y: 0, w: 1, h: 1 }, ...over,
});

const poster = (over: Partial<PosterFallbackWindow> = {}): PosterFallbackWindow => ({
  kind: 'poster-fallback', sectionId: 'sec-sim', label: 'sim',
  startSec: 6, endSec: 8, posterKey: 'posters/p.webp', ...over,
});

function plan(timeline: ExportWindow[], audio: ExportAudioWindow[] = [], totalDurationSec = 10): ExportPlan {
  return {
    projectId: 'p1', grid: { ...GRID }, timeline, audio,
    sources: [], rendererIdentity: null, warnings: [],
    estimatedSourceBytes: 0, requiredDiskBytes: 0, totalDurationSec,
  };
}

const identity = (key: string) => `/work/sources/${key}`;

describe('flattening the layered timeline', () => {
  it('cuts overlay holes into the base and resumes the base at ABSOLUTE time', () => {
    const t = translateContractPlan(plan([base(), clip()]), identity);
    expect(t.timeline).toEqual([
      { kind: 'video', startSec: 0, endSec: 2, sourcePath: identity('videos/main.mp4'), sourceInSec: 0 },
      { kind: 'clip', startSec: 2, endSec: 4, sourcePath: identity('videos/clip.mp4'), sourceInSec: 1 },
      // the base kept playing underneath: it resumes at source 4, not 2
      { kind: 'video', startSec: 4, endSec: 10, sourcePath: identity('videos/main.mp4'), sourceInSec: 4 },
    ]);
    expect(t.totalSec).toBe(10);
    expect(t.keys).toEqual(['videos/main.mp4', 'videos/clip.mp4']);
  });

  it('stacks poster over image over clip when they overlap, and says so', () => {
    const t = translateContractPlan(
      plan([base(), clip({ startSec: 2, endSec: 6, sourceInSec: 0, sourceOutSec: 4 }), image(), poster({ startSec: 4, endSec: 5 })]),
      identity,
    );
    expect(t.timeline.map((w) => [w.kind, w.startSec, w.endSec])).toEqual([
      ['video', 0, 2],
      ['clip', 2, 3],            // clip until the image starts
      ['image', 3, 4],           // image beats clip
      ['poster-fallback', 4, 5], // poster beats image
      ['clip', 5, 6],            // the clip resumes once the higher layers end
      ['video', 6, 10],
    ]);
    // the clip kept "playing" underneath: its resumed piece maps 1:1 from its window start
    const resumed = t.timeline[4]!;
    expect(resumed.sourceInSec).toBe(3);
    expect(t.warnings.some((w) => w.includes('overlap'))).toBe(true);
  });

  it('drops a null-poster fallback so the base shows through', () => {
    const t = translateContractPlan(plan([base(), poster({ posterKey: null })]), identity);
    expect(t.timeline).toEqual([
      { kind: 'video', startSec: 0, endSec: 10, sourcePath: identity('videos/main.mp4'), sourceInSec: 0 },
    ]);
  });

  it('renders a post-roll tail black when nothing covers it, bounded by the total', () => {
    // Sim tail [10,12) with no poster: beyond the base, nothing to show through.
    const t = translateContractPlan(plan([base(), poster({ startSec: 10, endSec: 12, posterKey: null })], [], 12), identity);
    expect(t.timeline).toEqual([
      { kind: 'video', startSec: 0, endSec: 10, sourcePath: identity('videos/main.mp4'), sourceInSec: 0 },
      { kind: 'poster-fallback', startSec: 10, endSec: 12 },
    ]);
    expect(t.warnings.some((w) => w.includes('render as black'))).toBe(true);
    expect(t.totalSec).toBe(12);
  });

  it('renders a post-roll poster tail as the poster', () => {
    const t = translateContractPlan(plan([base(), poster({ startSec: 9, endSec: 12 })], [], 12), identity);
    expect(t.timeline[t.timeline.length - 1]).toEqual({
      kind: 'poster-fallback', startSec: 9, endSec: 12, sourcePath: identity('posters/p.webp'),
    });
  });

  it('substitutes a sim-capture window that reached the assembler, loudly', () => {
    const sim: SimCaptureWindow = {
      kind: 'sim-capture', sectionId: 'sec-sim', label: 'sim', startSec: 6, endSec: 8,
      simulationId: 's1', servedUrl: 'http://sim', simpleUi: true, autoScript: true,
      uiHide: undefined, configHash: null, posterKey: 'posters/p.webp',
    };
    const t = translateContractPlan(plan([base(), sim]), identity);
    expect(t.timeline.some((w) => w.kind === 'poster-fallback' && w.sourcePath === identity('posters/p.webp'))).toBe(true);
    expect(t.warnings.some((w) => w.includes('sim-capture window reached the assembler'))).toBe(true);
  });

  it('snaps boundaries to the frame grid and keeps the total exact', () => {
    const t = translateContractPlan(
      plan([base({ endSec: 10.004, sourceOutSec: 10.004 }), clip({ startSec: 2.004, endSec: 4.004 })], [], 10.004),
      identity,
    );
    for (const w of t.timeline) {
      expect(Math.abs(w.startSec * 30 - Math.round(w.startSec * 30))).toBeLessThan(1e-9);
      expect(Math.abs(w.endSec * 30 - Math.round(w.endSec * 30))).toBeLessThan(1e-9);
    }
    expect(t.totalSec).toBe(Math.round(10.004 * 30) / 30);
    // contiguity survives snapping
    let cursor = 0;
    for (const w of t.timeline) {
      expect(w.startSec).toBe(cursor);
      cursor = w.endSec;
    }
    expect(cursor).toBe(t.totalSec);
  });

  it('drops sub-frame slivers instead of emitting zero-length windows', () => {
    const t = translateContractPlan(
      plan([base(), clip({ startSec: 2, endSec: 2.01, sourceInSec: 0, sourceOutSec: 0.01 })]),
      identity,
    );
    expect(t.timeline.every((w) => w.endSec - w.startSec >= 1 / 30 - 1e-9)).toBe(true);
  });

  it('clips an overlay extending past the total, with a warning', () => {
    const t = translateContractPlan(plan([base(), poster({ startSec: 9, endSec: 14 })], [], 12), identity);
    expect(t.timeline[t.timeline.length - 1]!.endSec).toBe(12);
    expect(t.warnings.some((w) => w.includes('clipped'))).toBe(true);
  });

  it('passes non-identity image crops through and drops identity crops', () => {
    const t = translateContractPlan(
      plan([base(), image({ crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }), image({ startSec: 5, endSec: 6, sectionId: 'sec-img2' })]),
      identity,
    );
    const imgs = t.timeline.filter((w) => w.kind === 'image');
    expect(imgs[0]!.cropFrac).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    expect(imgs[1]!.cropFrac).toBeUndefined();
  });

  it('refuses a video/clip window without a storage key, naming it', () => {
    expect(() => translateContractPlan(plan([base({ storageKey: null })]), identity))
      .toThrow(ExportPlanShapeError);
    expect(() => translateContractPlan(plan([base(), clip({ storageKey: null })]), identity))
      .toThrow(/no source master in storage/);
  });

  it('refuses a splice window whose source range disagrees with its span', () => {
    expect(() =>
      translateContractPlan(plan([base(), clip({ sourceOutSec: 10 })]), identity),
    ).toThrow(/1:1/);
  });

  it('refuses a non-positive total', () => {
    expect(() => translateContractPlan(plan([base()], [], 0), identity)).toThrow(ExportPlanShapeError);
  });
});

describe('audio translation', () => {
  const mainAudio = (over: Partial<ExportAudioWindow> = {}): ExportAudioWindow => ({
    source: 'main', sectionId: null, globalOffsetSec: 0,
    sourceInSec: 0, sourceOutSec: 10, storageKey: 'videos/main.mp4', gain: 1.0, ...over,
  });

  it('maps gain to dB: 1.0 → no volume filter, 0.5 → −6.02 dB, 0 → dropped with a warning', () => {
    expect(gainToDb(0.5)).toBeCloseTo(-6.0206, 3);
    expect(gainToDb(1)).toBe(0);
    expect(gainToDb(0)).toBeNull();
    expect(gainToDb(-2)).toBeNull();

    const t = translateContractPlan(
      plan([base()], [
        mainAudio(),
        mainAudio({ source: 'audio', sectionId: 'cut', globalOffsetSec: 2, sourceInSec: 0, sourceOutSec: 2, storageKey: 'audio/c.mp3', gain: 0.5 }),
        mainAudio({ source: 'audio', sectionId: 'muted', globalOffsetSec: 4, sourceInSec: 0, sourceOutSec: 2, storageKey: 'audio/m.mp3', gain: 0 }),
      ]),
      identity,
    );
    expect(t.audio).toHaveLength(2);
    expect(t.audio[0]!.gainDb).toBeUndefined();
    expect(t.audio[1]!.gainDb).toBeCloseTo(-6.0206, 3);
    expect(t.warnings.some((w) => w.includes('silences it'))).toBe(true);
  });

  it('places windows absolutely and trims overhang past the export end', () => {
    const t = translateContractPlan(
      plan([base()], [mainAudio({ source: 'audio', sectionId: 'c', globalOffsetSec: 8, sourceInSec: 1, sourceOutSec: 5, storageKey: 'audio/c.mp3', gain: 0.9 })]),
      identity,
    );
    expect(t.audio[0]).toMatchObject({ startSec: 8, endSec: 10, sourceInSec: 1 });
    expect(t.warnings.some((w) => w.includes('trimmed'))).toBe(true);
  });

  it('drops windows with no stored source or empty range, with warnings', () => {
    const t = translateContractPlan(
      plan([base()], [
        mainAudio({ storageKey: null }),
        mainAudio({ source: 'audio', sectionId: 'e', globalOffsetSec: 1, sourceInSec: 2, sourceOutSec: 2, storageKey: 'audio/e.mp3' }),
        mainAudio({ source: 'audio', sectionId: 'late', globalOffsetSec: 11, sourceInSec: 0, sourceOutSec: 1, storageKey: 'audio/l.mp3' }),
      ]),
      identity,
    );
    expect(t.audio).toEqual([]);
    expect(t.warnings.filter((w) => w.includes('omitted from the mix'))).toHaveLength(3);
  });

  it('deduplicates storage keys across video and audio use', () => {
    const t = translateContractPlan(plan([base()], [mainAudio()]), identity);
    expect(t.keys).toEqual(['videos/main.mp4']);
  });
});
