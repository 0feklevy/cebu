import { describe, it, expect } from 'vitest';
import {
  normalizeSpeakerTimeline,
  normalizeFaces,
  facesAreDegenerate,
  normalizeCircleSections,
  normalizeAvatarCircles,
  classifyAvatarCircles,
  type SceneRow,
  type CircleFace,
} from '../normalizeAvatarCircles.js';

const scene = (speaker: string, start_ms: number, end_ms: number, script_version = 1): SceneRow => ({ speaker, start_ms, end_ms, script_version });

describe('normalizeSpeakerTimeline — gap-fill so manual sections in pauses still attribute a speaker', () => {
  it('fills the gap between two turns (no null hole inside scripted coverage)', () => {
    // host_a [0,5], host_b [6,10] — a 1s pause at [5,6] would otherwise resolve to null.
    const tl = normalizeSpeakerTimeline([scene('host_a', 0, 5000), scene('host_b', 6000, 10000)]);
    expect(tl).toEqual([
      { speaker: 'host_a', start_sec: 0, end_sec: 6 },   // extended to the next turn's start
      { speaker: 'host_b', start_sec: 6, end_sec: 10 },  // last span keeps its own end
    ]);
  });

  it('clips an overlap to the next turn start', () => {
    const tl = normalizeSpeakerTimeline([scene('host_a', 0, 7000), scene('host_b', 5000, 9000)]);
    expect(tl[0]).toEqual({ speaker: 'host_a', start_sec: 0, end_sec: 5 });
    expect(tl[1]).toEqual({ speaker: 'host_b', start_sec: 5, end_sec: 9 });
  });

  it('merges consecutive same-speaker turns', () => {
    const tl = normalizeSpeakerTimeline([scene('host_a', 0, 3000), scene('host_a', 3000, 6000), scene('host_b', 6000, 8000)]);
    expect(tl).toEqual([
      { speaker: 'host_a', start_sec: 0, end_sec: 6 },
      { speaker: 'host_b', start_sec: 6, end_sec: 8 },
    ]);
  });

  it('keeps only the latest script_version and drops invalid rows', () => {
    const tl = normalizeSpeakerTimeline([
      scene('host_a', 0, 5000, 1),          // old version — dropped
      scene('host_b', 0, 4000, 2),
      scene('', 4000, 6000, 2),             // empty speaker — dropped
      scene('host_a', 7000, 6000, 2),       // end<=start — dropped
      scene('host_a', 6000, 9000, 2),
    ]);
    expect(tl).toEqual([
      { speaker: 'host_b', start_sec: 0, end_sec: 6 },
      { speaker: 'host_a', start_sec: 6, end_sec: 9 },
    ]);
  });

  it('empty scenes ⇒ empty timeline (script-less uploads keep the all-circles fallback)', () => {
    expect(normalizeSpeakerTimeline([])).toEqual([]);
    expect(normalizeSpeakerTimeline(undefined)).toEqual([]);
  });
});

describe('normalizeFaces — distinct speaker→circle mapping (his wave / her wave)', () => {
  it('both faces the SAME speaker ⇒ forced to host_a/host_b', () => {
    const faces: CircleFace[] = [{ speaker: 'host_a', side: 'left' }, { speaker: 'host_a', side: 'right' }];
    expect(normalizeFaces(faces, 2)).toEqual([
      { side: 'left', speaker: 'host_a' },
      { side: 'right', speaker: 'host_b' },
    ]);
  });

  it('count:2 with a single face ⇒ two distinct faces', () => {
    expect(normalizeFaces([{ speaker: 'host_b', side: 'left' }], 2)).toEqual([
      { side: 'left', speaker: 'host_b' },
      { side: 'right', speaker: 'host_a' },   // forced distinct from left
    ]);
  });

  it('both entries side:left ⇒ left/right filled, defaults applied', () => {
    const faces: CircleFace[] = [{ speaker: 'host_a', side: 'left' }, { speaker: 'host_b', side: 'left' }];
    expect(normalizeFaces(faces, 2)).toEqual([
      { side: 'left', speaker: 'host_a' },
      { side: 'right', speaker: 'host_b' },   // no right entry existed → default
    ]);
  });

  it('count:1 ⇒ a single left circle', () => {
    expect(normalizeFaces(undefined, 1)).toEqual([{ side: 'left', speaker: 'host_a' }]);
  });

  it('count:1 with only a RIGHT face ⇒ pinned to left, keeps its image/label (no drop)', () => {
    const faces: CircleFace[] = [{ speaker: 'host_b', side: 'right', imageUrl: 'r.png', label: 'Rae' }];
    expect(normalizeFaces(faces, 1)).toEqual([{ side: 'left', speaker: 'host_b', imageUrl: 'r.png', label: 'Rae' }]);
    // and classify flags it so the backfill actually repairs it (classify ↔ read-path parity)
    expect(facesAreDegenerate(faces, 1)).toBe(true);
  });

  it('preserves imageUrl/label from the matching side entry', () => {
    const faces: CircleFace[] = [
      { speaker: 'host_a', side: 'left', imageUrl: 'a.png', label: 'Alice' },
      { speaker: 'host_b', side: 'right', label: 'Bob' },
    ];
    expect(normalizeFaces(faces, 2)).toEqual([
      { side: 'left', speaker: 'host_a', imageUrl: 'a.png', label: 'Alice' },
      { side: 'right', speaker: 'host_b', label: 'Bob' },
    ]);
  });
});

describe('facesAreDegenerate', () => {
  it('absent faces are NOT a repair (defaults apply)', () => {
    expect(facesAreDegenerate(undefined, 2)).toBe(false);
  });
  it('flags same-speaker, wrong-count, duplicate-side, invalid enum', () => {
    expect(facesAreDegenerate([{ speaker: 'host_a', side: 'left' }, { speaker: 'host_a', side: 'right' }], 2)).toBe(true);
    expect(facesAreDegenerate([{ speaker: 'host_a', side: 'left' }], 2)).toBe(true);
    expect(facesAreDegenerate([{ speaker: 'host_a', side: 'left' }, { speaker: 'host_b', side: 'left' }], 2)).toBe(true);
    expect(facesAreDegenerate([{ speaker: 'bad' as 'host_a', side: 'left' }, { speaker: 'host_b', side: 'right' }], 2)).toBe(true);
  });
  it('a clean distinct mapping is NOT degenerate', () => {
    expect(facesAreDegenerate([{ speaker: 'host_a', side: 'left' }, { speaker: 'host_b', side: 'right' }], 2)).toBe(false);
  });
});

describe('normalizeCircleSections', () => {
  it('clamps, drops sub-0.5s, sorts, merges touching/overlapping', () => {
    const out = normalizeCircleSections([
      { id: 'b', start_sec: 12, end_sec: 8 },      // inverted → [8,12]
      { id: 'a', start_sec: 0, end_sec: 0.2 },     // too short → dropped
      { id: 'c', start_sec: 4, end_sec: 9 },       // overlaps [8,12] → merged
    ], 100);
    expect(out).toEqual([{ id: 'c', start_sec: 4, end_sec: 12 }]);
  });
});

describe('normalizeAvatarCircles + classifyAvatarCircles', () => {
  it('repairs a degenerate config while passing viz fields through', () => {
    const cfg = {
      enabled: true, visibility: 'manual', count: 2 as const, barColor: '#fff', numberOfBars: 240,
      faces: [{ speaker: 'host_a', side: 'left' }, { speaker: 'host_a', side: 'right' }] as CircleFace[],
      manualSections: [{ id: 's1', start_sec: 3, end_sec: 2.9 }, { id: 's2', start_sec: 5, end_sec: 9 }],
    };
    const out = normalizeAvatarCircles(cfg);
    expect(out.faces).toEqual([{ side: 'left', speaker: 'host_a' }, { side: 'right', speaker: 'host_b' }]);
    expect(out.manualSections).toEqual([{ id: 's2', start_sec: 5, end_sec: 9 }]); // s1 dropped (<0.5s)
    expect(out.barColor).toBe('#fff');           // untouched
    expect(out.numberOfBars).toBe(240);

    const cls = classifyAvatarCircles(cfg);
    expect(cls.facesRepaired).toBe(true);
    expect(cls.sectionsRepaired).toBe(true);
    expect(cls.usesManualLayer).toBe(true);
  });

  it('a clean config classifies as no-repair', () => {
    const cfg = {
      enabled: true, visibility: 'broll', count: 2 as const,
      faces: [{ speaker: 'host_a', side: 'left' }, { speaker: 'host_b', side: 'right' }] as CircleFace[],
    };
    const cls = classifyAvatarCircles(cfg);
    expect(cls.facesRepaired).toBe(false);
    expect(cls.sectionsRepaired).toBe(false);
  });
});
