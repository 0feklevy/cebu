/**
 * The fade guard, at EVERY eviction path.
 *
 * The defect these pin was not a missing guard — it was a guard in three places and not in the two
 * that ran. `ensurePooledSpec` spared a fading frame and its comment promised the frame would be
 * "evicted on the next tick, once the fade is done"; the per-tick residency loop had no fade check,
 * so the very next timeupdate evicted it mid-fade and both single-mode guards were undone inside
 * one tick. The hard-cap eviction picked its victim by active/warming only, so on a strong device
 * with more packages than the cap it could drop the frame currently fading.
 *
 * The rule now lives in one module used by all of them, so these tests cover every path rather
 * than one path's copy of the rule.
 */
import { describe, it, expect } from 'vitest';
import { singleModeEvictions, hardCapEviction, overCapEvictions } from '../lib/sim/poolResidency';

const specs = (...keys: string[]) => keys.map((key) => ({ key }));
const fading = (...keys: string[]) => (k: string) => keys.includes(k);
const none = () => false;

describe('singleModeEvictions — the kill switch keeps one document in STEADY STATE', () => {
  it('evicts every non-active package when nothing is fading', () => {
    expect(singleModeEvictions(specs('a', 'b', 'c'), 'a', none)).toEqual(['b', 'c']);
  });

  // THE REGRESSION. deactivateSim clears the active key BEFORE the residency pass runs, so the
  // outgoing frame is not "active" here — it is only protected by the fade check.
  it('spares the OUTGOING frame while it is still fading, even with no active key at all', () => {
    expect(singleModeEvictions(specs('outgoing', 'other'), null, fading('outgoing')))
      .toEqual(['other']);
  });

  it('spares a fading frame while admitting the eviction of its non-fading siblings', () => {
    expect(singleModeEvictions(specs('a', 'b', 'c'), 'a', fading('b'))).toEqual(['c']);
  });

  it('collects the frame on a LATER pass, once the fade has resolved', () => {
    const pool = specs('outgoing', 'incoming');
    expect(singleModeEvictions(pool, 'incoming', fading('outgoing'))).toEqual([]);
    // fade done → the same call now evicts it, which is the "evicted afterward" half of the promise
    expect(singleModeEvictions(pool, 'incoming', none)).toEqual(['outgoing']);
  });

  it('never evicts the active frame', () => {
    expect(singleModeEvictions(specs('a'), 'a', none)).toEqual([]);
  });
});

describe('hardCapEviction — the cap never cuts a live transition', () => {
  const CAP = 6;

  it('does nothing while the pool is under the cap', () => {
    expect(hardCapEviction(specs('a', 'b'), 'new', 'a', null, CAP, none)).toBeNull();
  });

  it('evicts the first frame that is neither active nor warming', () => {
    const pool = specs('a', 'b', 'c', 'd', 'e', 'f');
    expect(hardCapEviction(pool, 'new', 'a', 'b', CAP, none)).toBe('c');
  });

  // THE REGRESSION: 'c' is the ordinary victim, but it is mid-fade.
  it('skips a FADING candidate and takes the next eligible one', () => {
    const pool = specs('a', 'b', 'c', 'd', 'e', 'f');
    expect(hardCapEviction(pool, 'new', 'a', 'b', CAP, fading('c'))).toBe('d');
  });

  it('falls back to a merely-not-active frame, still excluding fading ones', () => {
    // Everything except the warming frame is fading, so the fallback tier must not resurrect them.
    const pool = specs('a', 'b', 'c', 'd', 'e', 'f');
    expect(hardCapEviction(pool, 'new', 'a', 'b', CAP, fading('c', 'd', 'e', 'f'))).toBe('b');
  });

  it('admits without evicting when EVERY candidate is fading, rather than cutting one', () => {
    const pool = specs('a', 'b', 'c', 'd', 'e', 'f');
    expect(hardCapEviction(pool, 'new', 'a', null, CAP, fading('b', 'c', 'd', 'e', 'f'))).toBeNull();
  });

  it('never evicts the incoming spec itself', () => {
    const pool = specs('new', 'a', 'b', 'c', 'd', 'e');
    expect(hardCapEviction(pool, 'new', 'a', null, CAP, none)).toBe('b');
  });
});

// ── the SECOND guard: a frame already in two-phase eviction ───────────────────────────────────
//
// The fade guard spares a frame that must not be CUT. This one spares a frame that is already
// LEAVING: marked, muted, frozen, its section released, with the parent holding the port open for
// the child's DISPOSED. Selecting it again would start a second teardown of one document — a second
// RELEASE_SECTION and DISPOSE_DOCUMENT into a port mid-handshake — and would file one eviction as
// two, so the clean-vs-forced record the handshake exists to produce would count frames that were
// never separately evicted.
const evicting = (...keys: string[]) => ({ isFadingOut: () => false, isEvicting: (k: string) => keys.includes(k) });

describe('the evicting guard — a frame that is already leaving is never selected again', () => {
  it('singleModeEvictions skips a frame whose disposal handshake is in flight', () => {
    expect(singleModeEvictions(specs('a', 'b', 'c'), 'a', evicting('b'))).toEqual(['c']);
  });

  it('singleModeEvictions returns nothing when every non-active frame is already leaving', () => {
    expect(singleModeEvictions(specs('a', 'b', 'c'), 'a', evicting('b', 'c'))).toEqual([]);
  });

  it('hardCapEviction skips an evicting candidate and takes the next eligible one', () => {
    const pool = specs('a', 'b', 'c', 'd', 'e', 'f');
    expect(hardCapEviction(pool, 'new', 'a', 'b', 6, evicting('c'))).toBe('d');
  });

  it('an EVICTING frame still counts toward the cap — its context is allocated until the child answers', () => {
    // Six resident frames, five of them leaving. Admitting a seventh without evicting would put the
    // pool over the browser's live-context budget for the length of a disposal handshake, so the
    // pass must still pick the one frame it may take.
    const pool = specs('a', 'b', 'c', 'd', 'e', 'f');
    expect(hardCapEviction(pool, 'new', null, null, 6, evicting('b', 'c', 'd', 'e', 'f'))).toBe('a');
  });

  it('admits without evicting when every candidate is either fading or leaving', () => {
    const pool = specs('a', 'b', 'c', 'd', 'e', 'f');
    const both = { isFadingOut: (k: string) => k === 'b', isEvicting: (k: string) => k !== 'b' };
    expect(hardCapEviction(pool, 'new', 'a', null, 6, both)).toBeNull();
  });

  it('BOTH guards apply together — neither is a fallback tier for the other', () => {
    const guards = { isFadingOut: (k: string) => k === 'b', isEvicting: (k: string) => k === 'c' };
    expect(singleModeEvictions(specs('a', 'b', 'c', 'd'), 'a', guards)).toEqual(['d']);
  });

  it('the bare-predicate call shape still means "fading only", with nothing evicting', () => {
    // Four call sites pass the predicate directly. If that shape ever started meaning something
    // else, four eviction paths would change behaviour with no edit visible at any of them.
    expect(singleModeEvictions(specs('a', 'b'), 'a', fading('b'))).toEqual([]);
    expect(singleModeEvictions(specs('a', 'b'), 'a', none)).toEqual(['b']);
  });
});

describe('overCapEvictions — the hard cap is a CEILING, not only an admission rule', () => {
  const evicting = (...keys: string[]) => ({ isFadingOut: none, isEvicting: (k: string) => keys.includes(k) });

  it('does nothing while the pool is at or under the cap', () => {
    expect(overCapEvictions(specs('a', 'b', 'c'), 'a', null, 6, none)).toEqual([]);
    expect(overCapEvictions(specs('a', 'b', 'c', 'd', 'e', 'f'), 'a', null, 6, none)).toEqual([]);
  });

  it('collects the overshoot `hardCapEviction` was forced to admit', () => {
    // `ensurePooledSpec` admits over the cap when every candidate has to be spared — a frame
    // mid-exit-fade, or one whose disposal handshake has not finished — because cutting a live
    // transition to hold an internal number is the worse trade. That overshoot was described as
    // self-clearing and was not: the cap was enforced at ADMISSION ONLY, so once the fade or the
    // handshake resolved, nothing came back for the extra frame and its WebGL context stayed
    // allocated for the rest of the session.
    expect(overCapEvictions(specs('a', 'b', 'c', 'd', 'e', 'f', 'g'), 'a', null, 6, none)).toEqual(['b']);
    // Two over the cap takes two, in the same preference order.
    expect(overCapEvictions(specs('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), 'a', null, 6, none)).toEqual(['b', 'c']);
  });

  it('never takes the active frame, and prefers a frame that is neither active nor warming', () => {
    expect(overCapEvictions(specs('a', 'b', 'c', 'd', 'e', 'f', 'g'), 'a', 'b', 6, none)).toEqual(['c']);
    // Active plus warming plus five spared leaves only the warming frame — still never the active one.
    const pool = specs('a', 'b', 'c', 'd', 'e', 'f', 'g');
    expect(overCapEvictions(pool, 'a', 'b', 6, evicting('c', 'd', 'e', 'f', 'g'))).toEqual(['b']);
  });

  it('obeys BOTH guards and stops rather than cutting a fade or double-evicting', () => {
    const pool = specs('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
    const guards = { isFadingOut: (k: string) => k === 'b', isEvicting: (k: string) => k !== 'b' && k !== 'a' };
    // Everything but the active frame is spared: the pass yields NOTHING rather than taking one of
    // them, and a later pass collects the overshoot once the fade and the handshakes resolve.
    expect(overCapEvictions(pool, 'a', null, 6, guards)).toEqual([]);
  });

  it('terminates even when the pool is enormous and nothing may be taken', () => {
    const pool = specs(...Array.from({ length: 50 }, (_, i) => `k${i}`));
    expect(overCapEvictions(pool, 'k0', null, 6, { isFadingOut: none, isEvicting: () => true })).toEqual([]);
    // …and never returns more keys than the overshoot when everything IS takeable.
    expect(overCapEvictions(pool, 'k0', null, 6, none)).toHaveLength(44);
  });
});
