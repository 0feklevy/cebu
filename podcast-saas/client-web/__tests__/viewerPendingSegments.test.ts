/**
 * A LECTURE SHARED RIGHT AFTER UPLOAD MUST NOT FREEZE — AND THE TEST MUST BE ABLE TO TELL.
 *
 * The previous version of this file is the reason there is a second round. It `readFileSync`'d
 * `ViewerPage.tsx` and asserted on the SOURCE TEXT, and it re-declared the readiness predicates
 * inside the test so it was checking its own copy rather than the shipped one. It had a case
 * named `starts playback on the first ready segment` whose body asserted only that *some*
 * segment was playable — a claim about scheduling that the assertion could not reach. The
 * component never did that: `useProjectPlayer` seeds `currentSegIdx: 0` and attaches
 * `segmentsRef.current[0]` unconditionally.
 *
 * All four regressions below passed that suite. Every test here imports the real decision from
 * `segmentReadiness.ts` — the same module the components call — so a test can no longer agree
 * with a comment while the code does something else.
 */
import { describe, it, expect } from 'vitest';
import {
  isPlayableSegment,
  isResolvedSegment,
  entrySegmentOf,
  readinessOf,
  mergeSegmentUrls,
  shouldPrewarm,
} from '../components/viewer/segmentReadiness';
import type { PlayerSegment } from '../components/viewer/types';

const seg = (over: Partial<PlayerSegment> & { id: string }): PlayerSegment =>
  ({ hls_url: null, fallback_url: null, hls_status: 'processing', label: '', duration_sec: 10, simulations: [], ...over }) as PlayerSegment;

const ready = (id: string) => seg({ id, hls_status: 'ready', hls_url: `https://cdn/${id}.m3u8` });
const processing = (id: string) => seg({ id, hls_status: 'processing' });
const failed = (id: string) => seg({ id, hls_status: 'failed' });

describe('REGRESSION 1 — readiness is the ENTRY segment’s, never “any segment’s”', () => {
  it('a ready LATER segment does not make an unready FIRST segment playable', () => {
    // The exact shipped bug. Transcodes run concurrently, so video 2 finishing first is ordinary.
    // `playable.length > 0` was true here, so the viewer dismissed the spinner and handed the
    // player a segment 0 with no URL: no video, no spinner, no error.
    const r = readinessOf({ segments: [processing('a'), ready('b')], branching: null });
    expect(r.entryPlayable).toBe(false);
    expect(r.pendingCount).toBe(1);
  });

  it('is playable as soon as the FIRST segment is, even with later ones transcoding', () => {
    const r = readinessOf({ segments: [ready('a'), processing('b')], branching: null });
    expect(r.entryPlayable).toBe(true);
    expect(r.pendingCount).toBe(1);            // and polling must continue
  });

  it('a progressive fallback counts, an .m3u8-only “ready” flag is not required', () => {
    expect(isPlayableSegment(seg({ id: 'a', hls_status: 'processing', fallback_url: 'https://cdn/a.mp4' }))).toBe(true);
  });

  it('resolves the entry through the entry SEQUENCE when the project branches', () => {
    const config = {
      segments: [processing('flat')],
      branching: {
        entry_sequence_id: 'seq-2',
        sequences: [
          { id: 'seq-1', segments: [processing('x')] },
          { id: 'seq-2', segments: [ready('entry'), processing('later')] },
        ],
      },
    };
    // Not sequences[0], and not config.segments — the sequence named by entry_sequence_id.
    expect(entrySegmentOf(config as never)?.id).toBe('entry');
    expect(readinessOf(config as never).entryPlayable).toBe(true);
  });

  it('falls back to the first sequence when the named entry is missing', () => {
    const config = {
      segments: [],
      branching: { entry_sequence_id: 'nope', sequences: [{ id: 'seq-1', segments: [ready('first')] }] },
    };
    expect(entrySegmentOf(config as never)?.id).toBe('first');
  });
});

describe('polling continues until every segment is terminal', () => {
  it('“failed” is resolved but NOT playable — so it surfaces instead of hanging', () => {
    expect(isResolvedSegment(failed('a'))).toBe(true);
    expect(isPlayableSegment(failed('a'))).toBe(false);
  });

  it('stops polling only when nothing can change again', () => {
    expect(readinessOf({ segments: [ready('a'), ready('b')], branching: null }).pendingCount).toBe(0);
    expect(readinessOf({ segments: [ready('a'), failed('b')], branching: null }).pendingCount).toBe(0);
    expect(readinessOf({ segments: [ready('a'), processing('b')], branching: null }).pendingCount).toBe(1);
  });

  it('one bad video among good ones is not a healthy project and not a dead one', () => {
    const r = readinessOf({ segments: [ready('a'), failed('b')], branching: null });
    expect(r.allFailed).toBe(false);
    expect(r.entryPlayable).toBe(true);
    expect(r.pendingCount).toBe(0);
  });

  it('every segment failed is a hard error, not a wait', () => {
    expect(readinessOf({ segments: [failed('a'), failed('b')], branching: null }).allFailed).toBe(true);
  });

  it('a project with no segments is empty, not playable', () => {
    const r = readinessOf({ segments: [], branching: null });
    expect(r.empty).toBe(true);
    expect(r.entryPlayable).toBe(false);
  });
});

describe('REGRESSION 2 — a URL arriving after mount must reach the held timeline', () => {
  it('fills in a segment that has since become ready', () => {
    const held = [ready('a'), processing('b')];
    const merged = mergeSegmentUrls(held, { segments: [ready('a'), ready('b')], branching: null } as never);
    expect(merged[1].hls_url).toBe('https://cdn/b.m3u8');
    expect(merged[1].hls_status).toBe('ready');
  });

  it('NEVER rewrites a segment that already has a URL — that is a shot swap mid-playback', () => {
    const held = [seg({ id: 'a', hls_status: 'ready', hls_url: 'https://cdn/ORIGINAL.m3u8' })];
    const merged = mergeSegmentUrls(held, { segments: [seg({ id: 'a', hls_status: 'ready', hls_url: 'https://cdn/DIFFERENT.m3u8' })], branching: null } as never);
    expect(merged[0].hls_url).toBe('https://cdn/ORIGINAL.m3u8');
  });

  it('matches across branch sequences, so it survives a navigation', () => {
    const held = [processing('deep')];
    const merged = mergeSegmentUrls(held, {
      segments: [],
      branching: { entry_sequence_id: 's1', sequences: [{ id: 's1', segments: [ready('deep')] }] },
    } as never);
    expect(merged[0].hls_url).toBe('https://cdn/deep.m3u8');
  });

  it('returns the SAME array when nothing changed, so the caller can skip the write', () => {
    const held = [ready('a')];
    expect(mergeSegmentUrls(held, { segments: [ready('a')], branching: null } as never)).toBe(held);
    expect(mergeSegmentUrls(held, { segments: [processing('a')], branching: null } as never)).toBe(held);
  });
});

describe('REGRESSION 3 — the standby is never claimed for a segment with no URL', () => {
  const base = { segmentId: 'b', claimedId: null as string | null, url: 'https://cdn/b.m3u8', hasStandby: true };

  it('does not claim when the URL is still empty — which is what allows the retry', () => {
    // The bug: the id was recorded first, the attach then no-opped on the empty URL, and the
    // “already claimed” guard matched forever after. The URL arrived and nothing re-attached.
    expect(shouldPrewarm({ ...base, url: '' })).toBe(false);
  });

  it('claims once the URL arrives on a later poll', () => {
    expect(shouldPrewarm({ ...base, url: 'https://cdn/b.m3u8' })).toBe(true);
  });

  it('does not re-claim a segment it already holds', () => {
    expect(shouldPrewarm({ ...base, claimedId: 'b' })).toBe(false);
  });

  it('needs a segment and a standby element', () => {
    expect(shouldPrewarm({ ...base, segmentId: null })).toBe(false);
    expect(shouldPrewarm({ ...base, hasStandby: false })).toBe(false);
  });
});
