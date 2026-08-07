/**
 * resolveSimUrl — the iframe-src resolver's audited hazards:
 *   1. a LIVE dpr query param changed the src on zoom/monitor moves and silently reloaded
 *      resident sims at the next overlay re-render (the load event was then misread and left
 *      stale ready/painted flags) — dpr is now snapshotted once per page;
 *   2. the #simboot fragment OVERWROTE author fragments (hash-routed sims, deep links) —
 *      it now appends, in exactly the form the boot snippet's /[#&]simboot=/ reader parses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveSimUrl, __resetDprSnapshotForTests } from '../lib/simUrl';

const URL_BASE = 'https://api.flowvidco.com/sim-public/simulations/p/s/boids-3d/index.html?section=a&v=1';

const setDpr = (v: number) => Object.defineProperty(window, 'devicePixelRatio', { value: v, configurable: true });

describe('resolveSimUrl', () => {
  beforeEach(() => { __resetDprSnapshotForTests(); setDpr(2); });
  afterEach(() => { __resetDprSnapshotForTests(); });

  it('keeps the section/query params and appends device hints', () => {
    const u = new URL(resolveSimUrl(URL_BASE));
    expect(u.searchParams.get('section')).toBe('a');
    expect(u.searchParams.get('dpr')).toBe('2');
  });

  it('SNAPSHOT: a devicePixelRatio change mid-session must NOT change the src (reload hazard)', () => {
    const first = resolveSimUrl(URL_BASE);
    setDpr(3);                                    // zoom / moved to another monitor
    const second = resolveSimUrl(URL_BASE);
    expect(second).toBe(first);                   // same URL → no iframe reload
    expect(new URL(second).searchParams.get('dpr')).toBe('2');   // boot-time value retained
  });

  it('caps the snapshot at 3', () => {
    setDpr(4.5);
    expect(new URL(resolveSimUrl(URL_BASE)).searchParams.get('dpr')).toBe('3');
  });

  it('writes the #simboot fragment for Minimal-UI boot cloaking', () => {
    const u = new URL(resolveSimUrl(URL_BASE, { hideSelectors: ['#hud', '.controls'] }));
    const m = /[#&]simboot=([^&]*)/.exec(u.hash);
    expect(m).toBeTruthy();
    expect(JSON.parse(decodeURIComponent(m![1]))).toEqual({ hide: ['#hud', '.controls'] });
  });

  it('PRESERVES an author fragment by appending (hash-routed sims must keep their deep link)', () => {
    const u = new URL(resolveSimUrl(`${URL_BASE}#/scene/3`, { hideSelectors: ['#hud'] }));
    expect(u.hash.startsWith('#/scene/3&simboot=')).toBe(true);
    // …and the boot snippet's reader regex parses the appended form.
    const m = /[#&]simboot=([^&]*)/.exec(u.hash);
    expect(JSON.parse(decodeURIComponent(m![1]))).toEqual({ hide: ['#hud'] });
  });

  it('replaces a stale simboot value instead of stacking a second one', () => {
    const once = resolveSimUrl(`${URL_BASE}#/scene/3`, { hideSelectors: ['#hud'] });
    const twice = resolveSimUrl(once, { hideSelectors: ['.panel'] });
    const hash = new URL(twice).hash;
    expect(hash.match(/simboot=/g)).toHaveLength(1);
    const m = /[#&]simboot=([^&]*)/.exec(hash);
    expect(JSON.parse(decodeURIComponent(m![1]))).toEqual({ hide: ['.panel'] });
    expect(hash.startsWith('#/scene/3&')).toBe(true);
  });

  it('leaves the author fragment untouched when there is nothing to cloak', () => {
    expect(new URL(resolveSimUrl(`${URL_BASE}#/scene/3`)).hash).toBe('#/scene/3');
  });
});
