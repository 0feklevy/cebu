import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildTimeline, isMurmurText, type TimelineTurn } from '../timeline.js';

// buildTimeline samples gaps from triangular distributions via Math.random.
// With random mocked to a constant, tri(min, mode, max) is deterministic.
// We mostly assert RANGES and invariants so tests stay robust to tuning.
function turn(p: Partial<TimelineTurn> & Pick<TimelineTurn, 'turnId' | 'speaker' | 'durationMs'>): TimelineTurn {
  return { overlap: false, beat: 'b1', text: 'so the seats have numbers.', pauseAfterMs: undefined, ...p };
}

function gapBetween(turns: TimelineTurn[]): number {
  const { placements } = buildTimeline(turns);
  const a = turns[0];
  return placements[1].delayMs - a.durationMs; // start of b minus end of a
}

describe('isMurmurText', () => {
  it('accepts non-lexical murmurs and pure reaction tags', () => {
    for (const s of ['mm-hm', 'huh', 'whoa', 'oh wow', 'yeah', 'right', '[laughs]', '[gasps]', 'Mmm…', 'uh-huh']) {
      expect(isMurmurText(s), s).toBe(true);
    }
  });
  it('rejects anything with real words', () => {
    for (const s of ['no way', 'wait, what?', 'that cannot be right', 'hold on—', 'exactly my point']) {
      expect(isMurmurText(s), s).toBe(false);
    }
  });
});

describe('buildTimeline — sequential turns NEVER overlap', () => {
  beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0.5); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('places the first turn at 0', () => {
    const { placements } = buildTimeline([turn({ turnId: 'a', speaker: 'teacher', durationMs: 1000 })]);
    expect(placements[0]).toEqual({ turnId: 'a', delayMs: 0 });
  });

  it('honors pause_after_ms exactly', () => {
    const { placements } = buildTimeline([
      turn({ turnId: 'a', speaker: 'teacher', durationMs: 1000, pauseAfterMs: 500 }),
      turn({ turnId: 'b', speaker: 'learner', durationMs: 800 }),
    ]);
    expect(placements[1]).toEqual({ turnId: 'b', delayMs: 1500 });
  });

  it('every gap class yields a POSITIVE gap — no double-talk, even at the random extremes', () => {
    const cases: TimelineTurn[][] = [
      // cut-off
      [turn({ turnId: 'a', speaker: 'teacher', durationMs: 2000, text: 'and the wild part is—' }), turn({ turnId: 'b', speaker: 'learner', durationMs: 800 })],
      // latch opener
      [turn({ turnId: 'a', speaker: 'teacher', durationMs: 2000 }), turn({ turnId: 'b', speaker: 'learner', durationMs: 800, text: '—which is exactly the problem.' })],
      // laughter adjacency
      [turn({ turnId: 'a', speaker: 'teacher', durationMs: 2000, text: '[laughs] that is absurd.' }), turn({ turnId: 'b', speaker: 'learner', durationMs: 800 })],
      // short reaction
      [turn({ turnId: 'a', speaker: 'teacher', durationMs: 2000 }), turn({ turnId: 'b', speaker: 'learner', durationMs: 300, text: 'No way.' })],
      // normal exchange
      [turn({ turnId: 'a', speaker: 'teacher', durationMs: 2000 }), turn({ turnId: 'b', speaker: 'learner', durationMs: 800, text: 'and that is where it gets strange.' })],
    ];
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
      vi.spyOn(Math, 'random').mockReturnValue(r);
      for (const c of cases) {
        expect(gapBetween(c)).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it('a scripted cut-off ("—") snaps in fast — quicker than a normal exchange thinking gap', () => {
    const cut = gapBetween([
      turn({ turnId: 'a', speaker: 'teacher', durationMs: 2000, text: 'and the wild part is—' }),
      turn({ turnId: 'b', speaker: 'learner', durationMs: 800 }),
    ]);
    expect(cut).toBeGreaterThanOrEqual(30);
    expect(cut).toBeLessThanOrEqual(150);
  });

  it('a beat bridge breathes far longer than a normal exchange', () => {
    const bridge = gapBetween([
      turn({ turnId: 'a', speaker: 'teacher', durationMs: 2000, beat: 'b1' }),
      turn({ turnId: 'b', speaker: 'learner', durationMs: 800, beat: 'b2' }),
    ]);
    const normal = gapBetween([
      turn({ turnId: 'a', speaker: 'teacher', durationMs: 2000, beat: 'b1' }),
      turn({ turnId: 'b', speaker: 'learner', durationMs: 800, beat: 'b1' }),
    ]);
    expect(bridge).toBeGreaterThanOrEqual(500);
    expect(bridge).toBeLessThanOrEqual(1300);
    expect(bridge).toBeGreaterThan(normal);
  });

  it('wh-questions get slower answers than polar questions', () => {
    const wh = gapBetween([
      turn({ turnId: 'a', speaker: 'teacher', durationMs: 2000, text: 'why would the matrix care about order?' }),
      turn({ turnId: 'b', speaker: 'learner', durationMs: 800, text: 'because the seats are numbered rows first.' }),
    ]);
    const polar = gapBetween([
      turn({ turnId: 'a', speaker: 'teacher', durationMs: 2000, text: 'is the matrix just a grid?' }),
      turn({ turnId: 'b', speaker: 'learner', durationMs: 800, text: 'because the seats are numbered rows first.' }),
    ]);
    expect(wh).toBeGreaterThan(polar);
  });

  it('a dispreferred response ("Well…") arrives late — the pause carries meaning', () => {
    const gap = gapBetween([
      turn({ turnId: 'a', speaker: 'teacher', durationMs: 2000 }),
      turn({ turnId: 'b', speaker: 'learner', durationMs: 800, text: 'Well… I actually don\'t buy that.' }),
    ]);
    expect(gap).toBeGreaterThanOrEqual(500);
  });

  it('no sampled silence ever exceeds ~1.3s (explicit editor pauses are verbatim)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const bridged = gapBetween([
      turn({ turnId: 'a', speaker: 'teacher', durationMs: 2000, beat: 'b1' }),
      turn({ turnId: 'b', speaker: 'learner', durationMs: 800, beat: 'b2' }),
    ]);
    expect(bridged).toBeLessThanOrEqual(1300);
    const explicit = gapBetween([
      turn({ turnId: 'a', speaker: 'teacher', durationMs: 1000, pauseAfterMs: 5000 }),
      turn({ turnId: 'b', speaker: 'learner', durationMs: 800 }),
    ]);
    expect(explicit).toBe(5000);
  });
});

describe('buildTimeline — murmurs are the only parallel audio', () => {
  beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0.5); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('a murmur rides the tail of the previous line, ducked', () => {
    const { placements } = buildTimeline([
      turn({ turnId: 'a', speaker: 'teacher', durationMs: 4000 }),
      turn({ turnId: 'c', speaker: 'learner', durationMs: 400, overlap: true, text: 'mm-hm' }),
      turn({ turnId: 'b', speaker: 'teacher', durationMs: 800 }),
    ]);
    const c = placements.find((p) => p.turnId === 'c')!;
    expect(c.gainDb).toBe(-6);
    expect(c.delayMs).toBeGreaterThanOrEqual(4000 * 0.55);
    expect(c.delayMs + 400).toBeLessThanOrEqual(4000 + 250); // spills ≤250ms past the line
  });

  it('a WORDED reaction marked overlap:true is demoted to sequential — never parallel', () => {
    const { placements } = buildTimeline([
      turn({ turnId: 'a', speaker: 'teacher', durationMs: 3000 }),
      turn({ turnId: 'c', speaker: 'learner', durationMs: 700, overlap: true, text: 'wait, that cannot be right' }),
      turn({ turnId: 'b', speaker: 'teacher', durationMs: 800 }),
    ]);
    const c = placements.find((p) => p.turnId === 'c')!;
    expect(c.gainDb).toBeUndefined();            // not ducked — it's a real line
    expect(c.delayMs).toBeGreaterThanOrEqual(3000 + 30); // starts AFTER the previous line ends
    const b = placements.find((p) => p.turnId === 'b')!;
    expect(b.delayMs).toBeGreaterThanOrEqual(c.delayMs + 700); // and the next line waits for it
  });

  it('a too-long murmur clip is demoted to sequential too', () => {
    const { placements } = buildTimeline([
      turn({ turnId: 'a', speaker: 'teacher', durationMs: 3000 }),
      turn({ turnId: 'c', speaker: 'learner', durationMs: 1500, overlap: true, text: 'mm-hm' }),
    ]);
    const c = placements.find((p) => p.turnId === 'c')!;
    expect(c.gainDb).toBeUndefined();
    expect(c.delayMs).toBeGreaterThanOrEqual(3000);
  });

  it('keeps a same-speaker line from overlapping its own murmur', () => {
    const { placements } = buildTimeline([
      turn({ turnId: 'a', speaker: 'teacher', durationMs: 1000 }),
      turn({ turnId: 'c', speaker: 'learner', durationMs: 400, overlap: true, text: 'right' }),
      turn({ turnId: 'b', speaker: 'learner', durationMs: 800 }),
    ]);
    const c = placements.find((p) => p.turnId === 'c')!;
    const b = placements.find((p) => p.turnId === 'b')!;
    expect(b.delayMs).toBeGreaterThanOrEqual(c.delayMs + 400 + 120);
  });

  it('reports a total that covers the last clip end', () => {
    const { placements, totalMs } = buildTimeline([
      turn({ turnId: 'a', speaker: 'teacher', durationMs: 1000, beat: 'b1' }),
      turn({ turnId: 'b', speaker: 'learner', durationMs: 800, beat: 'b1' }),
    ]);
    expect(totalMs).toBe(placements[1].delayMs + 800);
  });

  it('gap variance: identical exchanges with live randomness differ (no metronome)', () => {
    vi.restoreAllMocks();
    const mk = () => gapBetween([
      turn({ turnId: 'a', speaker: 'teacher', durationMs: 2000 }),
      turn({ turnId: 'b', speaker: 'learner', durationMs: 800, text: 'and that is where it gets strange for real.' }),
    ]);
    const samples = new Set(Array.from({ length: 24 }, mk));
    expect(samples.size).toBeGreaterThan(4);
  });
});
