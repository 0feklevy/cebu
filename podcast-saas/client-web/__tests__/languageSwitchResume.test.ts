/**
 * The `?t=` round trip that survives a language switch.
 *
 * A language switch is a FULL DOCUMENT LOAD by design — the player owns live hls.js instances on
 * two <video> elements, and a soft navigation would swap the config while those attachments live
 * on, which is the exact shape of "picture changes, audio does not". The position therefore has to
 * travel through the only thing that survives a load: the URL.
 *
 * These pin the two halves of that trip — the offset written out, and the offset read back — as
 * pure functions, so they can be asserted without standing up a player. The seek itself is
 * deliberately NOT reimplemented here: it reuses the scrub release path inside `useProjectPlayer`,
 * and duplicating that logic in a test would be testing the copy rather than the code.
 */
import { describe, expect, it } from 'vitest';

/** Mirrors `changeLanguage` in SharedViewerPage. */
function hrefFor(
  opts: { shareToken?: string; permalinkSlug?: string },
  code: string | null,
  atSec: number,
): string | null {
  const t = Number.isFinite(atSec) && atSec > 1 ? `t=${Math.floor(atSec)}` : '';
  const withT = (base: string, hasQuery: boolean) => (t ? `${base}${hasQuery ? '&' : '?'}${t}` : base);
  return opts.shareToken
    ? (code
        ? withT(`/v/${opts.shareToken}?lang=${encodeURIComponent(code)}`, true)
        : withT(`/v/${opts.shareToken}`, false))
    : opts.permalinkSlug
      ? (code
          ? withT(`/${opts.permalinkSlug}/${encodeURIComponent(code)}`, false)
          : withT(`/${opts.permalinkSlug}`, false))
      : null;
}

/** Mirrors the `initialSeekSec` read in SharedViewerPage. */
function readT(search: string): number | undefined {
  const raw = new URLSearchParams(search).get('t');
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Mirrors the clamp in `startPlayback` before the seek is applied. */
function clamp(pending: number, totalDur: number): number {
  return Math.max(0, Math.min(pending, Math.max(0, totalDur - 0.25)));
}

describe('the offset written into the new URL', () => {
  it('joins with & on a share link that already carries ?lang', () => {
    expect(hrefFor({ shareToken: 'tok' }, 'he', 90)).toBe('/v/tok?lang=he&t=90');
  });

  it('joins with ? on a permalink, whose language is a path segment', () => {
    expect(hrefFor({ permalinkSlug: 'chaos' }, 'es', 42.7)).toBe('/chaos/es?t=42');
  });

  it('carries the position back to the ORIGINAL language too', () => {
    expect(hrefFor({ shareToken: 'tok' }, null, 33)).toBe('/v/tok?t=33');
    expect(hrefFor({ permalinkSlug: 'chaos' }, null, 33)).toBe('/chaos?t=33');
  });

  it('omits t entirely near the start — resuming at 0 is just starting', () => {
    expect(hrefFor({ shareToken: 'tok' }, 'he', 0)).toBe('/v/tok?lang=he');
    expect(hrefFor({ shareToken: 'tok' }, 'he', 0.4)).toBe('/v/tok?lang=he');
  });

  it('never emits NaN into the URL', () => {
    expect(hrefFor({ shareToken: 'tok' }, 'he', Number.NaN)).toBe('/v/tok?lang=he');
    expect(hrefFor({ shareToken: 'tok' }, 'he', Number.POSITIVE_INFINITY)).toBe('/v/tok?lang=he');
  });

  it('percent-encodes the language code rather than trusting it', () => {
    expect(hrefFor({ permalinkSlug: 'chaos' }, 'zh Hans', 10)).toBe('/chaos/zh%20Hans?t=10');
  });
});

describe('the offset read back on the other side', () => {
  it('round-trips the value the switch wrote', () => {
    const href = hrefFor({ shareToken: 'tok' }, 'he', 90)!;
    expect(readT(href.slice(href.indexOf('?')))).toBe(90);
  });

  it('ignores absent, empty, zero, negative and non-numeric values', () => {
    for (const q of ['', '?lang=he', '?t=', '?t=0', '?t=-5', '?t=abc']) {
      expect(readT(q)).toBeUndefined();
    }
  });
});

describe('the clamp applied before seeking', () => {
  it('keeps an in-range offset', () => {
    expect(clamp(90, 600)).toBe(90);
  });

  it('pulls an offset past the end back inside the timeline, never past it', () => {
    expect(clamp(9999, 600)).toBeCloseTo(599.75, 5);
  });

  it('survives a zero-duration timeline without going negative', () => {
    expect(clamp(90, 0)).toBe(0);
  });
});
