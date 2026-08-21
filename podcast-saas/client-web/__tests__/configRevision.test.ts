/**
 * D-13 — the rule that turns a freshly fetched config into the session's next revision.
 *
 * IDENTITY IS THE SUBJECT OF EVERY TEST HERE, not contents. `HLSPlayerShell` resets caption state
 * on `config.segments` *identity*:
 *
 *     useEffect(() => { setCaptionState(...); setCaptionCues({}); setCaptionsEnabled(false); },
 *               [config.project_id, config.segments]);
 *
 * so the naive "just keep the poll alive" fix wipes the viewer's captions on every tick — and,
 * worse, wipes them at exactly the moment a real correction lands. That verified regression is
 * why D-13's ruling calls the diff-before-setState guard mandatory even with a `304` in front of
 * it: the `304` covers the common case, and this covers a rebuilt-but-identical payload after the
 * server's 5s micro-cache expires.
 */
import { describe, expect, it } from 'vitest';

import {
  applyConfigRevision, FRESHNESS_INTERVAL_MS, nextFreshnessDelayMs,
} from '../components/viewer/configRevision';
import type { PlayerConfig } from '../components/viewer/types';

function config(over: Partial<PlayerConfig> = {}): PlayerConfig {
  return {
    project_id: 'proj-1',
    title: 'A lecture',
    segments: [{ id: 'seg-1', hls_url: 'https://cdn/1.m3u8' }],
    broll_clips: [{ id: 'clip-1', global_offset_sec: 10, start_sec: 0, end_sec: 4, hls_url: 'https://cdn/b.m3u8' }],
    clip_overlays: [],
    image_overlays: [],
    audio_cutaways: [],
    ...over,
  } as unknown as PlayerConfig;
}

/** Round-trip through JSON, the way a real poll response arrives — never the same object back. */
function refetched(c: PlayerConfig): PlayerConfig {
  return JSON.parse(JSON.stringify(c)) as PlayerConfig;
}

describe('applyConfigRevision — an unchanged payload is a no-op', () => {
  it('returns the SAME object when a re-fetch is byte-identical', () => {
    const prev = config();
    const next = refetched(prev);
    expect(next).not.toBe(prev);                       // a genuinely new object off the wire
    expect(applyConfigRevision(prev, next)).toBe(prev); // …and React bails out on it
  });

  it('keeps segments by reference, which is what spares the captions', () => {
    const prev = config();
    const result = applyConfigRevision(prev, refetched(prev));
    expect(result.segments).toBe(prev.segments);
  });

  it('takes the first payload verbatim — a session with no config has nothing to preserve', () => {
    const next = config();
    expect(applyConfigRevision(null, next)).toBe(next);
  });
});

describe('applyConfigRevision — an editorial correction', () => {
  const prev = config();
  const corrected = refetched(config({
    broll_clips: [{ id: 'clip-1', global_offset_sec: 25, start_sec: 0, end_sec: 4, hls_url: 'https://cdn/b.m3u8' }],
  } as Partial<PlayerConfig>));

  it('reaches the player', () => {
    const result = applyConfigRevision(prev, corrected);
    expect(result).not.toBe(prev);
    expect(result.broll_clips[0].global_offset_sec).toBe(25);
  });

  it('does NOT disturb segment identity — the correction must cost the viewer nothing', () => {
    expect(applyConfigRevision(prev, corrected).segments).toBe(prev.segments);
  });

  it('applies all four overlay lanes as ONE bundle', () => {
    // The lanes are promoted together at a shot boundary by `commitOverlayConfig`. Delivering
    // three of the four would let the b-roll schedule and the audio-cutaway schedule describe
    // different edits of the same lecture.
    const next = refetched(config({
      broll_clips:    [{ id: 'clip-1', global_offset_sec: 25, start_sec: 0, end_sec: 4, hls_url: 'https://cdn/b.m3u8' }],
      clip_overlays:  [{ id: 'ov-1',   global_offset_sec: 30, start_sec: 0, end_sec: 2, hls_url: 'https://cdn/o.m3u8' }],
      image_overlays: [{ id: 'img-1',  global_offset_sec: 40, duration_sec: 3 }],
      audio_cutaways: [{ id: 'aud-1',  global_offset_sec: 50, start_sec: 0, end_sec: 5 }],
    } as unknown as Partial<PlayerConfig>));

    const result = applyConfigRevision(prev, next);
    expect(result.broll_clips).toEqual(next.broll_clips);
    expect(result.clip_overlays).toEqual(next.clip_overlays);
    expect(result.image_overlays).toEqual(next.image_overlays);
    expect(result.audio_cutaways).toEqual(next.audio_cutaways);
    expect(result.segments).toBe(prev.segments);
  });

  it('carries a REMOVED clip through — a deletion is a correction too', () => {
    const emptied = refetched(config({ broll_clips: [] } as unknown as Partial<PlayerConfig>));
    expect(applyConfigRevision(prev, emptied).broll_clips).toEqual([]);
  });
});

describe('applyConfigRevision — structural change (the still-transcoding path)', () => {
  it('delivers a segment that has just gained its URL', () => {
    // This delivery predates D-13 and must keep working: without it the player freezes at the
    // boundary of a segment that finished transcoding after the page loaded.
    const prev = config({ segments: [
      { id: 'seg-1', hls_url: 'https://cdn/1.m3u8' },
      { id: 'seg-2', hls_url: null },
    ] } as unknown as Partial<PlayerConfig>);
    const next = refetched(config({ segments: [
      { id: 'seg-1', hls_url: 'https://cdn/1.m3u8' },
      { id: 'seg-2', hls_url: 'https://cdn/2.m3u8' },
    ] } as unknown as Partial<PlayerConfig>));

    const result = applyConfigRevision(prev, next);
    expect(result.segments).not.toBe(prev.segments);
    expect((result.segments[1] as { hls_url: string | null }).hls_url).toBe('https://cdn/2.m3u8');
  });

  it('still spares the captions when the change is elsewhere', () => {
    const prev = config();
    const next = refetched(config({ title: 'A renamed lecture' }));
    const result = applyConfigRevision(prev, next);
    expect((result as PlayerConfig & { title: string }).title).toBe('A renamed lecture');
    expect(result.segments).toBe(prev.segments);
  });

  it('treats a different project as a new session, not a revision of this one', () => {
    const prev = config();
    const other = config({ project_id: 'proj-2' });
    expect(applyConfigRevision(prev, other)).toBe(other);
  });
});

describe('nextFreshnessDelayMs', () => {
  it('is 60s at the centre and spreads to plus or minus 25%', () => {
    expect(nextFreshnessDelayMs(() => 0.5)).toBe(FRESHNESS_INTERVAL_MS);
    expect(nextFreshnessDelayMs(() => 0)).toBe(45_000);
    expect(nextFreshnessDelayMs(() => 1)).toBe(75_000);
  });

  it('never returns the same delay for a spread of viewers — the burst is what jitter prevents', () => {
    // An audience arrives together (a link goes out, a class starts). Unjittered, they reconvene
    // into a synchronised burst every 60s against the host D-12 named as the scaling constraint.
    const draws = [0.05, 0.2, 0.4, 0.6, 0.8, 0.95].map((r) => nextFreshnessDelayMs(() => r));
    expect(new Set(draws).size).toBe(draws.length);
    for (const d of draws) {
      expect(d).toBeGreaterThanOrEqual(45_000);
      expect(d).toBeLessThanOrEqual(75_000);
    }
  });

  it('is never fast enough to be a stream — this is "the creator fixed a mistake"', () => {
    for (let i = 0; i < 200; i += 1) expect(nextFreshnessDelayMs()).toBeGreaterThanOrEqual(45_000);
  });
});
