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
type Verdict = import('../../usage/spendCeiling.js').SpendCeilingVerdict;
const evaluateSpendCeiling = vi.fn(async (): Promise<Verdict> => ({
  mode: 'shadow', refuse: false, wouldRefuse: false, spentCents: 0, ceilingCents: 0, reason: null,
}));
vi.mock('../../usage/spendCeiling.js', () => ({
  evaluateSpendCeiling: (...a: unknown[]) => evaluateSpendCeiling(...(a as [])),
}));

vi.mock('../../usage/recordTtsSpend.js', () => ({
  recordTtsSpend: (...a: unknown[]) => recordTtsSpend(...(a as [])),
}));

// `resolveGuidanceVoice` reads admin_settings through the REAL db client. Unmocked, this suite
// passed on any machine with the dev Postgres up and failed everywhere else — the publish died
// resolving a voice, the `.catch(() => {})` in `publish()` swallowed it, and every assertion saw
// "recordTtsSpend: 0 calls". A unit suite must not change its verdict with `docker ps`.
vi.mock('../../audio/GuidanceTTSService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../audio/GuidanceTTSService.js')>()),
  resolveGuidanceVoice: async () => ({ voiceId: 'test-voice', model: 'test-model' }),
}));

import { GuidanceService } from '../GuidanceService.js';
import { callArg } from '../../../__tests__/helpers/mockCalls.js';

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
    const spend = callArg<{ characters: number; task: string }>(recordTtsSpend, 0, 0);
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
    const spend = callArg<{ characters: number }>(recordTtsSpend, 0, 0);
    expect(spend.characters).toBe(NARRATION_B.length);
  });

  it('attributes the spend to the user and the project', async () => {
    // A spend surface that cannot say who and where is a total, not an account.
    const { svc } = service();
    await publish(svc, [entry('a', NARRATION_A)]);

    const spend = callArg<{ userId: string; projectId: string }>(recordTtsSpend, 0, 0);
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
    const spend = callArg<{ characters: number }>(recordTtsSpend, 0, 0);
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

describe('the ceiling guards a guidance publish', () => {
  // Guidance narration is ElevenLabs TTS bought by a click, and one press pays once PER CUE — so a
  // dozen-cue simulation is a dozen paid calls, and re-publishing after an edit pays again. Same
  // provider and same shape as the preview/re-voice paths the 22 August incident ran through, and
  // it was the last ElevenLabs surface without a ceiling.
  beforeEach(() => {
    evaluateSpendCeiling.mockReset();
    evaluateSpendCeiling.mockResolvedValue({
      mode: 'shadow', refuse: false, wouldRefuse: false, spentCents: 0, ceilingCents: 0, reason: null,
    });
  });

  const REFUSED: Verdict = {
    mode: 'enforce', refuse: true, wouldRefuse: true, spentCents: 9_000, ceilingCents: 5_000,
    reason: 'elevenlabs spend this month would reach $90.00, over the $50.00 ceiling (SPEND_CEILING_ELEVENLABS_CENTS).',
  };

  /** The file's own factory, so this block is wired exactly as every test above it. */
  const publish = () => service().svc.publishGuidance({
    simId: 'sim-1', projectId: 'proj-1',
    entries: [{ atMs: 0, text: 'one' }] as never,
  });

  it('asks the ceiling about ElevenLabs', async () => {
    await publish().catch(() => { /* the rest of the publish is not the subject */ });
    expect(evaluateSpendCeiling).toHaveBeenCalledWith(expect.objectContaining({ provider: 'elevenlabs' }));
  });

  it('REFUSES BEFORE THE FIRST CUE, not part-way through', async () => {
    // The reason the check is at the top rather than per cue: a publish that stops halfway leaves
    // a simulation with some cues voiced and some silent, which is worse than one that never ran.
    evaluateSpendCeiling.mockResolvedValue(REFUSED);
    await expect(publish()).rejects.toThrow(/ceiling/i);
    expect(recordTtsSpend, 'a refused publish still paid for something').not.toHaveBeenCalled();
  });

  it('carries the wording that names the variable to change', async () => {
    evaluateSpendCeiling.mockResolvedValue(REFUSED);
    await expect(publish()).rejects.toThrow(/SPEND_CEILING_ELEVENLABS_CENTS/);
  });

  it('does NOT block in shadow mode, even when it would have refused', async () => {
    evaluateSpendCeiling.mockResolvedValue({
      mode: 'shadow', refuse: false, wouldRefuse: true, spentCents: 9_000, ceilingCents: 5_000,
      reason: 'would have refused',
    });
    await publish().catch((e: Error) => {
      expect(e.message, 'shadow mode refused a publish').not.toMatch(/ceiling/i);
    });
  });
});
