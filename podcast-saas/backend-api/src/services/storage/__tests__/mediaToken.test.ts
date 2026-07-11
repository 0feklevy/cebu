import { describe, it, expect } from 'vitest';
import { mediaKeyScope, mintMediaToken, verifyMediaToken, splitMediaTokenPrefix } from '../mediaToken.js';

describe('mediaToken', () => {
  it('scopes a key to its first two segments for hls/ and videos/ only', () => {
    expect(mediaKeyScope('hls/vf-1/run/master.m3u8')).toBe('hls/vf-1');
    expect(mediaKeyScope('videos/proj-1/file.mp4')).toBe('videos/proj-1');
    expect(mediaKeyScope('thumbnails/proj-1/x.jpg')).toBeNull();
    expect(mediaKeyScope('hls/')).toBeNull();
    expect(mediaKeyScope('videos')).toBeNull();
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
