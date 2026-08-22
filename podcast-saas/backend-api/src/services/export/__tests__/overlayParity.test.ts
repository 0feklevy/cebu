/**
 * VIEWER/EXPORT PARITY on overlapping overlays (broll-player-002, C4).
 *
 * The bug this pins was not that either side was unreasonable — it was that they were DIFFERENT,
 * silently, on content the product lets anyone author. The viewer took the first array match (so a
 * `clip_overlay` could never beat a `broll_clip`, and array order decided what a person saw); the
 * export ranked by layer, then later start, then array index. A creator previewed one cut and
 * downloaded another, and the export even emitted a warning promising that "the viewer's stacking
 * order decides" — a stacking order the viewer did not have.
 *
 * So this suite asserts AGREEMENT, not a favourite winner: for the same authored overlap, what the
 * viewer selects and what the export renders must be the same clip. It drives the REAL
 * `translateContractPlan` and the REAL ranking the viewer now builds, so it fails if either side
 * drifts away from the shared rule.
 */
import { describe, it, expect } from 'vitest';
import { OVERLAY_LAYER, topmostAt, type StackRank } from 'shared';
import { translateContractPlan } from '../resolvePlan.js';
import type { ClipWindow, ExportPlan, ExportWindow, ImageWindow, VideoWindow } from '../types.js';

const GRID = { w: 1920, h: 1080, fps: 30 };
const TOTAL = 60;
const identity = (key: string) => `/work/sources/${key}`;

/** One authored clip, in the two shapes the two surfaces read it as. */
interface Authored { id: string; offset: number; len: number }

const viewerClip = (c: Authored) => ({
  id: c.id, global_offset_sec: c.offset, start_sec: 0, end_sec: c.len,
});

/** SHAPE-IDENTICAL to useProjectPlayer's `asStackedClip`; drift here is the thing being caught. */
function viewerRank(clip: ReturnType<typeof viewerClip>): StackRank {
  return {
    id: clip.id,
    layer: OVERLAY_LAYER.clip,
    start: clip.global_offset_sec,
    end: clip.global_offset_sec + (clip.end_sec - clip.start_sec),
  };
}

/** What the viewer would show at `t` — the clip id, or null for "base video showing". */
function viewerPick(clips: Authored[], t: number): string | null {
  return topmostAt(clips.map((c) => viewerRank(viewerClip(c))), t)?.id ?? null;
}

const baseWindow = (): VideoWindow => ({
  kind: 'video', sectionId: null, label: 'main.mp4',
  startSec: 0, endSec: TOTAL, videoFileId: 'v-base', storageKey: 'videos/base.mp4',
  sourceInSec: 0, sourceOutSec: TOTAL,
});

const clipWindow = (c: Authored): ClipWindow => ({
  kind: 'clip', sectionId: c.id, label: c.id,
  startSec: c.offset, endSec: c.offset + c.len,
  sourceVideoFileId: `v-${c.id}`, storageKey: `videos/${c.id}.mp4`,
  sourceInSec: 0, sourceOutSec: c.len, sourceRole: 'clip',
});

function planFor(clips: Authored[]): ExportPlan {
  const timeline: ExportWindow[] = [baseWindow(), ...clips.map(clipWindow)];
  return {
    projectId: 'p1', grid: { ...GRID }, timeline, audio: [],
    sources: [], rendererIdentity: null, warnings: [],
    estimatedSourceBytes: 0, requiredDiskBytes: 0, totalDurationSec: TOTAL,
  } as unknown as ExportPlan;
}

/**
 * What the export renders at `t`, as a clip id.
 *
 * The resolved windows carry a source PATH rather than a section id, so identity comes back out of
 * the storage key each fixture was built with — which is also a check that the right SOURCE is
 * spliced, not merely the right label.
 */
function exportPick(clips: Authored[], t: number): string | null {
  const { timeline } = translateContractPlan(planFor(clips), identity);
  const win = timeline.find((w) => t >= w.startSec && t < w.endSec);
  if (!win) return null;
  const path = (win as { sourcePath?: string }).sourcePath ?? '';
  const m = /videos\/(.+)\.mp4$/.exec(path);
  const id = m?.[1] ?? null;
  return id === 'base' ? null : id;   // base showing === the viewer showing no overlay
}

describe('viewer and export agree on overlapping clips', () => {
  const A: Authored = { id: 'aaa', offset: 35, len: 10 };
  const B: Authored = { id: 'bbb', offset: 40, len: 10 };

  it('THE REPORTED CASE: A at 35s+10s, B at 40s+10s, sampled at 42s', () => {
    expect(viewerPick([A, B], 42)).toBe('bbb');   // the later start — placed most recently
    expect(exportPick([A, B], 42)).toBe('bbb');   // and the master contains the same clip
  });

  it('agrees across the whole overlap, not only at one instant', () => {
    for (let t = 30; t < 55; t += 0.5) {
      expect(exportPick([A, B], t), `t=${t}`).toBe(viewerPick([A, B], t));
    }
  });

  it('agrees when the clips are declared in the opposite order', () => {
    // Array position used to be the viewer's ENTIRE rule. It must now change nothing, on either side.
    expect(viewerPick([B, A], 42)).toBe(viewerPick([A, B], 42));
    expect(exportPick([B, A], 42)).toBe(exportPick([A, B], 42));
    expect(viewerPick([B, A], 42)).toBe(exportPick([B, A], 42));
  });

  it('agrees on a fully nested overlap', () => {
    const outer: Authored = { id: 'outer', offset: 10, len: 30 };
    const inner: Authored = { id: 'inner', offset: 20, len: 5 };
    for (const t of [12, 21, 24.9, 26, 39]) {
      expect(exportPick([outer, inner], t), `t=${t}`).toBe(viewerPick([outer, inner], t));
    }
  });

  it('agrees on identical spans, where only the stable id can break the tie', () => {
    const x: Authored = { id: 'aaa', offset: 20, len: 10 };
    const y: Authored = { id: 'bbb', offset: 20, len: 10 };
    expect(viewerPick([x, y], 25)).toBe('bbb');
    expect(exportPick([x, y], 25)).toBe('bbb');
  });

  it('agrees that abutting clips do not contend at the seam', () => {
    const p: Authored = { id: 'aaa', offset: 10, len: 10 };
    const q: Authored = { id: 'bbb', offset: 20, len: 10 };
    expect(viewerPick([p, q], 20)).toBe('bbb');
    expect(exportPick([p, q], 20)).toBe('bbb');
    expect(viewerPick([p, q], 19.9)).toBe('aaa');
    expect(exportPick([p, q], 19.9)).toBe('aaa');
  });

  it('lets the LAYER CLASS beat an earlier start — the case the old fixtures could not see', () => {
    // The export's own suite already had a poster > image > clip test, but in that fixture the
    // higher layer also started later, so removing the layer comparison entirely produced the same
    // answer and the test stayed green. Here the image starts FIRST and must still win: the only
    // thing that can put it on top is the layer class.
    const clip: Authored = { id: 'ccc', offset: 20, len: 20 };
    const plan: ExportPlan = {
      projectId: 'p1', grid: { ...GRID }, audio: [],
      timeline: [
        baseWindow(),
        clipWindow(clip),
        {
          kind: 'image', sectionId: 'img', label: 'img',
          startSec: 10, endSec: 45, imageFileId: 'i1', storageKey: 'images/a.png',
          crop: { x: 0, y: 0, w: 1, h: 1 },
        } satisfies ImageWindow,
      ] as ExportWindow[],
      sources: [], rendererIdentity: null, warnings: [],
      estimatedSourceBytes: 0, requiredDiskBytes: 0, totalDurationSec: TOTAL,
    } as unknown as ExportPlan;

    const { timeline } = translateContractPlan(plan, identity);
    const at = (t: number) => timeline.find((w) => t >= w.startSec && t < w.endSec)?.kind;
    expect(at(30)).toBe('image');   // inside both — the image is the higher layer
    expect(at(15)).toBe('image');   // image only
    expect(at(50)).toBe('video');   // past both overlays
  });

  it('agrees that a non-overlapping timeline shows the base between clips', () => {
    const p: Authored = { id: 'aaa', offset: 10, len: 5 };
    const q: Authored = { id: 'bbb', offset: 30, len: 5 };
    expect(viewerPick([p, q], 20)).toBeNull();
    expect(exportPick([p, q], 20)).toBeNull();
  });
});
