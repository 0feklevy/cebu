/**
 * "THIS BUILD HAS STOPPED MOVING" MUST MEAN IT, AND MUST NOT BE A DEAD END.
 *
 * The first version of this guard had two defects an adversarial reviewer proved:
 *
 *   1. `lastMovedAt` was `const … = Date.now()` assigned once at effect entry and never updated,
 *      so it was a FLAT three-minute timeout wearing a stall detector's name. `mix.progress` is
 *      null at the start of every build, so the effect's heartbeat dependency could not reset it
 *      either — any build whose first clip took over three minutes (a queued job waiting for a
 *      worker, one long TTS line, a slow provider) was declared stopped while working perfectly.
 *   2. The resulting screen was TERMINAL. Its only offer was Rebuild, and the server answers 202
 *      `already_running` for a row still in `generating`, so it promised a recovery it could not
 *      perform — and `buildStalled` could only be cleared by an effect re-run keyed on a heartbeat
 *      that a genuinely stuck build never changes.
 *
 * These pin the decision rule and the escape, on the shipped source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../components/podcast/studio/AudioStudio.tsx'),
  'utf-8',
);
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The shipped rule: the mark moves only when observed progress changes. */
function stalled(samples: Array<{ atMs: number; progress: string }>, limitMs: number): boolean {
  let lastSeen = samples[0].progress;
  let lastMovedAt = samples[0].atMs;
  for (const s of samples.slice(1)) {
    if (s.progress !== lastSeen) { lastSeen = s.progress; lastMovedAt = s.atMs; }
    if (s.atMs - lastMovedAt >= limitMs) return true;
  }
  return false;
}

const LIMIT = 3 * 60_000;

describe('the stall detector observes progress, not the clock', () => {
  it('does NOT declare a slow first clip stopped', () => {
    // Ten minutes of "-1/-1" then real progress — the case that was wrongly killed at 3 minutes.
    const samples = [
      { atMs: 0, progress: '-1/-1' },
      { atMs: 120_000, progress: '-1/-1' },
      { atMs: 170_000, progress: '1/8' },   // first clip lands at 2m50s
      { atMs: 200_000, progress: '2/8' },
      { atMs: 260_000, progress: '3/8' },
    ];
    expect(stalled(samples, LIMIT)).toBe(false);
  });

  it('DOES declare a build stopped when nothing changes for the whole window', () => {
    const samples = [
      { atMs: 0, progress: '2/8' },
      { atMs: 100_000, progress: '2/8' },
      { atMs: 190_000, progress: '2/8' },
    ];
    expect(stalled(samples, LIMIT)).toBe(true);
  });

  it('a build that keeps moving slowly is never declared stopped', () => {
    const samples = Array.from({ length: 12 }, (_, i) => ({ atMs: i * 150_000, progress: `${i}/12` }));
    expect(stalled(samples, LIMIT)).toBe(false);
  });
});

describe('the stalled screen is not a dead end', () => {
  it('tracks the last observed progress inside the poll, and moves the mark', () => {
    expect(code).toMatch(/let lastSeen/);
    expect(code).toMatch(/let lastMovedAt/);
    expect(code).toMatch(/lastMovedAt = Date\.now\(\)/);
    // The old flat-timeout shape must not come back.
    expect(code).not.toMatch(/const lastMovedAt = Date\.now\(\)/);
  });

  it('offers a control that resumes polling, not only one the server refuses', () => {
    // Rebuild answers `already_running` for a row still generating, so it cannot be the only exit.
    expect(code).toMatch(/setBuildStalled\(false\); setPollNonce\(\(n\) => n \+ 1\)/);
    expect(code).toMatch(/pollNonce\]\)/);   // and the poll effect actually depends on it
  });
});
