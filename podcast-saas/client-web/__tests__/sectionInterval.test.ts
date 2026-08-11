/**
 * The section/playhead boundary tolerance (audit §9.6).
 *
 * The editor decided which section was active with strict containment, `t >= start && t < end`.
 * `useEditorPlayback.onEnded` parks the playhead EXACTLY on the end of the last clip, so a
 * post-roll simulation — one whose section runs to the end of the timeline — was never active at
 * the final instant: the one instant it exists for. The viewer has always tolerated that instant
 * (its `onEnded` snaps into a section the media end lands in, `seg.duration >= s.start_sec - 0.05`),
 * and this is that same tolerance, shared rather than duplicated.
 *
 * The hazard the fix must not create is TWO active sections. That is what the strict-first pass and
 * the end-of-timeline restriction are for, and most of what is pinned below.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { SECTION_BOUNDARY_EPSILON_SEC, sectionAtPlayhead } from '../lib/sectionInterval';

// NOT `new URL(<literal>, import.meta.url)`: Vite rewrites that exact form into a bundled asset
// reference, and the result is an http: URL that readFileSync refuses.
const HERE = dirname(fileURLToPath(import.meta.url));
const readSource = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8');

interface Sec { id: string; start: number; end: number }
const bounds = (s: Sec) => ({ start: s.start, end: s.end });
const at = (sections: Sec[], t: number, timelineEnd: number) =>
  sectionAtPlayhead(sections, t, bounds, timelineEnd)?.id ?? null;

const EPS = SECTION_BOUNDARY_EPSILON_SEC;

describe('a post-roll simulation is active at the final instant', () => {
  // One 100 s video with a simulation over its last 10 s. onEnded parks the playhead on 100.
  const sections = [{ id: 'intro', start: 0, end: 90 }, { id: 'sim', start: 90, end: 100 }];

  it('is active AT the end, where strict containment said nothing was', () => {
    expect(at(sections, 100, 100)).toBe('sim');
  });

  it('is active a hair before and a hair after — the media clock is not exact', () => {
    expect(at(sections, 99.98, 100)).toBe('sim');
    expect(at(sections, 100.02, 100)).toBe('sim');
  });

  it('is still active when the section is APPENDED past the video, and the media stops short', () => {
    // Sections are laid out from the stored duration_sec; the playhead comes from the media clock,
    // whose real duration is a few ms shorter. Without the START tolerance this simulation is not
    // merely late — the playhead never reaches its start, so it can never activate at all.
    // (The list is the simulation-typed sections, which is how the editor asks the question.)
    const appended = [{ id: 'post', start: 100, end: 110 }];
    expect(at(appended, 99.97, 110)).toBe('post');
    expect(at(appended, 99.9, 110)).toBeNull();
  });

  it('stops being active once the playhead is genuinely past the tolerance', () => {
    expect(at(sections, 100 + EPS, 100)).toBeNull();
    expect(at(sections, 100.5, 100)).toBeNull();
  });
});

describe('two sections are never active at once', () => {
  const touching = [{ id: 'a', start: 0, end: 10 }, { id: 'b', start: 10, end: 20 }];

  it('resolves the shared edge of two touching sections to exactly one — the incoming one', () => {
    // `a.end === b.start`, and the strict pass owns that instant, so widening changed nothing here.
    expect(at(touching, 10, 20)).toBe('b');
    expect(at([...touching].reverse(), 10, 20)).toBe('b');   // and not merely by list order
  });

  it('resolves the final instant to exactly one, even though both bounds were widened', () => {
    expect(at(touching, 20, 20)).toBe('b');
    expect(at([...touching].reverse(), 20, 20)).toBe('b');
  });

  it('lets a section that CONTAINS the playhead beat one that only tolerates it', () => {
    // 9.96 is inside `a`, and within epsilon of `b`'s start. Strict containment runs first and
    // wins, so the widened bounds never even get to disagree with it.
    expect(at(touching, 9.96, 20)).toBe('a');
  });

  it('never returns more than one section, at any instant near an edge', () => {
    for (const t of [9.96, 9.99, 10, 10.01, 10.04, 19.99, 20, 20.04]) {
      const hit = sectionAtPlayhead(touching, t, bounds, 20);
      expect(touching.filter(s => s === hit).length, `t=${t}`).toBeLessThanOrEqual(1);
    }
  });

  it('does not widen a MID-TIMELINE section AT ALL — the cross-overlay hazard', () => {
    // The editor evaluates one predicate per overlay kind (simulation, clip, image, b-roll) over
    // SEPARATE lists, so nothing would catch a just-ended image overlay and a just-started
    // simulation both matching at their shared edge. Only a section that runs to the end of the
    // timeline is ever widened, so a mid-timeline edge behaves exactly as it did before.
    const image = [{ id: 'image', start: 0, end: 10 }];
    const sim = [{ id: 'sim', start: 10, end: 20 }];
    expect(at(image, 10, 20)).toBeNull();      // ended: no tolerance, it is not the last section
    expect(at(sim, 10, 20)).toBe('sim');       // started: strict containment, exactly one active
  });

  it('widens the timeline\'s LAST section on both edges, and nothing else', () => {
    // A gap before the final section is the appended-post-roll layout: the media stops where the
    // video stops, a few ms short of where the section was laid out.
    const withGap = [{ id: 'a', start: 0, end: 10 }, { id: 'b', start: 12, end: 20 }];
    expect(at(withGap, 10, 20)).toBeNull();      // `a` ended and is not the last section
    expect(at(withGap, 11.5, 20)).toBeNull();    // deep in the gap: nothing is active
    expect(at(withGap, 11.97, 20)).toBe('b');    // within tolerance of the last section's start
    expect(at(withGap, 20, 20)).toBe('b');       // and of its end
  });
});

describe('a normal mid-roll section behaves exactly as before', () => {
  const sections = [{ id: 'a', start: 10, end: 20 }];

  it('is active through its interior and at its start', () => {
    expect(at(sections, 10, 100)).toBe('a');
    expect(at(sections, 15, 100)).toBe('a');
    expect(at(sections, 19.999, 100)).toBe('a');
  });

  it('is NOT active at or after its end, or before its start', () => {
    expect(at(sections, 20, 100)).toBeNull();
    expect(at(sections, 20.01, 100)).toBeNull();
    expect(at(sections, 9.99, 100)).toBeNull();
  });

  it('matches nothing when the list is empty, whatever the playhead', () => {
    expect(at([], 0, 100)).toBeNull();
    expect(at([], 100, 100)).toBeNull();
  });
});

describe('the tolerance is the viewer\'s, not a second one', () => {
  const read = readSource;

  it('is 50 ms — the value useProjectPlayer has always used', () => {
    expect(SECTION_BOUNDARY_EPSILON_SEC).toBe(0.05);
  });

  it('is IMPORTED by the viewer, so the two clocks cannot drift apart', () => {
    const viewer = read('../components/viewer/useProjectPlayer.ts');
    expect(viewer).toContain("SECTION_BOUNDARY_EPSILON_SEC } from '../../lib/sectionInterval'");
    // The section/sim interval comparisons must read the constant, not a bare literal.
    expect(viewer).toContain('start_sec <= SECTION_BOUNDARY_EPSILON_SEC');
    expect(viewer).toContain('start_sec >= segmentDuration - SECTION_BOUNDARY_EPSILON_SEC');
    expect(viewer).toContain('seg.duration >= s.start_sec - SECTION_BOUNDARY_EPSILON_SEC');
  });

  it('is what the EDITOR\'s playhead predicates go through — no strict containment left', () => {
    const editor = read('../components/VideoEditor.tsx');
    expect(editor).toContain("sectionAtPlayhead } from '../lib/sectionInterval'");
    // The exact shape of the bug: an interval end compared strictly against the playhead.
    expect(editor).not.toMatch(/playheadSec\s*<\s*sectionGlobalEnd/);
    expect(editor).not.toMatch(/playheadSec\s*>=\s*sectionGlobalStart/);
  });
});
