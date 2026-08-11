import { describe, it, expect } from 'vitest';
import {
  previousHlsTreeToGc,
  hlsCacheControlForKey,
  HLS_IMMUTABLE_CACHE_CONTROL,
} from '../hlsVersioning.js';

const ID = 'abc-123-def';

describe('previousHlsTreeToGc', () => {
  it('returns null when there is no previous master key', () => {
    expect(previousHlsTreeToGc(ID, null, 'k5x9')).toBeNull();
    expect(previousHlsTreeToGc(ID, undefined, 'k5x9')).toBeNull();
  });

  it('GCs a previous versioned tree with a different run id', () => {
    expect(previousHlsTreeToGc(ID, `hls/${ID}/oldrun/master.m3u8`, 'newrun')).toBe(`hls/${ID}/oldrun`);
  });

  it('does NOT GC when the run id is unchanged (idempotent re-run of the same run)', () => {
    expect(previousHlsTreeToGc(ID, `hls/${ID}/samerun/master.m3u8`, 'samerun')).toBeNull();
  });

  it('does NOT GC a legacy unversioned key (would delete the new tree under the same parent)', () => {
    expect(previousHlsTreeToGc(ID, `hls/${ID}/master.m3u8`, 'newrun')).toBeNull();
  });

  it('ignores a master key for a different video id', () => {
    expect(previousHlsTreeToGc(ID, `hls/other-id/run/master.m3u8`, 'newrun')).toBeNull();
  });

  it('only matches the master playlist, not an arbitrary nested object', () => {
    expect(previousHlsTreeToGc(ID, `hls/${ID}/run/360p/index.m3u8`, 'newrun')).toBeNull();
  });
});

describe('hlsCacheControlForKey', () => {
  const IMMUTABLE = 'public, max-age=31536000, immutable';

  it('pins the exact immutable Cache-Control value the whole pipeline shares', () => {
    expect(HLS_IMMUTABLE_CACHE_CONTROL).toBe(IMMUTABLE);
  });

  it('marks a versioned segment immutable', () => {
    expect(hlsCacheControlForKey(`hls/${ID}/k5x9/360p/seg_000.ts`)).toBe(IMMUTABLE);
  });

  it('marks a versioned variant playlist immutable (write-once tree — playlists included)', () => {
    expect(hlsCacheControlForKey(`hls/${ID}/k5x9/720p/index.m3u8`)).toBe(IMMUTABLE);
  });

  it('marks the versioned master playlist immutable (the mutable pointer is the DB row)', () => {
    expect(hlsCacheControlForKey(`hls/${ID}/k5x9/master.m3u8`)).toBe(IMMUTABLE);
  });

  it('returns null for legacy unversioned keys (overwritten in place — never immutable)', () => {
    expect(hlsCacheControlForKey(`hls/${ID}/master.m3u8`)).toBeNull();        // legacy master
    expect(hlsCacheControlForKey(`hls/${ID}/360p/index.m3u8`)).toBeNull();    // legacy tier playlist
    expect(hlsCacheControlForKey(`hls/${ID}/360p/seg_000.ts`)).toBeNull();    // legacy segment
  });

  it('returns null for sim keys and other non-HLS prefixes', () => {
    expect(hlsCacheControlForKey('simulations/proj/sim/revisions/r1/package/index.html')).toBeNull();
    expect(hlsCacheControlForKey('simulations/proj/sim/entry.html')).toBeNull();
    expect(hlsCacheControlForKey('videos/proj/file.mp4')).toBeNull();
    expect(hlsCacheControlForKey('thumbnails/proj/x.jpg')).toBeNull();
  });

  it('returns null for malformed keys (empty segments, too shallow, bare prefix)', () => {
    expect(hlsCacheControlForKey('hls')).toBeNull();
    expect(hlsCacheControlForKey(`hls/${ID}`)).toBeNull();
    expect(hlsCacheControlForKey(`hls//run/master.m3u8`)).toBeNull();
    expect(hlsCacheControlForKey(`hls/${ID}/run/`)).toBeNull();
  });
});
