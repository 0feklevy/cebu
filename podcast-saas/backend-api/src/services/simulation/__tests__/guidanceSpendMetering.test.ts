/**
 * What publishing a simulation's guidance costs, and that it gets written down.
 *
 * The spend contract can only see that `GuidanceService` MENTIONS a recorder. Mutation-testing
 * showed the gap that leaves: deleting the `charactersSpent +=` line kept the contract green,
 * because the recorder is still called — with zero, which `recordTtsSpend` correctly declines to
 * write. The result is guidance spend silently disappearing from the surface, which is the exact
 * failure this whole effort exists to end.
 *
 * So the counting is tested by behaviour. `GuidanceService` takes its storage, LLM and TTS by
 * constructor injection, so the vendor can be a fake and the arithmetic can be real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordTtsSpend = vi.fn(async () => {});
vi.mock('../../usage/recordTtsSpend.js', () => ({
  recordTtsSpend: (...a: unknown[]) => recordTtsSpend(...(a as [])),
}));

import { GuidanceService } from '../GuidanceService.js';

const NARRATION_A = 'Watch how the flock reorganises when one bird changes direction.';
const NARRATION_B = 'Now raise the separation weight and see the cohesion collapse.';

/** A storage double that accepts writes and answers the few reads a publish makes. */
const storage = {
  listObjects: async () => [],
  readObject: async () => Buffer.from(''),
  uploadFile: async () => {},
  getSimPublicUrl: (k: string) => `https://cdn.invalid/${k}`,
  getPresignedDownloadUrl: async (k: string) => `https://cdn.invalid/${k}`,
} as never;

function service(synthesize = vi.fn(async () => Buffer.from('mp3'))) {
  const tts = { synthesize } as never;
  return { svc: new GuidanceService(storage, {} as never, tts), synthesize };
}

const entry = (id: string, narration: string) => ({
  id, narration, enabled: true, warnings: [] as string[],
  trigger: { kind: 'time', atSec: 0 }, audioUrl: null,
} as never);

beforeEach(() => { recordTtsSpend.mockClear(); });

/** Runs a publish far enough to reach the metering call, ignoring what happens after it. */
async function publish(svc: GuidanceService, entries: unknown[], existing: unknown[] | null = null) {
  await (svc as unknown as {
    publishGuidance: (o: Record<string, unknown>) => Promise<unknown>;
  }).publishGuidance({
    simId: 'sim-1', projectId: 'proj-1', userId: 'user-1',
    entries, existing, language: 'en',
  }).catch(() => { /* the assemble/inject half needs a database; the meter runs before it */ });
}

describe('what a guidance publish records', () => {
  it('counts the characters of every cue it actually synthesises', async () => {
    const { svc } = service();
    await publish(svc, [entry('a', NARRATION_A), entry('b', NARRATION_B)]);

    expect(recordTtsSpend).toHaveBeenCalledTimes(1);
    const spend = recordTtsSpend.mock.calls[0]![0] as { characters: number; task: string };
    expect(spend.characters).toBe(NARRATION_A.length + NARRATION_B.length);
    expect(spend.task).toBe('guidance_publish');
  });

  it('does NOT count a cue whose narration is unchanged', async () => {
    // The cue-level cache above the synthesis: an unchanged narration keeps its existing audio and
    // never reaches the vendor. Counting it would inflate the spend surface with work nobody paid
    // for, which erodes trust in the number just as surely as under-counting does.
    const { svc, synthesize } = service();
    const prior = [{ ...(entry('a', NARRATION_A) as object), audioUrl: 'https://cdn.invalid/old.mp3' }];
    await publish(svc, [entry('a', NARRATION_A), entry('b', NARRATION_B)], prior);

    expect(synthesize).toHaveBeenCalledTimes(1);
    const spend = recordTtsSpend.mock.calls[0]![0] as { characters: number };
    expect(spend.characters).toBe(NARRATION_B.length);
  });

  it('attributes the spend to the user and the project', async () => {
    // A spend surface that cannot say who and where is a total, not an account.
    const { svc } = service();
    await publish(svc, [entry('a', NARRATION_A)]);

    const spend = recordTtsSpend.mock.calls[0]![0] as { userId: string; projectId: string };
    expect(spend.userId).toBe('user-1');
    expect(spend.projectId).toBe('proj-1');
  });

  it('records the spend even when the publish DIES mid-way', async () => {
    // A publish that throws on its fourth cue already paid for three. Recording only on success
    // makes a failing publish look free — and a publish that fails repeatedly, the expensive one,
    // would be the single thing the spend surface could never show.
    //
    // This is what the counter being placed BEFORE the vendor call buys, together with the
    // `finally`: a failure after the request left is not a refund. Both halves were missing until
    // a mutation moved the counter after the call and nothing failed.
    const { svc } = service(vi.fn(async () => { throw new Error('vendor 500'); }));
    await publish(svc, [entry('a', NARRATION_A)]);

    expect(recordTtsSpend, 'a failed publish recorded nothing at all').toHaveBeenCalledTimes(1);
    const spend = recordTtsSpend.mock.calls[0]![0] as { characters: number };
    expect(spend.characters, 'a failed publish was recorded as free').toBe(NARRATION_A.length);
  });

  it('records the spend exactly once', async () => {
    // A double-counted spend is as wrong as a missing one and harder to disbelieve. There is one
    // metering call site today, so nothing in the current code can produce two — this guards a
    // second one being added on some future early-return path.
    const { svc } = service();
    await publish(svc, [entry('a', NARRATION_A), entry('b', NARRATION_B)]);
    expect(recordTtsSpend).toHaveBeenCalledTimes(1);
  });
});
