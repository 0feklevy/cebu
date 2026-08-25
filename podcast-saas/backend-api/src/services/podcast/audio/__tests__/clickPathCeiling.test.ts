/**
 * The per-click synthesis paths meet the spend ceiling before they spend.
 *
 * ── WHY THESE TWO, AND WHY IT MATTERED ────────────────────────────────────────────────────────
 * The 22 August 2026 incident was not one expensive render. It was a creator auditioning voices —
 * click, listen, click again — with four ElevenLabs auto-top-ups firing in three and a half hours.
 * Every one of those clicks was a paid synthesis through `previewTurn` or `revoiceTurn`.
 *
 * `PodcastRenderer` has consulted the ceiling since it was written. These two did not, which is
 * backwards: a render is ONE action with a knowable cost, and a preview is unbounded by
 * construction. The ceiling now runs first on all three.
 *
 * ── WHAT A BROKEN VERSION WOULD ALSO PASS ─────────────────────────────────────────────────────
 * A test that only checks "throws when refused" is satisfied by a guard placed AFTER the vendor
 * call — the money is gone and an error is raised about it. So the vendor doubles here fail loudly
 * if reached, and that, not the thrown error, is the load-bearing assertion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Verdict = import('../../../usage/spendCeiling.js').SpendCeilingVerdict;
const evaluateSpendCeiling = vi.fn(async (): Promise<Verdict> => ({
  mode: 'shadow', refuse: false, wouldRefuse: false, spentCents: 0, ceilingCents: 0, reason: null,
}));
vi.mock('../../../usage/spendCeiling.js', () => ({
  evaluateSpendCeiling: (...a: unknown[]) => evaluateSpendCeiling(...(a as [])),
}));

/** Reached only if the guard let the call through. */
const vendorMustNotBeCalled = () => {
  throw new Error('the vendor was called after the ceiling refused — money was spent');
};

vi.mock('../ElevenLabsDialogue.js', () => ({
  ElevenLabsDialogue: class { async synthesize() { vendorMustNotBeCalled(); } },
  synthesizeDialogue: vendorMustNotBeCalled,
}));
vi.mock('../../PodcastVoiceService.js', () => ({
  PodcastVoiceService: class {
    async resolveDefaultVoices() { return { teacher: 'v-t', learner: 'v-l' }; }
    async synthesize() { vendorMustNotBeCalled(); }
  },
}));
vi.mock('../../../storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({ uploadFile: vendorMustNotBeCalled, getPublicUrl: (k: string) => k }),
}));
vi.mock('../../../usage/recordTtsSpend.js', () => ({ recordTtsSpend: vi.fn() }));
vi.mock('../../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../../db/index.js', () => ({ db: { query: {}, update: () => ({ set: () => ({ where: async () => undefined }) }) } }));
vi.mock('../../../../db/schema.js', () => ({ podcast_shows: {}, podcast_episodes: {}, podcast_scripts: {}, podcast_chunk_audio: {} }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn() }));

const SHOW = { id: 's1', teacher_voice_id: 'v-t', learner_voice_id: 'v-l', teacher_name: 'T', learner_name: 'L' };
const EPISODE = { id: 'e1', show_id: 's1', language: 'en' };
const TURNS = [{ id: 't1', speaker: 'host_a', text: 'hello there' }];

const REFUSED: Verdict = {
  mode: 'enforce', refuse: true, wouldRefuse: true, spentCents: 9_000, ceilingCents: 5_000,
  reason: 'elevenlabs spend this month would reach $90.00, over the $50.00 ceiling (SPEND_CEILING_ELEVENLABS_CENTS).',
};

beforeEach(() => {
  evaluateSpendCeiling.mockReset();
  evaluateSpendCeiling.mockResolvedValue({
    mode: 'shadow', refuse: false, wouldRefuse: false, spentCents: 0, ceilingCents: 0, reason: null,
  });
});

describe('previewTurn', () => {
  it('asks the ceiling about ElevenLabs', async () => {
    const { previewTurn } = await import('../previewTurn.js');
    await previewTurn({ show: SHOW as never, episode: EPISODE as never, turns: TURNS as never, index: 0 })
      .catch(() => { /* the rest of the preview is not the subject */ });
    expect(evaluateSpendCeiling).toHaveBeenCalledWith(expect.objectContaining({ provider: 'elevenlabs' }));
  });

  it('THROWS when refused, and never reaches the vendor', async () => {
    // The assertion the guard exists for. Every vendor double above throws a distinctive error if
    // called, so a guard placed after the call would fail with THAT message instead.
    evaluateSpendCeiling.mockResolvedValue(REFUSED);
    const { previewTurn } = await import('../previewTurn.js');
    await expect(
      previewTurn({ show: SHOW as never, episode: EPISODE as never, turns: TURNS as never, index: 0 }),
    ).rejects.toThrow(/ceiling/i);
  });

  it('carries the ceiling\'s own wording, so an operator learns what to change', async () => {
    evaluateSpendCeiling.mockResolvedValue(REFUSED);
    const { previewTurn } = await import('../previewTurn.js');
    await expect(
      previewTurn({ show: SHOW as never, episode: EPISODE as never, turns: TURNS as never, index: 0 }),
    ).rejects.toThrow(/SPEND_CEILING_ELEVENLABS_CENTS/);
  });

  it('does NOT block in shadow mode, even when it would have refused', async () => {
    // The whole reason shadow exists. If this fails, a ceiling nobody has calibrated has started
    // refusing previews — and the figure was never checked against reality.
    evaluateSpendCeiling.mockResolvedValue({
      mode: 'shadow', refuse: false, wouldRefuse: true, spentCents: 9_000, ceilingCents: 5_000,
      reason: 'would have refused',
    });
    const { previewTurn } = await import('../previewTurn.js');
    await previewTurn({ show: SHOW as never, episode: EPISODE as never, turns: TURNS as never, index: 0 })
      .catch((e: Error) => {
        expect(e.message, 'shadow mode refused a preview').not.toMatch(/ceiling/i);
        expect(e.message).not.toMatch(/would have refused/i);
      });
  });
});

describe('revoiceTurn', () => {
  it('asks the ceiling about ElevenLabs', async () => {
    const { revoicePodcastTurn } = await import('../revoiceTurn.js');
    await revoicePodcastTurn({ show: SHOW, episode: EPISODE, turns: TURNS, index: 0 } as never).catch(() => {});
    expect(evaluateSpendCeiling).toHaveBeenCalledWith(expect.objectContaining({ provider: 'elevenlabs' }));
  });

  it('THROWS when refused, and never reaches the vendor', async () => {
    evaluateSpendCeiling.mockResolvedValue(REFUSED);
    const { revoicePodcastTurn } = await import('../revoiceTurn.js');
    await expect(revoicePodcastTurn({ show: SHOW, episode: EPISODE, turns: TURNS, index: 0 } as never))
      .rejects.toThrow(/ceiling/i);
  });
});
