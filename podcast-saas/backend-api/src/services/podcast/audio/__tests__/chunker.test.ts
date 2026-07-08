import { describe, it, expect } from 'vitest';
import { planChunks } from '../chunker.js';
import type { PodcastTurn } from 'shared';

const voiceFor = (sp: 'teacher' | 'learner') => (sp === 'teacher' ? 'V_TEACHER' : 'V_LEARNER');
const OPTS = { seed: 42, languageCode: 'en', outputFormat: 'mp3_44100_128', stability: 0.5 };

function turn(id: string, speaker: 'teacher' | 'learner', beat: string, len = 20, overlap = false): PodcastTurn {
  return { id, speaker, beat, text: 'x'.repeat(len), overlap, is_hook: false };
}
function chunkChars(inputs: { text: string }[]): number {
  return inputs.reduce((n, i) => n + i.text.length, 0);
}

describe('planChunks', () => {
  it('groups turns per beat and excludes overlap turns (they become backchannels)', () => {
    const turns: PodcastTurn[] = [
      turn('t1', 'teacher', 'b1'),
      turn('t2', 'learner', 'b1'),
      turn('t3', 'learner', 'b1', 8, true), // overlap → backchannel
      turn('t4', 'teacher', 'b2'),
      turn('t5', 'learner', 'b2'),
    ];
    const { chunks, backchannels } = planChunks(turns, voiceFor, OPTS);

    // Two beats → at least two chunks; the overlap turn is not in any chunk.
    expect(chunks.length).toBe(2);
    expect(chunks[0].turnIds).toEqual(['t1', 't2']);
    expect(chunks[1].turnIds).toEqual(['t4', 't5']);
    expect(chunks.flatMap((c) => c.turnIds)).not.toContain('t3');
    expect(backchannels.map((b) => b.turnId)).toEqual(['t3']);
  });

  it('prepends prior-chunk turns as context (audio discarded), excluded from turnIds', () => {
    const turns: PodcastTurn[] = [
      turn('t1', 'teacher', 'b1'), turn('t2', 'learner', 'b1'),
      turn('t3', 'teacher', 'b2'), turn('t4', 'learner', 'b2'),
    ];
    const { chunks } = planChunks(turns, voiceFor, OPTS);
    const second = chunks[1];
    expect(second.contextCount).toBeGreaterThan(0);
    expect(second.turnIds).toEqual(['t3', 't4']);          // context not counted as real turns
    // inputs = [context…, real…]; real count === turnIds length
    expect(second.inputs.length).toBe(second.contextCount + second.turnIds.length);
  });

  it('never exceeds the total-char cap even with a dense beat + context (the 2,000-char fix)', () => {
    // Prior beat with two ~300-char turns, then a dense ~1500-char beat. Pre-fix this
    // would prepend ~600 chars of context → ~2100 total and 400 from ElevenLabs.
    const turns: PodcastTurn[] = [
      turn('p1', 'teacher', 'b1', 300),
      turn('p2', 'learner', 'b1', 300),
      turn('d1', 'teacher', 'b2', 290),
      turn('d2', 'learner', 'b2', 290),
      turn('d3', 'teacher', 'b2', 290),
      turn('d4', 'learner', 'b2', 290),
      turn('d5', 'teacher', 'b2', 290),
    ];
    const { chunks } = planChunks(turns, voiceFor, OPTS);
    for (const c of chunks) {
      expect(chunkChars(c.inputs)).toBeLessThanOrEqual(1850);
      expect(chunkChars(c.inputs)).toBeLessThan(2000); // hard ElevenLabs cap
    }
  });

  it('splits a single beat that exceeds the per-beat budget into multiple chunks', () => {
    // Six ~300-char turns in one beat = ~1800 > MAX_CHUNK_CHARS(1500) → splits.
    const turns: PodcastTurn[] = Array.from({ length: 6 }, (_, i) =>
      turn(`t${i}`, i % 2 ? 'learner' : 'teacher', 'b1', 300));
    const { chunks } = planChunks(turns, voiceFor, OPTS);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.beat === 'b1')).toBe(true);
  });

  it('produces a stable hash for identical input and a different hash when the seed changes', () => {
    const turns: PodcastTurn[] = [turn('t1', 'teacher', 'b1'), turn('t2', 'learner', 'b1')];
    const a = planChunks(turns, voiceFor, OPTS).chunks[0].hash;
    const b = planChunks(turns, voiceFor, OPTS).chunks[0].hash;
    const c = planChunks(turns, voiceFor, { ...OPTS, seed: 43 }).chunks[0].hash;
    expect(a).toBe(b);   // deterministic → cache hits on re-render
    expect(a).not.toBe(c); // seed is part of the key
  });

  it('never splits a scripted cut-off ("—") away from the line that interrupts it', () => {
    // Force a size split right at the cutoff pair: without the pairing rule, t5 (the
    // interrupter) would start a new chunk away from t4's dash.
    const turns: PodcastTurn[] = [
      turn('t1', 'teacher', 'b1', 400),
      turn('t2', 'learner', 'b1', 400),
      turn('t3', 'teacher', 'b1', 400),
      { ...turn('t4', 'learner', 'b1', 0), text: `${'x'.repeat(280)}—` }, // ends cut off
      turn('t5', 'teacher', 'b1', 200),                                   // the interrupter
    ];
    const { chunks } = planChunks(turns, voiceFor, OPTS);
    const withT4 = chunks.find((c) => c.turnIds.includes('t4'))!;
    expect(withT4.turnIds).toContain('t5'); // pair rendered in one request
  });

  it('gives a backchannel a prosody-context input from the line it rides', () => {
    const turns: PodcastTurn[] = [
      { ...turn('t1', 'teacher', 'b1', 0), text: 'And that is the wild part. The seats already knew.' },
      { ...turn('bc1', 'learner', 'b1', 0, true), text: 'no way' },
    ];
    const { backchannels } = planChunks(turns, voiceFor, OPTS);
    expect(backchannels).toHaveLength(1);
    const bc = backchannels[0];
    expect(bc.contextCount).toBe(1);
    expect(bc.inputs).toHaveLength(2);
    expect(bc.inputs[0].voice_id).toBe('V_TEACHER');       // context in the OTHER voice
    expect(bc.inputs[0].text).toContain('seats already knew');
    expect(bc.inputs[1]).toEqual({ text: 'no way', voice_id: 'V_LEARNER' });
  });

  it('backchannel context never carries a truncated audio tag (the v3 400 bug)', () => {
    // A long previous line whose tail (last ~160 chars) slices THROUGH "[emphasized]".
    const longLine = 'x'.repeat(200) + ' and the pressure just keeps climbing [emphasized] until it finally gives.';
    const turns: PodcastTurn[] = [
      { ...turn('t1', 'teacher', 'b1', 0), text: longLine },
      { ...turn('bc1', 'learner', 'b1', 0, true), text: '[laughs]' },
    ];
    const { backchannels } = planChunks(turns, voiceFor, OPTS);
    const ctx = backchannels[0].inputs[0].text;
    // Every '[' must have a matching ']' — no dangling open bracket.
    const opens = (ctx.match(/\[/g) ?? []).length;
    const closes = (ctx.match(/\]/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(ctx).not.toMatch(/\[[^\]]*$/); // no open bracket without a close before end
  });

  it('a backchannel with no preceding line gets no context', () => {
    const turns: PodcastTurn[] = [
      { ...turn('bc1', 'learner', 'b1', 0, true), text: 'huh' },
      turn('t1', 'teacher', 'b1'),
    ];
    const { backchannels } = planChunks(turns, voiceFor, OPTS);
    expect(backchannels[0].contextCount).toBe(0);
    expect(backchannels[0].inputs).toHaveLength(1);
  });

  it('sanitizes a trailing cut-off dash to an ellipsis for synthesis (v3 stutters on hard mid-clause stops)', () => {
    const turns: PodcastTurn[] = [
      { ...turn('t1', 'teacher', 'b1', 0), text: 'and the wild part is—' },
      turn('t2', 'learner', 'b1'),
    ];
    const { chunks } = planChunks(turns, voiceFor, OPTS);
    const input = chunks[0].inputs[0];
    expect(input.text.endsWith('…')).toBe(true);
    expect(input.text).not.toMatch(/[—–]\s*$/);
    // mid-line dashes are untouched
    const turns2: PodcastTurn[] = [{ ...turn('t1', 'teacher', 'b1', 0), text: 'so — and this matters — it holds.' }];
    const { chunks: c2 } = planChunks(turns2, voiceFor, OPTS);
    expect(c2[0].inputs[0].text).toBe('so — and this matters — it holds.');
  });
});
