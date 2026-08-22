/**
 * The shared recorder the short synthesis paths use.
 *
 * Its whole contract is that it is SAFE to call from a path the creator is waiting on: it never
 * throws, never rejects, and never writes a row for work that did not happen. Each of those is a
 * separate way for it to do damage, so each is tested separately.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const record = vi.fn(async () => {});
// A METHOD, not a class field. `recordTtsSpend` constructs its recorder at module scope, so a
// field initialiser would dereference `record` while the hoisted factory is still being evaluated
// — "Cannot access 'record' before initialization". Delegating at call time defers it.
vi.mock('../UsageTrackingService.js', () => ({
  UsageTrackingService: class {
    async record(...args: unknown[]) { return record(...(args as [])); }
  },
}));
vi.mock('../../../db/index.js', () => ({ db: {} }));

import { recordTtsSpend } from '../recordTtsSpend.js';
import { estimateTtsCost, DEFAULT_USD_PER_CREDIT } from '../ttsCost.js';

beforeEach(() => { record.mockReset(); record.mockResolvedValue(undefined); });

describe('what it writes', () => {
  it('records characters as characters, with the task that spent them', async () => {
    await recordTtsSpend({ userId: 'u1', task: 'podcast_preview', characters: 320 });

    expect(record).toHaveBeenCalledTimes(1);
    const row = record.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.unit).toBe('characters');
    expect(row.quantity).toBe(320);
    expect(row.task).toBe('podcast_preview');
    expect(row.provider).toBe('elevenlabs');
    expect(row.userId).toBe('u1');
  });

  it('leaves the token columns at zero', async () => {
    // The point of migration 073. A character in a token column is a number that sums with tokens
    // and means nothing afterwards.
    await recordTtsSpend({ userId: 'u', task: 't', characters: 100 });
    const row = record.mock.calls[0]![0] as Record<string, number>;
    expect(row.inputTokens).toBe(0);
    expect(row.cachedInputTokens).toBe(0);
    expect(row.outputTokens).toBe(0);
  });

  it('prices through the shared cost model, never with a number of its own', async () => {
    await recordTtsSpend({ userId: 'u', task: 't', characters: 5_000 });
    const row = record.mock.calls[0]![0] as { costCents: number };
    expect(row.costCents)
      .toBeCloseTo(estimateTtsCost({ characters: 5_000, usdPerCredit: DEFAULT_USD_PER_CREDIT }).costCents, 8);
  });
});

describe('what it refuses to write', () => {
  it('writes nothing for a cache hit', async () => {
    // Zero characters is a NON-EVENT, not a zero-cost event. A row would put a meaningless entry
    // in every per-day total, and the preview screen produces a great many of them.
    await recordTtsSpend({ userId: 'u', task: 'podcast_preview', characters: 0 });
    expect(record).not.toHaveBeenCalled();
  });

  it('writes nothing for a nonsense count', async () => {
    for (const n of [-10, NaN, Infinity]) {
      record.mockClear();
      await recordTtsSpend({ userId: 'u', task: 't', characters: n });
      expect(record, String(n)).not.toHaveBeenCalled();
    }
  });
});

describe('it can never break the thing it is measuring', () => {
  it('resolves even when the usage write fails', async () => {
    // The audio is already made and already paid for. Failing a creator's preview because the
    // usage table is busy spends their time to protect a report.
    record.mockRejectedValueOnce(new Error('usage table unavailable'));
    await expect(recordTtsSpend({ userId: 'u', task: 't', characters: 50 })).resolves.toBeUndefined();
  });

  it('resolves even when the recorder throws synchronously', async () => {
    record.mockImplementationOnce(() => { throw new Error('boom'); });
    await expect(recordTtsSpend({ userId: 'u', task: 't', characters: 50 })).resolves.toBeUndefined();
  });
});

/**
 * The transcription recorder, whose extra decision is what to do about an unknown quantity.
 *
 * Kept beside its TTS sibling because the two differ in exactly one place and the difference is
 * the interesting part: TTS always knows how many characters it sent, while a transcription may
 * come back without the duration the vendor billed.
 */
describe('recordSttSpend — when the vendor did not say how long the audio was', () => {
  it('records a reported duration in seconds', async () => {
    record.mockClear();
    const { recordSttSpend } = await import('../recordSttSpend.js');
    await recordSttSpend({ userId: null, projectId: 'p1', task: 'corpus_audio_transcribe', durationSec: 600 });

    const row = record.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.unit).toBe('seconds');
    expect(row.quantity).toBe(600);
    expect(row.provider).toBe('groq');
    expect(row.projectId).toBe('p1');
  });

  it('writes NOTHING when the duration is unknown, rather than a row saying it was free', async () => {
    // The whole reason `reportedDurationSec` returns null instead of 0. A row with quantity 0
    // asserts the transcription cost nothing, and a per-day total built from it is confidently
    // wrong — worse than a visible gap, because a number gets believed.
    record.mockClear();
    const { recordSttSpend } = await import('../recordSttSpend.js');
    await recordSttSpend({ userId: null, projectId: 'p1', task: 'corpus_audio_transcribe', durationSec: null });
    expect(record).not.toHaveBeenCalled();
  });

  it('never throws, whatever the recorder does', async () => {
    record.mockClear();
    record.mockRejectedValueOnce(new Error('usage table unavailable'));
    const { recordSttSpend } = await import('../recordSttSpend.js');
    await expect(
      recordSttSpend({ userId: null, projectId: 'p', task: 't', durationSec: 10 }),
    ).resolves.toBeUndefined();
  });
});
