import { describe, it, expect } from 'vitest';
import { isNonPublicUrl, keyFromUrl } from '../urlBackfill.js';

describe('isNonPublicUrl (migration match predicate)', () => {
  it('flags poisoned localhost/internal-host URLs that must be rewritten', () => {
    for (const u of [
      'http://localhost:8080/local-storage/playlist-banners/p/v/a.png',
      'http://localhost:8080/sim-public/simulations/p/v/index.html',
      'https://127.0.0.1/local-storage/thumbnails/x.png',
      'http://backend:8080/local-storage/images/y.png',
    ]) {
      expect(isNonPublicUrl(u)).toBe(true);
    }
  });

  it('LEAVES valid cloud + public-API URLs untouched (no blind rewrite)', () => {
    for (const u of [
      'https://abc123.supabase.co/storage/v1/object/public/media/thumbnails/x.png',
      'https://api.flowvidco.com/sim-public/simulations/p/v/index.html', // valid prod sim URL
      'https://cdn.example.com/a.png',
      'https://youtube.com/watch?v=abc', // user-entered external
    ]) {
      expect(isNonPublicUrl(u)).toBe(false);
    }
  });
});

describe('keyFromUrl (URL → storage key extraction)', () => {
  it('strips origin + serve route back to the bare key', () => {
    expect(keyFromUrl('http://localhost:8080/local-storage/thumbnails/p/v/a.png')).toBe('thumbnails/p/v/a.png');
    expect(keyFromUrl('http://localhost:8080/sim-public/simulations/p/v/index.html')).toBe('simulations/p/v/index.html');
  });

  it('strips a leading media-token segment', () => {
    expect(keyFromUrl('http://localhost:8080/hls-public/t/abc.def.ghi/hls/p/v/master.m3u8')).toBe('hls/p/v/master.m3u8');
    expect(keyFromUrl('http://localhost:8080/video-raw/t/tok/videos/v1.mp4')).toBe('videos/v1.mp4');
  });

  it('drops query/hash and decodes percent-encoding', () => {
    expect(keyFromUrl('http://localhost:8080/local-storage/images/a%20b.png?x=1#y')).toBe('images/a b.png');
  });

  it('returns null when no known serve route is present', () => {
    expect(keyFromUrl('https://youtube.com/watch?v=abc')).toBeNull();
  });
});
