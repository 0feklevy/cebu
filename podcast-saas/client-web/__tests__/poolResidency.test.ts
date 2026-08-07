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
import { singleModeEvictions, hardCapEviction } from '../lib/sim/poolResidency';

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
