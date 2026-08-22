/**
 * llm-pipeline-016 — a compile pass that guts the script must not be marked ready.
 *
 * The only guards were `directed.turns.length >= compiled.turns.length` and an all-or-nothing
 * fallback at exactly zero turns. A compiler returning THREE turns from a sixty-turn draft passed
 * both: the body was hashed, the script written `status: 'ready'` and the episode `script_ready`.
 * A gutted paid deliverable, marked complete, with nothing anywhere to indicate it.
 *
 * Zero is not the failure mode that happens; near-zero is.
 */
import { describe, it, expect } from 'vitest';
import { compiledBodyIsTooSmall, MIN_COMPILED_TURN_RATIO } from '../ScriptRoom.js';

describe('compiledBodyIsTooSmall', () => {
  it('THE REPORTED CASE: 3 turns compiled from a 60-turn draft', () => {
    expect(compiledBodyIsTooSmall(3, 60)).toBe(true);
  });

  it('still catches the zero case the old guard handled', () => {
    expect(compiledBodyIsTooSmall(0, 60)).toBe(true);
    expect(compiledBodyIsTooSmall(0, 1)).toBe(true);
  });

  it('accepts a body that kept the draft, or grew past it', () => {
    // splitLongTurn can only increase the final count, and the delivery director ADDS
    // backchannels — so a compiled body larger than the draft is the ordinary case, not a warning.
    expect(compiledBodyIsTooSmall(60, 60)).toBe(false);
    expect(compiledBodyIsTooSmall(75, 60)).toBe(false);
  });

  it('accepts ordinary compression above the floor', () => {
    // Merging a few turns is what the compiler is FOR. The floor must not punish it.
    expect(compiledBodyIsTooSmall(50, 60)).toBe(false);
    expect(compiledBodyIsTooSmall(31, 60)).toBe(false);
  });

  it('sits exactly where the ratio says, on both sides of the boundary', () => {
    const draft = 60;
    const floor = Math.ceil(draft * MIN_COMPILED_TURN_RATIO);
    expect(compiledBodyIsTooSmall(floor, draft), 'at the floor is acceptable').toBe(false);
    expect(compiledBodyIsTooSmall(floor - 1, draft), 'below the floor is a loss').toBe(true);
  });

  it('rounds the floor UP, so a tiny draft cannot be halved away', () => {
    // ceil(3 * 0.5) = 2, so one turn out of three is a loss rather than a rounding artefact.
    expect(compiledBodyIsTooSmall(1, 3)).toBe(true);
    expect(compiledBodyIsTooSmall(2, 3)).toBe(false);
  });

  it('passes a single-turn draft through, since one turn is the whole of it', () => {
    expect(compiledBodyIsTooSmall(1, 1)).toBe(false);
  });

  it('does not fail a script for the ABSENCE of a yardstick', () => {
    // An empty draft means nothing can be judged lost. Refusing here would reject a body for a
    // property of the comparison rather than of itself.
    expect(compiledBodyIsTooSmall(0, 0)).toBe(false);
    expect(compiledBodyIsTooSmall(5, 0)).toBe(false);
  });
});
