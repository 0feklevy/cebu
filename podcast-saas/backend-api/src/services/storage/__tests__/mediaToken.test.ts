import { describe, it, expect, vi, afterEach } from 'vitest';
import { mediaKeyScope, mintMediaToken, verifyMediaToken, splitMediaTokenPrefix } from '../mediaToken.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('mediaToken', () => {
  it('scopes a key to its first two segments for hls/, videos/ and exports/ only', () => {
    expect(mediaKeyScope('hls/vf-1/run/master.m3u8')).toBe('hls/vf-1');
    expect(mediaKeyScope('videos/proj-1/file.mp4')).toBe('videos/proj-1');
    expect(mediaKeyScope('exports/proj-1/exp-1/master.mp4')).toBe('exports/proj-1');
    expect(mediaKeyScope('thumbnails/proj-1/x.jpg')).toBeNull();
    expect(mediaKeyScope('hls/')).toBeNull();
    expect(mediaKeyScope('videos')).toBeNull();
    expect(mediaKeyScope('exports/')).toBeNull();
  });

  it('round-trips a minted token for its scope only', () => {
    const token = mintMediaToken('hls/vf-1');
    expect(verifyMediaToken('hls/vf-1', token)).toBe(true);
    expect(verifyMediaToken('hls/vf-2', token)).toBe(false);
    expect(verifyMediaToken('videos/vf-1', token)).toBe(false);
  });

  it('rejects expired, malformed, and tampered tokens', () => {
    expect(verifyMediaToken('hls/vf-1', mintMediaToken('hls/vf-1', -10))).toBe(false); // expired
    expect(verifyMediaToken('hls/vf-1', 'garbage')).toBe(false);
    expect(verifyMediaToken('hls/vf-1', '')).toBe(false);
    const token = mintMediaToken('hls/vf-1');
    const tampered = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    expect(verifyMediaToken('hls/vf-1', tampered)).toBe(false);
  });

  it('splits an optional t/{token}/ path prefix', () => {
    expect(splitMediaTokenPrefix('t/abc/hls/vf/run/seg.ts')).toEqual({ key: 'hls/vf/run/seg.ts', token: 'abc' });
    expect(splitMediaTokenPrefix('hls/vf/run/seg.ts')).toEqual({ key: 'hls/vf/run/seg.ts', token: null });
    expect(splitMediaTokenPrefix('t/')).toEqual({ key: 't/', token: null });
  });

  // ── Cache-key stability (P1.7c) ────────────────────────────────────────────
  // The token is embedded in every media URL and the player config re-mints per fetch.
  // Second-granularity expiries made every mint a DIFFERENT URL for the same immutable
  // bytes, so browser/CDN caches missed on every re-fetch. Default mints are therefore
  // day-quantized: identical within a UTC day, validity always within [7d, 8d].

  it('default mints within the same UTC day are string-identical (stable cache key)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:01Z'));
    const early = mintMediaToken('hls/vf-1');
    vi.setSystemTime(new Date('2026-08-11T12:34:56Z'));
    const midday = mintMediaToken('hls/vf-1');
    vi.setSystemTime(new Date('2026-08-11T23:59:59Z'));
    const late = mintMediaToken('hls/vf-1');
    expect(midday).toBe(early);
    expect(late).toBe(early);
    // …and it still verifies, and only for its own scope.
    expect(verifyMediaToken('hls/vf-1', early)).toBe(true);
    expect(verifyMediaToken('hls/vf-2', early)).toBe(false);
  });

  it('crossing a UTC-day boundary rotates the token', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T23:59:59Z'));
    const before = mintMediaToken('hls/vf-1');
    vi.setSystemTime(new Date('2026-08-12T00:00:01Z'));
    const after = mintMediaToken('hls/vf-1');
    expect(after).not.toBe(before);
    expect(verifyMediaToken('hls/vf-1', before)).toBe(true); // old token stays valid until ITS exp
    expect(verifyMediaToken('hls/vf-1', after)).toBe(true);
  });

  it('default validity is always at least 7 days and at most 8', () => {
    for (const at of ['2026-08-11T00:00:00Z', '2026-08-11T11:30:00Z', '2026-08-11T23:59:59Z']) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(at));
      const token = mintMediaToken('hls/vf-1');
      const exp = Number(token.slice(0, token.indexOf('-')));
      const now = Math.floor(Date.now() / 1000);
      expect(exp - now).toBeGreaterThanOrEqual(7 * 86400);
      expect(exp - now).toBeLessThanOrEqual(8 * 86400);
      vi.useRealTimers();
    }
  });

  it('verification accepts old-style fine-grained expiries too (exp > now is the only time rule)', () => {
    // An explicit ttl mints exactly the pre-quantization format: exp = now + ttl, any second.
    const fineGrained = mintMediaToken('hls/vf-1', 3600);
    expect(verifyMediaToken('hls/vf-1', fineGrained)).toBe(true);
    expect(verifyMediaToken('hls/vf-2', fineGrained)).toBe(false);
  });

  it('a minted URL survives HLS relative resolution (token prefix preserved)', () => {
    // master at /hls-public/t/{tok}/hls/vf/run/master.m3u8 references "v0/playlist.m3u8"
    const tok = mintMediaToken('hls/vf');
    const manifestUrl = new URL(`http://x/hls-public/t/${tok}/hls/vf/run/master.m3u8`);
    const segmentUrl = new URL('v0/playlist.m3u8', manifestUrl);
    const raw = segmentUrl.pathname.replace(/^\/hls-public\//, '');
    const { key, token } = splitMediaTokenPrefix(raw);
    expect(key).toBe('hls/vf/run/v0/playlist.m3u8');
    expect(token).toBe(tok);
    expect(verifyMediaToken(mediaKeyScope(key)!, token!)).toBe(true);
  });
});
