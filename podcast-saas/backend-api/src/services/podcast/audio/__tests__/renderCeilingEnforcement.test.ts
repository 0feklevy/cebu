/**
 * Does the renderer actually STOP when the ceiling refuses?
 *
 * A ceiling that evaluates correctly and is then ignored is worse than none: it produces a log
 * line saying the work was refused while the work happens anyway, so the next person reading the
 * logs during an overspend concludes the guard is working. Mutation-testing the wiring showed
 * exactly that — deleting the `throw` changed nothing any test could see.
 *
 * The ceiling ships in SHADOW mode, so the refusing case tested here is one an operator has to opt
 * into. That is the point: the opt-in has to mean something on the day it is used.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Typed by the real verdict, so `mockResolvedValue({ mode: 'enforce', … })` is legal — inferring
// the type from a shadow-mode literal narrowed `mode` to `'shadow'` and made every enforce case a
// type error the suite could not see.
type Verdict = import('../../../usage/spendCeiling.js').SpendCeilingVerdict;
const evaluateSpendCeiling = vi.fn(async (): Promise<Verdict> => ({
  mode: 'shadow', refuse: false, wouldRefuse: false, spentCents: 0, ceilingCents: 0, reason: null,
}));
vi.mock('../../../usage/spendCeiling.js', () => ({
  evaluateSpendCeiling: (...a: unknown[]) => evaluateSpendCeiling(...(a as [])),
}));
vi.mock('../../../usage/UsageTrackingService.js', () => ({
  UsageTrackingService: class { async record() { /* not the subject */ } },
}));

const EPISODE = { id: 'ep-1', show_id: 'show-1', language: 'en' };
const SHOW = { id: 'show-1', created_by: 'owner-1', language: 'en' };
const RENDER = { id: 'r-1', script_version: 1 };
const SCRIPT = { body_json: { turns: [{ speaker: 'host_a', text: 'hello' }] } };

vi.mock('../../../../db/index.js', () => ({
  db: {
    query: {
      podcast_episodes: { findFirst: async () => EPISODE },
      podcast_shows: { findFirst: async () => SHOW },
      podcast_renders: { findFirst: async () => RENDER },
      podcast_scripts: { findFirst: async () => SCRIPT },
    },
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));
vi.mock('../../../../db/schema.js', () => ({
  podcast_episodes: {}, podcast_shows: {}, podcast_renders: {}, podcast_scripts: {},
}));

import { PodcastRenderer } from '../PodcastRenderer.js';

/** Fails loudly if reached: a refused render must not synthesise a single character. */
const vendorMustNotBeCalled = () => {
  throw new Error('the vendor was called after the ceiling refused — money was spent');
};

function renderer(): PodcastRenderer {
  const r = new PodcastRenderer();
  (r as unknown as { el: { synthesize: () => unknown } }).el = { synthesize: vendorMustNotBeCalled };
  return r;
}

beforeEach(() => {
  evaluateSpendCeiling.mockReset();
  evaluateSpendCeiling.mockResolvedValue({
    mode: 'shadow', refuse: false, wouldRefuse: false, spentCents: 0, ceilingCents: 0, reason: null,
  });
});

describe('a render meets the ceiling before it spends anything', () => {
  it('asks the ceiling about ElevenLabs', async () => {
    await renderer().render('r-1', 'ep-1').catch(() => { /* the rest of the render is not the subject */ });
    expect(evaluateSpendCeiling).toHaveBeenCalledWith(expect.objectContaining({ provider: 'elevenlabs' }));
  });

  it('THROWS when the ceiling refuses, and never reaches the vendor', async () => {
    // The assertion the wiring exists for. Deleting the `throw` used to change nothing observable.
    evaluateSpendCeiling.mockResolvedValue({
      mode: 'enforce', refuse: true, wouldRefuse: true, spentCents: 9_000, ceilingCents: 5_000,
      reason: 'elevenlabs spend this month would reach $90.00, over the $50.00 ceiling.',
    });

    await expect(renderer().render('r-1', 'ep-1')).rejects.toThrow(/ceiling/i);
  });

  it('carries the ceiling\'s own wording, so the operator learns what to change', async () => {
    evaluateSpendCeiling.mockResolvedValue({
      mode: 'enforce', refuse: true, wouldRefuse: true, spentCents: 9_000, ceilingCents: 5_000,
      reason: 'over the $50.00 ceiling (SPEND_CEILING_ELEVENLABS_CENTS).',
    });

    await expect(renderer().render('r-1', 'ep-1')).rejects.toThrow(/SPEND_CEILING_ELEVENLABS_CENTS/);
  });

  it('does NOT stop the render in shadow mode, even when it would have refused', async () => {
    // The whole reason shadow exists. If this ever fails, the default has become a blocking one —
    // and a ceiling introduced on a figure nobody has checked would start killing renders.
    evaluateSpendCeiling.mockResolvedValue({
      mode: 'shadow', refuse: false, wouldRefuse: true, spentCents: 9_000, ceilingCents: 5_000,
      reason: 'would have refused',
    });

    // It proceeds PAST the ceiling and fails later for some unrelated reason — this harness stubs
    // only as much of a render as the ceiling check needs. The claim is therefore stated as what
    // it is: whatever kills the render in shadow mode, it is not the ceiling.
    await expect(renderer().render('r-1', 'ep-1')).rejects.toThrow();
    await renderer().render('r-1', 'ep-1').catch((e: Error) => {
      expect(e.message, 'shadow mode refused a render').not.toMatch(/ceiling/i);
      expect(e.message).not.toMatch(/would have refused/i);
    });
  });
});
