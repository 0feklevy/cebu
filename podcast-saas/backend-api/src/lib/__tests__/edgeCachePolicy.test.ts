import { describe, it, expect } from 'vitest';
import { defaultCacheControl, isPublicReadPath } from '../edgeCachePolicy.js';

describe('defaultCacheControl', () => {
  it('adds no-store to an /api/ response that said nothing, and leaves one that spoke alone', () => {
    expect(defaultCacheControl('/api/v1/projects', undefined)).toBe('no-store');
    expect(defaultCacheControl('/api/v1/projects?x=1', '')).toBe('no-store');
    expect(defaultCacheControl('/api/v1/public/library/slug', 'public, max-age=60')).toBeNull();
  });
  it('touches nothing outside /api/ — sim assets, health, local storage have their own rules', () => {
    expect(defaultCacheControl('/sim-public/simulations/x/index.html', undefined)).toBeNull();
    expect(defaultCacheControl('/health', undefined)).toBeNull();
  });
});

describe('isPublicReadPath', () => {
  it('names the anonymous viewer reads and nothing else', () => {
    expect(isPublicReadPath('GET', '/api/v1/public/permalink/my-lesson')).toBe(true);
    expect(isPublicReadPath('GET', '/api/v1/public/audio/my-lesson?language=en')).toBe(true);
    expect(isPublicReadPath('GET', '/api/v1/share/abc123')).toBe(true);
    expect(isPublicReadPath('GET', '/api/v1/projects/p1/player-config')).toBe(true);
    expect(isPublicReadPath('GET', '/api/v1/projects/p1/captions')).toBe(true);
    expect(isPublicReadPath('GET', '/api/v1/videos/v1/captions.vtt')).toBe(true);
    expect(isPublicReadPath('POST', '/api/v1/public/audio/s/questions')).toBe(false);   // has its own tighter limit
    expect(isPublicReadPath('GET', '/api/v1/projects/p1/videos')).toBe(false);          // authenticated
    expect(isPublicReadPath('GET', '/api/v1/projects/p1/captions/retry')).toBe(false);
  });
});
